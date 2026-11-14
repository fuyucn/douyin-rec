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
});
