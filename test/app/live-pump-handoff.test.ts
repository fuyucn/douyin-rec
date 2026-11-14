/**
 * T-221 (sol P1-3) integration: startup must disambiguate a pending submit intent BEFORE it
 * revalidates the WAL row, otherwise the row never gets the positive `validated` marker and the
 * REAL node queue refuses to take it. This test drives the actual pump AND the actual queue
 * helper, and asserts a real proc-queue row exists BEFORE the offline wait begins.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PART_KINDS } from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
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

/** Archive-view fake: the append intent is NOT present, so recover() clears it as unconfirmed. */
const archiveFetch = (() => Promise.resolve(new Response(JSON.stringify({
  code: 0,
  data: { archive: { aid: 7, bvid: "BV1", title: "t", tid: 21 }, videos: [] },
}), { status: 200 }))) as unknown as typeof fetch;

describe("T-221 startup handoff into the real node queue", () => {
  it("pending + unvalidated row: recover first, revalidate, then a REAL queue row before the idle wait", async () => {
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
    let rowsBeforeWait = -1;
    const onHandoff = (sp: string): LivePumpHandoffReceipt => {
      handoffs.push(sp);
      const queued = enqueueLivePumpPending({
        statePath: sp, cookiesPath: join(root, "cookies.json"), log: () => {},
      });
      const store = new ProcQueueStore(procQueueDbPath(root));
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

    expect(handoffs).toEqual([statePath]);
    expect(rowsBeforeWait).toBe(1); // the REAL queue owns the row before the offline wait
    const st = readLivePumpState(statePath);
    expect(st?.pending).toBeUndefined(); // disambiguated
    expect(st?.parts[0]?.validated).toBe(true); // revalidated AFTER recover
    expect(st?.parts[0]?.confirmed).toBe(false);
    expect(r.uploadPending).toBe(true);
    expect(r.error).toBe("queued uploads pending");
  }, 30_000);

  it("sol P1-4: an all-needs-manual backlog goes through the REAL classifier and keeps recording", async () => {
    // The pump-side test used a hand-written `blocked` receipt, which bypasses the production
    // classifier. Here the truncation goes through the REAL enqueue helper AND the REAL receipt
    // classifier: a needs-manual row must be `blocked` (keep recording/waiting), not `retryable`
    // (immediate exit 75 queued forever on a condition no retry can settle).
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

    let polls = 0;
    const r = await runLivePump({
      cookiesPath: join(root, "cookies.json"), room: "t221", spoolDir: dir,
      title: "t", tid: 21, tag: "x", private: true,
      sizeCap: 10 * 1024 * 1024, maxSegments: 1, submit: true, spoolMode: "full", quality: "origin",
      waitForBroadcast: true, idlePollMs: 1,
      fetchImpl: archiveFetch, fetch: async () => ({ living: false }),
      sleep: async () => { polls++; }, shouldStop: () => polls >= 2,
      onHandoff: (sp) => livePumpHandoffReceipt(enqueueLivePumpPending({
        statePath: sp, cookiesPath: join(root, "cookies.json"), log: () => {},
      })),
      probeDuration: async () => 60, scanDtsGap: async () => null, log: () => {},
    });

    expect(polls).toBeGreaterThan(0); // entered the recording wait instead of exiting immediately
    expect(r.uploadPending).toBe(true);
    expect(r.error).toBe("queued uploads pending");
    expect(readLivePumpState(statePath)?.parts[0]?.confirmed).toBe(false);
  }, 30_000);

  it("sol 4th: an ambiguous pending create is blocked, not a zero-take retry loop", async () => {
    // recover() can prove the pending create is AMBIGUOUS (two same-title candidates). The queue
    // helper only sees "pending" and reports deferred, so the receipt classifier would say
    // retryable and the pump would exit 75 before ever recording. The pump must override it.
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
    const ambiguousFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const m = (init?.method ?? "GET").toUpperCase();
      if (m !== "GET") submits++;
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
    expect(r.uploadPending).toBe(true);
    expect(r.error).toBe("queued uploads pending");
    // The pending intent is preserved for a human; nothing was confirmed.
    expect(readLivePumpState(statePath)?.pending?.partIndex).toBe(0);
    expect(readLivePumpState(statePath)?.parts[0]?.confirmed).toBe(false);
  }, 30_000);
});
