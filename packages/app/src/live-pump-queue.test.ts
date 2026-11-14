// T-220: zero-disk upload-pending handoff must be durable, idempotent, and must not duplicate
// a part that the queue already owns.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PART_KINDS } from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { confirmLivePumpPart, livePumpStatePath, readLivePumpState, writeLivePumpState, type LivePumpState } from "@drec/zero-upload";
import { enqueueLivePumpPending } from "./live-pump-queue.js";

let root: string;
let oldRoot: string | undefined;

function stateWith(parts: Array<{ index: number; spoolPath: string; confirmed?: boolean }>): LivePumpState {
  return {
    schemaVersion: 1, room: "q", createdAt: 1_000, title: "t", tid: 21, tag: "x", private: true, updatedAt: Date.now(),
    parts: parts.map((p) => ({
      index: p.index, spoolPath: p.spoolPath, filename: p.spoolPath.split("/").pop()!,
      stem: "s", title: "P" + (p.index + 1), bytes: 1, durationSec: 2, confirmed: p.confirmed ?? false,
    })),
  };
}

beforeEach(() => {
  oldRoot = process.env.DOUYIN_REC_ROOT;
  root = mkdtempSync(join(tmpdir(), "live-queue-"));
  process.env.DOUYIN_REC_ROOT = root;
  mkdirSync(join(root, "recordings", "q"), { recursive: true });
  writeFileSync(join(root, "cookies.json"), JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "DedeUserID", value: "9" }, { name: "bili_jct", value: "csrf" }] },
  }));
});

afterEach(() => {
  process.env.DOUYIN_REC_ROOT = oldRoot;
  rmSync(root, { recursive: true, force: true });
});

describe("enqueueLivePumpPending", () => {
  it("queues every sealed unconfirmed part atomically and marks the state queue-managed", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 1, spoolPath: p1 }]);
    writeLivePumpState(statePath, st);

    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 2, already: 0, failed: 0 });
    expect(readLivePumpState(statePath)?.queueManaged).toBe(true);

    const store = new ProcQueueStore(procQueueDbPath(root));
    try {
      for (const seq of [1, 2]) {
        const row = store.rowsForOrderSeq("q:1000", seq, PART_KINDS.upload, 1);
        expect(row).toHaveLength(1);
        expect(row[0]).toMatchObject({ state: "pending", seq, kind: PART_KINDS.upload });
        expect(row[0]!.params).toMatchObject({
          partWorkflow: "live-pump", liveStatePath: statePath, title: "t", tid: 21, tag: "x", public: false,
        });
        expect(row[0]!.inputs).toEqual([seq === 1 ? p0 : p1]);
      }
    } finally { store.close(); }

    const again = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(again).toMatchObject({ queued: 0, already: 2, failed: 0 });
  });

  it("keeps a confirmed earlier part's seq reserved (no collision with its done row)", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0, confirmed: true }, { index: 1, spoolPath: p1 }]);
    st.bvid = "BV1";
    writeLivePumpState(statePath, st);
    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 1, already: 1, failed: 0 });
    const store = new ProcQueueStore(procQueueDbPath(root));
    try {
      expect(store.rowsForOrderSeq("q:1000", 1, PART_KINDS.upload, 1)).toHaveLength(0);
      const row = store.rowsForOrderSeq("q:1000", 2, PART_KINDS.upload, 1)[0]!;
      expect((row.params.ctx as { index: number }).index).toBe(2);
      expect(row.params.liveStateIndex).toBe(1);
    } finally { store.close(); }
  });

  it("uses contiguous queue seq for a sparse live state (held part gap) and keeps liveStateIndex", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p2 = join(dir, "c_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p2, "ccc");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 2, spoolPath: p2 }]);
    st.bvid = "BV1";
    writeLivePumpState(statePath, st);
    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r.queued).toBe(2);
    const store = new ProcQueueStore(procQueueDbPath(root));
    try {
      const row1 = store.rowsForOrderSeq("q:1000", 1, PART_KINDS.upload, 1)[0]!;
      const row2 = store.rowsForOrderSeq("q:1000", 2, PART_KINDS.upload, 1)[0]!;
      expect((row1.params.ctx as { index: number }).index).toBe(1);
      expect((row2.params.ctx as { index: number }).index).toBe(2);
      expect(row1.params.liveStateIndex).toBe(0);
      expect(row2.params.liveStateIndex).toBe(2);
      expect((row1.params.ctx as { bv?: string }).bv).toBe("BV1");
    } finally { store.close(); }
  });

  it("skips confirmed/held/incomplete parts and keeps the queue marker fail-closed", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 1, spoolPath: p1, confirmed: true }]);
    st.parts[0]!.spoolIncomplete = true;
    writeLivePumpState(statePath, st);

    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 0, failed: 1, already: 1 });
    expect(readLivePumpState(statePath)?.queueManaged).toBeUndefined();
    const store = new ProcQueueStore(procQueueDbPath(root));
    try { expect(store.rowsForOrderSeq("q:1000", 1, PART_KINDS.upload, 1)).toHaveLength(0); } finally { store.close(); }
  });
});

describe("confirmLivePumpPart", () => {
  it("confirms in order and clears queueManaged only when every part + the WAL are settled", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 1, spoolPath: p1 }]);
    writeLivePumpState(statePath, { ...st, queueManaged: true });
    const fp0 = { size: 3, mtimeMs: statSync(p0).mtimeMs };
    expect(confirmLivePumpPart(statePath, 0, "BV1", fp0)).toEqual({ ok: true });
    expect(readLivePumpState(statePath)?.queueManaged).toBe(true);
    const fp1 = { size: 3, mtimeMs: statSync(p1).mtimeMs };
    expect(confirmLivePumpPart(statePath, 1, "BV1", fp1)).toEqual({ ok: true });
    expect(readLivePumpState(statePath)?.queueManaged).toBeUndefined();
  });

  it("refuses a changed fingerprint and a different bv (never claims an unproven part)", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    writeFileSync(p0, "aaa");
    const statePath = livePumpStatePath(dir, "q");
    writeLivePumpState(statePath, stateWith([{ index: 0, spoolPath: p0 }]));
    expect(confirmLivePumpPart(statePath, 0, "BV1", { size: 3, mtimeMs: 1 })).toMatchObject({ ok: false });
    expect(confirmLivePumpPart(statePath, 0, "BV1", { size: 3, mtimeMs: statSync(p0).mtimeMs })).toEqual({ ok: true });
    expect(confirmLivePumpPart(statePath, 0, "BV2", { size: 3, mtimeMs: statSync(p0).mtimeMs })).toMatchObject({ ok: false });
  });
});
