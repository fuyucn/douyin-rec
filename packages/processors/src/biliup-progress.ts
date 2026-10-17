/**
 * biliup transfer watchdog (plan 038 T15).
 *
 * Progress = TCP bytes acked by the peer on the biliup process's sockets (T14 measurement: rchar/wchar
 * plateau for minutes while bytes still flow, tcp.acked does not). Only `step=transfer` can stall;
 * gate_wait and submit never do. Missing evidence (no `ss`, unreadable sockets) never kills.
 */
import { execFileSync } from "node:child_process";

/** Per-socket bytes_acked keyed by "local>peer"; null = progress unknown. */
export type AckSample = ReadonlyMap<string, number> | null;

export interface WatchConfig {
  /** No acked progress for this long during transfer = stalled. */
  stallMs: number;
  /** Submit running longer than this = alert once (never kill). */
  submitAlertMs: number;
  /** Job wall time limit: alert, stop retrying; during submit the outcome becomes uncertain. */
  maxWallMs: number;
  /** Average rate below this over one window = alert once (never kill). */
  slowAlertBps: number;
  slowAlertWindowMs: number;
}

export const DEFAULT_WATCH: Readonly<WatchConfig> = {
  stallMs: 300_000,
  submitAlertMs: 30 * 60_000,
  maxWallMs: 24 * 3600_000,
  slowAlertBps: 256 * 1024,
  slowAlertWindowMs: 30 * 60_000,
};

/** Read overrides from job params; anything missing or not a positive number keeps the default. */
export function watchConfigOf(params: Record<string, unknown>): WatchConfig {
  const pick = (k: keyof WatchConfig): number => {
    const v = params[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_WATCH[k];
  };
  return {
    stallMs: pick("stallMs"), submitAlertMs: pick("submitAlertMs"), maxWallMs: pick("maxWallMs"),
    slowAlertBps: pick("slowAlertBps"), slowAlertWindowMs: pick("slowAlertWindowMs"),
  };
}

/** Parse `ss -tinpH`: each socket is a header line (with `pid=N,`) followed by an indented info line. */
export function parseSsAcked(text: string, pid: number): Map<string, number> {
  const out = new Map<string, number>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(`pid=${pid},`)) continue;
    const cols = line.trim().split(/\s+/);
    const info = /bytes_acked:/.test(line) ? line : (lines[i + 1] ?? "");
    const m = /bytes_acked:(\d+)/.exec(info);
    out.set(`${cols[3]}>${cols[4]}`, m ? Number(m[1]) : 0);
  }
  return out;
}

/** Live reader; null when `ss` is unavailable or fails. */
export function readTcpAcked(pid: number): AckSample {
  try {
    return parseSsAcked(execFileSync("ss", ["-tinpH"], { encoding: "utf-8", timeout: 5_000 }), pid);
  } catch {
    return null;
  }
}

export type WatchVerdict = { kind: "ok" } | { kind: "stall"; idleMs: number } | { kind: "wall"; step: string };

/** Pure state machine fed with samples; alerts go through the callback, each kind at most once. */
export class TransferWatch {
  private step = "gate_wait";
  private stepSince: number;
  private lastProgress: number;
  private prev: AckSample = null;
  private windowStart: number;
  private windowBytes = 0;
  private readonly alerted = new Set<string>();

  constructor(
    private readonly cfg: WatchConfig,
    private readonly now: () => number,
    private readonly alert: (msg: string) => void,
    private readonly startedAt = now(),
  ) {
    this.stepSince = this.lastProgress = this.windowStart = startedAt;
  }

  setStep(step: string): void {
    if (step === this.step) return;
    this.step = step;
    this.stepSince = this.now();
    if (step === "transfer") this.childStarted();
  }

  /** A new biliup child: its sockets are new, idle time restarts. */
  childStarted(): void {
    const t = this.now();
    this.prev = null;
    this.lastProgress = this.windowStart = t;
    this.windowBytes = 0;
  }

  observe(sample: AckSample): WatchVerdict {
    const t = this.now();
    if (t - this.startedAt >= this.cfg.maxWallMs && this.once("wall", `biliup job exceeded maxWallMs (${Math.round(this.cfg.maxWallMs / 60_000)} min); no more retries`)) {
      return { kind: "wall", step: this.step };
    }
    if (this.step === "submit") {
      if (t - this.stepSince >= this.cfg.submitAlertMs) this.once("submit", `biliup submit running for ${Math.round((t - this.stepSince) / 60_000)} min; not killing`);
      return { kind: "ok" };
    }
    if (this.step !== "transfer") return { kind: "ok" };
    if (sample === null) {
      // No evidence is not a stall: restart idle time so a later readable sample cannot kill on stale time.
      this.once("unknown", "cannot read tcp progress (ss unavailable); stall detection paused for this job");
      this.prev = null;
      this.lastProgress = t;
      return { kind: "ok" };
    }
    let gained = 0;
    for (const [k, v] of sample) {
      const before = this.prev?.get(k);
      if (before === undefined) gained += v;
      else if (v > before) gained += v - before;
    }
    this.prev = sample;
    if (gained > 0) {
      this.lastProgress = t;
      this.windowBytes += gained;
    }
    if (t - this.windowStart >= this.cfg.slowAlertWindowMs) {
      const bps = (this.windowBytes * 1000) / (t - this.windowStart);
      if (bps < this.cfg.slowAlertBps) this.once("slow", `biliup transfer slow: ${Math.round(bps / 1024)}KB/s over ${Math.round((t - this.windowStart) / 60_000)} min`);
      this.windowStart = t;
      this.windowBytes = 0;
    }
    const idleMs = t - this.lastProgress;
    return idleMs >= this.cfg.stallMs ? { kind: "stall", idleMs } : { kind: "ok" };
  }

  private once(key: string, msg: string): boolean {
    if (this.alerted.has(key)) return false;
    this.alerted.add(key);
    this.alert(msg);
    return true;
  }
}
