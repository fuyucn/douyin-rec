/** T-251: startup holds unqualified live delivery without replay or queue ownership. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PART_KINDS } from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { uploadAliasPath } from "@drec/processors";
import { appendConfirmedJournal, livePumpHasUnconfirmed } from "@drec/zero-upload";
import {
  runLivePump, writeLivePumpState, readLivePumpState, livePumpStatePath,
  setSpawnForTest, type LivePumpState, type LivePumpHandoffReceipt,
} from "../../packages/zero-upload/src/live-pump.js";
import { enqueueLivePumpPending } from "../../packages/app/src/live-pump-queue.js";
import { livePumpHandoffReceipt } from "../../packages/cli/src/live-pump-handoff.js";

let root: string;
let oldRoot: string | undefined;

beforeEach(() => {
  oldRoot = process.env.DOUYIN_REC_ROOT;
  root = mkdtempSync(join(tmpdir(), "live-pump-handoff-"));
  process.env.DOUYIN_REC_ROOT = root;
  mkdirSync(join(root, "recordings", "t221"), { recursive: true });
  writeFileSync(join(root, "cookies.json"), JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "DedeUserID", value: "9" }, { name: "bili_jct", value: "csrf" }] },
  }));
});

afterEach(() => {
  setSpawnForTest(undefined);
  process.env.DOUYIN_REC_ROOT = oldRoot;
  rmSync(root, { recursive: true, force: true });
});

/** Negative archive read must never be used to clear a quarantined intent. */
const archiveFetch = (() => Promise.resolve(new Response(JSON.stringify({
  code: 0,
  data: { archive: { aid: 7, bvid: "BV1", title: "t", tid: 21 }, videos: [] },
}), { status: 200 }))) as unknown as typeof fetch;

describe("T-221 startup handoff into the real node queue", () => {
  it("retains ambiguous pending intent instead of handing it to the legacy queue", async () => {
    const dir = join(root, "recordings", "t221");
    const p0 = join(dir, "a_000.live.ts");
    writeFileSync(p0, "aaa");
    const statePath = livePumpStatePath(dir, "t221");
    const state: LivePumpState = {
      schemaVersion: 1, room: "t221", createdAt: 1, title: "t", tid: 21, tag: "x", private: true,
      updatedAt: Date.now(), bvid: "BV1", queueManaged: true,
      parts: [{
        index: 0, spoolPath: p0, filename: "a_000.live.ts", stem: "s0", title: "P1",
        bytes: 3, durationSec: 2, confirmed: false,
      }],
      // Same index as the unvalidated row: the OLD order (validate → recover) could not write
      // `validated` because noteUnconfirmedPart refuses a pending index.
      pending: { kind: "append", partIndex: 0, stem: "s0", title: "P1", bytes: 3, durationSec: 2, spoolPath: p0 },
    };
    writeLivePumpState(statePath, state);

    const handoffs: string[] = [];
    let polls = 0;
    const onHandoff = (sp: string): LivePumpHandoffReceipt => {
      handoffs.push(sp);
      const queued = enqueueLivePumpPending({
        statePath: sp, cookiesPath: join(root, "cookies.json"), log: () => {},
      });
      const store = new ProcQueueStore(procQueueDbPath(root));
      let rowsBeforeWait: number;
      try {
        rowsBeforeWait = store.rowsForOrderSeq("t221:1", 1, PART_KINDS.upload, 1)
          .filter((r) => r.state === "pending" || r.state === "running").length;
      } finally { store.close(); }
      if (queued.failed > 0 || queued.error) {
        return { status: "blocked", detail: `failed=${queued.failed} error=${queued.error ?? ""}` };
      }
      return rowsBeforeWait === 1 ? { status: "owned" } : { status: "blocked", detail: "no real queue row" };
    };

    const r = await runLivePump({
      cookiesPath: join(root, "cookies.json"), room: "t221", spoolDir: dir,
      title: "t", tid: 21, tag: "x", private: true,
      sizeCap: 10 * 1024 * 1024, maxSegments: 1, submit: true, spoolMode: "full", quality: "origin",
      waitForBroadcast: true, idlePollMs: 1,
      fetchImpl: archiveFetch, fetch: async () => ({ living: false }),
      sleep: async () => { polls++; }, shouldStop: () => polls >= 3,
      onHandoff,
      probeDuration: async () => 60, scanDtsGap: async () => null, log: () => {},
    });

    expect(handoffs).toEqual([]);
    expect(existsSync(procQueueDbPath(root))).toBe(false);
    const st = readLivePumpState(statePath);
    expect(st?.pending).toEqual(state.pending);
    expect(st?.parts[0]?.validated).toBeUndefined();
    expect(st?.parts[0]?.confirmed).toBe(false);
    expect(r.uploadPending).toBeUndefined();
    expect(r.error).toContain("manual review");
    expect(r.outcome).not.toBe("idle");
  }, 30_000);

  it("sol P1-4: an all-needs-manual backlog goes through the REAL classifier and keeps recording", async () => {
    const dir = join(root, "recordings", "t221");
    const p0 = join(dir, "a_000.live.ts");
    writeFileSync(p0, "truncated-bytes");
    const statePath = livePumpStatePath(dir, "t221");
    writeLivePumpState(statePath, {
      schemaVersion: 1, room: "t221", createdAt: 1, title: "t", tid: 21, tag: "x", private: true,
      updatedAt: Date.now(), bvid: "BV1", queueManaged: true,
      parts: [{
        index: 0, spoolPath: p0, filename: "a_000.live.ts", stem: "s0", title: "P1",
        bytes: 15, durationSec: 2, confirmed: false, spoolIncomplete: true,
      }],
    });

    const receipt = livePumpHandoffReceipt(enqueueLivePumpPending({ statePath, cookiesPath: join(root, "cookies.json") }));
    expect(receipt.status).toBe("blocked");
    const onHandoff = vi.fn(() => receipt);
    let polls = 0;
    const r = await runLivePump({
      cookiesPath: join(root, "cookies.json"), room: "t221", spoolDir: dir,
      title: "t", tid: 21, tag: "x", private: true,
      sizeCap: 10 * 1024 * 1024, maxSegments: 1, submit: true, spoolMode: "full", quality: "origin",
      waitForBroadcast: true, idlePollMs: 1,
      fetchImpl: archiveFetch, fetch: async () => ({ living: false }),
      sleep: async () => { polls++; }, shouldStop: () => polls >= 2,
      onHandoff,
      probeDuration: async () => 60, scanDtsGap: async () => null, log: () => {},
    });

    expect(polls).toBeGreaterThan(0); // entered the recording wait instead of exiting immediately
    expect(onHandoff).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.uploadPending).toBeUndefined();
    expect(r.error).toContain("manual review");
    expect(existsSync(procQueueDbPath(root))).toBe(false);
    expect(readLivePumpState(statePath)?.parts[0]?.confirmed).toBe(false);
  }, 30_000);

  it("sol 4th: an ambiguous pending create is blocked, not a zero-take retry loop", async () => {
    const dir = join(root, "recordings", "t221");
    const p0 = join(dir, "a_000.live.ts");
    writeFileSync(p0, "aaa");
    const statePath = livePumpStatePath(dir, "t221");
    writeLivePumpState(statePath, {
      schemaVersion: 1, room: "t221", createdAt: 1, title: "t", tid: 21, tag: "x", private: true,
      updatedAt: Date.now(), queueManaged: true,
      parts: [{ index: 0, spoolPath: p0, filename: "a_000.live.ts", stem: "s0", title: "P1", bytes: 3, durationSec: 2, confirmed: false }],
      // A create intent whose outcome was never persisted (no bvid/aid): the dangerous case.
      pending: { kind: "create", partIndex: 0, stem: "s0", title: "P1", bytes: 3, durationSec: 2, spoolPath: p0 },
    });

    let polls = 0;
    let submits = 0;
    let readbacks = 0;
    const ambiguousFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const m = (init?.method ?? "GET").toUpperCase();
      if (m !== "GET") submits++;
      else readbacks++;
      // The archive list is readable and returns TWO exact same-title candidates -> ambiguous.
      if (u.pathname === "/x/web/archives") {
        return new Response(JSON.stringify({
          code: 0, data: { archives: [{ aid: 1, bvid: "BV1", title: "t" }, { aid: 2, bvid: "BV2", title: "t" }] },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await runLivePump({
      cookiesPath: join(root, "cookies.json"), room: "t221", spoolDir: dir,
      title: "t", tid: 21, tag: "x", private: true,
      sizeCap: 10 * 1024 * 1024, maxSegments: 1, submit: true, spoolMode: "full", quality: "origin",
      waitForBroadcast: true, idlePollMs: 1,
      fetchImpl: ambiguousFetch, fetch: async () => ({ living: false }),
      sleep: async () => { polls++; }, shouldStop: () => polls >= 2,
      onHandoff: (sp) => livePumpHandoffReceipt(enqueueLivePumpPending({
        statePath: sp, cookiesPath: join(root, "cookies.json"), log: () => {},
      })),
      probeDuration: async () => 60, scanDtsGap: async () => null, log: () => {},
    });

    expect(polls).toBeGreaterThan(0); // kept the recording wait, not an immediate exit 75
    expect(submits).toBe(0); // never re-submitted the ambiguous create/append
    expect(readbacks).toBe(0);
    expect(r.uploadPending).toBeUndefined();
    expect(r.error).toContain("manual review");
    // The pending intent is preserved for a human; nothing was confirmed.
    expect(readLivePumpState(statePath)?.pending?.partIndex).toBe(0);
    expect(readLivePumpState(statePath)?.parts[0]?.confirmed).toBe(false);
  }, 30_000);

  it.each((["queueManaged", "deliveryDeferred", "unmarked confirmed", "journal-only", "empty marker", "archive-only", "observed marker"] as const)
    .flatMap(history => (["full", "none"] as const).map(spoolMode => ({ history, spoolMode }))))(
    "holds $history restart with $spoolMode spool before readback, recovery or custom queue ownership", async ({ history, spoolMode }) => {
      const dir = join(root, "recordings", "t221");
      const file = join(dir, "old.live.ts");
      writeFileSync(file, "video");
      const alias = uploadAliasPath(file);
      mkdirSync(dirname(alias), { recursive: true });
      linkSync(file, alias);
      const statePath = livePumpStatePath(dir, "t221");
      const state: LivePumpState = {
        schemaVersion: 1, room: "t221", createdAt: 1, title: "t", tid: 21, tag: "x", private: true,
        updatedAt: 1, ...(history === "empty marker" ? {} : { bvid: "BV1", aid: 7 }),
        ...(history === "queueManaged" || history === "empty marker" || history === "observed marker" ? { queueManaged: true } : {}),
        ...(history === "deliveryDeferred" ? { deliveryDeferred: true } : {}),
        ...(history === "observed marker" ? { submissionProofVersion: 1 } : {}),
        parts: history === "empty marker" || history === "archive-only" ? [] : [{
          index: 0, spoolPath: file, filename: "old.live.ts", stem: "s0", title: "P1", bytes: 5,
          durationSec: 2, confirmed: history !== "journal-only",
          ...(history === "observed marker" ? { proof: "observed", nativeKey: "s0", observedAt: 2 } : {}),
        }],
      };
      writeLivePumpState(statePath, state);
      appendConfirmedJournal(statePath, { index: 0, bv: "BV1", at: 3, createdAt: 1 });
      const before = readFileSync(statePath, "utf-8");
      const journal = readFileSync(statePath + ".confirmed", "utf-8");
      const readback = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {
        archive: { aid: 7, bvid: "BV1", title: "t", tid: 21 }, videos: [{ cid: 1, filename: "s0", title: "P1" }],
      } }), { status: 200 }));
      const probeDuration = vi.fn(async () => 60);
      const scanDtsGap = vi.fn(async () => null);
      const onHandoff = vi.fn(() => ({ status: "owned" as const }));
      let polls = 0;

      const result = await runLivePump({
        cookiesPath: join(root, "cookies.json"), room: "t221", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true,
        sizeCap: 10 * 1024 * 1024, maxSegments: 1, submit: true, spoolMode, quality: "origin",
        waitForBroadcast: true, idlePollMs: 1, fetchImpl: readback, fetch: async () => ({ living: false }),
        sleep: async () => { polls++; }, shouldStop: () => polls >= 2,
        probeDuration, scanDtsGap, onHandoff, log: () => {},
      });

      expect(result.ok).toBe(false);
      expect(result.uploadPending).toBeUndefined();
      expect(result.outcome).not.toBe("idle");
      expect(result.error).toMatch(/manual review|observation paused/);
      expect(readback).not.toHaveBeenCalled();
      expect(probeDuration).not.toHaveBeenCalled();
      expect(scanDtsGap).not.toHaveBeenCalled();
      expect(onHandoff).not.toHaveBeenCalled();
      expect(readFileSync(statePath, "utf-8")).toBe(before);
      expect(readFileSync(statePath + ".confirmed", "utf-8")).toBe(journal);
      expect(readFileSync(file, "utf-8")).toBe("video");
      expect(readFileSync(alias, "utf-8")).toBe("video");
      expect(livePumpHasUnconfirmed(statePath)).toBe(true);
      expect(existsSync(procQueueDbPath(root))).toBe(false);
      expect(polls > 0).toBe(spoolMode === "full");
    },
  );
});
