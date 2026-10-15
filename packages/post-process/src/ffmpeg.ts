// ts/src/core/post/ffmpeg.ts
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface Progress {
  pct: number;
  outTimeMs: number;
  outSize: number;
  speed: number;
  bitrateKbps: number;
  totalMs: number;
}

/**
 * 移植 merger.py burn 进度块解析（L763-792）：
 * - out_time_ms 是微秒，除以 1000 转为毫秒
 * - pct = min(99, floor(outTimeMs/totalMs*100))，outTimeMs<=0 时为 0
 * - speed 剥 "x" 后缀；bitrate 剥 "kbits/s" 后缀
 */
export function parseProgressBlock(
  block: Record<string, string>,
  totalMs: number,
): Progress {
  const outTimeMs = Math.floor(Number(block.out_time_ms ?? "0") / 1000);
  const outSize = Number(block.total_size ?? "0") || 0;
  const speed =
    parseFloat((block.speed ?? "0x").replace(/x$/, "")) || 0;
  const bitrateKbps =
    parseFloat(
      (block.bitrate ?? "0").replace("kbits/s", "").trim(),
    ) || 0;
  const pct =
    outTimeMs > 0 && totalMs > 0
      ? Math.min(99, Math.floor((outTimeMs / totalMs) * 100))
      : 0;
  return { pct, outTimeMs, outSize, speed, bitrateKbps, totalMs };
}

/**
 * 进程 CPU 时间探针(纯函数工厂,便于单测)。
 *
 * 返回的函数每次读一次 `/proc/<pid>/stat` 的 `utime+stime`(时钟 tick);与上次**不同** → true(= 在烧 CPU,视为存活)。
 * 读不到(pid 已退、非 Linux、权限)→ false(绝不把「读不到」当存活,免得掩盖真卡死)。
 * **平台边界**:依赖 `/proc`,仅 Linux 有效(三个节点与 master 容器都是 Linux)。非 Linux 上退化为
 * 原来的「只看 stdout/stderr」语义 —— 不引入新风险,只是那里享受不到这条修复。
 *
 * 为什么用 CPU 时间而不是「输出文件在长」:实测 `-movflags +faststart` 的收尾一遍**会长时间不写输出**,
 * 且静默随体积增长(88MB→2s、887MB→35s、3.1GB→117s),拿它当存活信号会在最大场次上照样误杀;
 * 而同一窗口内 **CPU 时间从不静默**(实测最大静默 0s)—— 挪 moov 一直在烧 CPU,是可靠判活依据。
 */
export function makeCpuProbe(pid: number, readProc: (p: number) => string | null = defaultReadProcStat): () => boolean {
  let last = -1;
  return () => {
    const raw = readProc(pid);
    if (raw == null) return false;
    // /proc/<pid>/stat: comm 可能含空格/括号 → 取最后一个 ')' 之后再切字段。
    const tail = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    // 字段 14/15(1-based)在 tail 里是 11/12(comm+state 之后)。
    const ticks = Number(tail[11]) + Number(tail[12]);
    if (!Number.isFinite(ticks)) return false;
    if (ticks === last) return false;
    last = ticks;
    return true;
  };
}

function defaultReadProcStat(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return null;
  }
}

/**
 * spawn ffmpeg；解析 -progress pipe:1 stdout；
 * rc≠0 时 reject，带 stderr 尾部（最后 ~600 字符）。
 */
export function runFfmpeg(
  args: string[],
  opts: {
    cwd?: string;
    totalMs?: number;
    onProgress?: (p: Progress) => void;
    /**
     * 卡死阈值:**既无 stdout/stderr 输出、又无 CPU 时间前进**持续超过此毫秒数 → 杀 ffmpeg + reject。
     * 默认 120s,0=禁用。(2026-10-15 起语义含 CPU 存活信号,见 {@link makeCpuProbe};
     * 此前只看 stdout/stderr,会把 `+faststart` 收尾的长时间静默误判成卡死。)
     */
    stallMs?: number;
    /** 看门狗检查间隔(默认 15s)。仅供测试注入更小值,生产不要改。 */
    watchIntervalMs?: number;
    /**
     * **只靠 CPU 信号续命**的硬上限(默认 30 分钟,0=禁用)。
     *
     * 为什么需要:若卡死表现为 CPU 空转(解复用器死循环),CPU 时间一直在涨 → 光看 CPU 就永远不会被杀。
     * 这里规定:连续这么久**只有 CPU 前进、没有任何 stdout/stderr 输出** → 仍判定卡死并杀。
     * 真进度不会踩到它:`+faststart` 收尾虽静默,但只持续几十秒~几分钟,远小于 30 分钟。
     *
     * ⚠️ 依赖调用方**不传** `-v quiet`/`-nostats`:本计时只被 stdout/stderr 输出清零,若调用方把
     * ffmpeg 的 stats 也静音了,长任务会在该上限处被误杀。新增调用方时请留意。
     */
    cpuOnlyStallMs?: number;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { cwd: opts.cwd });

    let stderrTail = "";
    let block: Record<string, string> = {};
    let buf = "";

    // 卡死看门狗:ffmpeg 输入损坏可能挂起(不退出、不写进度)→ Promise 永不 settle、整个
    // merge/burn job 卡死无自愈。存活信号 = stdout/stderr 活动 **或** 进程 CPU 时间前进(见 makeCpuProbe);
    // 两者都没有超过 stallMs → SIGKILL + reject。
    let settled = false;
    let lastActivity = Date.now();
    const stallMs = opts.stallMs ?? 120_000;
    const cpuProbe = makeCpuProbe(proc.pid ?? -1);
    const cpuOnlyStallMs = opts.cpuOnlyStallMs ?? 30 * 60_000;
    // 最近一次**真实输出**(stdout/stderr)的时刻:与 lastActivity 不同,它不被 CPU 信号刷新。
    let lastRealOutput = Date.now();
    const watch = stallMs > 0
      ? setInterval(() => {
          // 存活信号:stdout/stderr 活动(下面两个 data 监听) **或** 进程 CPU 时间前进。
          // CPU 是主信号 —— faststart 收尾一遍不写任何输出,但一直在烧 CPU。
          if (cpuProbe()) lastActivity = Date.now();
          const idleMs = Date.now() - lastActivity;
          const cpuOnlyMs = Date.now() - lastRealOutput;
          // ① 完全没动静(既无输出也无 CPU)→ 卡死;
          // ② 只有 CPU 在转、长时间没有任何输出 → 视为 CPU 空转型卡死(防止忙等永远杀不掉)。
          const cpuOnlyStuck = cpuOnlyStallMs > 0 && cpuOnlyMs > cpuOnlyStallMs;
          if (idleMs <= stallMs && !cpuOnlyStuck) return;
          try { proc.kill("SIGKILL"); } catch { /* gone */ }
          const why = cpuOnlyStuck
            ? `${(cpuOnlyMs / 1000).toFixed(1)}s 只有 CPU 前进、无任何输出(疑忙等)`
            : `${(idleMs / 1000).toFixed(1)}s 无进度/输出`;
          done(() => reject(new Error(
            `ffmpeg 卡死:${why},已杀。stderr 尾: ${stderrTail.trim().slice(-300) || "(无)"}`,
          )));
        }, opts.watchIntervalMs ?? 15_000)
      : null;
    watch?.unref?.();
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (watch) clearInterval(watch);
      fn();
    };

    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      lastActivity = lastRealOutput = Date.now();
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const i = line.indexOf("=");
        if (i < 0) continue;
        const k = line.slice(0, i);
        const v = line.slice(i + 1);
        block[k] = v;
        if (k === "progress") {
          if (opts.onProgress && opts.totalMs) {
            opts.onProgress(parseProgressBlock(block, opts.totalMs));
          }
          block = {};
        }
      }
    });

    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (c: string) => {
      lastActivity = lastRealOutput = Date.now();
      stderrTail = (stderrTail + c).slice(-600);
    });

    proc.on("error", (e) => done(() => reject(e)));
    proc.on("close", (code) => done(() => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg 失败 (rc=${code}): ${stderrTail.trim() || "(无输出)"}`,
          ),
        );
    }));
  });
}

/**
 * 末帧视频包 PTS（秒）兜底。mesio 录像被中途 SIGINT 杀停时，FLV 头 duration 字段不会回写
 * （为 0/缺失），`format.duration` 因此读 0——但内容其实完整。扫视频流取最后一个包的 pts_time
 * = 真实时长。要遍历全部包，比读头慢（大文件几百毫秒～数秒），**仅当 format.duration≤0 时兜底**。
 * 失败/无包 → 0（由调用方决定是否报错）。
 */
function ffprobeLastVideoPts(path: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "packet=pts_time",
      "-of", "csv=p=0",
      path,
    ]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.on("error", () => resolve(0));
    proc.on("close", () => {
      const last = out
        .trim()
        .split("\n")
        .map((l) => parseFloat(l))
        .filter((n) => Number.isFinite(n))
        .pop();
      resolve(last ?? 0);
    });
  });
}

/**
 * 视频流真实时间跨度(秒)= 全部视频包 pts_time 的 max − min(再加一帧由调用方的容差吸收)。
 * 与 `format.duration` 的本质区别:mkv / faststart 的 mp4 把时长写在**文件头**,尾部被截断时头里仍是完整时长,
 * 只有扫包才能看见真实末帧。取 max/min 而不是「最后一个包」:含 B 帧的流包序不单调。
 * 节点侧原地替换的校验用它比较新旧文件(同一口径,所以 ts 的 PCR 起点偏移 / mp4 的起点归零都被抵消)。
 * 无视频包 / 解析失败 / ffprobe 失败 → packets=0(调用方视为无法判定,不得据此删文件)。
 */
export function ffprobeVideoSpan(path: string): Promise<{ spanSec: number; packets: number }> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "packet=pts_time",
      "-of", "csv=p=0",
      path,
    ]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.on("error", () => resolve({ spanSec: 0, packets: 0 }));
    proc.on("close", (code) => {
      if (code !== 0) return resolve({ spanSec: 0, packets: 0 });
      let min = Infinity, max = -Infinity, n = 0;
      for (const l of out.split("\n")) {
        const v = parseFloat(l);
        if (!Number.isFinite(v)) continue;
        n++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      resolve(n > 0 ? { spanSec: max - min, packets: n } : { spanSec: 0, packets: 0 });
    });
  });
}

/**
 * ffprobe 取时长（秒）。移植 get_segment_duration（L140-157）。
 * format.duration≤0/缺失（mesio 硬停的 flv）→ 末帧 PTS 兜底，避免 merge 偏移按 0 算错。
 */
export function ffprobeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe 失败 (${path}): ${err.trim().slice(0, 200)}`));
        return;
      }
      const v = parseFloat(out.trim());
      if (Number.isFinite(v) && v > 0) {
        resolve(v);
        return;
      }
      // 头部无时长（mesio 硬停的 flv）→ 末帧 PTS 兜底
      ffprobeLastVideoPts(path).then((pts) => {
        if (pts > 0) resolve(pts);
        else reject(new Error(`ffprobe 无法取得时长 (${path}): format.duration 与末帧 PTS 均为 0`));
      });
    });
  });
}

/**
 * ffprobe 取视频流 fps + 码率(kbps) + 时长(ms)。
 * r_frame_rate "n/den" → n/den；bit_rate/1000；format.duration*1000。
 */
export function ffprobeVideo(
  path: string,
): Promise<{ fps: number; kbps: number; durationMs: number; width: number; height: number; hasVideo: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      path,
    ]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0)
        return reject(
          new Error(
            `ffprobe 失败 (${path}): ${err.trim().slice(0, 200)}`,
          ),
        );
      try {
        const d = JSON.parse(out);
        const v =
          (d.streams ?? []).find(
            (s: { codec_type?: string }) => s.codec_type === "video",
          ) ?? {};
        const [n, den] = String(v.r_frame_rate ?? "0/1").split("/");
        const fps = Number(n) / Math.max(Number(den) || 1, 1);
        const kbps = Math.floor(Number(v.bit_rate ?? 0) / 1000);
        const durationMs = Math.floor(
          Number(d.format?.duration ?? 0) * 1000,
        );
        const base = {
          // 有无视频流(节点侧原地替换的校验用):没有 video 流的「成功 remux」不算数。
          hasVideo: (d.streams ?? []).some((s: { codec_type?: string }) => s.codec_type === "video"),
          fps: Number.isFinite(fps) ? fps : 0,
          kbps,
          width: Number(v.width) || 0,
          height: Number(v.height) || 0,
        };
        if (durationMs > 0) {
          resolve({ ...base, durationMs });
          return;
        }
        // 头部无时长（mesio 硬停的 flv）→ 末帧 PTS 兜底（秒→ms）
        ffprobeLastVideoPts(path).then((pts) =>
          resolve({ ...base, durationMs: Math.floor(pts * 1000) }),
        );
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}
