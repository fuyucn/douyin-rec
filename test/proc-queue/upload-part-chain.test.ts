// plan 046 PR5 prelude: runner chains cleanup-part only from a confirmed upload-part success.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  PART_KINDS, jobIdOf, registerProcessor, _resetProcessors, type PartCtx, type Processor,
} from "@drec/core";
import { ProcRunner, type ProcRunnerOpts } from "@drec/proc-queue";
import { makeEnv, fakeProcessor, gate, type Env } from "./helpers.js";

let env: Env;
let alerts: string[];
const runners: ProcRunner[] = [];
const retryTasks: Array<{ at: number; run: () => void }> = [];
beforeEach(() => { env = makeEnv(); alerts = []; retryTasks.length = 0; _resetProcessors(); });
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop().catch(() => {});
  _resetProcessors();
  env.cleanup();
});
const allowed = () => ({ allowedRoots: [env.root] });
function mkRunner(over: Partial<ProcRunnerOpts> = {}): ProcRunner {
  const { store: overrideStore, ...opts } = over;
  const r = new ProcRunner({
    store: overrideStore ?? env.open(), owner: "A", diskMinGB: () => 0,
    alert: (_t, m) => alerts.push(m), timers: false, now: () => env.clock.t,
    chainAllowedRoots: [env.root],
    scheduleRetry: (run, delayMs) => {
      const task = { at: env.clock.t + delayMs, run };
      retryTasks.push(task);
      return () => { const i = retryTasks.indexOf(task); if (i >= 0) retryTasks.splice(i, 1); };
    },
    ...opts,
  });
  runners.push(r);
  r.start();
  return r;
}
async function advanceRetryClock(ms: number): Promise<void> {
  for (const r of runners) r.heartbeat();
  env.clock.t += ms;
  for (const r of runners) r.heartbeat();
  for (let pass = 0; pass < 20; pass += 1) {
    const due = [...retryTasks.filter((t) => t.at <= env.clock.t)];
    for (const t of due) { retryTasks.splice(retryTasks.indexOf(t), 1); t.run(); }
    for (const r of runners) r.tick();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    if (due.length === 0) break;
  }
}
const ctxOf = (file: string, bv?: string, index = 1): PartCtx => {
  const s = statSync(file);
  return { v: 1, orderKey: "same-broadcast", index, file, fp: { size: s.size, mtimeMs: s.mtimeMs }, ...(bv ? { bv } : {}) };
};
const partJob = (file: string, mode?: string, logicalKey = "same-broadcast:part-1", orderKey = "same-broadcast", seq = 1) => ({
  jobId: jobIdOf(PART_KINDS.upload, logicalKey, 1), kind: PART_KINDS.upload, logicalKey, generation: 1,
  inputs: [file], params: {
    ctx: ctxOf(file, undefined, seq), partWorkflow: mode, cookies: "c", title: "t", tid: 21, tag: "tag",
  }, replaceInputs: false, owner: { taskId: 1 }, createdAt: env.clock.t,
  orderKey, seq,
});
const confirmed = (bv: string) => ({ outputs: [], bv, confirmed: { size: 1, mtimeMs: 1, ackedBytes: 10 } });
const proc = (over: Partial<Processor> = {}): Processor => ({
  ...fakeProcessor({ kind: PART_KINDS.upload, resource: "upload", lane: "biliup", retryable: false, interruptible: false }),
  ...over,
});

describe("upload-part runner chain", () => {
  it("rolling: done + exactly one cleanup successor in one transaction, ctx bv from confirmed row", async () => {
    const file = env.file("a_000.ts");
    const c = ctxOf(file);
    registerProcessor(proc({ run: async () => ({ ...confirmed("CONFIRMED"), confirmed: { size: c.fp.size, mtimeMs: c.fp.mtimeMs, ackedBytes: c.fp.size } }) }));
    const r = mkRunner();
    const s = env.open();
    const job = partJob(file, "rolling");
    const id = s.enqueue(job, allowed()).jobId;
    s.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
    r.tick();
    await vi.waitFor(() => expect(s.get(id)?.state).toBe("done"));
    const cleanupId = jobIdOf(PART_KINDS.cleanup, job.logicalKey, 1);
    expect(s.get(cleanupId)).toMatchObject({ kind: PART_KINDS.cleanup, state: "pending" });
    expect((s.get(cleanupId)?.params.ctx as PartCtx).bv).toBe("CONFIRMED");
    expect(s.list({ kind: PART_KINDS.cleanup })).toHaveLength(1);
  });

  it("whole-order / missing mode do NOT chain, but still finish done (conservative default)", async () => {
    const file = env.file("a_000.ts");
    const c = ctxOf(file);
    registerProcessor(proc({ run: async () => ({ ...confirmed("CONFIRMED"), confirmed: { size: c.fp.size, mtimeMs: c.fp.mtimeMs, ackedBytes: c.fp.size } }) }));
    const r = mkRunner();
    const s = env.open();
    const [a, b] = ["whole-order", undefined].map((mode, i) => {
      const key = "same-broadcast:part-" + String(i + 1);
      return s.enqueue(partJob(file, mode, key, "order-" + String(i + 1), 1), allowed()).jobId;
    });
    s.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
    r.tick();
    await vi.waitFor(() => { r.tick(); expect(s.get(a)?.state).toBe("done"); expect(s.get(b)?.state).toBe("done"); });
    expect(s.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("chain transaction failure rolls back: row stays running, no done-without-successor", async () => {
    const file = env.file("a_000.ts");
    const c = ctxOf(file);
    const injected = new Error("injected chain insert failure");
    const store = env.open();
    const original = store.completeAndChain.bind(store);
    vi.spyOn(store, "completeAndChain").mockImplementation(() => ({ ok: false, error: injected.message }));
    registerProcessor(proc({ run: async () => ({ ...confirmed("CONFIRMED"), confirmed: { size: c.fp.size, mtimeMs: c.fp.mtimeMs, ackedBytes: c.fp.size } }) }));
    const r = mkRunner({ store });
    const job = partJob(file, "rolling");
    const id = store.enqueue(job, allowed()).jobId;
    store.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
    r.tick();
    await vi.waitFor(() => expect(alerts.some((m) => m.includes("链出失败"))).toBe(true));
    expect(store.get(id)?.state).toBe("running");
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
    expect(original).toBeTypeOf("function");
  });

  it("no confirmation evidence means no chain (the source cannot be deleted by an unconfirmed upload)", async () => {
    const file = env.file("a_000.ts");
    registerProcessor(proc({ run: async () => ({ outputs: [], bv: "CONFIRMED" }) }));
    const r = mkRunner();
    const s = env.open();
    const job = partJob(file, "rolling");
    const id = s.enqueue(job, allowed()).jobId;
    s.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
    r.tick();
    await vi.waitFor(() => expect(s.get(id)?.state).toBe("done"));
    expect(s.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("stale fp or too few acked bytes means no chain (even if the row has a bv)", async () => {
    const file = env.file("a_000.ts");
    const c = ctxOf(file);
    const bad = [
      { size: c.fp.size + 1, mtimeMs: c.fp.mtimeMs, ackedBytes: c.fp.size },
      { size: c.fp.size, mtimeMs: c.fp.mtimeMs + 1, ackedBytes: c.fp.size },
      { size: c.fp.size, mtimeMs: c.fp.mtimeMs, ackedBytes: c.fp.size - 1 },
    ];
    for (const [i, evidence] of bad.entries()) {
      _resetProcessors();
      registerProcessor(proc({ run: async () => ({ outputs: [], bv: "CONFIRMED", confirmed: evidence }) }));
      const r = mkRunner();
      const s = env.open();
      const key = "same-broadcast:bad-" + String(i);
      const id = s.enqueue(partJob(file, "rolling", key, "order-bad-" + String(i), 1), allowed()).jobId;
      s.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
      r.tick();
      await vi.waitFor(() => expect(alerts.some((m) => m.includes("确认证据不足"))).toBe(true));
      expect(s.get(id)?.state).toBe("running");
      expect(s.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
      alerts.length = 0;
      await r.stop();
    }
  });

  it("a stale attempts snapshot still chains after re-entry (fresh row CAS)", async () => {
    const file = env.file("a_000.ts");
    const c = ctxOf(file);
    const s = env.open();
    const bump = vi.fn(() => {
      const raw = new DatabaseSync(env.dbPath);
      raw.prepare("UPDATE proc_jobs SET attempts=attempts+1 WHERE state='running'").run();
      raw.close();
    });
    registerProcessor(proc({ run: async () => {
      bump();
      return { ...confirmed("CONFIRMED"), confirmed: { size: c.fp.size, mtimeMs: c.fp.mtimeMs, ackedBytes: c.fp.size } };
    } }));
    const r = mkRunner({ store: s });
    const id = s.enqueue(partJob(file, "rolling"), allowed()).jobId;
    s.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
    r.tick();
    await vi.waitFor(() => expect(s.get(id)?.state).toBe("done"));
    expect(s.list({ kind: PART_KINDS.cleanup })).toHaveLength(1);
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it("rate-limit re-entry never chains cleanup and does not double-submit the same claim", async () => {
    let phase: "rate" | "ok" = "rate";
    const upFile = env.file("a_000.ts");
    const c0 = ctxOf(upFile);
    const run = vi.fn(async () => {
      if (phase === "rate") throw new Error("code: 21566 投稿过于频繁");
      return { ...confirmed("CONFIRMED"), confirmed: { size: c0.fp.size, mtimeMs: c0.fp.mtimeMs, ackedBytes: c0.fp.size } };
    });
    registerProcessor(proc({ run }));
    env.clock.t = 1_000_000;
    const r = mkRunner();
    const s = env.open();
    const id = s.enqueue(partJob(upFile, "rolling"), allowed()).jobId;
    s.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
    r.tick();
    await vi.waitFor(() => expect(s.get(id)?.state).toBe("pending"));
    expect(s.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(1);
    phase = "ok";
    for (const rr of runners) rr.heartbeat();
    await advanceRetryClock(5 * 60_000);
    await vi.waitFor(() => { r.tick(); expect(run).toHaveBeenCalledTimes(2); expect(s.get(id)?.state).toBe("done"); });
    expect(s.list({ kind: PART_KINDS.cleanup })).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(existsSync(upFile)).toBe(true);
  });

  it("HIGH 5: a skipped placeholder predecessor does not block the next part (create is allowed)", async () => {
    const file1 = env.file("a_000.ts");
    const file2 = env.file("a_001.ts");
    const s = env.open();
    const j1 = partJob(file1, "rolling", "same-broadcast:part:1", "same-broadcast", 1);
    const skipped = { ...j1, params: { ...j1.params, partWorkflow: "rolling" } };
    expect(s.enqueueSourceGone(skipped, { allowedRoots: [env.root] }).state).toBe("skipped");
    const j2 = partJob(file2, "rolling", "same-broadcast:part:2", "same-broadcast", 2);
    const id2 = s.enqueue({ ...j2, jobId: jobIdOf(PART_KINDS.upload, "same-broadcast:part:2", 1) }, allowed()).jobId;
    const seenBv: Array<string | undefined> = [];
    const c2 = ctxOf(file2);
    registerProcessor(proc({ run: async (j) => {
      seenBv.push((j.params.ctx as PartCtx).bv);
      return { outputs: [], bv: "NEWDRAFT01", confirmed: { size: c2.fp.size, mtimeMs: c2.fp.mtimeMs, ackedBytes: c2.fp.size } };
    } }));
    const r = mkRunner();
    s.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
    r.tick();
    await vi.waitFor(() => expect(s.get(id2)?.state).toBe("done"));
    expect(seenBv).toEqual([undefined]); // no confirmed predecessor => create, not a thrown failure
    expect(s.get(id2)?.bv).toBe("NEWDRAFT01");
  });

});
