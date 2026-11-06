// plan 046 PR6 (方案 A): queue mode only enqueues; the legacy path stays byte-identical when off.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { RollingUploader, makeRollingUploadHookFactory } from "./rolling-upload.js";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { TaskStore } from "./store.js";
import { PART_KINDS, jobIdOf, partLogicalKey, type PartCtx, type ProcessJob } from "@drec/core";
import {
  enqueueRollingUploadPart, enqueueRollingSkipPart, importRollingConfirmedPart, rollingQueueModeEnabled,
  queueOrderHasRows, rollingQueueMaxSeq,
} from "./rolling-queue.js";
import { makeUploadPartProcessor } from "@drec/processors";
import { enqueueHubOwnedSkip } from "./hub-owner.js";
import { uploadOwnerForTask } from "./hub-rule-match.js";

// Fake draft ids are built from parts: the privacy gate rejects bare BV-shaped literals.
const FAKE_BV1 = ["B", "V", "legacy", "0001"].join("");
const FAKE_BV2 = ["B", "V", "legacy", "0002"].join("");
const FAKE_BV3 = ["B", "V", "legacy", "0003"].join("");
const FAKE_BV4 = ["B", "V", "legacy", "0004"].join("");
const BASE_MS = Date.UTC(2026, 5, 27, 0, 0, 0);
const NOW_MS = BASE_MS + 3_600_000;
const room = { platform: "douyin", roomSlug: "123" };
const uploadMeta = { tag: "直播", tid: 21 };
const SESSION_BASE = "主播_2026-06-27_08-00-00";

let root: string;
let rec: string;
let dbPath: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "rolling-queue-"));
  rec = path.join(root, "recordings");
  mkdirSync(rec, { recursive: true });
  dbPath = procQueueDbPath(root);
  process.env.DOUYIN_REC_ROOT = root;
});
afterEach(() => {
  delete process.env.DOUYIN_REC_ROOT;
  rmSync(root, { recursive: true, force: true });
});

function segs(n: number, body = "abcdefgh"): string[] {
  return Array.from({ length: n }, (_, i) => {
    const p = path.join(rec, SESSION_BASE + "_" + String(i).padStart(3, "0") + ".ts");
    writeFileSync(p, body);
    utimesSync(p, new Date(BASE_MS + i * 60_000), new Date(BASE_MS + i * 60_000));
    return p;
  });
}
const sidecar = (): string => path.join(rec, SESSION_BASE + ".rolling.json");
const readSidecar = (): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(sidecar(), "utf-8")) as Record<string, unknown>; } catch { return null; }
};
const openQueue = (): ProcQueueStore => new ProcQueueStore(dbPath);
const orderKeyOf = (): string => "douyin:123:" + SESSION_BASE;
const rowsOf = (kind: string): Array<Record<string, unknown>> => {
  const s = openQueue();
  try { return s.list({ kind }).map((r) => ({ jobId: r.jobId, state: r.state, params: r.params, orderKey: r.orderKey, seq: r.seq, bv: r.bv })); }
  finally { s.close(); }
};

/** Rebuild a queue job (same jobId/logicalKey) with overridden params, for processor-level checks. */
function jobFrom(file: string, params: Record<string, unknown>): ProcessJob {
  const logicalKey = orderKeyOf() + ":part:1";
  return {
    jobId: jobIdOf(PART_KINDS.upload, logicalKey, 1), kind: PART_KINDS.upload, logicalKey, generation: 1,
    inputs: [file], params: { ...params, cookies: "c", title: "t", tid: 21, tag: "tag" },
    replaceInputs: false, owner: { taskId: 1 }, createdAt: 1, orderKey: orderKeyOf(), seq: 1,
  };
}

function queueUploader(over: Partial<ConstructorParameters<typeof RollingUploader>[0]> = {}): RollingUploader {
  const enq: Array<Record<string, unknown>> = [];
  const skips: Array<Record<string, unknown>> = [];
  const imports: Array<Record<string, unknown>> = [];
  const u = new RollingUploader({
    room, uploadMeta, minSegmentSec: 0, now: () => NOW_MS,
    queueMode: true,
    enqueueQueuePart: (i) => { enq.push({ ...i }); return "queued"; },
    enqueueQueueSkip: (i) => { skips.push({ ...i }); return "queued"; },
    importQueueConfirmed: (i) => { imports.push({ ...i }); return "already"; },
    // Legacy seams must never be reached in queue mode: they would be a second uploader.
    uploadPlainRaw: vi.fn(async () => { throw new Error("biliup must not run in queue mode"); }),
    appendGroupRaw: vi.fn(async () => { throw new Error("biliup must not run in queue mode"); }),
    removeFile: vi.fn(() => { throw new Error("queue mode must not delete"); }),
    ...over,
  });
  (u as unknown as { __enq: typeof enq }).__enq = enq;
  (u as unknown as { __skips: typeof skips }).__skips = skips;
  (u as unknown as { __imports: typeof imports }).__imports = imports;
  return u;
}
const seen = (u: RollingUploader, k: "__enq" | "__skips" | "__imports"): Array<Record<string, unknown>> =>
  (u as unknown as Record<string, Array<Record<string, unknown>>>)[k];

describe("rolling queue mode (方案 A)", () => {
  it("sealed parts are enqueued in order; nothing is uploaded or deleted", async () => {
    const paths = segs(3);
    const u = queueUploader();
    paths.forEach((p) => u.noteSegment(p));
    const r = await u.flush({ recordingActive: true });
    expect(r.uploaded.sort()).toEqual([0, 1]); // 段 2 仍在写
    expect(r.deleted).toEqual([]);
    expect(seen(u, "__enq").map((i) => i.index)).toEqual([0, 1]);
    expect(seen(u, "__enq")[0]).toMatchObject({ orderKey: orderKeyOf() });
  });

  it("session end enqueues the last part too, and repeat flushes are idempotent", async () => {
    const paths = segs(2);
    const u = queueUploader();
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(seen(u, "__enq").map((i) => i.index)).toEqual([0, 1]);
    await u.flush({ recordingActive: false });
    expect(seen(u, "__enq").map((i) => i.index)).toEqual([0, 1]); // 不重复入队
  });

  it("empty and fragment parts become skipped placeholders so seq never gaps", async () => {
    const paths = segs(3);
    writeFileSync(paths[1], ""); // 0 字节
    utimesSync(paths[1], new Date(BASE_MS + 60_000), new Date(BASE_MS + 60_000));
    const u = queueUploader({ minSegmentSec: 2 });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(seen(u, "__skips").map((i) => i.index)).toEqual([1]);
    expect(seen(u, "__enq").map((i) => i.index)).toEqual([0, 2]);
  });

  it("a legacy sidecar import turns confirmed parts into done rows, idempotently", async () => {
    const paths = segs(2);
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE, segments: paths.map((p, i) => ({ index: i, path: p })),
      confirmed: [0], bv: FAKE_BV1, updatedAt: BASE_MS,
    }));
    const imports: Array<Record<string, unknown>> = [];
    const u = queueUploader({
      countPartsRaw: async () => 3,
      importQueueConfirmed: (i) => {
        imports.push({ ...i });
        // Real adapter is idempotent; here we exercise the store import directly once per index.
        importRollingConfirmedPart(i as Parameters<typeof importRollingConfirmedPart>[0]);
        return "already";
      },
    });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    await u.flush({ recordingActive: false });
    expect(imports.map((i) => i.index)).toEqual([0, 0]); // seam called each flush; store import is idempotent
    const s = openQueue();
    try {
      const done = s.list({ kind: PART_KINDS.upload, state: "done" });
      expect(done).toHaveLength(1);
      expect(done[0]?.bv).toBe(FAKE_BV1);
    } finally { s.close(); }
  });

  it("queue mode never takes the upload slot or spawns biliup, even with a slot injected", async () => {
    const slot = { acquire: vi.fn(async () => true), release: vi.fn(), touch: vi.fn() };
    const up = vi.fn(async () => "BVx");
    const u = queueUploader({ slot: slot as never, uploadPlainRaw: up, minSegmentSec: 0 });
    expect(u.uploadSlot()).toBeNull(); // 构造即置空:queue mode 不得持有节点上传槽
    const paths = segs(2);
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(slot.acquire).not.toHaveBeenCalled();
    expect(up).not.toHaveBeenCalled();
  });

  it("legacy path (switch off) still uploads and deletes exactly as before", async () => {
    const paths = segs(2);
    const up = vi.fn(async () => FAKE_BV2);
    const remove = vi.fn(() => true);
    const u = new RollingUploader({
      room, uploadMeta, minSegmentSec: 0, now: () => NOW_MS, gate: { run: async (_k: string, fn: () => Promise<unknown>) => fn() } as never,
      uploadPlainRaw: up as never, appendGroupRaw: (async () => {}) as never, removeFile: remove,
    });
    paths.forEach((p) => u.noteSegment(p));
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([0, 1]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(up).toHaveBeenCalledTimes(1);
  });
});

describe("rolling-queue store adapters", () => {
  it("enqueue writes one deterministic pending upload-part row with rolling workflow", () => {
    const p = segs(1)[0]!;
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta: { cookies: "c", title: "t", tid: 21, tag: "tag", public: false } })).toBe("queued");
    const rows = rowsOf(PART_KINDS.upload);
    expect(rows).toHaveLength(1);
    const ctx = rows[0]!.params as unknown as { ctx: PartCtx };
    expect(ctx.ctx).toMatchObject({ v: 1, index: 1, orderKey: orderKeyOf(), file: p });
    expect((rows[0]!.params as Record<string, unknown>).partWorkflow).toBe("rolling");
    expect(rows[0]!.jobId).toBe(jobIdOf(PART_KINDS.upload, orderKeyOf() + ":part:1", 1));
    // 重复入队幂等:同一 jobId,不新增行。
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta: { cookies: "c", title: "t", tid: 21, tag: "tag", public: false } })).toBe("queued");
    expect(rowsOf(PART_KINDS.upload)).toHaveLength(1);
  });

  it("skip adapter writes a skipped placeholder; import adapter writes a done row with the bv", () => {
    const p = segs(1)[0]!;
    expect(enqueueRollingSkipPart({ file: p, index: 0, orderKey: orderKeyOf(), meta: { cookies: "c", title: "t", tid: 21, tag: "tag", public: false } })).toBe("already");
    expect(rowsOf(PART_KINDS.upload)[0]!.state).toBe("skipped");

    const q = segs(2)[1]!;
    expect(importRollingConfirmedPart({ file: q, index: 1, orderKey: orderKeyOf(), bv: FAKE_BV3, meta: { cookies: "c", title: "t", tid: 21, tag: "tag", public: false } })).toBe("already");
    const done = rowsOf(PART_KINDS.upload).find((r) => r.seq === 2);
    expect(done).toMatchObject({ state: "done", bv: FAKE_BV3 });
  });

  it("later parts inherit the bv from the imported done row (same order + generation)", () => {
    const p = segs(1)[0]!;
    importRollingConfirmedPart({ file: p, index: 0, orderKey: orderKeyOf(), bv: FAKE_BV4, meta: { cookies: "c", title: "t", tid: 21, tag: "tag", public: false } });
    const q = segs(2)[1]!;
    enqueueRollingUploadPart({ file: q, index: 1, orderKey: orderKeyOf(), meta: { cookies: "c", title: "t", tid: 21, tag: "tag", public: false } });
    const s = openQueue();
    try {
      const row = s.list({ kind: PART_KINDS.upload }).find((r) => r.seq === 2)!;
      const ctx = row.params.ctx as PartCtx;
      expect(ctx.bv).toBeUndefined(); // 入队时为空;runner 认领时从 done 行继承(PR518/519)
      expect(row.orderKey).toBe(orderKeyOf());
    } finally { s.close(); }
  });

  it("factory: queueMode wires the adapters and a null slot; off leaves the legacy slot decision", async () => {
    const slot = { acquire: vi.fn(async () => true), release: vi.fn(), touch: vi.fn() };
    const enq: number[] = [];
    const hook = makeRollingUploadHookFactory({
      enabled: true, platform: room.platform, roomSlug: room.roomSlug, queueMode: true,
      enqueueQueuePart: (i) => { enq.push(i.index); return "queued"; },
      enqueueQueueSkip: () => "queued", importQueueConfirmed: () => "already",
      slot: slot as never,
    })!;
    const mkHook = hook as unknown as () => { onSegment(p: string): void; onSessionEnd(): Promise<void> };
    const session = mkHook();
    const paths = segs(2);
    session.onSegment(paths[0]!);
    session.onSegment(paths[1]!);
    await session.onSessionEnd();
    expect(enq).toEqual([0, 1]);
    expect(slot.acquire).not.toHaveBeenCalled(); // queue mode never takes the node upload slot
    const off = makeRollingUploadHookFactory({ enabled: false, platform: room.platform, roomSlug: room.roomSlug, queueMode: true });
    expect(off).toBeUndefined();
  });

  it("a file outside the node roots is rejected (fail-closed containment)", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
    try {
      const p = path.join(outside, "a_000.ts");
      writeFileSync(p, "x");
      expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta: { cookies: "c", title: "t", tid: 21, tag: "tag", public: false } })).toBe("failed");
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it("the settings switch defaults to off and honours off/on values", () => {
    const s = new TaskStore(path.join(root, "db", "douyin-rec.db"));
    try {
      expect(rollingQueueModeEnabled(path.join(root, "db", "douyin-rec.db"))).toBe(false);
      s.setSetting("rollingQueueMode", "off");
      expect(rollingQueueModeEnabled(path.join(root, "db", "douyin-rec.db"))).toBe(false);
      s.setSetting("rollingQueueMode", "on");
      expect(rollingQueueModeEnabled(path.join(root, "db", "douyin-rec.db"))).toBe(true);
      s.setSetting("rollingQueueMode", "0");
      expect(rollingQueueModeEnabled(path.join(root, "db", "douyin-rec.db"))).toBe(false);
    } finally { s.close(); }
  });
});

describe("rework findings (PR6 round 1)", () => {
  const meta = { cookies: "c", title: "rendered title", tid: 21, tag: "tag", public: false };

  it("CRITICAL 1: rows carry full biliup metadata and pass upload-part validate", () => {
    const p = segs(1)[0]!;
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
    const row = openQueue().list({ kind: PART_KINDS.upload })[0]!;
    expect(row.params).toMatchObject({ cookies: "c", title: "rendered title", tid: 21, tag: "tag", public: false });
    const v = makeUploadPartProcessor().validate(row);
    expect(v).toBeNull();
  });

  it("CRITICAL 3: hub-owned segments write only skipped(hub-owned), no upload row", async () => {
    const paths = segs(2);
    const skipped: number[] = [];
    const enq: number[] = [];
    const u = queueUploader({
      uploadOwner: () => "master",
      enqueueHubSkipped: (i) => { skipped.push(i.index); },
      enqueueQueuePart: (i) => { enq.push(i.index); return "queued"; },
    });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(skipped).toEqual([0, 1]);
    expect(enq).toEqual([]);
  });

  it("CRITICAL 3: hub skip and upload producer share one logical key (one job id per segment)", () => {
    const p = segs(1)[0]!;
    expect(enqueueHubOwnedSkip({ file: p, index: 0, streamKey: orderKeyOf(), taskId: 1 })).toBe(true);
    const ids = openQueue().list({ kind: PART_KINDS.upload }).map((r) => r.jobId);
    expect(ids).toHaveLength(1);
    // The upload producer for the same segment hits the same deterministic job id and must not add a row.
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("already");
    expect(openQueue().list({ kind: PART_KINDS.upload })).toHaveLength(1);
  });

  it("HIGH 4: a done row no longer blocks later parts (restart flush continues)", async () => {
    const paths = segs(2);
    expect(enqueueRollingUploadPart({ file: paths[0]!, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
    // Simulate an already-finished part on restart.
    const s = openQueue();
    const id = s.list({ kind: PART_KINDS.upload })[0]!.jobId;
    s.acquireLease("upload-part", "A", { pid: process.pid });
    s.claim({ kinds: ["upload-part"], owner: "A" });
    s.finish(id, "A", { state: "done", outputs: [] });
    s.releaseLease("upload-part", "A");
    s.close();

    const u = queueUploader();
    paths.forEach((p) => u.noteSegment(p));
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([0, 1]); // done part counted as handled; new part still enqueued
  });

  it("HIGH 6: a misspelled switch value is OFF (explicit on-list)", () => {
    const s = new TaskStore(path.join(root, "db", "douyin-rec.db"));
    try {
      s.setSetting("rollingQueueMode", "ofl");
      expect(rollingQueueModeEnabled(path.join(root, "db", "douyin-rec.db"))).toBe(false);
      s.setSetting("rollingQueueMode", "true");
      expect(rollingQueueModeEnabled(path.join(root, "db", "douyin-rec.db"))).toBe(true);
    } finally { s.close(); }
  });

  it("MEDIUM 7: a failed enqueue notifies and does not mark the part handled", async () => {
    const paths = segs(2);
    const notify = vi.fn();
    const u = queueUploader({
      notify,
      queueRetryMs: 0,
      enqueueQueuePart: () => "failed",
    });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(notify).toHaveBeenCalled();
    expect(seen(u, "__enq")).toEqual([]);
  });

  it("MEDIUM 8: sidecar import of a still-present source also enqueues cleanup-part", () => {
    const paths = segs(1);
    expect(importRollingConfirmedPart({ file: paths[0]!, index: 0, orderKey: orderKeyOf(), bv: FAKE_BV1, withCleanup: true, meta })).toBe("already");
    const rows = openQueue().list({ kind: PART_KINDS.cleanup });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("pending");
    expect((rows[0]!.params.ctx as PartCtx).bv).toBe(FAKE_BV1);
  });

  it("MEDIUM 9: a same-broadcast successor reuses the predecessor order key and seq base", async () => {
    const prevBase = "主播_2026-06-27_07-00-00";
    const prevPath = path.join(rec, prevBase + "_000.ts");
    writeFileSync(prevPath, "abcdefgh");
    utimesSync(prevPath, new Date(BASE_MS - 30 * 60_000), new Date(BASE_MS - 30 * 60_000));
    writeFileSync(path.join(rec, prevBase + ".rolling.json"), JSON.stringify({
      streamKey: "douyin:123:" + prevBase, sessionBase: prevBase,
      segments: [{ index: 0, path: prevPath }], confirmed: [0], bv: FAKE_BV2,
      room, startMs: BASE_MS - 30 * 60_000, updatedAt: BASE_MS - 30 * 60_000,
    }));
    // Predecessor's row already used seq 1 in that order.
    expect(enqueueRollingUploadPart({ file: prevPath, index: 0, orderKey: "douyin:123:" + prevBase, meta })).toBe("queued");
    const paths = segs(1);
    const u = queueUploader({ queueMaxSeq: () => 1 });
    u.noteSegment(paths[0]!);
    await u.flush({ recordingActive: false });
    const first = seen(u, "__enq")[0]!;
    expect(first.orderKey).toBe("douyin:123:" + prevBase);
    expect(first.seq).toBe(2); // continues after the predecessor's part
  });

  it("CRITICAL 2: providers-register wires upload-part with the shared gate/slot/account key", () => {
    const src = readFileSync(path.join(import.meta.dirname, "..", "..", "cli", "src", "providers-register.ts"), "utf-8");
    expect(src).toContain("registerProcessor(makeUploadPartProcessor({");
    expect(src).toContain("accountKey: resolveUploadAccountKey");
    expect(src).toContain("nodeUploadSlot");
    expect(src).not.toContain("registerProcessor(uploadPartProcessor)");
  });


describe("rework round 2", () => {
  const meta = { cookies: "c", title: "t", tid: 21, tag: "tag", public: false };

  it("P1-A: a legacy predecessor with bv+parts is inherited (first part appends, seq continues)", async () => {
    const prevBase = "主播_2026-06-27_06-00-00";
    const prevFile = path.join(rec, prevBase + "_000.ts");
    writeFileSync(prevFile, "abcdefgh");
    utimesSync(prevFile, new Date(BASE_MS - 20 * 60_000), new Date(BASE_MS - 20 * 60_000));
    writeFileSync(path.join(rec, prevBase + ".rolling.json"), JSON.stringify({
      streamKey: "douyin:123:" + prevBase, sessionBase: prevBase,
      segments: [{ index: 0, path: prevFile }], confirmed: [0], bv: FAKE_BV1,
      room, startMs: BASE_MS - 20 * 60_000, updatedAt: BASE_MS - 20 * 60_000,
    }));
    const paths = segs(1);
    const u = queueUploader({ queueMaxSeq: () => 0 });
    u.noteSegment(paths[0]!);
    await u.flush({ recordingActive: false });
    const first = seen(u, "__enq")[0]!;
    expect(first.orderKey).toBe("douyin:123:" + prevBase);
    expect(first.bv).toBe(FAKE_BV1); // first segment of the successor carries the inherited draft
    expect(first.seq).toBe(2); // after the predecessor's confirmed part
  });

  it("P1-B: legacy uploading intent and ambiguous segments fail closed (no enqueue)", async () => {
    const paths = segs(3);
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [],
      uploading: { index: 0, kind: "create" }, updatedAt: BASE_MS,
    }));
    const notify = vi.fn();
    const u = queueUploader({ notify, countPartsRaw: async () => 1 });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(seen(u, "__enq")).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    await u.flush({ recordingActive: false });
    expect(notify).toHaveBeenCalledTimes(1); // one alert, not per flush

    // Ambiguous segment 1 blocks it and everything after it.
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [], ambiguous: [1], updatedAt: BASE_MS,
    }));
    const u2 = queueUploader();
    paths.forEach((p) => u2.noteSegment(p));
    await u2.flush({ recordingActive: false });
    expect(seen(u2, "__enq").map((i) => i.index)).toEqual([0]);
  });

  it("B1: a segment already deleted by cleanup (done row) is 'already', never retried", () => {
    const p = segs(1)[0]!;
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
    const s = openQueue();
    const id = s.list({ kind: PART_KINDS.upload })[0]!.jobId;
    s.acquireLease("upload-part", "A", { pid: process.pid });
    s.claim({ kinds: ["upload-part"], owner: "A" });
    s.finish(id, "A", { state: "done", outputs: [] });
    s.releaseLease("upload-part", "A");
    s.close();
    rmSync(p);
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("already");
    expect(enqueueRollingSkipPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("already");
  });

  it("A1: a queue-mode predecessor without bv still shares its order key (no second draft)", async () => {
    const prevBase = "主播_2026-06-27_05-30-00";
    const prevFile = path.join(rec, prevBase + "_000.ts");
    writeFileSync(prevFile, "abcdefgh");
    utimesSync(prevFile, new Date(BASE_MS - 10 * 60_000), new Date(BASE_MS - 10 * 60_000));
    writeFileSync(path.join(rec, prevBase + ".rolling.json"), JSON.stringify({
      streamKey: "douyin:123:" + prevBase, sessionBase: prevBase, queueOrderKey: "douyin:123:" + prevBase,
      segments: [{ index: 0, path: prevFile }], confirmed: [], room,
      startMs: BASE_MS - 10 * 60_000, updatedAt: BASE_MS - 10 * 60_000,
    }));
    const notify = vi.fn();
    const paths = segs(1);
    const u = queueUploader({ notify });
    u.noteSegment(paths[0]!);
    await u.flush({ recordingActive: false });
    expect(notify).not.toHaveBeenCalled();
    expect(seen(u, "__enq")[0]!.orderKey).toBe("douyin:123:" + prevBase);
  });

  it("A3: import + cleanup are one transaction (cleanup contract failure rolls the done row back)", () => {
    const p = segs(1)[0]!;
    const s = openQueue();
    try {
      const job = {
        jobId: jobIdOf(PART_KINDS.upload, orderKeyOf() + ":part:1", 1), kind: PART_KINDS.upload,
        logicalKey: orderKeyOf() + ":part:1", generation: 1, inputs: [p],
        params: { ctx: { v: 1, orderKey: orderKeyOf(), index: 1, file: p, fp: { size: 8, mtimeMs: 1 } } },
        replaceInputs: false, owner: { taskId: 1 }, createdAt: 1, orderKey: orderKeyOf(), seq: 1,
      };
      const badCleanup = {
        ...job, jobId: jobIdOf(PART_KINDS.cleanup, orderKeyOf() + ":part:1", 1), kind: PART_KINDS.cleanup,
        inputs: ["/outside/root/x.ts"], params: { ctx: { v: 1, orderKey: orderKeyOf(), index: 1, file: "/outside/root/x.ts", fp: { size: 1, mtimeMs: 1 }, bv: "X" } },
      };
      expect(() => s.importConfirmedPart(job as never, { allowedRoots: [root], bv: "X", cleanupJob: badCleanup as never }))
        .toThrow();
      expect(s.list({ kind: PART_KINDS.upload, state: "done" })).toHaveLength(0);
      expect(s.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
    } finally { s.close(); }
  });

  it("A4: hub-owned rooms never import/cleanup from a legacy sidecar", async () => {
    const paths = segs(1);
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [0], bv: FAKE_BV1, updatedAt: BASE_MS,
    }));
    const imports: unknown[] = [];
    const u = queueUploader({
      uploadOwner: () => "master",
      countPartsRaw: async () => 3,
      importQueueConfirmed: (i) => { imports.push(i); return "already"; },
      enqueueHubSkipped: () => true,
    });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(imports).toEqual([]);
  });

  it("A5: maxPartSeq uses SQL MAX (no 10k list truncation)", () => {
    const s = openQueue();
    try {
      const raw = new DatabaseSync(dbPath);
      raw.exec("BEGIN");
      const stmt = raw.prepare("INSERT INTO proc_jobs(jobId,kind,logicalKey,generation,state,inputs,params,replaceInputs,createdAt,updatedAt,orderKey,seq) VALUES(?,?,?,1,'done','[]','{}',0,1,1,?,?)");
      for (let i = 1; i <= 10_050; i += 1) stmt.run("u" + i, PART_KINDS.upload, "k" + i, orderKeyOf(), i);
      raw.exec("COMMIT");
      raw.close();
      expect(s.maxPartSeq(orderKeyOf())).toBe(10_050);
    } finally { s.close(); }
  });

  it("A11: an old PR7 skip row (different logical key) is deduped by (orderKey, seq)", () => {
    const p = segs(1)[0]!;
    const s = openQueue();
    try {
      const old = {
        jobId: jobIdOf(PART_KINDS.upload, orderKeyOf() + ":part-1@", 1), kind: PART_KINDS.upload,
        logicalKey: orderKeyOf() + ":part-1@", generation: 1, inputs: [p],
        params: { ctx: { v: 1, orderKey: orderKeyOf(), index: 1, file: p, fp: { size: 8, mtimeMs: 1 } } }, replaceInputs: false,
        owner: {}, createdAt: 1, orderKey: orderKeyOf(), seq: 1,
      };
      expect(s.enqueueSkipped(old as never, { allowedRoots: [root], reason: "skip-hub-owned" }).state).toBe("skipped");
    } finally { s.close(); }
    expect(enqueueHubOwnedSkip({ file: p, index: 0, streamKey: orderKeyOf(), taskId: 1 })).toBe(true);
    expect(openQueue().list({ kind: PART_KINDS.upload })).toHaveLength(1);
  });

  it("B2: production record wires the hub-owner decision (static)", () => {
    const src = readFileSync(path.join(import.meta.dirname, "..", "..", "cli", "src", "cli.ts"), "utf-8");
    expect(src).toContain("uploadOwnerForTask");
    expect(src).toContain("enqueueHubOwnedSkip");
    expect(src).toContain("new TaskStore(resolveDbPath())");
    // Ownership is decided only on a hub master (DOUYIN_REC_HUB_MASTER) or for a hub-managed task.
    expect(src).toContain("shouldDecideUploadOwner(task, hubMaster)");
    expect(src).toContain("DOUYIN_REC_HUB_MASTER");
    expect(src).toContain("masterOwnedWithoutRule");
  });

  it("B2b: task run passes the notifier and gates the owner decision (static)", () => {
    const src = readFileSync(path.join(import.meta.dirname, "cli-task.ts"), "utf-8");
    expect(src).toContain("notify: (message: string)");
    // Same gate as the record path: leftover rule files on a non-hub machine must not stop node uploads.
    expect(src).toContain("shouldDecideUploadOwner(task, process.env.DOUYIN_REC_HUB_MASTER");
  });
});


  it("A2: a retry never forces recordingActive=false (growing segment stays unsealed)", async () => {
    const paths = segs(2);
    const calls: boolean[] = [];
    const u = queueUploader({
      queueRetryMs: 5,
      enqueueQueuePart: (i) => {
        calls.push(i.index === 0);
        return i.index === 0 ? "failed" : "queued";
      },
    });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: true });
    const retry = vi.spyOn(u, "flush");
    await new Promise((r) => setTimeout(r, 30));
    // The retry must preserve recordingActive=true; a false would seal (and enqueue) the growing segment.
    expect(retry).toHaveBeenCalledWith({ recordingActive: true });
    expect(calls.every(Boolean)).toBe(true);
  });

  it("P3.2: a failed/cancelled row is terminal (notify once, no retry)", async () => {
    const p = segs(1)[0]!;
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
    const s = openQueue();
    const id = s.list({ kind: PART_KINDS.upload })[0]!.jobId;
    s.acquireLease("upload-part", "A", { pid: process.pid });
    s.claim({ kinds: ["upload-part"], owner: "A" });
    s.finish(id, "A", { state: "failed", error: "x" });
    s.releaseLease("upload-part", "A");
    s.close();
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("terminal");
  });

  it("P3.3: a failed hub skip write is not marked handled (notify + retry)", async () => {
    const paths = segs(2);
    const notify = vi.fn();
    const u = queueUploader({
      uploadOwner: () => "master",
      notify,
      enqueueHubSkipped: () => false,
    });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(notify).toHaveBeenCalled();
    expect(seen(u, "__enq")).toEqual([]);
  });


describe("rework addendum 3", () => {
  const meta = { cookies: "c", title: "t", tid: 21, tag: "tag", public: false };

  it("A3-1: a hub-managed task is master-owned even with no local hub rules", () => {
    const task = { id: 7, room: "https://live.douyin.com/123", managedBy: "hub" };
    expect(uploadOwnerForTask(task, root + "/config/hub")).toBe("master");
  });

  it("A3-2: recorder persist merges runner-written bv/confirmed instead of erasing them", async () => {
    const paths = segs(2);
    const u = queueUploader();
    u.noteSegment(paths[0]!);
    // The runner writes its confirmation between two recorder persists.
    const st = JSON.parse(readFileSync(sidecar(), "utf-8")) as Record<string, unknown>;
    writeFileSync(sidecar(), JSON.stringify({ ...st, bv: FAKE_BV1, confirmed: [0] }));
    u.noteSegment(paths[1]!); // triggers persist()
    const merged = readFileSync(sidecar(), "utf-8");
    expect(merged).toContain(FAKE_BV1);
    expect((JSON.parse(merged) as { confirmed: number[] }).confirmed).toContain(0);
  });

  it("A3-3: failed import proof blocks those parts (never re-enqueued as fresh uploads)", async () => {
    const paths = segs(1);
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [0], bv: FAKE_BV1, updatedAt: BASE_MS,
    }));
    const u = queueUploader({ countPartsRaw: async () => 0 });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(seen(u, "__enq")).toEqual([]);
  });

  it("A3-4: a predecessor with an interrupted intent or ambiguous part is not a continuation base", async () => {
    const prevBase = "主播_2026-06-27_04-00-00";
    const prevFile = path.join(rec, prevBase + "_000.ts");
    writeFileSync(prevFile, "abcdefgh");
    utimesSync(prevFile, new Date(BASE_MS - 15 * 60_000), new Date(BASE_MS - 15 * 60_000));
    writeFileSync(path.join(rec, prevBase + ".rolling.json"), JSON.stringify({
      streamKey: "douyin:123:" + prevBase, sessionBase: prevBase,
      segments: [{ index: 0, path: prevFile }], confirmed: [], uploading: { index: 0, kind: "append" }, bv: FAKE_BV1,
      room, startMs: BASE_MS - 15 * 60_000, updatedAt: BASE_MS - 15 * 60_000,
    }));
    const notify = vi.fn();
    const paths = segs(1);
    const u = queueUploader({ notify });
    u.noteSegment(paths[0]!);
    await u.flush({ recordingActive: false });
    expect(seen(u, "__enq")).toEqual([]);
    expect(notify).toHaveBeenCalled();
  });

  it("A3-6: the legacy import proof is queried once per session", async () => {
    const paths = segs(1);
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [0], bv: FAKE_BV1, updatedAt: BASE_MS,
    }));
    const count = vi.fn(async () => 3);
    const u = queueUploader({ countPartsRaw: count });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    await u.flush({ recordingActive: false });
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("A3-8: a hub-owned successor does not inherit the predecessor bv", async () => {
    const prevBase = "主播_2026-06-27_03-00-00";
    const prevFile = path.join(rec, prevBase + "_000.ts");
    writeFileSync(prevFile, "abcdefgh");
    utimesSync(prevFile, new Date(BASE_MS - 12 * 60_000), new Date(BASE_MS - 12 * 60_000));
    writeFileSync(path.join(rec, prevBase + ".rolling.json"), JSON.stringify({
      streamKey: "douyin:123:" + prevBase, sessionBase: prevBase,
      segments: [{ index: 0, path: prevFile }], confirmed: [0], bv: FAKE_BV1,
      room, startMs: BASE_MS - 12 * 60_000, updatedAt: BASE_MS - 12 * 60_000,
    }));
    const paths = segs(1);
    const u = queueUploader({ uploadOwner: () => "master", enqueueHubSkipped: () => true });
    u.noteSegment(paths[0]!);
    await u.flush({ recordingActive: false });
    const sc = JSON.parse(readFileSync(sidecar(), "utf-8")) as { bv?: string };
    expect(sc.bv).toBeUndefined();
  });

  it("A3-10: a non-upload row with the same order/seq does not count as the part", () => {
    const p = segs(1)[0]!;
    const s = openQueue();
    try {
      const row = {
        jobId: jobIdOf("biliup", orderKeyOf() + ":part:1", 1), kind: "biliup", logicalKey: orderKeyOf() + ":part:1",
        generation: 1, inputs: [p], params: {}, replaceInputs: false, owner: {}, createdAt: 1, orderKey: orderKeyOf(), seq: 1,
      };
      s.enqueue(row as never, { allowedRoots: [root] });
    } finally { s.close(); }
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
  });
});


  it("A3-5: queue mode settles a legacy append intent by part count without a gate", async () => {
    const paths = segs(1);
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [],
      uploading: { index: 0, kind: "append" }, bv: FAKE_BV1, updatedAt: BASE_MS,
    }));
    const u = queueUploader({ countPartsRaw: async () => 1 });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    const sc = JSON.parse(readFileSync(sidecar(), "utf-8")) as { confirmed?: number[]; uploading?: unknown };
    expect(sc.uploading).toBeUndefined();
    expect(sc.confirmed).toContain(0);
  });

  it("A3-12: the retry uses the LATEST recording state (an active failure then a session-end failure retries inactive)", async () => {
    // The tail segment can only be sealed once recording has ended: a retry stuck on the first
    // failure's recordingActive=true would never enqueue it (silent stall, alert already deduped).
    // Two segments: the active flush seals index 0 (and fails); the session-end flush seals the tail
    // (index 1) and fails too. Only the tail's false lets the retry seal segment 1.
    const paths = segs(2);
    const u = queueUploader({ queueRetryMs: 40, enqueueQueuePart: () => "failed" });
    const retry = vi.spyOn(u, "flush");
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: true });
    await u.flush({ recordingActive: false });
    await new Promise((r) => setTimeout(r, 90));
    const flags = retry.mock.calls.map(([arg]) => arg.recordingActive);
    expect(flags).toContain(false);
    expect(flags[flags.length - 1]).toBe(false);
  });

});

describe("rework addenda 5-7", () => {
  const meta = { cookies: "c", title: "rendered title", tid: 21, tag: "tag", public: false };

  it("S1: the row names the canonical sidecar next to the part (one derivation with the processor)", () => {
    const p = segs(1)[0]!;
    enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta });
    const row = rowsOf(PART_KINDS.upload)[0]!;
    expect((row.params as Record<string, unknown>).sidecarPath).toBe(path.join(rec, SESSION_BASE + ".rolling.json"));
  });

  it("G1: an older generation's done row does not mask the part of the live generation", () => {
    const p = segs(1)[0]!;
    expect(importRollingConfirmedPart({ file: p, index: 0, orderKey: orderKeyOf(), bv: FAKE_BV1, meta })).toBe("already");
    const s = openQueue();
    try {
      // A stale re-dispatch bumps the order's live generation.
      s.enqueue({
        jobId: jobIdOf(PART_KINDS.upload, partLogicalKey(orderKeyOf(), 9), 2), kind: PART_KINDS.upload,
        logicalKey: partLogicalKey(orderKeyOf(), 9), generation: 2, inputs: [p],
        params: { ctx: { v: 1, orderKey: orderKeyOf(), index: 9, file: p, fp: { size: 8, mtimeMs: 1 } } },
        replaceInputs: false, owner: {}, createdAt: 1, orderKey: orderKeyOf(), seq: 9,
      } as never, { allowedRoots: [root] });
    } finally { s.close(); }
    // Before the fix the gen-1 done row made this look handled => the current part was never uploaded.
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
    const rows = rowsOf(PART_KINDS.upload).filter((r) => r.seq === 1);
    expect(rows.map((r) => r.state).sort()).toEqual(["done", "pending"]);
  });

  it("G2: a pending row under an older logical-key spelling blocks a second job id", () => {
    const p = segs(1)[0]!;
    const s = openQueue();
    try {
      s.enqueue({
        jobId: jobIdOf(PART_KINDS.upload, orderKeyOf() + ":part-1", 1), kind: PART_KINDS.upload,
        logicalKey: orderKeyOf() + ":part-1", generation: 1, inputs: [p],
        params: { ctx: { v: 1, orderKey: orderKeyOf(), index: 1, file: p, fp: { size: 8, mtimeMs: 1 } } },
        replaceInputs: false, owner: {}, createdAt: 1, orderKey: orderKeyOf(), seq: 1,
      } as never, { allowedRoots: [root] });
    } finally { s.close(); }
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
    expect(rowsOf(PART_KINDS.upload)).toHaveLength(1); // no second claimable row for the same segment
  });

  it("R1: turning the switch off does not re-upload a broadcast that already has queue rows", async () => {
    const paths = segs(2);
    // This session ran in queue mode before the switch was turned off.
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE, room,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [],
      queueOrderKey: orderKeyOf(), updatedAt: NOW_MS,
    }));
    expect(enqueueRollingUploadPart({ file: paths[0]!, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
    expect(queueOrderHasRows(orderKeyOf())).toBe(true);

    const up = vi.fn(async () => FAKE_BV2);
    const remove = vi.fn(() => true);
    const notes: string[] = [];
    const u = new RollingUploader({
      room, uploadMeta, minSegmentSec: 0, now: () => NOW_MS,
      gate: { run: async (_k: string, fn: () => Promise<unknown>) => fn() } as never,
      uploadPlainRaw: up as never, appendGroupRaw: (async () => {}) as never, removeFile: remove,
      notify: (m) => notes.push(m), queueOrderHasRows,
    });
    paths.forEach((p) => u.noteSegment(p));
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([]);
    expect(up).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(existsSync(paths[0]!)).toBe(true);
    expect(notes.join(" ")).toMatch(/队列/);
  });

  it("R2: the same switch-off without any queue rows keeps the legacy upload path", async () => {
    const paths = segs(2);
    const up = vi.fn(async () => FAKE_BV3);
    const remove = vi.fn(() => true);
    const u = new RollingUploader({
      room, uploadMeta, minSegmentSec: 0, now: () => NOW_MS,
      gate: { run: async (_k: string, fn: () => Promise<unknown>) => fn() } as never,
      uploadPlainRaw: up as never, appendGroupRaw: (async () => {}) as never, removeFile: remove,
      queueOrderHasRows,
    });
    paths.forEach((p) => u.noteSegment(p));
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([0, 1]);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("R3: a queue-mode predecessor blocks the legacy path too (same broadcast, other session)", async () => {
    const prevBase = "主播_2026-06-27_07-00-00";
    const prevFile = path.join(rec, prevBase + "_000.ts");
    writeFileSync(prevFile, "abcdefgh");
    utimesSync(prevFile, new Date(BASE_MS - 600_000), new Date(BASE_MS - 600_000));
    writeFileSync(path.join(rec, prevBase + ".rolling.json"), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: prevBase, room,
      segments: [{ index: 0, path: prevFile }], confirmed: [], queueOrderKey: orderKeyOf(),
      startMs: BASE_MS - 600_000, updatedAt: BASE_MS - 60_000,
    }));
    expect(enqueueRollingUploadPart({ file: prevFile, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");

    const up = vi.fn(async () => FAKE_BV4);
    const u = new RollingUploader({
      room, uploadMeta, minSegmentSec: 0, now: () => NOW_MS,
      gate: { run: async (_k: string, fn: () => Promise<unknown>) => fn() } as never,
      uploadPlainRaw: up as never, appendGroupRaw: (async () => {}) as never,
      queueOrderHasRows, ownerWaitMs: 0,
    });
    u.noteSegment(segs(1)[0]!);
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([]);
    expect(up).not.toHaveBeenCalled();
  });
});

describe("rework addendum 8", () => {
  const meta = { cookies: "c", title: "rendered title", tid: 21, tag: "tag", public: false };

  it("H1: a master-owned room never claims a node queue in the sidecar (the master must not hold)", async () => {
    const paths = segs(2);
    const skips: Array<Record<string, unknown>> = [];
    const u = queueUploader({
      uploadOwner: () => "master",
      enqueueHubSkipped: (i) => { skips.push({ ...i }); return true; },
    });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    const sc = JSON.parse(readFileSync(sidecar(), "utf-8")) as Record<string, unknown>;
    // queueOrderKey/queueSeqBase are what tryRollingShortCircuit reads as "node queue still uploading".
    expect(sc.queueOrderKey).toBeUndefined();
    expect(sc.queueSeqBase).toBeUndefined();
    // The timeline rows still exist, under a stable key (so seq stays gap-free across sessions).
    expect(skips.map((s) => s.seq)).toEqual([1, 2]);
    expect(skips[0]!.streamKey).toBe(orderKeyOf());
  });

  it("H1b: a node-owned room still persists the queue key (behaviour unchanged)", async () => {
    const paths = segs(1);
    const u = queueUploader({ uploadOwner: () => "node" });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    const sc = JSON.parse(readFileSync(sidecar(), "utf-8")) as Record<string, unknown>;
    expect(sc.queueOrderKey).toBe(orderKeyOf());
  });

  it("P8-4: a failed import proof is re-measured after the bounded window and then imports", async () => {
    const paths = segs(1);
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [0], bv: FAKE_BV1, updatedAt: BASE_MS,
    }));
    let clock = NOW_MS;
    let calls = 0;
    const count = vi.fn(async () => { calls += 1; return calls === 1 ? null : 3; });
    const u = queueUploader({ countPartsRaw: count, queueProofRetryMs: 30_000, now: () => clock });
    paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(count).toHaveBeenCalledTimes(1);
    expect(seen(u, "__imports")).toEqual([]); // first proof failed: nothing imported, source kept
    clock += 31_000;
    await u.flush({ recordingActive: false });
    expect(count).toHaveBeenCalledTimes(2);
    expect(seen(u, "__imports")).toHaveLength(1); // the later good proof wins
  });
});

describe("rework addendum 9", () => {
  const meta = { cookies: "c", title: "rendered title", tid: 21, tag: "tag", public: false };

  it("A9-1: a queue-mode predecessor whose sources are already cleaned shares its order key (no second draft)", async () => {
    const prevBase = "主播_2026-06-27_07-30-00";
    const prevKey = "douyin:123:prev-order";
    const prevFile = path.join(rec, prevBase + "_000.ts");
    writeFileSync(prevFile, "abcdefgh");
    writeFileSync(path.join(rec, prevBase + ".rolling.json"), JSON.stringify({
      streamKey: "douyin:123:" + prevBase, sessionBase: prevBase, room,
      segments: [{ index: 0, path: prevFile }], confirmed: [0], queueOrderKey: prevKey,
      startMs: BASE_MS - 300_000, updatedAt: BASE_MS - 300_000,
    }));
    rmSync(prevFile); // cleanup-part already deleted it; the bv never reached the sidecar
    const u = queueUploader();
    u.noteSegment(segs(1)[0]!);
    await u.flush({ recordingActive: false });
    const enq = seen(u, "__enq");
    expect(enq).toHaveLength(1);
    expect(enq[0]!.orderKey).toBe(prevKey);
    expect(enq[0]!.seq).toBe(2); // continues after the predecessor's one confirmed part
  });

  it("A9-1b: with the switch off the legacy predecessor rule is untouched (byte-identical)", async () => {
    const prevBase = "主播_2026-06-27_07-30-00";
    const prevFile = path.join(rec, prevBase + "_000.ts");
    writeFileSync(prevFile, "abcdefgh");
    writeFileSync(path.join(rec, prevBase + ".rolling.json"), JSON.stringify({
      streamKey: "douyin:123:" + prevBase, sessionBase: prevBase, room,
      segments: [{ index: 0, path: prevFile }], confirmed: [0], queueOrderKey: "douyin:123:prev-order",
      startMs: BASE_MS - 300_000, updatedAt: BASE_MS - 300_000,
    }));
    rmSync(prevFile);
    const up = vi.fn(async () => FAKE_BV2);
    const u = new RollingUploader({
      room, uploadMeta, minSegmentSec: 0, now: () => NOW_MS,
      gate: { run: async (_k: string, fn: () => Promise<unknown>) => fn() } as never,
      uploadPlainRaw: up as never, appendGroupRaw: (async () => {}) as never,
    });
    u.noteSegment(segs(1)[0]!);
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([0]); // legacy: a bv-less, content-less predecessor is simply "none"
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("A9-2: a sidecar write failure in queue mode is alerted, not only logged", async () => {
    const paths = segs(2);
    const notify = vi.fn();
    const u = queueUploader({ notify });
    u.noteSegment(paths[0]!);
    chmodSync(rec, 0o500); // read-only directory: every further atomic write fails
    try {
      u.noteSegment(paths[1]!);
      await u.flush({ recordingActive: false });
      expect(seen(u, "__enq")).toEqual([]);
    } finally {
      chmodSync(rec, 0o755);
    }
    // The alert fires at the write itself (not only on the next flush): the queue stops here.
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("写盘"));
  });

  it("A9-3: a fully drained queue no longer blocks the legacy path", async () => {
    const paths = segs(2);
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE, room,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [0], bv: FAKE_BV1,
      queueOrderKey: orderKeyOf(), startMs: BASE_MS, updatedAt: NOW_MS,
    }));
    expect(importRollingConfirmedPart({ file: paths[0]!, index: 0, orderKey: orderKeyOf(), bv: FAKE_BV1, meta })).toBe("already");
    // Runtime proof of the guard: the row exists, but it is terminal => the queue owns nothing here.
    expect(openQueue().list({ kind: PART_KINDS.upload })).toHaveLength(1);
    expect(queueOrderHasRows(orderKeyOf())).toBe(false);
    const up = vi.fn(async () => FAKE_BV2);
    const remove = vi.fn(() => true);
    const notes: string[] = [];
    const u = new RollingUploader({
      room, uploadMeta, minSegmentSec: 0, now: () => NOW_MS,
      gate: { run: async (_k: string, fn: () => Promise<unknown>) => fn() } as never,
      uploadPlainRaw: up as never, appendGroupRaw: (async () => {}) as never, removeFile: remove,
      notify: (m) => notes.push(m), queueOrderHasRows,
    });
    paths.forEach((p) => u.noteSegment(p));
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([1]); // the unconfirmed tail continues on the legacy path
    expect(notes.join(" ")).not.toMatch(/队列/);
  });

  it("A9-4: a permanently failing archive proof is retried a bounded number of times", async () => {
    const paths = segs(1);
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE,
      segments: paths.map((p, i) => ({ index: i, path: p })), confirmed: [0], bv: FAKE_BV1, updatedAt: BASE_MS,
    }));
    let clock = NOW_MS;
    const count = vi.fn(async () => { throw new Error("archive lookup unavailable"); });
    const u = queueUploader({ countPartsRaw: count, queueProofRetryMs: 1_000, queueProofMaxAttempts: 3, now: () => clock });
    paths.forEach((p) => u.noteSegment(p));
    for (let i = 0; i < 5; i += 1) {
      clock += 10_000;
      await u.flush({ recordingActive: false });
    }
    expect(count).toHaveBeenCalledTimes(3);
  });

  it("A9-5: a bogus params.sidecarIndex is refused by the real processor validate", () => {
    const f = segs(1)[0]!;
    expect(enqueueRollingUploadPart({ file: f, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
    const s = openQueue();
    let params: Record<string, unknown> = {};
    try {
      params = s.list({ kind: PART_KINDS.upload })[0]!.params as Record<string, unknown>;
    } finally { s.close(); }
    expect(typeof params.sidecarIndex).toBe("number");
    const proc = makeUploadPartProcessor();
    expect(proc.validate(jobFrom(f, { ...params, sidecarIndex: -1 }))).toMatch(/sidecarIndex/);
    expect(proc.validate(jobFrom(f, params))).toBeNull();
  });
});

describe("rework addendum 10", () => {
  const meta = { cookies: "c", title: "rendered title", tid: 21, tag: "tag", public: false };

  it("A10-1: hub-owned sessions of one broadcast share one local order key and keep seq continuity", async () => {
    const s1File = path.join(rec, SESSION_BASE + "_000.ts");
    writeFileSync(s1File, "abcdefgh");
    utimesSync(s1File, new Date(BASE_MS), new Date(BASE_MS));
    const u1 = queueUploader({
      uploadOwner: () => "master",
      enqueueHubSkipped: (i) => enqueueHubOwnedSkip({ ...i, taskId: 1 }),
      queueMaxSeq: rollingQueueMaxSeq,
      queueOrderHasRows,
    });
    u1.noteSegment(s1File);
    await u1.flush({ recordingActive: false });

    const base2 = "主播_2026-06-27_09-05-00";
    const s2File = path.join(rec, base2 + "_000.ts");
    writeFileSync(s2File, "abcdefgh");
    utimesSync(s2File, new Date(BASE_MS + 300_000), new Date(BASE_MS + 300_000));
    const u2 = queueUploader({
      uploadOwner: () => "master",
      enqueueHubSkipped: (i) => enqueueHubOwnedSkip({ ...i, taskId: 1 }),
      queueMaxSeq: rollingQueueMaxSeq,
      queueOrderHasRows,
      now: () => BASE_MS + 360_000,
    });
    u2.noteSegment(s2File);
    await u2.flush({ recordingActive: false });

    const rows = rowsOf(PART_KINDS.upload).filter((r) => r.state === "skipped");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(new Set(rows.map((r) => r.orderKey)).size).toBe(1);
    // One local key per broadcast is DURABLE (that is what keeps consecutive sessions on one key),
    // and it is never the queueOrderKey the master's hold reads.
    const sc1 = JSON.parse(readFileSync(path.join(rec, SESSION_BASE + ".rolling.json"), "utf-8")) as Record<string, unknown>;
    expect(typeof sc1.hubOrderKey).toBe("string");
    expect(sc1.queueOrderKey).toBeUndefined();
    const sc2 = JSON.parse(readFileSync(path.join(rec, base2 + ".rolling.json"), "utf-8")) as Record<string, unknown>;
    expect(sc2.hubOrderKey).toBe(sc1.hubOrderKey);
    expect((readSidecar() ?? {}).queueOrderKey).toBeUndefined();
  });

  it("A10-2: a stale queueOrderKey is dropped for a hub-owned session once the queue has no open rows", async () => {
    const p = segs(1)[0]!;
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE, room,
      segments: [{ index: 0, path: p }], confirmed: [],
      queueOrderKey: orderKeyOf(), startMs: BASE_MS, updatedAt: BASE_MS,
    }));
    const u = queueUploader({
      uploadOwner: () => "master", enqueueHubSkipped: () => true, queueOrderHasRows, queueMaxSeq: rollingQueueMaxSeq,
    });
    u.noteSegment(p);
    await u.flush({ recordingActive: false });
    const sc = JSON.parse(readFileSync(sidecar(), "utf-8")) as Record<string, unknown>;
    expect(sc.queueOrderKey).toBeUndefined();
  });

  it("A10-3: the queue key is KEPT while the queue still has open rows (hold stays correct)", async () => {
    const p = segs(1)[0]!;
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE, room,
      segments: [{ index: 0, path: p }], confirmed: [],
      queueOrderKey: orderKeyOf(), startMs: BASE_MS, updatedAt: BASE_MS,
    }));
    expect(enqueueRollingUploadPart({ file: p, index: 0, orderKey: orderKeyOf(), meta })).toBe("queued");
    const u = queueUploader({
      uploadOwner: () => "master", enqueueHubSkipped: () => true, queueOrderHasRows, queueMaxSeq: rollingQueueMaxSeq,
    });
    u.noteSegment(p);
    await u.flush({ recordingActive: false });
    const sc = JSON.parse(readFileSync(sidecar(), "utf-8")) as Record<string, unknown>;
    expect(sc.queueOrderKey).toBe(orderKeyOf());
  });
});

describe("rework addenda 11-13", () => {
  const meta = { cookies: "c", title: "rendered title", tid: 21, tag: "tag", public: false };

  it("H1c: an existing queueOrderKey does not survive a rebind to hub-owned (master must upload)", async () => {
    const p = segs(1)[0]!;
    // The sidecar was written while the room was node-owned (queue mode): key + seq base, nothing uploaded.
    writeFileSync(sidecar(), JSON.stringify({
      streamKey: orderKeyOf(), sessionBase: SESSION_BASE, room,
      segments: [{ index: 0, path: p }], confirmed: [], queueOrderKey: orderKeyOf(), queueSeqBase: 4,
      startMs: BASE_MS, updatedAt: BASE_MS,
    }));
    const skips: Array<Record<string, unknown>> = [];
    const u = queueUploader({
      uploadOwner: () => "master",
      // Real adapter: the row must exist in the store for the guard assertions below.
      enqueueHubSkipped: (i) => { skips.push({ ...i }); return enqueueHubOwnedSkip({ ...i, taskId: 1 }); },
      queueOrderHasRows, queueMaxSeq: rollingQueueMaxSeq,
    });
    u.noteSegment(p);
    await u.flush({ recordingActive: false });
    const sc = JSON.parse(readFileSync(sidecar(), "utf-8")) as Record<string, unknown>;
    expect(sc.queueOrderKey).toBeUndefined();   // no claim => the master's hold cannot fire
    expect(sc.queueSeqBase).toBeUndefined();
    expect(typeof sc.hubOrderKey).toBe("string");
    expect(skips).toHaveLength(1);              // the node still writes its timeline row
    // What scan would hand the master: no queueOrderKey => no hold, normal pipeline uploads.
    expect(skips[0]!.streamKey).toBe(orderKeyOf());
    // The flip never injects an upload-part row (hub-owned writes only skip rows): the clear cannot race
    // a fresh open row into existence.
    const rows = rowsOf(PART_KINDS.upload);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("skipped");
    expect(queueOrderHasRows(orderKeyOf())).toBe(false);
  });

  it("A11-1: a briefly held sidecar lock is waited out, not treated as a write failure", async () => {
    const paths = segs(1);
    const notify = vi.fn();
    const u = queueUploader({ notify, sidecarLock: { timeoutMs: 5_000 } });
    const lock = sidecar() + ".lock";
    writeFileSync(lock, String(process.pid) + ".abcdef012345");
    // A separate live process holds the lock and releases it after 150ms (a slow peer writer).
    const child = spawn(process.execPath, [
      "-e",
      "setTimeout(function(){try{require('fs').unlinkSync(process.argv[1])}catch(e){}},150)",
      lock,
    ], { stdio: "ignore" });
    try {
      u.noteSegment(paths[0]!); // persist waits for the peer instead of marking the session untrusted
      await u.flush({ recordingActive: false });
    } finally {
      await new Promise((resolve) => child.on("exit", resolve));
    }
    expect(notify).not.toHaveBeenCalled();
    expect(seen(u, "__enq")).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });
});


  it("A13-1: the sidecar lock budget is configurable (a too-short budget fails loudly, not silently)", async () => {
    const paths = segs(1);
    const notify = vi.fn();
    const u = queueUploader({ notify, sidecarLock: { timeoutMs: 20 } });
    const lock = sidecar() + ".lock";
    writeFileSync(lock, String(process.pid) + ".abcdef012345");
    const child = spawn(process.execPath, [
      "-e",
      "setTimeout(function(){try{require('fs').unlinkSync(process.argv[1])}catch(e){}},150)",
      lock,
    ], { stdio: "ignore" });
    try {
      u.noteSegment(paths[0]!); // lock held past the 20ms budget => write failure => untrusted + alert
      await u.flush({ recordingActive: false });
    } finally {
      await new Promise((resolve) => child.on("exit", resolve));
    }
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("写盘"));
    expect(seen(u, "__enq")).toEqual([]); // nothing enqueued: the session stopped safely
  });
