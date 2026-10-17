// plan 038 T15: transfer watchdog (tcp.acked), stall retry with proof, submit never killed, capability.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerProcessor, _resetProcessors, advertisedCapabilities, isUncertainOutcome } from "@drec/core";
import { openUploadSlot } from "@drec/core";
import { makeBiliupProcessor, type BiliupDeps } from "../../packages/processors/src/biliup.js";
import { DEFAULT_WATCH, TransferWatch, parseSsAcked, watchConfigOf } from "../../packages/processors/src/biliup-progress.js";
import type { BiliupHooks } from "../../packages/processors/src/run-biliup.js";

const SS = [
  "ESTAB 0      0         local:53844 peer-a:443   users:((\"biliup\",pid=4242,fd=9))",
  "\t cubic wscale:9,7 rto:217 bytes_sent:904 bytes_acked:900 segs_out:3",
  "ESTAB 0      0         local:53845 peer-a:443   users:((\"node\",pid=7,fd=3))",
  "\t cubic bytes_acked:55",
  "ESTAB 0      0         local:53846 peer-b:443   users:((\"biliup\",pid=4242,fd=10))",
  "\t cubic bytes_sent:1",
].join("\n");

describe("parseSsAcked", () => {
  it("keeps only the pid's sockets; a socket without bytes_acked counts as 0", () => {
    expect([...parseSsAcked(SS, 4242)]).toEqual([["local:53844>peer-a:443", 900], ["local:53846>peer-b:443", 0]]);
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
    expect(advertisedCapabilities()).toEqual(["biliup", "biliup-queue", "biliup-slot"]);
  });
});

// ── progress (plan 038 PR5) ──────────────────────────────────────────────────

describe("TransferWatch.ackedSinceChild", () => {
  it("sums per-socket gains, keeps a closed socket's share and restarts per child", () => {
    const { w, clock } = mkWatch();
    w.setStep("transfer");
    clock.t = 1; w.observe(new Map([["a", 500]]));
    clock.t = 2; w.observe(new Map([["b", 200]])); // a closed, b new
    expect(w.ackedSinceChild).toBe(700);
    w.childStarted();
    expect(w.ackedSinceChild).toBe(0);
  });
});

describe("biliup processor progress", () => {
  it("reports cumulative bytes across parts, capped per part, with a rate once two samples exist", async () => {
    const releases: Array<() => void> = [];
    const lines: Array<(l: string) => void> = [];
    let acked = 0;
    const run = vi.fn((argv: string[], hooks?: BiliupHooks) => new Promise<string>((res) => {
      hooks?.onSpawn?.(20 + releases.length);
      acked = 0;
      lines.push((l) => hooks?.onLine?.(l));
      releases.push(() => res(argv.includes("upload") ? "BV1aaaaaaaaa" : "ok")); // issue-guard: allow (fake BV fixture)
    }));
    const p = makeBiliupProcessor(base({
      run, progressEveryMs: 0, sizeOf: () => 1000, readAcked: () => new Map([["s", (acked += 400)]]),
      lookup: { run: async () => "[]" }, countParts: async () => 1,
    }));
    const { c, setState } = ctx();
    const done = p.run(job(files(2), {}, { stallMs: 60_000 }), c);
    const progress = () => setState.mock.calls.map((x) => (x[0] as { progress?: { doneBytes: number; totalBytes: number; bps: number | null } }).progress).filter(Boolean);
    const settle = () => new Promise((r) => setTimeout(r, 40));
    await settle();
    expect(progress().every((x) => x!.totalBytes === 2000 && x!.doneBytes <= 1000)).toBe(true);
    expect(progress().some((x) => x!.doneBytes === 1000)).toBe(true); // 400+400+... capped at the part size
    lines[0]!("All files uploaded successfully");
    releases[0]!();
    await settle();
    expect(progress().at(-1)!.doneBytes).toBeGreaterThan(1000);
    expect(progress().some((x) => x!.bps !== null)).toBe(true);
    lines[1]!("All files uploaded successfully");
    expect(progress().at(-1)!.doneBytes).toBe(2000);
    releases[1]!();
    await done;
    const seq = progress().map((x) => x!.doneBytes);
    expect(seq).toEqual([...seq].sort((a, b) => a - b)); // never goes backwards
  });
});

describe("biliup processor progress write failures", () => {
  it("a throwing progress write is logged and the upload still finishes", async () => {
    let finish: () => void = () => {};
    const run = vi.fn((_a: string[], hooks?: BiliupHooks) => new Promise<string>((res) => {
      hooks?.onSpawn?.(30);
      finish = () => { hooks?.onLine?.("All files uploaded successfully"); res("BV1aaaaaaaaa"); }; // issue-guard: allow (fake BV fixture)
    }));
    const logs: string[] = [];
    const setState = vi.fn((patch: { progress?: unknown }) => { if (patch.progress) throw new Error("database is locked"); });
    const c = { log: (m: string) => logs.push(m), alert() {}, markProgress() {}, assertLease() {}, signal: new AbortController().signal, setState } as never;
    let n = 0;
    const p = makeBiliupProcessor(base({ run, progressEveryMs: 0, sizeOf: () => 10, readAcked: () => new Map([["s", ++n]]), lookup: { run: async () => "[]" } }));
    const pending = p.run(job(files(1), {}, { stallMs: 60_000 }), c);
    await new Promise((r) => setTimeout(r, 30));
    finish();
    expect((await pending).bv).toBe("BV1aaaaaaaaa"); // issue-guard: allow (fake BV fixture)
    expect(logs.some((m) => /progress not saved/.test(m))).toBe(true);
  });
});

// ── node-wide upload slot (plan 038 PR4) ─────────────────────────────────────

describe("biliup processor upload slot", () => {
  function fakeSlot(held: { v: boolean }) {
    return {
      index: null,
      acquire: async () => { if (held.v) return false; held.v = true; return true; },
      release: () => { held.v = false; },
      touch: () => {},
      close: () => {},
    };
  }

  it("takes the slot around every part and gives it back (one biliup at a time)", async () => {
    const held = { v: false };
    const overlap: boolean[] = [];
    const bvSeen: string[] = [];
    const run = vi.fn(async (argv: string[]) => {
      overlap.push(held.v);
      bvSeen.push(argv.includes("upload") ? "create" : "append");
      return argv.includes("upload") ? "BV1aaaaaaaaa" : "ok"; // issue-guard: allow (fake BV fixture)
    });
    const p = makeBiliupProcessor(base({ run, slot: fakeSlot(held) as never, lookup: { run: async () => "[]" }, countParts: async () => 1 }));
    const r = await p.run(job(files(3), {}, { stallMs: 60_000 }), ctx().c);
    expect(r.bv).toBe("BV1aaaaaaaaa"); // issue-guard: allow (fake BV fixture)
    expect(overlap).toEqual([true, true, true]);
    expect(bvSeen).toEqual(["create", "append", "append"]);
    expect(held.v).toBe(false); // released after the last part
  });

  it("waits for a busy slot instead of failing, and never spawns a second biliup", { timeout: 15_000 }, async () => {
    // A real slot: another holder owns it, we poll until it lets go.
    const dir = mkdtempSync(join(tmpdir(), "slot-"));
    const other = openUploadSlot(join(dir, "proc-queue.db"), { concurrency: 1, probe: () => null });
    expect(await other.acquire("rolling", 10)).toBe(true);
    let created = 0;
    const run = vi.fn(async (argv: string[]) => { created++; return argv.includes("upload") ? "BV1aaaaaaaaa" : "ok"; }); // issue-guard: allow (fake BV fixture)
    // Real time (1s poll): the other holder lets go shortly after we start waiting.
    const ours = openUploadSlot(join(dir, "proc-queue.db"), { concurrency: 1, probe: () => null });
    const release = setTimeout(() => other.release(), 20);
    try {
        const p = makeBiliupProcessor(base({ run, slot: ours, lookup: { run: async () => "[]" } }));
      const r = await p.run(job(files(1), {}, { stallMs: 60_000 }), ctx().c);
      expect(r.bv).toBe("BV1aaaaaaaaa"); // issue-guard: allow (fake BV fixture)
      expect(created).toBe(1);
      expect(ours.index).toBeNull(); // released after the part
    } finally { clearTimeout(release); other.close(); ours.close(); }
  });

  it("asks for a retry (not a failure) when no slot frees up within the wait limit", async () => {
    const run = vi.fn(async () => "BV1aaaaaaaaa"); // issue-guard: allow (fake BV fixture)
    const p = makeBiliupProcessor(base({ run, slotWaitMs: 1, slot: fakeSlot({ v: true }) as never, lookup: { run: async () => "[]" } }));
    // Nothing was uploaded, so this must stay retryable: treating it as uncertain would need manual review.
    expect(await p.run(job(files(1)), ctx().c)).toMatchObject({ outputs: [], retry: { reason: "slot-busy" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("without a slot nothing changes (old behaviour)", async () => {
    const run = vi.fn(async () => "BV1aaaaaaaaa"); // issue-guard: allow (fake BV fixture)
    const p = makeBiliupProcessor(base({ run, lookup: { run: async () => "[]" } }));
    expect((await p.run(job(files(1)), ctx().c)).bv).toBe("BV1aaaaaaaaa"); // issue-guard: allow (fake BV fixture)
    expect(run).toHaveBeenCalledTimes(1);
  });
});
