/**
 * mesio 下载引擎 — mesio(rust-srec 的 mesio-cli)落盘 .flv(+ 分段)。
 *
 * 提炼自原 douyin-live-mesio-recorder / bilibili-live-mesio-recorder(两者除来路 header 外一致;
 * header 现经 EngineSpawnArgs.headers → `-H 'K: V'` 透传,故合并为一个引擎)。mesio 自带 FLV/HLS
 * 一致性修复(--fix)+ 按时长分段(-d)。产物 .flv 分段 {nameBase}_%i.flv(对齐 concat 会话分组)。
 *
 * 进度上报:mesio 无 ffmpeg 的 `time=` 进度,改用「**本会话**每个分段是否增长」喂 markProgress;
 * 同时按目录扫描把滚出的 `_NNN.flv`(段号>=1)通过 onSegment 交给录制器(#566)。
 * 只认 `{nameBase}_NNN.flv`:同目录另一个任务/会话的写入不能给它续命(issue #474)。
 */
import { join } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { DownloadEngine, EngineSpawnArgs, EngineSpawnResult } from "@drec/core";

/**
 * mesio 二进制定位(按优先级):
 *   1. `MESIO_PATH` 环境变量(docker 用,见 Dockerfile `ENV MESIO_PATH=/app/bin/mesio`);
 *   2. 仓库约定路径 `<cwd>/bin/mesio`(本地从仓库根起 serve 时直接命中,install-mesio.sh 装到这);
 *   3. 回落裸 `mesio`(交给 PATH)。
 * 之前只有 1+3:本地起 serve 没设 MESIO_PATH 且 PATH 无 ./bin → `spawn mesio ENOENT` 死循环重连。
 */
export function resolveMesioBin(): string {
  if (process.env.MESIO_PATH) return process.env.MESIO_PATH;
  const repoBin = join(process.cwd(), "bin", "mesio");
  if (existsSync(repoBin)) return repoBin;
  return "mesio";
}
const MESIO = resolveMesioBin();

/** 输出文件增长看门狗检查间隔(对齐原录制器的 STALL_CHECK_MS=15s)。 */
export const FILE_WATCH_MS = 15_000;

/** 本会话的一个已落盘分段(`{nameBase}_NNN.flv`)。 */
export interface OwnMesioSegment {
  name: string;
  path: string;
  index: number;
  size: number;
}

/**
 * 本会话的分段清单:目录里所有 `{nameBase}_NNN.flv`(N 为段号),按名字排序。
 *
 * 与 {@link ownSegmentBytes} 的区别:这里**必须**带段号后缀 —— 它是「新段出现」的信号源,
 * 所以不能把别的形状的 `.flv` 当成分段。目录还不可读(mesio 尚未创建)时返回 null。
 */
export function listOwnSegments(dir: string, nameBase: string): OwnMesioSegment[] | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  const prefix = nameBase ? `${nameBase}_` : undefined;
  const out: OwnMesioSegment[] = [];
  for (const name of names) {
    const m = /_(\d+)\.flv$/i.exec(name);
    if (!m) continue;
    // The digits must be the WHOLE tail after the base: `{base}_extra_001.flv` is another session's file.
    if (prefix !== undefined && name !== `${prefix}${m[1]}.flv`) continue;
    let size = 0;
    try { size = statSync(join(dir, name)).size; } catch { continue; /* just deleted, or still being created */ }
    out.push({ name, path: join(dir, name), index: Number(m[1]), size });
  }
  out.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));
  return out;
}

/**
 * Bytes of the `.flv` segments **this** mesio writes: mesio names them `{nameBase}_NNN.flv`
 * (`-n {nameBase}_%i`, split into several files), so match the whole prefix, not one exact name.
 *
 * Returns `null` when the output directory cannot be read (not created yet): the caller keeps its
 * previous reading rather than treating that as progress.
 */
export function ownSegmentBytes(dir: string, nameBase: string): number | null {
  const prefix = nameBase ? `${nameBase}_` : undefined;
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  let total = 0;
  for (const f of names) {
    if (!/\.flv$/i.test(f)) continue;
    // TODO(?): a caller that spawns mesio with an empty nameBase cannot be told apart from its
    // neighbours, so fall back to counting every *.flv (the pre-#474 behaviour) instead of never
    // reporting progress. Every current caller passes a nameBase.
    if (prefix !== undefined && !f.startsWith(prefix)) continue;
    try { total += statSync(join(dir, f)).size; } catch { /* file being written or just deleted */ }
  }
  return total;
}

/** {@link startMesioProgressWatch} 的句柄:定时器 + 进程退出前的最后一次扫描。 */
export interface MesioProgressWatch {
  timer: NodeJS.Timeout;
  /** Clear the interval and scan once more (call it on process exit). */
  finish(): void;
}

/**
 * File-growth watchdog + per-segment reporting: every {@link FILE_WATCH_MS} scan OUR segments and
 *   - refresh progress when any of them grew (per-file deltas, so a **deleted** sealed segment never
 *     masks growth in the next one — #566: the old `lastTotalBytes` baseline only moved up);
 *   - report a newly appeared segment (index >= 1) through `onSegment` (#566: mesio rolls its own
 *     files and used to report only the first one, so rolling upload / in-place remux ignored every
 *     later segment). Index 0 stays with the recorder's spawn-time `sessionFirstPath` report; firing it
 *     twice would re-open a `-danmu-xml-mode segment` writer for the same file and re-anchor its timeline.
 *
 * The scan relies on mesio creating the next file only after the previous one stops growing (verified
 * on mesio 0.4.1), so "new file appeared" == "previous segment is sealed" for the callers that treat
 * onSegment that way. Both hooks are isolated: a throwing callback must never take down the recorder.
 */
export function startMesioProgressWatch(
  dir: string,
  nameBase: string,
  markProgress: () => void,
  onSegment?: (path: string) => void,
  /** Called when onSegment throws; the recorder keeps running (recording wins over XML/bookkeeping). */
  onHookError?: (err: unknown) => void,
): MesioProgressWatch {
  /** Size per file at the previous scan. A deleted file simply drops out; it is never a negative. */
  const sizes = new Map<string, number>();
  /** Segment paths already reported, so the periodic tick and {@link MesioProgressWatch.finish} never duplicate. */
  const reported = new Set<string>();
  const scan = (): void => {
    const segs = listOwnSegments(dir, nameBase);
    if (segs === null) return; // directory not created yet (or a transient read failure)
    let grew = false;
    for (const s of segs) {
      const prev = sizes.get(s.name);
      if (prev !== undefined && s.size > prev) grew = true;
      if (prev === undefined && s.size > 0) grew = true; // a fresh segment with data is progress too
      sizes.set(s.name, s.size);
      // An empty base cannot be told apart from our neighbours (see {@link ownSegmentBytes}); counting
      // their bytes for progress is the documented fallback, but never REPORT them as our segments.
      if (nameBase && s.index >= 1 && !reported.has(s.path)) {
        reported.add(s.path);
        try { onSegment?.(s.path); } catch (e) {
          // Never let a hook kill the recording; still make the failure visible in the recorder's stderr tail.
          try { onHookError?.(e); } catch { /* the reporter itself must not throw */ }
        }
      }
    }
    const present = new Set(segs.map((s) => s.name));
    for (const name of [...sizes.keys()]) if (!present.has(name)) sizes.delete(name);
    if (grew) markProgress();
  };
  const timer = setInterval(scan, FILE_WATCH_MS);
  timer.unref?.();
  return {
    timer,
    finish: () => {
      clearInterval(timer);
      // One last scan: a stop that lands within one watch interval after a rollover must still
      // report (and thereby seal) the final segment before the session-end flush runs.
      scan();
    },
  };
}

/** 构造 mesio argv(纯函数,便于单测)。 */
export function buildMesioArgs(a: Pick<EngineSpawnArgs, "url" | "headers" | "dir" | "nameBase" | "segSec">): string[] {
  // mesio -n 模板:%i=段号(3 位补零)。对齐 ffmpeg 版命名 {nameBase}_{NNN}.flv,
  // 使 concat.ts 的会话分组正则能识别(只是容器是 .flv 非 .ts)。
  const nameTpl = `${a.nameBase}_%i`;
  const headerArgs = a.headers ? Object.entries(a.headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]) : [];
  const args = [a.url, "-o", a.dir, "-n", nameTpl, "--fix", "--disable-log-file", ...headerArgs];
  if (a.segSec > 0) args.push("-d", `${a.segSec}s`);
  return args;
}

/**
 * mesio 可运行性自检:跑 `--version`,2 秒超时。
 *
 * 为什么不能只看「文件存在 + 可执行」:实测 VPS 上的 mesio 需要 GLIBC 2.38/2.39,
 * 而 Ubuntu 22.04 只有 2.35 → 二进制存在、权限也对,但**一执行就报 GLIBC 缺失并退出**。
 * 只看文件属性会放它过去,然后录制反复失败(短命录制 → 退避到 300s),用户很久才发现
 * 「看起来在录、实际没落盘」。所以这里**真的执行一次**。
 *
 * 只判「能否启动」,不判版本是否符合预期 —— 版本是 install 脚本的职责(单一真理源),
 * 这里只回答「这台机器上跑不跑得起来」。
 */
export function probeMesio(): string | null {
  const bin = resolveMesioBin();
  try {
    const r = spawnSync(bin, ["--version"], { timeout: 2000, encoding: "utf-8" });
    if (r.error) {
      const e = r.error as NodeJS.ErrnoException;
      return e.code === "ENOENT" ? `mesio 不存在: ${bin}` : `mesio 无法启动(${e.code ?? "error"}): ${e.message}`;
    }
    if (r.status !== 0) {
      // 最常见的失败:GLIBC 版本不足。把 stderr 首行带出来,别让用户去猜。
      const why = String(r.stderr ?? "").trim().split("\n")[0] || `退出码 ${r.status}`;
      return `mesio 启动失败: ${why}`;
    }
    return null;
  } catch (e) {
    return `mesio 自检异常: ${(e as Error)?.message ?? e}`;
  }
}

export const mesioEngine: DownloadEngine = {
  id: "mesio",
  probe: probeMesio,
  spawn(a: EngineSpawnArgs): EngineSpawnResult {
    const args = buildMesioArgs(a);
    const proc = spawn(MESIO, args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr?.on("data", (d: Buffer) => {
      const s = String(d).trim();
      if (s) a.pushStderr(s);
    });

    // File-growth watchdog + per-segment reporting: only the segments this mesio writes count (#474),
    // and every rolled segment reaches the recorder's hooks (#566).
    const fileWatch = startMesioProgressWatch(
      a.dir,
      a.nameBase,
      () => a.markProgress(),
      (p) => a.onSegment(p),
      (e) => a.pushStderr(`[mesio] onSegment 钩子抛错(已忽略,录制继续): ${(e as Error)?.message ?? e}`),
    );

    return {
      proc,
      sessionFirstPath: join(a.dir, `${a.nameBase}_000.flv`),
      cleanup: () => fileWatch.finish(),
    };
  },
};
