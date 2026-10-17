// plan 038 T11: hub-recover-order planner + runner (dry-run default, new generation only).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { jobIdOf, type EnqueueRequest } from "@drec/core";
import { ProcQueueStore } from "@drec/proc-queue";
import { planRecoverOrder, runRecoverOrder, type RecoverDeps, type RecoverRunDeps } from "../../packages/cli/src/hub-recover-order.js";
import { parseRecoverPayload } from "../../packages/cli/src/hub-recover-order-commands.js";
import { makeEnv, type Env } from "../proc-queue/helpers.js";

let env: Env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => env.cleanup());

const ORDER = "douyin:1:2026-10-17";
const BV = "BV1abcdefghi"; // issue-guard: allow (fake BV fixture)
const noDraft: RecoverDeps = { lookup: { run: async () => "" } };
const roots = (): { allowedRoots: string[] } => ({ allowedRoots: [env.root] });

/** Seed generation 1: prep (seq 1) then a three-part biliup row (seq 2) bound to it. */
function seed(s: ProcQueueStore, biliupParams: Record<string, unknown> = {}): { prepId: string; upId: string } {
  const prep = env.job("seg.ts", {
    kind: "upload-prep", logicalKey: `${ORDER}:prep`, orderKey: ORDER, seq: 1, outputs: [env.file("stage-1.mp4")],
  });
  const parts = ["p1.mp4", "p2.mp4", "p3.mp4"].map((n) => env.file(n));
  const up = env.job("p1.mp4", {
    kind: "biliup", logicalKey: `${ORDER}:up`, orderKey: ORDER, seq: 2, prepJobId: prep.jobId, inputs: parts,
    params: { cookies: "/c.json", title: "t", tid: 21, tag: "x", expectedDurationSec: 600, ...biliupParams },
  });
  s.enqueueBatch([prep, up], roots());
  return { prepId: prep.jobId, upId: up.jobId };
}

const lease = (s: ProcQueueStore, kind: string): void => { s.acquireLease(kind, "A", { pid: process.pid }); };

/** Drive the prep row to a terminal state through the real claim/finish path. */
function endPrep(s: ProcQueueStore, state: "done" | "failed"): void {
  lease(s, "upload-prep");
  const c = s.claim({ kinds: ["upload-prep"], owner: "A" })!;
  s.finish(c.jobId, "A", state === "done" ? { state: "done", outputs: c.outputs ?? [] } : { state: "failed", error: "prep boom" });
  if (state === "failed") s.cascadePrepFailed(ORDER, 1);
}

/** After a done prep, run the biliup row into a failed state (optionally with a recorded BV). */
function failUpload(s: ProcQueueStore, bv?: string): void {
  lease(s, "biliup");
  const c = s.claim({ kinds: ["biliup"], owner: "A" })!;
  if (bv) s.setBv(c.jobId, bv);
  s.finish(c.jobId, "A", { state: "failed", error: "upload boom" });
}

const applyDeps = (): RecoverRunDeps => ({
  ...noDraft,
  enqueue: (r: EnqueueRequest) => {
    const w = new ProcQueueStore(env.dbPath);
    try { return { v: 1, results: w.enqueueBatch(r.jobs, roots()) }; } finally { w.close(); }
  },
});

describe("planRecoverOrder refusals", () => {
  it("unknown orderKey", async () => {
    const s = env.open();
    const p = await planRecoverOrder(s, { orderKey: "nope", mode: "prep" });
    expect(p).toMatchObject({ ok: false, refusal: "unknown orderKey" });
  });

  it("refuses while the latest generation still has pending rows", async () => {
    const s = env.open();
    seed(s);
    const p = await planRecoverOrder(s, { orderKey: ORDER, mode: "prep" });
    expect(p.ok).toBe(false);
    expect(p.refusal).toMatch(/still active/);
  });

  it("refuses when a recorded child may still be running", async () => {
    const s = env.open();
    const { upId } = seed(s);
    endPrep(s, "done");
    failUpload(s);
    s.setChildPid(upId, 4242, "T0");
    const live = { probe: (pid: number) => ({ pid, startedAt: "T0", cmdline: "biliup" }) };
    const p = await planRecoverOrder(s, { orderKey: ORDER, mode: "restart" }, { ...noDraft, ...live });
    expect(p.refusal).toMatch(/child process/);
    const gone = await planRecoverOrder(s, { orderKey: ORDER, mode: "restart" }, { ...noDraft, probe: () => null });
    expect(gone.ok).toBe(true);
  });
});

describe("--prep", () => {
  it("dry-run changes nothing; apply creates a new generation bound to the new prep, old rows untouched", async () => {
    const s = env.open();
    const { prepId, upId } = seed(s);
    endPrep(s, "failed");
    const before = s.list().map((r) => [r.jobId, r.state]);

    const dry = await runRecoverOrder(env.root, { orderKey: ORDER, mode: "prep" }, false, applyDeps());
    expect(dry).toMatchObject({ applied: false, plan: { ok: true, newGeneration: 2 } });
    expect(s.list().map((r) => [r.jobId, r.state])).toEqual(before);

    const run = await runRecoverOrder(env.root, { orderKey: ORDER, mode: "prep" }, true, applyDeps());
    expect(run.applied).toBe(true);
    const newPrep = jobIdOf("upload-prep", `${ORDER}:prep`, 2);
    const newUp = s.get(jobIdOf("biliup", `${ORDER}:up`, 2))!;
    expect(newUp).toMatchObject({ state: "pending", generation: 2, seq: 2, prepJobId: newPrep });
    expect(s.get(prepId)?.state).toBe("failed");
    expect(s.get(upId)?.state).toBe("cancelled");

    // Old terminal rows never block the new generation: the new prep is claimable immediately.
    lease(s, "upload-prep");
    expect(s.claim({ kinds: ["upload-prep"], owner: "A" })?.jobId).toBe(newPrep);

    // Running it twice is refused: the new generation is active.
    const again = await runRecoverOrder(env.root, { orderKey: ORDER, mode: "prep" }, true, applyDeps());
    expect(again).toMatchObject({ applied: false, plan: { ok: false } });
    expect(again.plan.refusal).toMatch(/still active/);
  });

  it("refuses once a biliup row already ran", async () => {
    const s = env.open();
    seed(s);
    endPrep(s, "done");
    failUpload(s);
    const p = await planRecoverOrder(s, { orderKey: ORDER, mode: "prep" });
    expect(p.refusal).toMatch(/prep already done/);
  });
});

describe("--bv", () => {
  async function failedWithDraft(bv?: string): Promise<ProcQueueStore> {
    const s = env.open();
    seed(s);
    endPrep(s, "done");
    failUpload(s, bv);
    return s;
  }

  it("appends only the parts from --from-part onto the verified draft", async () => {
    const s = await failedWithDraft(BV);
    const p = await planRecoverOrder(s, { orderKey: ORDER, mode: "bv", bv: BV, fromPart: 3 });
    expect(p.ok).toBe(true);
    const job = p.jobs[0]!;
    expect(job.inputs).toHaveLength(1);
    expect(job.inputs[0]).toMatch(/p3\.mp4$/);
    expect(job.params.bv).toBe(BV);
    expect(job.generation).toBe(2);
    // The prep it waits on is the old, done one.
    expect(job.prepJobId).toBe(jobIdOf("upload-prep", `${ORDER}:prep`, 1));
  });

  it.each([
    ["missing --from-part", { bv: BV }, /from-part/],
    ["--from-part below 2", { bv: BV, fromPart: 1 }, /from-part/],
    ["nothing left to append", { bv: BV, fromPart: 4 }, /nothing to append/],
    ["malformed BV", { bv: "BV123", fromPart: 2 }, /valid BV/],
  ])("refuses: %s", async (_n, extra, re) => {
    const s = await failedWithDraft(BV);
    const p = await planRecoverOrder(s, { orderKey: ORDER, mode: "bv", ...extra });
    expect(p.ok).toBe(false);
    expect(p.refusal).toMatch(re);
  });

  it("refuses when the queue recorded a different BV", async () => {
    const s = await failedWithDraft("BV1zzzzzzzzz"); // issue-guard: allow (fake BV fixture)
    const p = await planRecoverOrder(s, { orderKey: ORDER, mode: "bv", bv: BV, fromPart: 2 });
    expect(p.refusal).toMatch(/differs/);
  });
});

describe("--restart", () => {
  it("creates a fresh generation only when the archive lookup proves no draft", async () => {
    const s = env.open();
    seed(s);
    endPrep(s, "done");
    failUpload(s);
    const p = await planRecoverOrder(s, { orderKey: ORDER, mode: "restart" }, noDraft);
    expect(p).toMatchObject({ ok: true, newGeneration: 2 });
    expect(p.jobs[0]!.inputs).toHaveLength(3);
    expect(p.jobs[0]!.params.bv).toBeUndefined();
  });

  it("refuses on unknown archive state (lookup failure)", async () => {
    const s = env.open();
    seed(s);
    endPrep(s, "done");
    failUpload(s);
    const failing: RecoverDeps = { lookup: { run: async () => { throw new Error("net"); } } };
    const p = await planRecoverOrder(s, { orderKey: ORDER, mode: "restart" }, failing);
    expect(p.ok).toBe(false);
    expect(p.refusal).toMatch(/cannot confirm no draft/);
  });

  it("refuses when a draft BV is already known or the proof inputs are missing", async () => {
    const s = env.open();
    seed(s);
    endPrep(s, "done");
    failUpload(s, BV);
    expect((await planRecoverOrder(s, { orderKey: ORDER, mode: "restart" }, noDraft)).refusal).toMatch(/use --bv/);

    const e2 = makeEnv();
    try {
      const s2 = e2.open();
      const prep = e2.job("seg.ts", { kind: "upload-prep", logicalKey: "o2:prep", orderKey: "o2", seq: 1, outputs: [e2.file("s.mp4")] });
      const up = e2.job("p1.mp4", { kind: "biliup", logicalKey: "o2:up", orderKey: "o2", seq: 2, prepJobId: prep.jobId, params: { cookies: "/c", title: "t", tid: 1, tag: "x" } });
      s2.enqueueBatch([prep, up], { allowedRoots: [e2.root] });
      s2.acquireLease("upload-prep", "A", { pid: process.pid });
      const c = s2.claim({ kinds: ["upload-prep"], owner: "A" })!;
      s2.finish(c.jobId, "A", { state: "done", outputs: c.outputs ?? [] });
      s2.acquireLease("biliup", "A", { pid: process.pid });
      s2.finish(s2.claim({ kinds: ["biliup"], owner: "A" })!.jobId, "A", { state: "failed", error: "x" });
      const p = await planRecoverOrder(s2, { orderKey: "o2", mode: "restart" }, noDraft);
      expect(p.refusal).toMatch(/expectedDurationSec/);
    } finally {
      e2.cleanup();
    }
  });

  it("refuses when prep outputs vanished from disk", async () => {
    const s = env.open();
    seed(s);
    endPrep(s, "done");
    failUpload(s);
    const p = await planRecoverOrder(s, { orderKey: ORDER, mode: "restart" }, { ...noDraft, fileExists: () => false });
    expect(p.refusal).toMatch(/prep outputs are missing/);
  });
});

describe("runRecoverOrder", () => {
  it("refuses when there is no queue db under the data root", async () => {
    const r = await runRecoverOrder(`${env.root}/nowhere`, { orderKey: ORDER, mode: "prep" }, true, applyDeps());
    expect(r).toMatchObject({ applied: false, plan: { ok: false } });
  });
});

describe("parseRecoverPayload", () => {
  it("accepts a well-formed payload and defaults apply to false", () => {
    expect(parseRecoverPayload({ orderKey: "k", mode: "bv", bv: BV, fromPart: 2 }))
      .toEqual({ req: { orderKey: "k", mode: "bv", bv: BV, fromPart: 2 }, apply: false });
    expect(parseRecoverPayload({ orderKey: "k", mode: "prep", apply: true }).apply).toBe(true);
  });

  it.each([
    [null], [{}], [{ orderKey: "", mode: "prep" }], [{ orderKey: "k", mode: "wipe" }],
    [{ orderKey: "k", mode: "bv", bv: 7 }], [{ orderKey: "k", mode: "bv", fromPart: 1.5 }],
  ])("rejects malformed payload %j", (raw) => {
    expect(() => parseRecoverPayload(raw)).toThrow();
  });
});
