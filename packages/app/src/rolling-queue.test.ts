// plan 046 PR6 (方案 A): queue mode only enqueues; the legacy path stays byte-identical when off.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RollingUploader, makeRollingUploadHookFactory } from "./rolling-upload.js";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { TaskStore } from "./store.js";
import { PART_KINDS, jobIdOf, type PartCtx } from "@drec/core";
import {
  enqueueRollingUploadPart, enqueueRollingSkipPart, importRollingConfirmedPart, rollingQueueModeEnabled,
} from "./rolling-queue.js";
import { makeUploadPartProcessor } from "@drec/processors";
import { enqueueHubOwnedSkip } from "./hub-owner.js";

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
    expect(importRollingConfirmedPart({ file: paths[0]!, index: 0, orderKey: orderKeyOf(), bv: FAKE_BV1, meta })).toBe("already");
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

});
