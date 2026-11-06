/**
 * biliup transfer watchdog (plan 038 T15).
 *
 * Progress = TCP bytes acked by the peer on the biliup process's sockets (T14 measurement: rchar/wchar
 * plateau for minutes while bytes still flow, tcp.acked does not). Only `step=transfer` can stall;
 * gate_wait and submit never do. Missing evidence (no `ss`, unreadable sockets) never kills.
 *
 * "No evidence" and "zero bytes" are different states (issue #532): a null sample, or an ss listing
 * with no socket for the child, is unknown, not 0. The per-part byte proof reads the snapshot taken at
 * the transfer-complete boundary (see TransferWatch.markBoundary) so a mid-transfer sample is never
 * mistaken for a short transfer.
 */
import { execFile, execFileSync } from "node:child_process";

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

/** Async variant of {@link readTcpAcked} (same 5s timeout) for callers that must not block the event loop. */
export function readTcpAckedAsync(pid: number): Promise<AckSample> {
  return new Promise((resolve) => {
    try {
      execFile("ss", ["-tinpH"], { encoding: "utf-8", timeout: 5_000 }, (err, stdout) => {
        resolve(err ? null : parseSsAcked(String(stdout), pid));
      });
    } catch {
      resolve(null);
    }
  });
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
  private childBytes = 0;
  /** Readable samples for the current child while transferring; 0 = no evidence either way. */
  private samples = 0;
  /** Bytes acked at the transfer-complete boundary; null = nothing readable at that moment. */
  private boundary: number | null = null;
  private readonly alerted = new Set<string>();

  constructor(
    private readonly cfg: WatchConfig,
    private readonly now: () => number,
    private readonly alert: (msg: string) => void,
    private readonly startedAt = now(),
  ) {
    this.stepSince = this.lastProgress = this.windowStart = startedAt;
  }

  get currentStep(): string {
    return this.step;
  }

  /**
   * Bytes acked by the current child so far (sum of per-socket gains; closed sockets keep their share).
   * null = no readable sample yet: "unknown" is never reported as 0 bytes.
   */
  get ackedSinceChild(): number | null {
    return this.samples > 0 ? this.childBytes : null;
  }

  /** Snapshot of ackedSinceChild taken at the transfer-complete boundary (plan 046 §5.4). */
  get ackedAtBoundary(): number | null {
    return this.boundary;
  }

  /**
   * Record the byte-proof snapshot for the current child. Called once the child reports the
   * transfer-complete line, while its sockets are still visible. A boundary read that returned no
   * socket is unknown: earlier mid-transfer samples are short by nature and must not become the proof.
   */
  markBoundary(readable: boolean): number | null {
    // Only a readable boundary read sets the proof; a later unreadable one (e.g. a repeated boundary
    // line after the child moved to submit) never erases the value captured while the sockets were up.
    if (readable) this.boundary = this.ackedSinceChild;
    return this.boundary;
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
    this.childBytes = 0;
    this.samples = 0;
    this.boundary = null;
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
      // A live socket's bytes_acked never decreases, so a lower total means the tuple was reused by a
      // new connection: count that socket from its own zero, keeping the closed one's share.
      else if (v < before) gained += v;
    }
    // An ss listing without this child's sockets carries no byte information: keep the last known
    // per-socket values (closed sockets keep their share) and do not count it as a sample. It still
    // counts as "no progress" for the stall watchdog above.
    if (sample.size > 0) {
      this.prev = sample;
      this.samples += 1;
    }
    if (gained > 0) {
      this.lastProgress = t;
      this.windowBytes += gained;
      this.childBytes += gained;
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
