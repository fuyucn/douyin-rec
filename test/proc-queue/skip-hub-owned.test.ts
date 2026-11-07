import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PART_KINDS, jobIdOf, type PartCtx, type ProcessJob } from "@drec/core";
import { ProcQueueStore } from "@drec/proc-queue";

let root: string;
let store: ProcQueueStore;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skip-hub-"));
  mkdirSync(join(root, "recordings"), { recursive: true });
  clock = 1000;
  store = new ProcQueueStore(join(root, "db", "proc-queue.db"), { now: () => clock });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const file = (name: string): string => {
  const p = join(root, "recordings", name);
  writeFileSync(p, "x");
  return p;
};
const part = (path: string, seq: number, over: Partial<ProcessJob> = {}): ProcessJob => {
  const orderKey = "same-broadcast";
  const ctx: PartCtx = { v: 1, orderKey, index: seq, file: path, fp: { size: 1, mtimeMs: 1 } };
  return {
    jobId: jobIdOf(PART_KINDS.upload, orderKey + ":part-" + seq, 1), kind: PART_KINDS.upload,
    logicalKey: orderKey + ":part-" + seq, generation: 1, inputs: [path], params: { ctx },
    replaceInputs: false, owner: { taskId: 1, streamKey: orderKey }, createdAt: clock, orderKey, seq, ...over,
  };
};
const allowed = () => ({ allowedRoots: [join(root, "recordings")] });

describe("skipped(hub-owned) queue rows (plan 046 PR7)", () => {
  it("writes a terminal skipped row, never claims it, and creates no cleanup successor", () => {
    const p = file("a_000.ts");
    const r = store.enqueueSkipped(part(p, 1), allowed());
    expect(r.state).toBe("skipped");
    expect(store.get(r.jobId)).toMatchObject({ state: "skipped", orderKey: "same-broadcast", seq: 1 });
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
    store.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
    expect(store.claim({ kinds: [PART_KINDS.upload], owner: "A" })).toBeNull();
  });

  it("a skipped earlier seq does not block a later pending part, including after gc", () => {
    const p1 = file("a_000.ts");
    const p2 = file("a_001.ts");
    expect(store.enqueueSkipped(part(p1, 1), allowed()).state).toBe("skipped");
    expect(store.enqueue(part(p2, 2), allowed()).state).toBe("pending");
    store.acquireLease(PART_KINDS.upload, "A", { pid: process.pid });
    const claimed = store.claim({ kinds: [PART_KINDS.upload], owner: "A" });
    expect(claimed?.seq).toBe(2);
    expect(store.finish(claimed!.jobId, "A", { state: "done", outputs: [] })).toBe(true);
    const p3 = file("a_002.ts");
    expect(store.enqueue(part(p3, 3), allowed()).state).toBe("pending");
    clock += 10;
    expect(store.gc({ retainMs: 0 })).toBe(2);
    expect(store.claim({ kinds: [PART_KINDS.upload], owner: "A" })?.seq).toBe(3);
  });

  it("repeated skip is idempotent; a real pending row is never converted", () => {
    const p = file("a_000.ts");
    const first = store.enqueueSkipped(part(p, 1), allowed());
    expect(store.enqueueSkipped(part(p, 1), allowed()).state).toBe("skipped");
    const p2 = file("a_001.ts");
    expect(store.enqueue(part(p2, 2), allowed()).state).toBe("pending");
    const blocked = store.enqueueSkipped(part(p2, 2), allowed());
    expect(blocked.state).toBe("rejected");
    expect(store.get(blocked.jobId)?.state).toBe("pending");
    expect(first.state).toBe("skipped");
  });
});
