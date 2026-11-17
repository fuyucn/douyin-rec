import { spawn } from "node:child_process";
import type { ChildProcessLike, FfmpegPipeArgs, SegmentExit, SpawnFn } from "./live-pump-types.js";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
let spawnOverride: SpawnFn | undefined;
export function setSpawnForTest(fn: SpawnFn | undefined): void { spawnOverride = fn; }

const TS_DISCONTINUITY_RE =
  /timestamp discontinuity|non-monoton(?:ic|ous) dts|non monotonically increasing dts/i;

export function countTsDiscontinuities(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) if (TS_DISCONTINUITY_RE.test(line)) count++;
  return count;
}

/** HTTP reconnect flags precede the input; only FLV URLs force the live demuxer. */
export function buildPipeFfmpegArgs(a: FfmpegPipeArgs): string[] {
  const isHttp = /^https?:/.test(a.url);
  const headers: string[] = [];
  if (isHttp && a.headers) {
    for (const [key, value] of Object.entries(a.headers)) {
      switch (key.toLowerCase()) {
        case "user-agent": headers.push("-user_agent", value); break;
        case "referer": headers.push("-referer", value); break;
        default: headers.push("-headers", key + ": " + value + "\r\n");
      }
    }
  }
  const liveFlv = isHttp && /\.flv(?:[?#]|$)/i.test(a.url) ? ["-f", "live_flv"] : [];
  const reconnect = isHttp
    ? ["-reconnect", "1", "-reconnect_at_eof", "1", "-reconnect_streamed", "1",
      "-reconnect_delay_max", "30"] : [];
  return [
    "-loglevel", "warning", "-y", ...headers, "-fflags", "+genpts", ...reconnect, ...liveFlv,
    "-i", a.url, "-c", "copy", "-map", "0", "-reset_timestamps", "1",
    "-avoid_negative_ts", "make_zero", "-f", "mpegts", "-",
  ];
}

/** Owns one child, its stderr accounting and bounded stdout/exit teardown. */
export class LivePumpProcess {
  readonly child: ChildProcessLike;
  readonly exited: Promise<SegmentExit>;
  closed = false;
  killed = false;
  discontinuities = 0;
  private tail = "";
  private partial = "";
  private destroyTimer: NodeJS.Timeout | undefined;

  constructor(args: string[], private readonly destroyGraceMs = 5_000) {
    const spawnNow: SpawnFn = spawnOverride ?? ((cmd, argv, opts) =>
      spawn(cmd, argv as string[], opts as never) as unknown as ChildProcessLike);
    this.child = spawnNow(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (this.child.stderr) {
      (this.child.stderr as NodeJS.ReadableStream & { setEncoding(e: string): void })
        .setEncoding("utf-8");
      this.child.stderr.on("data", (chunk: unknown) => this.noteStderr(String(chunk)));
    }
    this.exited = new Promise((resolve) => {
      this.child.on("close", (...args: unknown[]) => {
        this.closed = true;
        this.armDestroy();
        resolve({ code: (args[0] as number | null) ?? null,
          signal: (args[1] as NodeJS.Signals | null) ?? null, stderrTail: this.tail });
      });
    });
  }

  private noteStderr(text: string): void {
    this.tail = (this.tail + text).slice(-4000);
    this.partial += text;
    const newline = this.partial.lastIndexOf("\n");
    if (newline < 0) return;
    this.discontinuities += countTsDiscontinuities(this.partial.slice(0, newline));
    this.partial = this.partial.slice(newline + 1);
  }

  private armDestroy(): void {
    if (this.destroyTimer) return;
    this.destroyTimer = setTimeout(() => {
      const stdout = this.child.stdout;
      const state = stdout as (NodeJS.ReadableStream & {
        destroyed?: boolean; readableEnded?: boolean;
      }) | null;
      if (!stdout || state?.destroyed || state?.readableEnded) return;
      try { stdout.destroy?.(new Error("live-pump: ffmpeg stdout did not close after kill")); }
      catch { /* The stream already closed. */ }
    }, this.destroyGraceMs);
    this.destroyTimer.unref?.();
  }

  /** Never signal a process group: the uploader shares the child's group. */
  stop(): void {
    if (this.killed) return;
    this.killed = true;
    try { this.child.kill("SIGKILL"); } catch { /* The child already exited. */ }
    this.armDestroy();
  }

  clearDestroyTimer(): void {
    if (this.destroyTimer) clearTimeout(this.destroyTimer);
  }

  async exit(aborted: boolean, graceMs = 10_000): Promise<SegmentExit> {
    const exit = await Promise.race([this.exited, new Promise<SegmentExit>((resolve) => {
      const timer = setTimeout(() => {
        this.stop();
        resolve({ code: null, signal: aborted ? "SIGTERM" : "SIGKILL", stderrTail: this.tail });
      }, graceMs);
      timer.unref?.();
    })]);
    this.discontinuities += countTsDiscontinuities(this.partial);
    return exit;
  }
}
