// ts/src/core/post/ffmpeg.ts
import { spawn } from "node:child_process";

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
 * spawn ffmpeg；解析 -progress pipe:1 stdout；
 * rc≠0 时 reject，带 stderr 尾部（最后 ~600 字符）。
 */
export function runFfmpeg(
  args: string[],
  opts: {
    cwd?: string;
    totalMs?: number;
    onProgress?: (p: Progress) => void;
    /** 卡死阈值:stdout/stderr 静默(无进度/无输出)超此毫秒数 → 杀 ffmpeg + reject。默认 120s,0=禁用。 */
    stallMs?: number;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { cwd: opts.cwd });

    let stderrTail = "";
    let block: Record<string, string> = {};
    let buf = "";

    // 卡死看门狗:ffmpeg 输入损坏可能挂起(不退出、不写进度)→ Promise 永不 settle、整个
    // merge/burn job 卡死无自愈。任何 stdout/stderr 活动刷新计时;静默超阈值 → SIGKILL + reject。
    let settled = false;
    let lastActivity = Date.now();
    const stallMs = opts.stallMs ?? 120_000;
    const watch = stallMs > 0
      ? setInterval(() => {
          if (Date.now() - lastActivity <= stallMs) return;
          try { proc.kill("SIGKILL"); } catch { /* gone */ }
          done(() => reject(new Error(
            `ffmpeg 卡死:${Math.round(stallMs / 1000)}s 无进度/输出,已杀。stderr 尾: ${stderrTail.trim().slice(-300) || "(无)"}`,
          )));
        }, 15_000)
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
      lastActivity = Date.now();
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
      lastActivity = Date.now();
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
): Promise<{ fps: number; kbps: number; durationMs: number; width: number; height: number }> {
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
