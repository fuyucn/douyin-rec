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
 * ffprobe 超时(毫秒)。依据:全包扫描(`-show_entries packet=...`)要读完整个文件,30 分钟分段(直播码流
 * 1~6Mbps ≈ 0.2~1.4GB)在机械盘 / 网络盘上实测量级是数秒~数十秒;5 分钟是它的 10 倍以上裕量,保守但有限。
 * 超过 = 文件异常(补零 / 损坏导致解复用空转)或盘卡死,一律按「无法判定」处理,绝不无限等。
 */
export const FFPROBE_SCAN_TIMEOUT_MS = 5 * 60_000;
/** 只读文件头的探测(`format=duration` / `-show_streams`)超时:正常毫秒级,60 秒已极度宽松。 */
export const FFPROBE_HEADER_TIMEOUT_MS = 60_000;
/** stderr 只保留尾部这么多字节:被探测文件异常时 ffprobe 可能输出几十 MB 报错,不读会写满管道把进程阻塞住。 */
const FFPROBE_STDERR_TAIL_BYTES = 4096;
/** stdout 上限:全包扫描 30 分钟 60fps 约几 MB;超过 64MB 必是异常输出,杀掉按无法判定处理。 */
const FFPROBE_STDOUT_MAX_BYTES = 64 * 1024 * 1024;

export interface FfprobeRun {
  /** 退出码;null = 起不来 / 被杀。 */
  code: number | null;
  out: string;
  /** stderr 尾部(≤4KB)。 */
  errTail: string;
  timedOut: boolean;
  /** stdout 超上限被杀。 */
  overflow: boolean;
  /** stderr 总行数(含被截掉的部分):内容损坏时 ffprobe 会对每个坏包报一行,是「数据坏了」的信号。 */
  errLines: number;
}

/**
 * 统一的 ffprobe 运行器(本包所有探测共用):**必须**消费 stderr(只留尾部)、有超时(SIGKILL)、不抛。
 * 任何异常都以 `code !== 0` / `timedOut` / `overflow` 表达,由调用方按「无法判定」处理。
 */
export function runFfprobe(args: string[], timeoutMs: number): Promise<FfprobeRun> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try { proc = spawn("ffprobe", args); }
    catch (e) { return resolve({ code: null, out: "", errTail: String((e as Error).message), timedOut: false, overflow: false, errLines: 0 }); }
    const chunks: Buffer[] = [];
    let outBytes = 0;
    let errTail = "";
    let timedOut = false;
    let overflow = false;
    let errLines = 0;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks).toString("utf-8"), errTail, timedOut, overflow, errLines });
    };
    const kill = (): void => { try { proc.kill("SIGKILL"); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); finish(null); }, timeoutMs);
    proc.stdout?.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > FFPROBE_STDOUT_MAX_BYTES) { overflow = true; kill(); finish(null); return; }
      chunks.push(c);
    });
    proc.stderr?.on("data", (c: Buffer) => {
      for (const b of c) if (b === 10) errLines++;
      errTail = (errTail + c.toString("utf-8")).slice(-FFPROBE_STDERR_TAIL_BYTES);
    });
    proc.on("error", (e) => { errTail = String(e.message); finish(null); });
    proc.on("close", (code) => finish(code));
  });
}

const probeFailMsg = (path: string, r: FfprobeRun): string =>
  `ffprobe ${r.timedOut ? "超时" : r.overflow ? "输出超限" : "失败"} (${path}): ${r.errTail.trim().slice(-200)}`;

/**
 * 末帧视频包 PTS（秒）兜底。mesio 录像被中途 SIGINT 杀停时，FLV 头 duration 字段不会回写
 * （为 0/缺失），`format.duration` 因此读 0——但内容其实完整。扫视频流取最后一个包的 pts_time
 * = 真实时长。要遍历全部包，比读头慢（大文件几百毫秒～数秒），**仅当 format.duration≤0 时兜底**。
 * 失败/超时/无包 → 0（由调用方决定是否报错）。
 */
async function ffprobeLastVideoPts(path: string): Promise<number> {
  const r = await runFfprobe(
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", path],
    FFPROBE_SCAN_TIMEOUT_MS,
  );
  if (r.code == null) return 0;
  const last = r.out.trim().split("\n").map((l) => parseFloat(l)).filter((n) => Number.isFinite(n)).pop();
  return last ?? 0;
}

/** 全包扫描统计(节点侧原地替换的校验用,新旧文件同口径)。 */
export interface PacketStats {
  /** 视频包 pts_time 的 max−min(秒)。 */
  spanSec: number;
  videoPackets: number;
  audioPackets: number;
  hasAudio: boolean;
  /** 视频流里相邻关键帧之间的最大包数(= 一个 GOP 的包数上界)。 */
  gopPackets: number;
  /** 全包扫描时 ffprobe 的 stderr 行数(内容损坏的信号;新文件不得多于原文件)。 */
  errorLines: number;
}

/**
 * 单次全包扫描:视频跨度 + 视频/音频包数 + GOP 大小。
 * 与 `format.duration` 的本质区别:mkv / faststart 的 mp4 把时长写在**文件头**,尾部被截断时头里仍是完整时长,
 * 只有扫包才能看见真实末帧;包数则能抓到「中段被抹零、跨度/头部/体积都正常」的丢包。
 * 取 max/min 而不是「最后一个包」:含 B 帧的流包序不单调。
 * **任何无法判定**(ffprobe 失败 / 超时 / 输出超限 / 无视频流 / 无视频包)→ 返回 undefined,调用方必须按失败处理。
 */
export async function ffprobePacketStats(path: string, timeoutMs = FFPROBE_SCAN_TIMEOUT_MS): Promise<PacketStats | undefined> {
  const st = await runFfprobe(["-v", "error", "-show_entries", "stream=index,codec_type", "-of", "csv=p=0", path], Math.min(timeoutMs, FFPROBE_HEADER_TIMEOUT_MS));
  if (st.code !== 0) return undefined;
  let videoIdx = -1;
  const audioIdx = new Set<number>();
  for (const l of st.out.split("\n")) {
    const f = l.trim().split(",");
    const kind = f.find((x) => x === "video" || x === "audio");
    const idx = f.map((x) => Number(x)).find((x) => Number.isInteger(x) && x >= 0);
    if (idx === undefined) continue;
    if (kind === "video" && videoIdx < 0) videoIdx = idx;
    else if (kind === "audio") audioIdx.add(idx);
  }
  if (videoIdx < 0) return undefined;
  const r = await runFfprobe(["-v", "error", "-show_entries", "packet=stream_index,pts_time,flags", "-of", "csv=p=0", path], timeoutMs);
  if (r.code !== 0) return undefined;
  let min = Infinity, max = -Infinity, v = 0, a = 0, run = 0, gop = 0;
  for (const l of r.out.split("\n")) {
    const f = l.trim().split(",");
    if (f.length < 3) continue;
    const idx = Number(f[0]);
    if (idx === videoIdx) {
      v++;
      const t = parseFloat(f[1] ?? "");
      if (Number.isFinite(t)) { if (t < min) min = t; if (t > max) max = t; }
      if ((f[2] ?? "").startsWith("K")) { gop = Math.max(gop, run); run = 1; } else run++;
    } else if (audioIdx.has(idx)) a++;
  }
  gop = Math.max(gop, run);
  if (v === 0 || !Number.isFinite(min)) return undefined;
  return { spanSec: max - min, videoPackets: v, audioPackets: a, hasAudio: audioIdx.size > 0, gopPackets: gop, errorLines: r.errLines };
}

/** 兼容入口:视频跨度 + 视频包数;无法判定 → packets=0。 */
export async function ffprobeVideoSpan(path: string): Promise<{ spanSec: number; packets: number }> {
  const s = await ffprobePacketStats(path);
  return s ? { spanSec: s.spanSec, packets: s.videoPackets } : { spanSec: 0, packets: 0 };
}

/**
 * ffprobe 取时长（秒）。移植 get_segment_duration（L140-157）。
 * format.duration≤0/缺失（mesio 硬停的 flv）→ 末帧 PTS 兜底，避免 merge 偏移按 0 算错。
 */
export async function ffprobeDuration(path: string): Promise<number> {
  const r = await runFfprobe(
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
    FFPROBE_HEADER_TIMEOUT_MS,
  );
  if (r.code !== 0) throw new Error(probeFailMsg(path, r));
  const v = parseFloat(r.out.trim());
  if (Number.isFinite(v) && v > 0) return v;
  // 头部无时长（mesio 硬停的 flv）→ 末帧 PTS 兜底
  const pts = await ffprobeLastVideoPts(path);
  if (pts > 0) return pts;
  throw new Error(`ffprobe 无法取得时长 (${path}): format.duration 与末帧 PTS 均为 0`);
}

/**
 * ffprobe 取视频流 fps + 码率(kbps) + 时长(ms)。
 * r_frame_rate "n/den" → n/den；bit_rate/1000；format.duration*1000。
 */
export async function ffprobeVideo(
  path: string,
): Promise<{ fps: number; kbps: number; durationMs: number; width: number; height: number; hasVideo: boolean }> {
  const r = await runFfprobe(["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], FFPROBE_HEADER_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(probeFailMsg(path, r));
  const d = JSON.parse(r.out);
  const v = (d.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === "video") ?? {};
  const [n, den] = String(v.r_frame_rate ?? "0/1").split("/");
  const fps = Number(n) / Math.max(Number(den) || 1, 1);
  const kbps = Math.floor(Number(v.bit_rate ?? 0) / 1000);
  const durationMs = Math.floor(Number(d.format?.duration ?? 0) * 1000);
  const base = {
    // 有无视频流(节点侧原地替换的校验用):没有 video 流的「成功 remux」不算数。
    hasVideo: (d.streams ?? []).some((s: { codec_type?: string }) => s.codec_type === "video"),
    fps: Number.isFinite(fps) ? fps : 0,
    kbps,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
  };
  if (durationMs > 0) return { ...base, durationMs };
  // 头部无时长（mesio 硬停的 flv）→ 末帧 PTS 兜底（秒→ms）
  const pts = await ffprobeLastVideoPts(path);
  return { ...base, durationMs: Math.floor(pts * 1000) };
}
