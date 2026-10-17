// plan 038 T15: transfer watchdog (tcp.acked), stall retry with proof, submit never killed, capability.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerProcessor, _resetProcessors, advertisedCapabilities, isUncertainOutcome } from "@drec/core";
import { makeBiliupProcessor, type BiliupDeps } from "../../packages/processors/src/biliup.js";
import { DEFAULT_WATCH, TransferWatch, parseSsAcked, watchConfigOf } from "../../packages/processors/src/biliup-progress.js";
import type { BiliupHooks } from "../../packages/processors/src/run-biliup.js";

const SS = [
  "ESTAB 0      0         10.0.0.1:53844 10.0.0.2:443   users:((\"biliup\",pid=4242,fd=9))",
  "\t cubic wscale:9,7 rto:217 bytes_sent:904 bytes_acked:900 segs_out:3",
  "ESTAB 0      0         10.0.0.1:53845 10.0.0.2:443   users:((\"node\",pid=7,fd=3))",
  "\t cubic bytes_acked:55",
  "ESTAB 0      0         10.0.0.1:53846 10.0.0.3:443   users:((\"biliup\",pid=4242,fd=10))",
  "\t cubic bytes_sent:1",
].join("\n");

describe("parseSsAcked", () => {
  it("keeps only the pid's sockets; a socket without bytes_acked counts as 0", () => {
    expect([...parseSsAcked(SS, 4242)]).toEqual([["10.0.0.1:53844>10.0.0.2:443", 900], ["10.0.0.1:53846>10.0.0.3:443", 0]]);
    expect(parseSsAcked(SS, 1).size).toBe(0);
  });
});

function mkWatch(cfg: Partial<typeof DEFAULT_WATCH> = {}) {
  const clock = { t: 0 };
  const alerts: string[] = [];
  const w = new TransferWatch({ ...DEFAULT_WATCH, ...cfg }, () => clock.t, (m) => alerts.push(m));
  return { w, clock, alerts };
}
const acked = (...v: number[]) => new Map(v.map((x, i) => [`s${i}`, x]));

describe("TransferWatch", () => {
  it("acked growth keeps it alive; no growth for stallMs during transfer stalls", () => {
    const { w, clock } = mkWatch({ stallMs: 300_000 });
    w.setStep("transfer");
    for (let i = 1; i <= 10; i++) { clock.t += 60_000; expect(w.observe(acked(i * 100))).toEqual({ kind: "ok" }); }
    clock.t += 299_000;
    expect(w.observe(acked(1000)).kind).toBe("ok");
    clock.t += 1_000;
    expect(w.observe(acked(1000))).toEqual({ kind: "stall", idleMs: 300_000 });
  });

  it("a summed drop (socket closed) is not counted as regress; a new socket with bytes is progress", () => {
    const { w, clock } = mkWatch({ stallMs: 100 });
    w.setStep("transfer");
    clock.t = 10; w.observe(new Map([["a", 5000]]));
    clock.t = 90; expect(w.observe(new Map([["b", 10]])).kind).toBe("ok");
    clock.t = 190; expect(w.observe(new Map([["b", 10]])).kind).toBe("stall");
  });

  it("gate_wait and submit never stall; submit alerts once past submitAlertMs", () => {
    const { w, clock, alerts } = mkWatch({ stallMs: 10, submitAlertMs: 1000 });
    clock.t = 10_000;
    expect(w.observe(acked(0)).kind).toBe("ok");
    w.setStep("submit");
    clock.t += 5_000;
    expect(w.observe(acked(0)).kind).toBe("ok");
    expect(w.observe(acked(0)).kind).toBe("ok");
    expect(alerts.filter((a) => /submit/.test(a))).toHaveLength(1);
  });

  it("unknown progress never kills and alerts once; idle restarts when evidence returns", () => {
    const { w, clock, alerts } = mkWatch({ stallMs: 100 });
    w.setStep("transfer");
    for (let i = 0; i < 5; i++) { clock.t += 100; expect(w.observe(null).kind).toBe("ok"); }
    expect(alerts.filter((a) => /cannot read tcp/.test(a))).toHaveLength(1);
    clock.t += 50;
    expect(w.observe(acked(0)).kind).toBe("ok");
  });

  it("slow transfer alerts once per job, never stalls while bytes move", () => {
    const { w, clock, alerts } = mkWatch({ slowAlertBps: 1000, slowAlertWindowMs: 10_000 });
    w.setStep("transfer");
    for (let i = 1; i <= 30; i++) { clock.t += 1_000; expect(w.observe(acked(i * 10)).kind).toBe("ok"); }
    expect(alerts.filter((a) => /slow/.test(a))).toHaveLength(1);
  });

  it("past maxWallMs reports wall once with the current step", () => {
    const { w, clock } = mkWatch({ maxWallMs: 100 });
    w.setStep("submit");
    clock.t = 100;
    expect(w.observe(acked(0))).toEqual({ kind: "wall", step: "submit" });
    expect(w.observe(acked(0)).kind).toBe("ok");
  });

  it("params override only with positive numbers", () => {
    expect(watchConfigOf({ stallMs: 60_000, maxWallMs: -1, submitAlertMs: "x" })).toMatchObject({
      stallMs: 60_000, maxWallMs: DEFAULT_WATCH.maxWallMs, submitAlertMs: DEFAULT_WATCH.submitAlertMs,
    });
  });
});

// ── processor ────────────────────────────────────────────────────────────────

function files(n: number): string[] {
  const dir = mkdtempSync(join(tmpdir(), "bili-stall-"));
  return Array.from({ length: n }, (_, i) => { const p = join(dir, `p${i}.mp4`); writeFileSync(p, "x"); return p; });
}
function job(inputs: string[], over: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return {
    jobId: "biliup:k#g1", kind: "biliup", logicalKey: "k", generation: 1, attempts: 1, inputs,
    params: { cookies: "c", title: "t", tid: 21, tag: "tag", expectedDurationSec: 60, stallMs: 40, ...params },
    replaceInputs: false, owner: { taskId: 1 }, createdAt: 1, ...over,
  } as never;
}
function ctx() {
  const alerts: string[] = [];
  const setState = vi.fn();
  return { alerts, setState, c: { log() {}, alert: (m: string) => alerts.push(m), markProgress() {}, assertLease() {}, signal: new AbortController().signal, setState } as never };
}

/** A biliup fake whose children hang until killed; `hangOn` picks which argv hangs. */
function hangingRun(hangOn: (argv: string[]) => boolean) {
  const live = new Map<number, (e: Error) => void>();
  let nextPid = 100;
  const run = vi.fn((argv: string[], hooks?: BiliupHooks) => new Promise<string>((resolve, reject) => {
    const pid = nextPid++;
    hooks?.onSpawn?.(pid);
    if (!hangOn(argv)) { resolve(argv.includes("upload") ? "BV1aaaaaaaaa" : "ok"); return; } // issue-guard: allow (fake BV fixture)
    live.set(pid, reject);
  }));
  const kill = vi.fn((pid: number) => { live.get(pid)?.(new Error("biliup 失败 (rc=null): killed")); live.delete(pid); });
  return { run, kill };
}
const base = (over: BiliupDeps): BiliupDeps => ({
  tickMs: 5, killGraceMs: 5, readAcked: () => new Map([["s", 1]]), probe: () => null, ...over,
});

describe("biliup processor stall handling", () => {
  it("stall while creating: child stopped, no draft proven → retry with backoff and nothing else run", async () => {
    const { run, kill } = hangingRun(() => true);
    const p = makeBiliupProcessor(base({ run, kill, lookup: { run: async () => "[]" } }));
    const { c, alerts } = ctx();
    const t0 = Date.now();
    const r = await p.run(job(files(2)), c);
    expect(kill).toHaveBeenCalledWith(100, "SIGTERM");
    expect(r.retry?.reason).toBe("transfer-retry");
    expect(r.retry!.notBefore - t0).toBeGreaterThanOrEqual(5 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(alerts.some((a) => /stalled/.test(a))).toBe(true);
  });

  it("stall while creating without a no-draft proof → ambiguous failure, no retry", async () => {
    const { run, kill } = hangingRun(() => true);
    let calls = 0;
    // The pre-create proof succeeds; the post-stall proof cannot be obtained.
    const lookup = { run: async () => { if (++calls > 3) throw new Error("x"); return "[]"; } };
    const p = makeBiliupProcessor(base({ run, kill, lookup }));
    await expect(p.run(job(files(1)), ctx().c)).rejects.toThrow(/cannot prove no draft/);
  });

  it("third attempt does not retry again", async () => {
    const { run, kill } = hangingRun(() => true);
    const p = makeBiliupProcessor(base({ run, kill, lookup: { run: async () => "[]" } }));
    await expect(p.run(job(files(1), { attempts: 3 }), ctx().c)).rejects.toThrow(/3 attempts used/);
  });

  it("stall while appending: a confirmed part count allows retry and keeps the bv", async () => {
    const { run, kill } = hangingRun((a) => a.includes("append"));
    const p = makeBiliupProcessor(base({ run, kill, lookup: { run: async () => "[]" }, countParts: async () => 1 }));
    const r = await p.run(job(files(3)), ctx().c);
    expect(r.bv).toBe("BV1aaaaaaaaa"); // issue-guard: allow (fake BV fixture)
    expect(r.retry?.reason).toBe("transfer-retry");
  });

  it("stall while appending with an unknown part count → ambiguous, no retry", async () => {
    const { run, kill } = hangingRun((a) => a.includes("append"));
    const p = makeBiliupProcessor(base({ run, kill, lookup: { run: async () => "[]" }, countParts: async () => null }));
    await expect(p.run(job(files(2)), ctx().c)).rejects.toThrow(/part count unknown/);
  });

  it("growing tcp.acked is never killed", async () => {
    let n = 0;
    let finish: () => void = () => {};
    const run = vi.fn((_a: string[], hooks?: BiliupHooks) => new Promise<string>((res) => { hooks?.onSpawn?.(9); finish = () => res("BV1bbbbbbbbb"); })); // issue-guard: allow (fake BV fixture)
    const kill = vi.fn();
    const p = makeBiliupProcessor(base({ run, kill, readAcked: () => new Map([["s", ++n]]), lookup: { run: async () => "[]" } }));
    const pending = p.run(job(files(1)), ctx().c);
    await new Promise((r) => setTimeout(r, 150));
    finish();
    expect((await pending).bv).toBe("BV1bbbbbbbbb"); // issue-guard: allow (fake BV fixture)
    expect(kill).not.toHaveBeenCalled();
  });

  it("submit past maxWallMs → UncertainOutcome, child not killed", async () => {
    const kill = vi.fn();
    const run = vi.fn((_a: string[], hooks?: BiliupHooks) => new Promise<string>(() => {
      hooks?.onSpawn?.(11);
      hooks?.onLine?.("All files uploaded successfully");
    }));
    const p = makeBiliupProcessor(base({ run, kill, readAcked: () => new Map(), lookup: { run: async () => "[]" } }));
    const err = await p.run(job(files(1), {}, { maxWallMs: 30 }), ctx().c).catch((e: unknown) => e);
    expect(isUncertainOutcome(err)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("wall first crossed during transfer still turns a later submit uncertain", async () => {
    let enterSubmit: () => void = () => {};
    const kill = vi.fn();
    const run = vi.fn((_a: string[], hooks?: BiliupHooks) => new Promise<string>(() => {
      hooks?.onSpawn?.(13);
      enterSubmit = () => hooks?.onLine?.("All files uploaded successfully");
    }));
    let n = 0;
    const p = makeBiliupProcessor(base({ run, kill, readAcked: () => new Map([["s", ++n]]), lookup: { run: async () => "[]" } }));
    const pending = p.run(job(files(1), {}, { maxWallMs: 20 }), ctx().c).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 60));
    enterSubmit();
    expect(isUncertainOutcome(await pending)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("after an uncertain submit the abandoned run never starts the next append", async () => {
    let finishSubmit: () => void = () => {};
    const run = vi.fn((argv: string[], hooks?: BiliupHooks) => new Promise<string>((res) => {
      hooks?.onSpawn?.(12);
      hooks?.onLine?.("All files uploaded successfully");
      finishSubmit = () => res(argv.includes("upload") ? "BV1ccccccccc" : "ok"); // issue-guard: allow (fake BV fixture)
    }));
    const p = makeBiliupProcessor(base({ run, readAcked: () => new Map(), lookup: { run: async () => "[]" }, countParts: async () => 1 }));
    const err = await p.run(job(files(3), {}, { maxWallMs: 30 }), ctx().c).catch((e: unknown) => e);
    expect(isUncertainOutcome(err)).toBe(true);
    finishSubmit();
    await new Promise((r) => setTimeout(r, 30));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("records the child's start fingerprint so the slot can be bound to it", async () => {
    const { run } = hangingRun(() => false);
    const { c, setState } = ctx();
    await makeBiliupProcessor(base({ run, probe: (pid) => ({ pid, startedAt: "st", cmdline: "biliup" }), lookup: { run: async () => "[]" } })).run(job(files(1)), c);
    expect(setState).toHaveBeenCalledWith({ step: "transfer", childPid: 100, childPidStartedAt: "st" });
  });
});

describe("biliup-queue capability", () => {
  afterEach(() => _resetProcessors());
  it("is advertised only through the registered biliup processor", () => {
    _resetProcessors();
    expect(advertisedCapabilities()).not.toContain("biliup-queue");
    registerProcessor(makeBiliupProcessor());
    expect(advertisedCapabilities()).toEqual(["biliup", "biliup-queue"]);
  });
});
