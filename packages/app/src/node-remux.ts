/**
 * node-remux.ts — 节点侧「原地替换容器」(issue #137 第 2/2)。
 *
 * 只作用于**无后处理的任务**:每个录制分段**封口后**在节点上 `-c copy` remux 成任务所选容器(mp4/mkv),
 * 校验通过后删除原文件,新文件成为 source;**绝不并存两份**。`original` 时本模块完全不参与。
 *
 * 硬边界:
 *   - 只碰已封口分段(封口判定复用 core `sealedSegmentIndices`,与边录边传同一份):正在写的分段绝不动;
 *     会话收尾(`await recorder.stop()` 之后)再补转最后一段。
 *   - 先写临时文件 `{新名}.drec-remux`(非视频扩展名 → 任何扫描/分组/孤儿清理都不会当成分段),
 *     校验通过才 fsync + 原子 rename 成最终名,再删原文件。任一步失败:删临时文件、**保留原文件**、告警。
 *   - 永不删到最后一份:原文件只在「新文件已校验并落到最终名」之后才删。校验 = {@link verifyRemuxed}(扫包取末帧
 *     + 大小比例,识别截断/损坏),正常路径与崩溃接管路径**共用同一个函数**;接管时新文件存疑 → 两份都留。
 *   - 转换串行(并发上限 1)、fire-and-forget,不阻塞录制;失败不影响后续分段。
 *   - 崩溃接管见 {@link recoverNodeRemux}。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  platformForRoom,
  sealedSegmentIndices,
  sessionBaseOf,
  STAGE_CONTAINERS,
  type OutputFormat,
  type RollingSegment,
  type StageFormat,
} from "@drec/core";
import type { RollingUploadHook } from "@drec/manager";
import { listHubRules, hubKey } from "./hub-store.js";
import { volumeFreeBytes } from "./disk-gate.js";
import type { Task } from "./store.js";

/** 临时文件后缀(追加在最终文件名之后)。不是视频扩展名:扫描 / 分组 / 孤儿清理都不会把它当分段或 scratch。 */
export const NODE_REMUX_TMP_SUFFIX = ".drec-remux";

/**
 * 时长校验容差 = max(2s, 源时长 × 1%)。依据:`-c copy` 不改 PTS 跨度,容器间的合法差异只有首尾
 * 取整(mesio 修复过的 flv 头时长为 0、走末帧 PTS 兜底;ts 的 PCR 起点偏移),都在一个 GOP(直播 1~2s)内;
 * 而写盘中断 / 解复用丢包造成的截断,偏差远大于此。1% 兜住长分段(30 分钟 ≈ 18s)的累积取整。
 */
export const DURATION_TOLERANCE_SEC = 2;
export const DURATION_TOLERANCE_RATIO = 0.01;

/**
 * 转换前磁盘余量要求 = 源文件大小(临时文件约一份)+ 此固定余量。余量留给**仍在写的当前分段**,
 * 否则 remux 把盘占满、录制反而被拖垮(本功能的底线是不得拖垮录制)。
 */
export const REMUX_DISK_HEADROOM_BYTES = 1024 ** 3;

/** 容差(秒)。 */
export function durationToleranceSec(srcSec: number): number {
  return Math.max(DURATION_TOLERANCE_SEC, srcSec * DURATION_TOLERANCE_RATIO);
}

/**
 * 视频流时间跨度容差 = max(3s, 源跨度 × 0.3%)。跨度来自扫全部视频包的 pts(见 post-process `ffprobeVideoSpan`),
 * 新旧文件同口径,偏差只来自 remux 丢掉首个关键帧之前的包(≤ 一个 GOP,直播 1~2s)。
 * 比头部时长容差(1%)更紧:头部时长在 mkv / faststart mp4 里截断后依旧完整,这是真正能抓到截断的那一道。
 */
export const SPAN_TOLERANCE_SEC = 3;
export const SPAN_TOLERANCE_RATIO = 0.003;

/**
 * 新文件体积 / 原文件体积下限。依据:`-c copy` 只换容器、码流原样搬,体积应与原文件同量级。
 * 容器实测(docker 内 ffmpeg 5.1,2Mbps 640x360 噪声源 20s):ts→mkv 0.957、ts→mp4 0.957、flv→mp4 1.00;
 * 极端的 ~100kbps 纯色合成流因 ts 填充开销大,ts→mkv 也只到 0.47。真实直播码流(≥1Mbps)恒在 0.9 以上,
 * 取 0.5:再低就是被截断/丢流的强信号。误杀只会多留一份原文件并告警(安全方向),漏判才会丢数据。
 */
export const MIN_SIZE_RATIO = 0.5;

/**
 * 崩溃接管只删「足够旧」的孤儿临时文件。接管扫的是共享输出根(含其他任务正在转换的目录),
 * 新鲜的临时文件可能正被另一个任务的 ffmpeg 写。依据:单段 remux 是顺序 `-c copy`,
 * 30 分钟的段在机械盘上也只需几分钟;2 小时远大于最长合理转换时间。正在写的文件 mtime 持续刷新,永远不会被判旧。
 */
export const STALE_TMP_MIN_AGE_MS = 2 * 60 * 60 * 1000;

/** 存疑的新文件(接管时校验不通过 / 无法判定)改成此后缀隔离:两份都保留,但新文件不再被扫描/分组当成分段(避免与原文件重复计入)。 */
export const NODE_REMUX_SUSPECT_SUFFIX = ".drec-suspect";

export interface MediaProbe {
  durationSec: number;
  hasVideo: boolean;
  /** 全部视频包 pts 的 max−min(秒)。 */
  spanSec: number;
  /** 视频包数;0 = 无法判定(ffprobe 失败 / 无包)。 */
  packets: number;
}

export interface NodeRemuxDeps {
  /** `-c copy` 转封装 src → tmp(tmp 扩展名不是容器扩展名,实现需显式指定封装器)。失败 reject。 */
  remux?: (src: string, tmp: string, fmt: StageFormat) => Promise<void>;
  /** ffprobe 接缝。失败 reject。 */
  probe?: (path: string) => Promise<MediaProbe>;
  /** 目录所在卷剩余字节;null = 查不到 → 放行。 */
  freeBytes?: (dir: string) => number | null;
  /** 测试接缝:落盘 / 改名。默认 fsync + renameSync。 */
  fsync?: (path: string) => void;
  rename?: (from: string, to: string) => void;
  /** 当前时间(ms),判定临时文件新旧用;默认 Date.now。 */
  now?: () => number;
  /** 告警(→ 现有通道:通知 error 事件 → webhook + @@DREC_ALERT@@ + 站内 toast)。 */
  alert?: (message: string) => void;
  log?: (msg: string) => void;
}

/** 默认接缝:动态 import post-process(与 segment-pipeline 同做法,避免 app 顶层硬依赖 ffmpeg 包初始化)。 */
async function defaultRemux(src: string, tmp: string, fmt: StageFormat): Promise<void> {
  const { remuxSegment } = await import("@drec/post-process");
  await remuxSegment(src, tmp, fmt);
}
async function defaultProbe(p: string): Promise<MediaProbe> {
  const { ffprobeVideo, ffprobeVideoSpan } = await import("@drec/post-process");
  const v = await ffprobeVideo(p);
  const span = await ffprobeVideoSpan(p);
  return { durationSec: v.durationMs / 1000, hasVideo: v.hasVideo, spanSec: span.spanSec, packets: span.packets };
}

/** `{dir}/{stem}.{old}` → 目标最终路径(原基名 + 新扩展名;带段号的保持段号,无段号保持无段号)。 */
export function remuxTargetPath(src: string, fmt: StageFormat): string {
  return `${src.slice(0, src.length - extname(src).length)}${STAGE_CONTAINERS[fmt].ext}`;
}

/** 会话 sidecar `{base}.session.json` 路径(与 manager 写入口径一致:同目录)。 */
function sessionJsonOf(dir: string, base: string): string {
  return join(dir, `${base}.session.json`);
}

/**
 * 在会话 sidecar 里记录「已转换格式」(合并写,保留其余字段;文件不存在则建最小文件)。
 * 老文件缺字段 = 未转换。**先于 rename 写**:崩溃后凭它识别配对、凭它让无段号单文件被识别为源。
 * 写失败抛错(调用方据此放弃本次转换,保留原文件)。
 */
export function markSessionNodeFormat(dir: string, base: string, fmt: StageFormat): void {
  const p = sessionJsonOf(dir, base);
  let data: Record<string, unknown> = { sessionBase: base };
  try { data = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>; } catch { /* 新建 */ }
  if (data.nodeFormat === fmt) return;
  data.nodeFormat = fmt;
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), "utf-8");
  renameSync(tmp, p);
}

function readNodeFormat(dir: string, base: string): string | undefined {
  try {
    const d = JSON.parse(readFileSync(sessionJsonOf(dir, base), "utf-8")) as { nodeFormat?: unknown };
    return typeof d.nodeFormat === "string" ? d.nodeFormat : undefined;
  } catch { return undefined; }
}

function fsyncFile(p: string): void {
  const fd = openSync(p, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function rmQuiet(p: string): void {
  try { rmSync(p, { force: true }); } catch { /* 删不掉由调用方日志说明 */ }
}

export type RemuxOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: "missing" | "target-exists" | "no-space" | "mark-failed" | "remux-failed" | "verify-failed"; detail?: string };

/**
 * 校验新文件(**唯一校验函数**,正常转换与崩溃接管共用)。返回失败原因(通过 = undefined);
 * 任何「无法判定」(探测失败 / 无视频包 / 原文件时长未知)都按失败处理 —— 宁可保留原文件。
 *   ① 两边都能 ffprobe、新文件有视频流且有视频包;
 *   ② 头部时长在容差内(挡 remux 提前退出);
 *   ③ **视频包 pts 跨度在容差内**(扫包取真实末帧;挡「头部完好、尾部被截断」——mkv / faststart mp4 的头部时长不会变);
 *   ④ 新文件大小 ≥ 原文件 × {@link MIN_SIZE_RATIO}(挡跨度巧合通过的大块丢流)。
 */
export async function verifyRemuxed(src: string, out: string, probe: NonNullable<NodeRemuxDeps["probe"]>): Promise<string | undefined> {
  let s: MediaProbe, o: MediaProbe;
  try { s = await probe(src); } catch (e) { return `原文件无法探测: ${(e as Error).message}`; }
  try { o = await probe(out); } catch (e) { return `新文件无法探测: ${(e as Error).message}`; }
  if (!o.hasVideo) return "新文件没有视频流";
  if (!(s.durationSec > 0)) return "原文件时长未知";
  if (!(s.packets > 0) || !(s.spanSec > 0)) return "原文件视频包无法判定";
  if (!(o.packets > 0)) return "新文件没有可读的视频包";
  const diff = Math.abs(o.durationSec - s.durationSec);
  if (diff > durationToleranceSec(s.durationSec)) {
    return `时长不符: 原 ${s.durationSec.toFixed(1)}s → 新 ${o.durationSec.toFixed(1)}s(容差 ${durationToleranceSec(s.durationSec).toFixed(1)}s)`;
  }
  const spanTol = Math.max(SPAN_TOLERANCE_SEC, s.spanSec * SPAN_TOLERANCE_RATIO);
  if (Math.abs(o.spanSec - s.spanSec) > spanTol) {
    return `视频末帧不符(疑似截断): 原跨度 ${s.spanSec.toFixed(1)}s → 新 ${o.spanSec.toFixed(1)}s(容差 ${spanTol.toFixed(1)}s)`;
  }
  let srcSize: number, outSize: number;
  try { srcSize = statSync(src).size; outSize = statSync(out).size; } catch (e) { return `读取文件大小失败: ${(e as Error).message}`; }
  if (srcSize <= 0) return "原文件大小为 0";
  if (outSize < srcSize * MIN_SIZE_RATIO) {
    return `体积过小(疑似截断): 新 ${outSize}B / 原 ${srcSize}B = ${(outSize / srcSize).toFixed(2)} < ${MIN_SIZE_RATIO}`;
  }
  return undefined;
}

/**
 * 把一个**已封口**的分段原地转成 `fmt`。全程不抛:返回结果,失败时已清理临时文件、保留原文件、发过告警。
 */
export async function convertSegmentInPlace(src: string, fmt: StageFormat, deps: NodeRemuxDeps = {}): Promise<RemuxOutcome> {
  const log = deps.log ?? ((): void => {});
  const alert = deps.alert ?? ((): void => {});
  const remux = deps.remux ?? defaultRemux;
  const probe = deps.probe ?? defaultProbe;
  const fsync = deps.fsync ?? fsyncFile;
  const rename = deps.rename ?? renameSync;
  const freeBytes = deps.freeBytes ?? volumeFreeBytes;
  const name = basename(src);
  const fail = (reason: Extract<RemuxOutcome, { ok: false }>["reason"], detail: string, tmp?: string): RemuxOutcome => {
    if (tmp) rmQuiet(tmp);
    const msg = `分段转 ${fmt} 失败(${reason}),已保留原文件 ${name}: ${detail}`;
    log(`[remux] ${msg}`);
    alert(msg);
    return { ok: false, reason, detail };
  };

  let size: number;
  try { size = statSync(src).size; } catch { return { ok: false, reason: "missing" }; } // 已被别处处理/删除:无事可做
  const final = remuxTargetPath(src, fmt);
  const tmp = `${final}${NODE_REMUX_TMP_SUFFIX}`;
  // 目标已存在 = 上次崩溃留下的配对(交给启动接管)或外部同名文件;**绝不覆盖**。
  if (existsSync(final)) return fail("target-exists", `${basename(final)} 已存在,不覆盖`);

  const free = freeBytes(dirname(src));
  if (free != null && free < size + REMUX_DISK_HEADROOM_BYTES) {
    return fail("no-space", `磁盘余量 ${(free / 1024 ** 3).toFixed(1)}GB 不足(需约 ${((size + REMUX_DISK_HEADROOM_BYTES) / 1024 ** 3).toFixed(1)}GB),跳过转换`);
  }

  try { markSessionNodeFormat(dirname(src), sessionBaseOf(src), fmt); }
  catch (e) { return fail("mark-failed", `写会话标记失败: ${(e as Error).message}`); }

  try { await remux(src, tmp, fmt); }
  catch (e) { return fail("remux-failed", String((e as Error)?.message ?? e).slice(-300), tmp); }

  const bad = await verifyRemuxed(src, tmp, probe);
  if (bad) return fail("verify-failed", bad, tmp);

  try {
    fsync(tmp); // 先落盘再 rename:否则断电后新文件可能是空洞、而原文件已删 → 丢数据
    rename(tmp, final);
  } catch (e) { return fail("remux-failed", `落盘/改名失败: ${(e as Error).message}`, tmp); }

  // 新文件已是最终名且校验过 → 才删原文件。删失败不算失败(配对留给启动接管),但要留痕。
  try { rmSync(src); }
  catch (e) { log(`[remux] 新文件已就位但删除原文件失败(留待下次启动接管): ${name}: ${(e as Error).message}`); }
  log(`[remux] ${name} → ${basename(final)}`);
  return { ok: true, path: final };
}

/**
 * 一个任务的原地替换钩子工厂(manager 的 `makeRolling` 接缝)。**整个工厂共享一条串行队列**
 * (并发上限 1,跨会话也不并发):remux 是 CPU/IO 重活,多个分段同时转会拖垮同机录制。
 */
export function makeNodeRemuxHookFactory(o: { format: StageFormat } & NodeRemuxDeps): () => RollingUploadHook {
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  return () => {
    const indexByPath = new Map<string, number>();
    const handled = new Set<string>();
    let nextIndex = 0;

    const flush = (recordingActive: boolean): Promise<void> => {
      const segs: RollingSegment[] = [...indexByPath.entries()].map(([p, index]) => {
        let mtimeMs = 0;
        try { mtimeMs = statSync(p).mtimeMs; } catch { mtimeMs = 0; }
        return { path: p, index, mtimeMs };
      });
      // 封口判定唯一真理 = core.sealedSegmentIndices。收尾调用方契约是录制进程已退出(最后一段不再增长),
      // 所以 grace 恒 0 且 nowMs 取 Infinity:不让「mtime 与此刻同一毫秒(或亚毫秒领先)」把末段判成未封口 → 永不转换。
      const sealed = sealedSegmentIndices(segs, { recordingActive, nowMs: Infinity, sealGraceMs: 0 });
      const todo = segs.filter((s) => sealed.has(s.index) && !handled.has(s.path)).sort((a, b) => a.index - b.index);
      for (const s of todo) handled.add(s.path); // 入队即占位:同一段绝不并发/重复转
      return enqueue(async () => {
        for (const s of todo) {
          try { await convertSegmentInPlace(s.path, o.format, o); }
          catch (e) { o.log?.(`[remux] 转换抛错(忽略,保留原文件): ${(e as Error)?.message ?? e}`); }
        }
      });
    };

    return {
      onSegment: (p: string): void => {
        if (!indexByPath.has(p)) indexByPath.set(p, nextIndex++);
        void flush(true); // 新段出现 = 旧段已封口;fire-and-forget,不阻塞录制
      },
      onSessionEnd: (): Promise<void> => flush(false),
    };
  };
}

export interface RecoverSummary {
  /** 删除的陈旧孤儿临时文件。 */
  removedTmp: string[];
  /** 新鲜的临时文件(可能是别的任务正在写):保留、不碰。 */
  skippedFreshTmp: string[];
  /** 配对且新文件通过校验 → 删了原文件。 */
  removedOriginal: string[];
  /** 配对但新文件存疑(校验不通过 / 无法判定)→ 两份都保留,新文件改名隔离({@link NODE_REMUX_SUSPECT_SUFFIX})。 */
  keptBoth: string[];
}

const NATIVE_EXTS = [".ts", ".flv"];

/**
 * 崩溃接管:在会话开始前扫描录制目录(`dir` 本身 + 一层子目录)。
 *   ① 孤儿临时文件 `*.drec-remux`(转换在 rename 前被打断)→ **只删 mtime 早于 {@link STALE_TMP_MIN_AGE_MS} 的**
 *      (扫的是共享输出根,新鲜的可能是别的任务正在写,绝不碰)。临时文件只在校验通过后才 rename,
 *      所以它一定不是完成品,原文件此时必然还在;删除后发告警(「上次中断、该段保持原容器」)。
 *   ② 配对(转换已 rename 但未删原文件):`{stem}.ts|flv` 与 `{stem}{fmt}` 并存,且该会话 session.json 的
 *      `nodeFormat` 等于 `fmt`(本功能留的标记,避免误伤无关的同名文件)→ 用与正常路径**同一个** {@link verifyRemuxed}:
 *      通过才删原文件;**不通过或无法判定 → 两份都留**(新文件改名隔离防重复计入)并告警,绝不删任何一份。
 */
export async function recoverNodeRemux(dir: string, fmt: StageFormat, deps: NodeRemuxDeps = {}): Promise<RecoverSummary> {
  const log = deps.log ?? ((): void => {});
  const alert = deps.alert ?? ((): void => {});
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? defaultProbe;
  const out: RecoverSummary = { removedTmp: [], skippedFreshTmp: [], removedOriginal: [], keptBoth: [] };
  const dirs = [dir];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) dirs.push(join(dir, e.name));
  } catch { return out; }
  const ext = STAGE_CONTAINERS[fmt].ext;
  for (const d of dirs) {
    let names: string[];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(NODE_REMUX_TMP_SUFFIX)) continue;
      const p = join(d, n);
      let mtimeMs: number;
      try { mtimeMs = statSync(p).mtimeMs; } catch { continue; }
      if (now() - mtimeMs < STALE_TMP_MIN_AGE_MS) {
        out.skippedFreshTmp.push(p);
        log(`[remux] 接管:临时文件 ${n} 较新(可能其他任务正在转换),不碰`);
        continue;
      }
      rmQuiet(p);
      out.removedTmp.push(p);
      log(`[remux] 接管:删除陈旧孤儿临时文件 ${n}`);
      alert(`上次转 ${fmt} 被中断(进程被强杀/崩溃),已清理残留临时文件 ${n};该段保持原容器`);
    }
    for (const n of names) {
      if (!n.endsWith(ext)) continue;
      const stem = n.slice(0, -ext.length);
      const orig = NATIVE_EXTS.map((x) => `${stem}${x}`).find((x) => names.includes(x));
      if (!orig) continue;
      if (readNodeFormat(d, sessionBaseOf(n)) !== fmt) continue; // 无本功能标记 → 不是我们的配对,不碰
      const bad = await verifyRemuxed(join(d, orig), join(d, n), probe);
      if (bad) {
        // 存疑:两份都留。新文件改名隔离(防止与原文件在扫描/分组里重复计入);改名失败也不删。
        const suspect = `${join(d, n)}${NODE_REMUX_SUSPECT_SUFFIX}`;
        try { renameSync(join(d, n), suspect); } catch { /* 改名失败:原地保留 */ }
        out.keptBoth.push(join(d, n));
        log(`[remux] 接管:新文件 ${n} 未通过/无法完成校验(${bad}),两份都保留(新文件已隔离),不删任何一份`);
        alert(`上次转 ${fmt} 被中断,新文件 ${n} 校验未通过(${bad});该段保持原容器 ${orig},两份均已保留,请人工确认`);
      } else {
        rmQuiet(join(d, orig));
        out.removedOriginal.push(join(d, orig));
        log(`[remux] 接管:新文件 ${n} 已校验,删除原文件 ${orig}`);
        alert(`上次转 ${fmt} 被中断,已接管:新文件 ${n} 校验通过,已删除原文件 ${orig}`);
      }
    }
  }
  return out;
}

/**
 * **唯一判定点**(spawn 录制子进程之前调用):该任务是否做节点侧原地替换,以及替换成什么。
 *   - 不被 hub 管理(`managedBy !== "hub"`:worker 上的受管任务一律不适用),
 *   - 且没有任何 hub 规则绑定它(规则 `recording.sourceTaskId === 任务 id`,或房间键 `{platform}.{roomSlug}` 同名)
 *     —— 有规则的存档侧形态由后处理容器负责(PR 1);
 *   - 且没开边录边传(`rollingEffective`:rolling 上传后删源,与原地替换互斥)
 *   才返回任务所选格式;否则一律 `original`(= 子进程不带该参数,行为与改动前一致)。
 * 规则**之后才绑定**的任务:已在跑的进程不受影响,下一次 spawn 起按新判定(不再替换)。
 */
export function resolveNodeOutputFormat(
  task: Pick<Task, "id" | "room" | "managedBy" | "outputFormat" | "rollingEffective">,
  hubDir: string,
): OutputFormat {
  if (task.outputFormat === "original") return "original";
  return nodeOutputFormatLock(task, hubDir) ? "original" : task.outputFormat;
}

/**
 * 「不适用」原因(= 该任务的输出格式被锁、后端不会替换);适用则 undefined。**与 {@link resolveNodeOutputFormat}
 * 同源**(后者只是在它之上叠加用户所选格式),任务视图把它原样下发,前端据此锁定下拉并显示原因。
 *   hub-managed = worker 上的受管任务;hub-rule = 有规则绑定(源任务 id 或房间键同名,不论是否 hub 模式);
 *   rolling = 开了边录边传(上传后删源,互斥)。
 */
export type NodeOutputFormatLock = "hub-managed" | "hub-rule" | "rolling";
export function nodeOutputFormatLock(
  task: Pick<Task, "id" | "room" | "managedBy" | "rollingEffective">,
  hubDir: string,
): NodeOutputFormatLock | undefined {
  if (task.managedBy === "hub") return "hub-managed";
  if (task.rollingEffective) return "rolling";
  const platform = platformForRoom(task.room);
  const key = hubKey(platform.id, platform.extractRoomSlug(task.room));
  for (const r of listHubRules(hubDir)) {
    if (r.recording?.sourceTaskId === task.id || r.key === key) return "hub-rule";
  }
  return undefined;
}
