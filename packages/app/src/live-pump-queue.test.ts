import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PART_KINDS, jobIdOf, partLogicalKey, type ProcessJob } from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { uploadAliasPath } from "@drec/processors";
import { appendConfirmedJournal, confirmLivePumpPart, livePumpHasUnconfirmed, livePumpStatePath, readConfirmedJournal, readLivePumpState, writeLivePumpState, type LivePumpState } from "@drec/zero-upload";
import { enqueueLivePumpPending } from "./live-pump-queue.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), readFileSync: vi.fn(actual.readFileSync), writeSync: vi.fn(actual.writeSync) };
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
  vi.mocked(readFileSync).mockImplementation(actual.readFileSync);
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
      queued: 0, already: 0, failed: 1, needsManual: 1, blocked: expect.stringContaining("UPOS"),
    });
    expect(readLivePumpState(path)!.queueManaged).toBeUndefined();
    expect(existsSync(procQueueDbPath(root))).toBe(false);
  });

  it.each(["accepted without pending", "intent", "observed", "never-attempted successor"] as const)(
    "blocks protected %s before credentials, journal or queue access", (disposition) => {
      const dir = join(root, "recordings", "q");
      const file = join(dir, "protected.ts");
      const later = join(dir, "later.ts");
      writeFileSync(file, "video");
      const alias = uploadAliasPath(file);
      mkdirSync(dirname(alias), { recursive: true });
      linkSync(file, alias);
      const state = stateWith([{ index: 0, spoolPath: file }]);
      state.submissionProofVersion = 1;
      state.bvid = "BV1";
      state.aid = 7;
      const part = state.parts[0]!;
      part.bytes = 5;
      part.stem = "native-first";
      part.nativeKey = part.stem;
      if (disposition === "accepted without pending") {
        part.proof = "accepted";
        part.acceptedAt = 1_001;
      } else if (disposition === "intent") {
        state.pending = { kind: "append", submissionState: "intent", partIndex: 0,
          stem: part.stem, title: part.title, bytes: part.bytes, durationSec: part.durationSec, spoolPath: file };
      } else {
        part.confirmed = true;
        part.proof = "observed";
        part.observedAt = 1_002;
      }
      if (disposition === "never-attempted successor") {
        writeFileSync(later, "later");
        state.parts.push({ ...stateWith([{ index: 1, spoolPath: later }]).parts[0]!, stem: "native-later" });
      }
      const statePath = livePumpStatePath(dir, "q");
      writeLivePumpState(statePath, state);
      appendConfirmedJournal(statePath, { index: 0, bv: "BV-stale", at: 1_003, createdAt: state.createdAt });
      const before = readFileSync(statePath, "utf-8");
      vi.mocked(readFileSync).mockClear();

      const queued = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "missing-cookies.json") });

      expect(queued).toMatchObject({ queued: 0, already: 0,
        failed: disposition === "observed" ? 0 : 1, blocked: expect.stringContaining("UPOS") });
      expect(queued.error).toBeUndefined();
      expect(vi.mocked(readFileSync).mock.calls.map(([path]) => String(path))).toEqual([statePath]);
      expect(existsSync(procQueueDbPath(root))).toBe(false);
      expect(readFileSync(statePath, "utf-8")).toBe(before);
      expect(readFileSync(file, "utf-8")).toBe("video");
      expect(readFileSync(alias, "utf-8")).toBe("video");
      if (disposition === "never-attempted successor") expect(readFileSync(later, "utf-8")).toBe("later");
    },
  );

  it.each([
    ["protected", "pending"], ["protected", "done"], ["protected", "skipped"],
    ["legacy", "pending"], ["legacy", "done"], ["legacy", "skipped"],
  ] as const)(
    "does not derive %s ownership from a stale %s row or confirmation journal", (mode, history) => {
      const file = join(root, "recordings", "q", "protected.ts");
      writeFileSync(file, "video");
      const statePath = livePumpStatePath(dirname(file), "q");
      const state = stateWith([{ index: 0, spoolPath: file }]);
      if (mode === "protected")
        state.parts[0] = { ...state.parts[0]!, proof: "accepted", nativeKey: "s", acceptedAt: 1_001 };
      writeLivePumpState(statePath, state);
      appendConfirmedJournal(statePath, { index: 0, bv: "BV-stale", at: 1_002, createdAt: state.createdAt });
      const orderKey = "q:1000";
      const logicalKey = partLogicalKey(orderKey, 1);
      const stat = statSync(file);
      const job: ProcessJob = { jobId: jobIdOf(PART_KINDS.upload, logicalKey, 1), kind: PART_KINDS.upload,
        logicalKey, generation: 1, inputs: [file], params: { partWorkflow: "live-pump", liveStatePath: statePath,
          ctx: { v: 1, orderKey, index: 1, file, fp: { size: stat.size, mtimeMs: stat.mtimeMs } } },
        replaceInputs: false, owner: { streamKey: orderKey }, createdAt: 1_000, orderKey, seq: 1 };
      const store = new ProcQueueStore(procQueueDbPath(root));
      try {
        const seeded = history === "done"
          ? store.importConfirmedPart(job, { allowedRoots: [root], bv: "BV-stale" })
          : history === "skipped" ? store.enqueueSourceGone(job, { allowedRoots: [root] })
            : store.enqueue(job, { allowedRoots: [root] });
        expect(seeded.state).toBe(history);
        const rows = store.list();
        const before = readFileSync(statePath, "utf-8");
        vi.mocked(readFileSync).mockClear();

        expect(enqueueLivePumpPending({ statePath, cookiesPath: "unused" })).toMatchObject({
          queued: 0, already: 0, failed: 1, needsManual: 1,
          blocked: expect.stringContaining(mode === "protected" ? "UPOS" : "Legacy"),
        });

        expect(vi.mocked(readFileSync).mock.calls.map(([path]) => String(path))).toEqual([statePath]);
        expect(store.list()).toEqual(rows);
        expect(readFileSync(statePath, "utf-8")).toBe(before);
        expect(readFileSync(file, "utf-8")).toBe("video");
      } finally { store.close(); }
    },
  );

  it.each(["unconfirmed", "confirmed", "journal-only", "empty"] as const)(
    "blocks readable legacy %s state before credentials, journal or queue shortcuts", (history) => {
      const file = join(root, "recordings", "q", "legacy.ts");
      writeFileSync(file, "video");
      const alias = uploadAliasPath(file);
      mkdirSync(dirname(alias), { recursive: true });
      linkSync(file, alias);
      const statePath = livePumpStatePath(dirname(file), "q");
      const state = stateWith(history === "empty" ? [] : [{ index: 0, spoolPath: file, confirmed: history === "confirmed" }]);
      state.queueManaged = true;
      state.deliveryDeferred = true;
      writeLivePumpState(statePath, state);
      appendConfirmedJournal(statePath, { index: 0, bv: "BV-stale", at: 1_002, createdAt: state.createdAt });
      const before = readFileSync(statePath, "utf-8");
      vi.mocked(readFileSync).mockClear();

      const result = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "missing-cookies.json") });

      const held = history === "empty" ? 0 : 1;
      expect(result).toEqual({ queued: 0, already: 0, failed: held, needsManual: held,
        blocked: expect.stringContaining("Legacy live delivery has no native per-part observation") });
      expect(vi.mocked(readFileSync).mock.calls.map(([path]) => String(path))).toEqual([statePath]);
      expect(readFileSync(statePath, "utf-8")).toBe(before);
      expect(readFileSync(file, "utf-8")).toBe("video");
      expect(readFileSync(alias, "utf-8")).toBe("video");
      expect(existsSync(procQueueDbPath(root))).toBe(false);
    },
  );

  it("holds every sealed legacy part without creating queue ownership on repeated handoff", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 1, spoolPath: p1 }]);
    writeLivePumpState(statePath, st);
    const before = readFileSync(statePath, "utf-8");

    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 0, already: 0, failed: 2, needsManual: 2, blocked: expect.stringContaining("Legacy") });
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(existsSync(procQueueDbPath(root))).toBe(false);
    expect(readFileSync(p0, "utf-8")).toBe("aaa");
    expect(readFileSync(p1, "utf-8")).toBe("bbb");

    const again = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(again).toEqual(r);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(existsSync(procQueueDbPath(root))).toBe(false);
  });

  it("does not skip a legacy confirmed prefix to enqueue its successor", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0, confirmed: true }, { index: 1, spoolPath: p1 }]);
    st.bvid = "BV1";
    writeLivePumpState(statePath, st);
    const before = readFileSync(statePath, "utf-8");
    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 0, already: 0, failed: 2, needsManual: 2, blocked: expect.stringContaining("Legacy") });
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(existsSync(procQueueDbPath(root))).toBe(false);
    expect(existsSync(p0)).toBe(true);
    expect(existsSync(p1)).toBe(true);
  });

  it("retains sparse legacy indexes without inventing contiguous queue ownership", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p2 = join(dir, "c_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p2, "ccc");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 2, spoolPath: p2 }]);
    st.bvid = "BV1";
    writeLivePumpState(statePath, st);
    const before = readFileSync(statePath, "utf-8");
    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 0, already: 0, failed: 2, needsManual: 2, blocked: expect.stringContaining("Legacy") });
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(existsSync(procQueueDbPath(root))).toBe(false);
    expect(existsSync(p0)).toBe(true);
    expect(existsSync(p2)).toBe(true);
  });

  it("holds incomplete, sealed and open legacy parts together without queue access", () => {
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
    const before = readFileSync(statePath, "utf-8");

    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 0, failed: 3, already: 0, needsManual: 3, blocked: expect.any(String) });
    expect(readLivePumpState(statePath)?.queueManaged).toBeUndefined();
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(existsSync(procQueueDbPath(root))).toBe(false);
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
    expect(r).toMatchObject({ queued: 0, failed: 2, already: 0, blocked: expect.stringContaining("UPOS") });
    const store = new ProcQueueStore(procQueueDbPath(root));
    try {
      expect(store.rowsForOrderSeq("q:1000", 1, PART_KINDS.upload, 1)).toHaveLength(0);
      expect(store.rowsForOrderSeq("q:1000", 2, PART_KINDS.upload, 1)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("T-221 (sol P1-2): a sealed row without the positive validated marker is default-denied", () => {
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
    expect(r.blocked).toContain("Legacy");
    expect(r.deferred ?? 0).toBe(0);
    expect(r.needsManual).toBe(2);
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

  it("holds missing-spool and unvalidated legacy rows for manual review, never retry", () => {
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
    expect(r.needsManual).toBe(2);
    expect(r.blocked).toContain("Legacy");
    expect(r.deferred ?? 0).toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect(readFileSync(unvalidated, "utf-8")).toBe("bytes");
  });

  it("does not count a journal-confirmed legacy prefix as already delivered", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 1, spoolPath: p1 }]);
    writeLivePumpState(statePath, st);
    appendConfirmedJournal(statePath, { index: 0, bv: "BV1", at: 1, createdAt: 1_000 });
    const before = readFileSync(statePath, "utf-8");

    const r = enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") });
    expect(r).toMatchObject({ queued: 0, already: 0, failed: 2, needsManual: 2, blocked: expect.stringContaining("Legacy") });
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(readConfirmedJournal(statePath).get(0)?.bv).toBe("BV1");
    expect(existsSync(procQueueDbPath(root))).toBe(false);
    expect(existsSync(p0)).toBe(true);
    expect(existsSync(p1)).toBe(true);
  });
});

describe("confirmLivePumpPart", () => {
  it("refuses legacy queue ACKs without changing the state or writing a confirmation journal", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    const p1 = join(dir, "b_000.live.ts");
    writeFileSync(p0, "aaa");
    writeFileSync(p1, "bbb");
    const statePath = livePumpStatePath(dir, "q");
    const st = stateWith([{ index: 0, spoolPath: p0 }, { index: 1, spoolPath: p1 }]);
    writeLivePumpState(statePath, { ...st, queueManaged: true });
    const fp0 = { size: 3, mtimeMs: statSync(p0).mtimeMs };
    const before = readFileSync(statePath, "utf-8");
    const refused = { ok: false, error: "live delivery requires native per-part observation; queue ACK cannot confirm it" };
    expect(confirmLivePumpPart(statePath, 0, "BV1", fp0)).toEqual(refused);
    expect(readLivePumpState(statePath)?.queueManaged).toBe(true);
    expect(readLivePumpState(statePath)?.parts[0]?.confirmed).toBe(false);
    expect(readConfirmedJournal(statePath).size).toBe(0);
    expect(livePumpHasUnconfirmed(statePath)).toBe(true);
    const fp1 = { size: 3, mtimeMs: statSync(p1).mtimeMs };
    expect(confirmLivePumpPart(statePath, 1, "BV1", fp1)).toEqual(refused);
    expect(readConfirmedJournal(statePath).size).toBe(0);
    expect(existsSync(statePath + ".confirmed")).toBe(false);
    expect(livePumpHasUnconfirmed(statePath)).toBe(true);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(readFileSync(p0, "utf-8")).toBe("aaa");
    expect(readFileSync(p1, "utf-8")).toBe("bbb");
  });

  it("refuses a changed fingerprint and a different bv (never claims an unproven part)", () => {
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    writeFileSync(p0, "aaa");
    const statePath = livePumpStatePath(dir, "q");
    writeLivePumpState(statePath, stateWith([{ index: 0, spoolPath: p0 }]));
    expect(confirmLivePumpPart(statePath, 0, "BV1", { size: 3, mtimeMs: 1 })).toMatchObject({ ok: false });
    expect(confirmLivePumpPart(statePath, 0, "BV1", { size: 3, mtimeMs: statSync(p0).mtimeMs })).toMatchObject({ ok: false });
    expect(confirmLivePumpPart(statePath, 0, "BV2", { size: 3, mtimeMs: statSync(p0).mtimeMs })).toMatchObject({ ok: false });
  });

  it("keeps historical journal records durable without allowing queue ACKs to authorize cleanup", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const dir = join(root, "recordings", "q");
    const p0 = join(dir, "a_000.live.ts");
    writeFileSync(p0, "aaa");
    const statePath = livePumpStatePath(dir, "q");
    writeLivePumpState(statePath, stateWith([{ index: 0, spoolPath: p0 }]));
    const journal = `${statePath}.confirmed`;
    appendConfirmedJournal(statePath, { index: 0, bv: "BV1", at: 5, createdAt: 1_000 });
    const before = readFileSync(journal, "utf-8");
    const fp = { size: 3, mtimeMs: statSync(p0).mtimeMs };
    vi.mocked(fsyncSync).mockClear().mockImplementationOnce(() => { throw new Error("sync failed"); });
    const refused = { ok: false, error: "live delivery requires native per-part observation; queue ACK cannot confirm it" };
    expect(confirmLivePumpPart(statePath, 0, "BV1", fp)).toEqual(refused);
    expect(fsyncSync).not.toHaveBeenCalled();
    expect(readConfirmedJournal(statePath, 1_000).get(0)?.bv).toBe("BV1");
    expect(existsSync(p0)).toBe(true);
    expect(readLivePumpState(statePath)?.parts[0]?.confirmed).toBe(false);

    expect(readFileSync(journal, "utf-8")).toBe(before);
    expect(livePumpHasUnconfirmed(statePath)).toBe(true);

    vi.mocked(writeSync).mockClear().mockImplementationOnce((fd, data) =>
      actual.writeSync(fd, (data as unknown as Buffer).subarray(0, 8)));
    vi.mocked(fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
    appendConfirmedJournal(statePath, { index: 0, bv: "BV1", at: 5, createdAt: 1_000 });
    expect(writeSync).toHaveBeenCalledTimes(2);
    expect(fsyncSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fsyncSync).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(writeSync).mock.invocationCallOrder[1]!,
    );
    expect(JSON.parse(readFileSync(journal, "utf-8").trim().split("\n").at(-1)!))
      .toEqual({ index: 0, bv: "BV1", at: 5, createdAt: 1_000 });
    const after = readFileSync(journal, "utf-8").split("\n").filter(Boolean).length;
    expect(after).toBe(before.split("\n").filter(Boolean).length + 1);
    expect(readConfirmedJournal(statePath, 1_000).get(0)?.bv).toBe("BV1");

    const st2 = readLivePumpState(statePath)!;
    writeLivePumpState(statePath, { ...st2, parts: st2.parts.map((p) => ({ ...p, confirmed: true })) });
    const before2 = readFileSync(journal, "utf-8").split("\n").filter(Boolean).length;
    vi.mocked(fsyncSync).mockClear();
    expect(confirmLivePumpPart(statePath, 0, "BV1", fp)).toEqual(refused);
    expect(fsyncSync).not.toHaveBeenCalled();
    const after2 = readFileSync(journal, "utf-8").split("\n").filter(Boolean).length;
    expect(after2).toBe(before2);
    expect(livePumpHasUnconfirmed(statePath)).toBe(true);
    expect(existsSync(p0)).toBe(true);
  });
});
