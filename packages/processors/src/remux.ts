/**
 * processors/remux.ts — remux 处理器(plans/036 T6):节点侧「原地替换容器」的校验 / 转换 / 命名 / 阈值 / 边车标记,
 * 与 `remuxProcessor`(core Processor 契约的一个实现)。
 *
 * 由 `app/node-remux.ts`(issue #137)**逐字搬入**:`verifyRemuxed` / `convertSegmentInPlace` / 临时名命名 / 阈值常量 /
 * 边车容器标记 —— 语义与命名一律不改(临时名 `{final}.{owner}-{pid}.drec-remux` 保证旧 bundle 回滚时照常接管)。
 *
 * 硬边界:
 *   - 只碰 job 显式列出的 inputs / 由它推出的目标与临时路径;**不扫目录、不分组、不推导会话**(目录级崩溃接管
 *     `recoverNodeRemux` 留在 app 的 node-remux 里,只兜底「不在表里」的旧 tmp)。
 *   - 先写临时文件 → 校验({@link verifyRemuxed},唯一校验函数)→ fsync + 原子 rename → **最后**才删原文件;
 *     任一步失败:删临时文件、保留原文件。永不删到最后一份。
 *   - 不可逆动作(rename / 删原文件)前调 `assertLease`(失租即放弃,原文件不动)。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, statfsSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { FFPROBE_HEADER_TIMEOUT_MS, FFPROBE_SCAN_TIMEOUT_MS } from "@drec/post-process";
import {
  freeBytesOf,
  sessionBaseOf,
  STAGE_CONTAINERS,
  type ProcessContext,
  type ProcessJob,
  type ProcessResult,
  type Processor,
  type StageFormat,
} from "@drec/core";

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
 * 单个文件探测的整体上界 = 两次 ffprobe(头 + 全包扫描)各自最坏(头超时 + 扫描超时,且时长兜底再扫一次)的和。
 * ffprobe 自身已有超时并杀进程(post-process `runFfprobe`);这里再包一层是兜底:注入的 probe / 任何未来的探测
 * 都不能让校验无限等。超时 = 无法判定 = 校验失败 = 两份都保留。
 */
export const PROBE_BOUND_MS = 2 * (FFPROBE_SCAN_TIMEOUT_MS + FFPROBE_HEADER_TIMEOUT_MS);

/** 存疑的新文件(接管时校验不通过 / 无法判定)改成此后缀隔离:两份都保留,但新文件不再被扫描/分组当成分段(避免与原文件重复计入)。 */
export const NODE_REMUX_SUSPECT_SUFFIX = ".drec-suspect";

export interface MediaProbe {
  durationSec: number;
  hasVideo: boolean;
  /** 全部视频包 pts 的 max−min(秒)。 */
  spanSec: number;
  /** 视频包数;0 = 无法判定(ffprobe 失败 / 无包)。 */
  packets: number;
  /** 视频流里一个 GOP 的包数上界(缺省 = 未知,只用比例容差)。 */
  gopPackets?: number;
  /** 是否有音频流(缺省 = 无)。 */
  hasAudio?: boolean;
  audioPackets?: number;
  /** 全包扫描的 ffprobe 告警行数(缺省 = 0)。 */
  scanErrors?: number;
}

export interface NodeRemuxDeps {
  /** `-c copy` 转封装 src → tmp(tmp 扩展名不是容器扩展名,实现需显式指定封装器)。失败 reject。 */
  remux?: (src: string, tmp: string, fmt: StageFormat, signal?: AbortSignal) => Promise<void>;
  /** ffprobe 接缝。失败 reject。 */
  probe?: (path: string) => Promise<MediaProbe>;
  /** 目录所在卷剩余字节;null = 查不到 → 放行。 */
  freeBytes?: (dir: string) => number | null;
  /** 测试接缝:落盘 / 改名。默认 fsync + renameSync。 */
  fsync?: (path: string) => void;
  rename?: (from: string, to: string) => void;
  /** 当前时间(ms),判定临时文件新旧用;默认 Date.now。 */
  now?: () => number;
  /** 任务归属标识(临时文件名带它 + pid;接管只立即清「本任务 + 进程已不存在」的残留)。默认空 = 无归属。 */
  owner?: string;
  /** 本进程 pid(默认 process.pid);pid 存活判定(默认 kill -0)。测试接缝。 */
  pid?: number;
  pidAlive?: (pid: number) => boolean;
  /** 单文件探测上界(默认 {@link PROBE_BOUND_MS});测试接缝。 */
  probeBoundMs?: number;
  /** 外部要求放弃(会话收尾总时限 / 接管总时限到了):在开始前与 remux 后检查,放弃则保留原文件。 */
  shouldAbort?: () => boolean;
  /** 取消 / 关停信号:透传给默认 remux(杀 ffmpeg,不留孤儿进程);abort 后走失败路径(删临时文件、保留原文件)。 */
  signal?: AbortSignal;
  /** 租约断言:不可逆动作(rename / 删原文件)前调用,失租抛错 → 放弃(原文件不动)。runner 经 `ctx.assertLease` 注入。 */
  assertLease?: () => void;
  /** 告警(→ 现有通道:通知 error 事件 → webhook + @@DREC_ALERT@@ + 站内 toast)。 */
  alert?: (message: string) => void;
  log?: (msg: string) => void;
}

/** 默认接缝:动态 import post-process(与 segment-pipeline 同做法,避免 app 顶层硬依赖 ffmpeg 包初始化)。 */
async function defaultRemux(src: string, tmp: string, fmt: StageFormat, signal?: AbortSignal): Promise<void> {
  const { remuxSegment } = await import("@drec/post-process");
  // atomic:false —— 本模块自己就是两阶段落盘(`{最终名}.{owner}-{pid}.drec-remux` → 校验 → fsync + rename),
  // 且那个中间名是崩溃接管扫描(recoverNodeRemux / parseRemuxTmpName)的识别依据;
  // 再套一层 `.part` 会让临时名匹配不上、接管逻辑认不出自己的残留。
  await remuxSegment(src, tmp, fmt, { atomic: false, signal });
}
export async function defaultProbe(p: string): Promise<MediaProbe> {
  const { ffprobeVideo, ffprobePacketStats } = await import("@drec/post-process");
  const v = await ffprobeVideo(p);
  const st = await ffprobePacketStats(p);
  if (!st) throw new Error("全包扫描无法判定(ffprobe 失败 / 超时 / 无视频包)");
  return {
    durationSec: v.durationMs / 1000, hasVideo: v.hasVideo, spanSec: st.spanSec, packets: st.videoPackets,
    gopPackets: st.gopPackets, hasAudio: st.hasAudio, audioPackets: st.audioPackets, scanErrors: st.errorLines,
  };
}

/** 目录(或其最近的已存在祖先)所在卷的剩余字节,取值口径 = core `freeBytesOf`;查不到 → null(放行,磁盘看门狗告警兜底)。 */
export function volumeFreeBytes(dir: string): number | null {
  try {
    let p = dir;
    while (!existsSync(p)) {
      const up = dirname(p);
      if (up === p) break;
      p = up;
    }
    return freeBytesOf(statfsSync(p));
  } catch {
    return null;
  }
}

/** 给探测加硬上界:超时 reject(= 无法判定)。定时器及时清掉,不拖住进程退出。 */
async function probeBounded(probe: NonNullable<NodeRemuxDeps["probe"]>, path: string, ms: number): Promise<MediaProbe> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`探测超时(>${Math.round(ms / 1000)}s)`)), ms); timer.unref?.(); });
  try { return await Promise.race([probe(path), limit]); } finally { if (timer) clearTimeout(timer); }
}

export const ownerKey = (o?: string): string => (o ?? "").replace(/[^A-Za-z0-9_]/g, "");

/** 临时文件路径:`{final}.{owner}-{pid}.drec-remux`(归属标记 = 任务标识 + 进程号;非视频扩展名,扫描不会当分段)。 */
export function remuxTmpPath(final: string, owner: string | undefined, pid: number): string {
  return `${final}.${ownerKey(owner)}-${pid}${NODE_REMUX_TMP_SUFFIX}`;
}

/** 解析临时文件名里的归属标记;老格式 / 无标记 → undefined。 */
export function parseRemuxTmpName(name: string): { owner: string; pid: number } | undefined {
  const m = /\.([A-Za-z0-9_]*)-(\d+)\.drec-remux$/.exec(name);
  return m ? { owner: m[1] ?? "", pid: Number(m[2]) } : undefined;
}

export function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // ESRCH = 已不存在;EPERM = 存在但无权
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

export function readNodeFormat(dir: string, base: string): string | undefined {
  try {
    const d = JSON.parse(readFileSync(sessionJsonOf(dir, base), "utf-8")) as { nodeFormat?: unknown };
    return typeof d.nodeFormat === "string" ? d.nodeFormat : undefined;
  } catch { return undefined; }
}

function fsyncFile(p: string): void {
  const fd = openSync(p, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function rmQuiet(p: string): void {
  try { rmSync(p, { force: true }); } catch { /* 删不掉由调用方日志说明 */ }
}

export type RemuxOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: "missing" | "target-exists" | "no-space" | "mark-failed" | "remux-failed" | "verify-failed" | "aborted"; detail?: string };

/**
 * 包数容差 = min(一个 GOP 的包数, 总包数 × 0.5%),至少 1。依据:`-c copy` 合法的丢包只有「首个关键帧之前的非关键帧」
 * (≤ 一个 GOP),但真实中段丢失量级是百分之几十;两者取**更严**的那个(误拒只会多留一份原文件,安全方向;
 * 漏判才丢数据)。GOP 未知(音频 / 老探测)只用 0.5%。
 */
export function packetAllowance(total: number, gop?: number): number {
  const byRatio = Math.ceil(total * 0.005);
  const a = gop && gop > 0 ? Math.min(gop, byRatio) : byRatio;
  return Math.max(1, a);
}

/**
 * 校验新文件(**唯一校验函数**,正常转换与崩溃接管共用)。返回失败原因(通过 = undefined);
 * 任何「无法判定」(探测失败 / 无视频包 / 原文件时长未知)都按失败处理 —— 宁可保留原文件。
 *   ① 两边都能 ffprobe、新文件有视频流且有视频包;
 *   ② 头部时长在容差内(挡 remux 提前退出);
 *   ③ **视频包 pts 跨度在容差内**(扫包取真实末帧;挡「头部完好、尾部被截断」——mkv / faststart mp4 的头部时长不会变);
 *   ④ **视频包数** ≥ 原文件 − {@link packetAllowance}(挡「中段被抹零、跨度/头部/体积都正常」的丢包);
 *   ⑤ **音频**:原文件有音频流 → 新文件必须有音频流,且音频包数 ≥ 原 − 容差(挡整条音轨丢失 / 中段丢音频);
 *   ⑥ 全包扫描的 ffprobe 告警行数不多于原文件(挡索引完好但数据被补零的 mp4);
 *   ⑦ 新文件大小 ≥ 原文件 × {@link MIN_SIZE_RATIO}(挡跨度与包数都巧合通过的大块丢流)。
 * 探测整体有硬上界({@link PROBE_BOUND_MS}),超时同样按无法判定处理。
 */
export async function verifyRemuxed(
  src: string, out: string, probe: NonNullable<NodeRemuxDeps["probe"]>, boundMs: number = PROBE_BOUND_MS,
): Promise<string | undefined> {
  let s: MediaProbe, o: MediaProbe;
  try { s = await probeBounded(probe, src, boundMs); } catch (e) { return `原文件无法探测: ${(e as Error).message}`; }
  try { o = await probeBounded(probe, out, boundMs); } catch (e) { return `新文件无法探测: ${(e as Error).message}`; }
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
  const vAllow = packetAllowance(s.packets, s.gopPackets);
  if (o.packets < s.packets - vAllow) {
    return `视频包数不足(疑似中段丢失): 原 ${s.packets} → 新 ${o.packets}(容差 ${vAllow})`;
  }
  // 内容损坏(如中段被补零:索引完好、包数/跨度都对,但每个坏包 ffprobe 都报一行):新文件的解析告警不得多于原文件。
  if ((o.scanErrors ?? 0) > (s.scanErrors ?? 0)) {
    return `新文件解析告警多于原文件(疑似内容损坏): 原 ${s.scanErrors ?? 0} 行 → 新 ${o.scanErrors} 行`;
  }
  if (s.hasAudio) {
    if (!o.hasAudio) return "新文件缺少音频流(原文件有音频)";
    const sa = s.audioPackets ?? 0;
    const aAllow = packetAllowance(sa);
    if ((o.audioPackets ?? 0) < sa - aAllow) {
      return `音频包数不足(疑似丢音频): 原 ${sa} → 新 ${o.audioPackets ?? 0}(容差 ${aAllow})`;
    }
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
  let srcTimes: { atime: Date; mtime: Date };
  try { const st = statSync(src); size = st.size; srcTimes = { atime: st.atime, mtime: st.mtime }; } catch { return { ok: false, reason: "missing" }; } // 已被别处处理/删除:无事可做
  const final = remuxTargetPath(src, fmt);
  const tmp = remuxTmpPath(final, deps.owner, deps.pid ?? process.pid);
  // 目标已存在 = 上次崩溃留下的配对(交给启动接管)或外部同名文件;**绝不覆盖**。
  if (existsSync(final)) return fail("target-exists", `${basename(final)} 已存在,不覆盖`);

  const free = freeBytes(dirname(src));
  if (free != null && free < size + REMUX_DISK_HEADROOM_BYTES) {
    return fail("no-space", `磁盘余量 ${(free / 1024 ** 3).toFixed(1)}GB 不足(需约 ${((size + REMUX_DISK_HEADROOM_BYTES) / 1024 ** 3).toFixed(1)}GB),跳过转换`);
  }

  if (deps.shouldAbort?.()) return fail("aborted", "已超过总时限,放弃本次转换");

  try { markSessionNodeFormat(dirname(src), sessionBaseOf(src), fmt); }
  catch (e) { return fail("mark-failed", `写会话标记失败: ${(e as Error).message}`); }

  try { await remux(src, tmp, fmt, deps.signal); }
  catch (e) { return fail("remux-failed", String((e as Error)?.message ?? e).slice(-300), tmp); }

  if (deps.shouldAbort?.()) return fail("aborted", "已超过总时限,放弃本次转换(临时文件已清理)", tmp);
  const bad = await verifyRemuxed(src, tmp, probe, deps.probeBoundMs);
  if (bad) return fail("verify-failed", bad, tmp);

  try {
    deps.assertLease?.(); // 不可逆动作前:失租即放弃(tmp 清理、原文件不动)
    // 继承原文件 atime/mtime:清单适配器用 mtime 当分段结束时间,转换时刻会让对账把已完成的同一场聚成新簇(重复管线 + 重复上传)。
    // 封口转换 / 收尾转换 / 回落链 / recover 重跑都经本函数,故这是唯一一处。写失败按失败处理(保留原文件),不留「mtime 错位」的静默状态。
    utimesSync(tmp, srcTimes.atime, srcTimes.mtime);
    fsync(tmp); // 先落盘再 rename:否则断电后新文件可能是空洞、而原文件已删 → 丢数据
    rename(tmp, final);
  } catch (e) { return fail("remux-failed", `落盘/改名失败: ${(e as Error).message}`, tmp); }

  // 新文件已是最终名且校验过 → 才删原文件。删失败不算失败(配对留给启动接管),但要留痕。
  try { deps.assertLease?.(); }
  catch (e) {
    // 失租:新文件已校验并就位,但删原文件已不归我们 —— 留给新持有者的 recover(目标存在且校验通过 → done 并删原文件)。
    return fail("aborted", `租约已丢,新文件已就位、原文件留待接管处理: ${(e as Error).message}`);
  }
  try { rmSync(src); }
  catch (e) { log(`[remux] 新文件已就位但删除原文件失败(留待下次启动接管): ${name}: ${(e as Error).message}`); }
  log(`[remux] ${name} → ${basename(final)}`);
  return { ok: true, path: final };
}


// ───────────────────────── remuxProcessor(core Processor 契约) ─────────────────────────

/** 本处理器认的源容器(录制原生容器);与 `recoverNodeRemux` 的 NATIVE_EXTS 同口径。 */
const NATIVE_SOURCE_EXTS = [".ts", ".flv"];

/** runner 的 owner 约定 `serve:<pid>:<ts>` / `record:<pid>:<ts>`:取出写临时文件的进程号(tmp 名 = `{final}.{owner}-{pid}.drec-remux`)。 */
function pidOfRunnerOwner(claimedBy: string | null | undefined): number | undefined {
  const m = /^(?:serve|record):(\d+):/.exec(claimedBy ?? "");
  return m ? Number(m[1]) : undefined;
}

function formatOf(job: ProcessJob): StageFormat | undefined {
  const f = job.params.format;
  return typeof f === "string" && Object.prototype.hasOwnProperty.call(STAGE_CONTAINERS, f) ? (f as StageFormat) : undefined;
}

/**
 * 构造 remux 处理器。`deps` 只给测试注入接缝(remux / probe / freeBytes / fsync / rename …);生产用默认。
 *
 * - `inputs = [src]`(录制原生容器 .ts/.flv),`params.format` ∈ mp4|mkv,`params.owner` = 临时文件归属标识,`replaceInputs = true`。
 * - run:{@link convertSegmentInPlace}(校验通过才删原文件)。失败一律抛错(runner 落 failed + 告警一次;原文件保留)。
 * - recover(只碰 job 列出的 src / 由它推出的目标与临时路径,**不扫目录**):
 *     只有 tmp(无目标)→ 删 tmp → `rerun`;目标存在且 {@link verifyRemuxed} 通过 → 删原文件 → `done`;
 *     目标存在但存疑 → 目标改名 `.drec-suspect` 隔离 → `uncertain`(两份都留,绝不删最后一份)。
 */
export function makeRemuxProcessor(deps: NodeRemuxDeps = {}): Processor {
  return {
    kind: "remux",
    resource: "cpu",
    lane: "copy",
    retryable: true,
    interruptible: true,
    validate(job: ProcessJob): string | null {
      if (job.inputs.length !== 1) return `remux 只接受 1 个输入,收到 ${job.inputs.length}`;
      if (!NATIVE_SOURCE_EXTS.includes(extname(job.inputs[0]).toLowerCase())) return `remux 源须是录制原生容器(.ts/.flv): ${basename(job.inputs[0])}`;
      if (!formatOf(job)) return `params.format 须为 ${Object.keys(STAGE_CONTAINERS).join("|")}`;
      if (!job.replaceInputs) return "remux 是原地替换,replaceInputs 须为 true";
      return null;
    },
    estimateDiskBytes(job: ProcessJob): number {
      try { return statSync(job.inputs[0]).size; } catch { return 0; }
    },
    async run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult> {
      const src = job.inputs[0];
      const fmt = formatOf(job)!; // validate 已保证
      let lastAlert: string | undefined;
      const out = await convertSegmentInPlace(src, fmt, {
        ...deps,
        owner: typeof job.params.owner === "string" ? job.params.owner : undefined,
        log: (m) => ctx.log(m),
        // 失败文案由 runner 以「任务失败」统一告警一次(这里只截获,避免双告警)。
        alert: (m) => { lastAlert = m; },
        signal: ctx.signal,
        assertLease: () => ctx.assertLease(),
        shouldAbort: () => ctx.signal.aborted,
      });
      if (out.ok) return { outputs: [out.path], note: `${basename(src)} → ${basename(out.path)}` };
      if (out.reason === "missing") {
        const final = remuxTargetPath(src, fmt);
        // 上次已转完并删了原文件(行未及落 done):目标在 = 事实上已完成。
        if (existsSync(final)) return { outputs: [final], note: "原文件已不在,目标已存在" };
        throw new Error(`原文件不存在: ${basename(src)}`);
      }
      throw new Error(lastAlert ?? `${out.reason}${out.detail ? `: ${out.detail}` : ""}`);
    },
    async recover(job: ProcessJob, ctx: ProcessContext): Promise<"rerun" | "done" | "uncertain"> {
      const src = job.inputs[0];
      const fmt = formatOf(job);
      if (!fmt) return "uncertain";
      const final = remuxTargetPath(src, fmt);
      // 上一持有者留下的临时文件(pid 取自 claimedBy 约定);取不到 pid → 不碰(留给 recoverNodeRemux 兜底按「陈旧」清理)。
      const deadPid = pidOfRunnerOwner((job as { claimedBy?: string | null }).claimedBy);
      const owner = typeof job.params.owner === "string" ? job.params.owner : undefined;
      const tmp = deadPid !== undefined ? remuxTmpPath(final, owner, deadPid) : undefined;
      const srcExists = existsSync(src);
      const finalExists = existsSync(final);
      if (!finalExists) {
        if (!srcExists) return "uncertain"; // 两份都不在:无法判定
        if (tmp) rmQuiet(tmp); // 只有 tmp(rename 之前被打断)→ 删 tmp → 重跑
        return "rerun";
      }
      if (!srcExists) return "done"; // 目标在、原文件已删 = 上次已完成(目标是最后一份,绝不动)
      // 目标与原文件并存(rename 之后、删原文件之前被打断):凭本功能的边车标记确认是我们的配对,再走同一个校验。
      if (readNodeFormat(dirname(src), sessionBaseOf(src)) !== fmt) return "uncertain"; // 无标记:不碰(可能是同名外部文件)
      const bad = await verifyRemuxed(src, final, deps.probe ?? defaultProbe, deps.probeBoundMs);
      if (!existsSync(src)) return "done"; // 校验期间原文件被别处转换完删掉:目标是唯一一份,不隔离
      if (bad) {
        ctx.log(`recover: 新文件 ${basename(final)} 未通过校验(${bad}),两份保留、新文件隔离`);
        try { renameSync(final, `${final}${NODE_REMUX_SUSPECT_SUFFIX}`); } catch { /* 改名失败也不删 */ }
        if (tmp) rmQuiet(tmp);
        return "uncertain";
      }
      ctx.assertLease(); // 不可逆:删原文件前确认仍持租约
      if (tmp) rmQuiet(tmp);
      rmQuiet(src);
      ctx.log(`recover: 新文件 ${basename(final)} 已校验,删除原文件 ${basename(src)}`);
      return "done";
    },
  };
}

/** 默认实例(生产):`providers-register.ts` 一行 `registerProcessor(remuxProcessor)`。 */
export const remuxProcessor: Processor = makeRemuxProcessor();
