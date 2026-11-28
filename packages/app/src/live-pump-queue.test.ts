// T-220: zero-disk upload-pending handoff must be durable, idempotent, and must not duplicate
// a part that the queue already owns.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PART_KINDS } from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { appendConfirmedJournal, confirmLivePumpPart, livePumpHasUnconfirmed, livePumpStatePath, readConfirmedJournal, readLivePumpState, writeLivePumpState, type LivePumpState } from "@drec/zero-upload";
import { enqueueLivePumpPending } from "./live-pump-queue.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), writeSync: vi.fn(actual.writeSync) };
});

let root: string;
let oldRoot: string | undefined;

function stateWith(parts: Array<{ index: number; spoolPath: string; confirmed?: boolean; sealed?: boolean; validated?: boolean }>): LivePumpState {
  return {
    schemaVersion: 1, room: "q", createdAt: 1_000, title: "t", tid: 21, tag: "x", private: true, updatedAt: Date.now(),
    parts: parts.map((p) => ({
      index: p.index, spoolPath: p.spoolPath, filename: p.spoolPath.split("/").pop()!,
      stem: "s", title: "P" + (p.index + 1), bytes: 1, durationSec: 2, confirmed: p.confirmed ?? false,
      // T-221 (sol P1-2): the positive gate marker is REQUIRED for a deliverable row. An
      // open-time placeholder (sealed:false) never has one.
      ...(p.sealed === false || p.validated === false ? {} : { validated: true }),
      ...(p.sealed === false ? { sealed: false as const } : {}),
    })),
  };
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);
  vi.mocked(writeSync).mockImplementation(actual.writeSync);
  oldRoot = process.env.DOUYIN_REC_ROOT;
  root = mkdtempSync(join(tmpdir(), "live-queue-"));
  process.env.DOUYIN_REC_ROOT = root;
  mkdirSync(join(root, "recordings", "q"), { recursive: true });
  writeFileSync(join(root, "cookies.json"), JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "DedeUserID", value: "9" }, { name: "bili_jct", value: "csrf" }] },
  }));
});

afterEach(() => {
  vi.resetAllMocks();
  process.env.DOUYIN_REC_ROOT = oldRoot;
  rmSync(root, { recursive: true, force: true });
});

describe("enqueueLivePumpPending", () => {
  it("keeps protected accepted work with its original owner without opening the queue", () => {
    const path = livePumpStatePath(root, "q");
    const state = stateWith([{ index: 0, spoolPath: join(root, "part.ts") }]);
    state.submissionProofVersion = 1;
    state.parts[0]!.proof = "accepted";
    writeLivePumpState(path, state);
    expect(enqueueLivePumpPending({ statePath: path, cookiesPath: "unused" })).toMatchObject({
      queued: 0, already: 0, failed: 1, needsManual: 1,
    });
    expect(readLivePumpState(path)!.queueManaged).toBeUndefined();
    expect(existsSync(procQueueDbPath(root))).toBe(false);
  });
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

  it("skips open/incomplete parts per-index and still enqueues the sealed ones (T-221)", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    const p2 = join(dir, "c_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    writeFileSync(p2, "ccc");
    const statePath = livePumpStatePath(dir, "q");
    // T-221 recording shape: an incomplete spool, a sealed complete part, and the open
    // placeholder of the part currently being recorded.
    const st = stateWith([
      { index: 0, spoolPath: p0 },
      { index: 1, spoolPath: p1 },
      { index: 2, spoolPath: p2, sealed: false },
    ]);
    st.parts[0]!.spoolIncomplete = true;
    writeLivePumpState(statePath, st);

    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    // Order hole: the incomplete part 0 blocks EVERY later part from entering the queue now —
    // the runner appends in seq order and a later part appended first would be out of order forever.
    expect(r).toMatchObject({ queued: 0, failed: 3, already: 0 });
    // No rows: the marker is never invented on a zero-row batch (review P2).
    expect(readLivePumpState(statePath)?.queueManaged).toBeUndefined();
    const store = new ProcQueueStore(procQueueDbPath(root));
    try {
      expect(store.rowsForOrderSeq("q:1000", 1, PART_KINDS.upload, 1)).toHaveLength(0);
      expect(store.rowsForOrderSeq("q:1000", 2, PART_KINDS.upload, 1)).toHaveLength(0);
      expect(store.rowsForOrderSeq("q:1000", 3, PART_KINDS.upload, 1)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("T-221: a pending-index part is an order hole — later parts wait for the next cycle", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 1, spoolPath: p1 }]);
    st.pending = { kind: "append", partIndex: 0, stem: "s0", title: "P1", bytes: 3, durationSec: 2, spoolPath: p0 };
    writeLivePumpState(statePath, st);

    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    // Part 0's submit intent is unresolved; part 1 must NOT jump the order (the runner appends
    // in seq order — a later part appended first would be permanently out of order).
    expect(r).toMatchObject({ queued: 0, failed: 2, already: 0 });
    const store = new ProcQueueStore(procQueueDbPath(root));
    try {
      expect(store.rowsForOrderSeq("q:1000", 1, PART_KINDS.upload, 1)).toHaveLength(0);
      expect(store.rowsForOrderSeq("q:1000", 2, PART_KINDS.upload, 1)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("T-221 (sol P1-2): a sealed row without the positive validated marker is default-denied", () => {
    // A SIGKILL between noteSealed (real bytes + estimated duration hit the WAL) and the
    // background finalize leaves a perfectly ordinary-looking row. It must NOT be enqueued:
    // probe/DTS never ran on that file. Startup revalidation adopts it only after the gates pass.
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "unvalidated-sealed-bytes");
    writeFileSync(p1, "validated-bytes");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([
      { index: 0, spoolPath: p0, validated: false },
      { index: 1, spoolPath: p1 },
    ]);
    writeLivePumpState(statePath, st);

    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    // Order hole: the unvalidated part 0 blocks the validated part 1 from jumping the queue.
    expect(r).toMatchObject({ queued: 0, failed: 2, already: 0 });
    // sol P1-4: both rows are merely deferred (part 1 is only blocked behind part 0), so the CLI
    // classifier can retry — a needs-manual count here would wrongly pin the task in exit 75.
    expect(r.deferred).toBe(2);
    expect(r.needsManual ?? 0).toBe(0);
    expect(readLivePumpState(statePath)?.queueManaged).toBeUndefined();
    const store = new ProcQueueStore(procQueueDbPath(root));
    try {
      expect(store.rowsForOrderSeq("q:1000", 1, PART_KINDS.upload, 1)).toHaveLength(0);
      expect(store.rowsForOrderSeq("q:1000", 2, PART_KINDS.upload, 1)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("T-221 (sol P1-4): a truncated spool is reported as needs-manual, not merely deferred", () => {
    // A truncated spool can never settle by retrying. The classifier must see needsManual > 0 so
    // it reports `blocked` and the pump KEEPS RECORDING instead of exiting 75 on a loop no retry
    // can clear.
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    writeFileSync(p0, "truncated-bytes");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }]);
    const s0 = st.parts[0]!;
    writeLivePumpState(statePath, { ...st, parts: [{ ...s0, spoolIncomplete: true }] });
    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 0, failed: 1, already: 0 });
    expect(r.needsManual).toBe(1);
    expect(r.deferred ?? 0).toBe(0);
  });

  it("T-221 (sol P1-4): a missing spool is needs-manual; a missing validated marker is deferred", () => {
    const dir = join(root, "recordings", "q");
    const missing = join(dir, "gone_000.live.ts");
    const unvalidated = join(dir, "uv_000.live.ts");
    writeFileSync(unvalidated, "bytes");
    const statePath = livePumpStatePath(dir, "q");
    writeLivePumpState(statePath, stateWith([
      { index: 0, spoolPath: missing },
      { index: 1, spoolPath: unvalidated, validated: false },
    ]));
    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r.queued).toBe(0);
    expect(r.needsManual).toBe(1); // index 0 spool is gone
    expect(r.deferred).toBe(1); // index 1 only lacks the marker (and is blocked by index 0)
  });

  it("T-221: a journal-confirmed part is `already`, not re-enqueued", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 1, spoolPath: p1 }]);
    writeLivePumpState(statePath, st);
    appendConfirmedJournal(statePath, { index: 0, bv: "BV1", at: 1, createdAt: 1_000 });

    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 1, already: 1, failed: 0 });
    const store = new ProcQueueStore(procQueueDbPath(root));
    try {
      // Seq 1 stays reserved for the journal-confirmed part 0: only part 1 (seq 2) enqueues.
      expect(store.rowsForOrderSeq("q:1000", 1, PART_KINDS.upload, 1)).toHaveLength(0);
      expect(store.rowsForOrderSeq("q:1000", 2, PART_KINDS.upload, 1)).toHaveLength(1);
    } finally { store.close(); }
  });
});

describe("confirmLivePumpPart", () => {
  it("T-221: confirms land in the journal; the state file is left to the pump (sole writer)", () => {
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
    // The state file is the pump's; the confirmation went to the journal instead.
    expect(readLivePumpState(statePath)?.queueManaged).toBe(true);
    expect(readLivePumpState(statePath)?.parts[0]?.confirmed).toBe(false);
    expect(readConfirmedJournal(statePath).get(0)?.bv).toBe("BV1");
    expect(livePumpHasUnconfirmed(statePath)).toBe(true);
    const fp1 = { size: 3, mtimeMs: statSync(p1).mtimeMs };
    expect(confirmLivePumpPart(statePath, 1, "BV1", fp1)).toEqual({ ok: true });
    expect(readConfirmedJournal(statePath).get(1)?.bv).toBe("BV1");
    // Journal-settled: the live gate agrees there is nothing left to deliver.
    expect(livePumpHasUnconfirmed(statePath)).toBe(false);
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

  it("T-221 (sol P1-2): a journal-only hit re-syncs durably instead of approving the cleanup", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    writeFileSync(p0, "aaa");
    const statePath = livePumpStatePath(dir, "q");
    writeLivePumpState(statePath, stateWith([{ index: 0, spoolPath: p0 }]));
    const journal = `${statePath}.confirmed`;
    appendConfirmedJournal(statePath, { index: 0, bv: "BV1", at: 5, createdAt: 1_000 });
    const before = readFileSync(journal, "utf-8").split("\n").filter(Boolean).length;
    const fp = { size: 3, mtimeMs: statSync(p0).mtimeMs };
    vi.mocked(fsyncSync).mockClear().mockImplementationOnce(() => { throw new Error("sync failed"); });
    expect(confirmLivePumpPart(statePath, 0, "BV1", fp)).toEqual({
      ok: false, error: "confirmation journal re-sync failed: sync failed",
    });
    expect(fsyncSync).toHaveBeenCalledTimes(1);
    expect(readConfirmedJournal(statePath, 1_000).get(0)?.bv).toBe("BV1");
    expect(existsSync(p0)).toBe(true);
    expect(readLivePumpState(statePath)?.parts[0]?.confirmed).toBe(false);

    // A short write must finish the record before the retry may acknowledge cleanup.
    vi.mocked(writeSync).mockClear().mockImplementationOnce((fd, data) =>
      actual.writeSync(fd, (data as unknown as Buffer).subarray(0, 8)));
    vi.mocked(fsyncSync).mockClear();
    expect(confirmLivePumpPart(statePath, 0, "BV1", fp)).toEqual({ ok: true });
    expect(writeSync).toHaveBeenCalledTimes(2);
    expect(fsyncSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fsyncSync).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(writeSync).mock.invocationCallOrder[1]!,
    );
    expect(JSON.parse(readFileSync(journal, "utf-8").trim().split("\n").at(-1)!))
      .toEqual({ index: 0, bv: "BV1", at: 5, createdAt: 1_000 });
    const after = readFileSync(journal, "utf-8").split("\n").filter(Boolean).length;
    expect(after).toBe(before + 2);
    expect(readConfirmedJournal(statePath, 1_000).get(0)?.bv).toBe("BV1");

    // A state-confirmed row is durable already: no extra journal line is written.
    const st2 = readLivePumpState(statePath)!;
    writeLivePumpState(statePath, { ...st2, parts: st2.parts.map((p) => ({ ...p, confirmed: true })) });
    const before2 = readFileSync(journal, "utf-8").split("\n").filter(Boolean).length;
    vi.mocked(fsyncSync).mockClear();
    expect(confirmLivePumpPart(statePath, 0, "BV1", fp)).toEqual({ ok: true });
    expect(fsyncSync).not.toHaveBeenCalled();
    const after2 = readFileSync(journal, "utf-8").split("\n").filter(Boolean).length;
    expect(after2).toBe(before2);
  });
});
