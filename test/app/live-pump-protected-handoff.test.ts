import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uploadAliasPath } from "@drec/processors";
import { procQueueDbPath } from "@drec/proc-queue";
import {
  LivePumpSession, appendConfirmedJournal, livePumpStatePath, readLivePumpState,
  runLivePump, setSpawnForTest, writeLivePumpState, type LivePumpState,
} from "../../packages/zero-upload/src/live-pump.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "live-pump-protected-handoff-"));
  vi.stubEnv("DOUYIN_REC_ROOT", root);
  writeFileSync(join(root, "cookies.json"), JSON.stringify({ cookie_info: { cookies: [
    { name: "SESSDATA", value: "test-session" }, { name: "DedeUserID", value: "9" },
    { name: "bili_jct", value: "test-csrf" },
  ] } }));
});

afterEach(() => {
  setSpawnForTest(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function seedProtected(marker: "queueManaged" | "deliveryDeferred") {
  const dir = join(root, "recordings", "protected");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "part.ts");
  writeFileSync(file, "video");
  const alias = uploadAliasPath(file);
  mkdirSync(dirname(alias), { recursive: true });
  linkSync(file, alias);
  const stat = statSync(file);
  const sourceFp = { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
  const state: LivePumpState = {
    schemaVersion: 1, submissionProofVersion: 1, room: "protected", createdAt: 1_000,
    updatedAt: Date.now(), title: "T", tid: 21, tag: "test", private: true, bvid: "BV1", aid: 7,
    [marker]: true,
    parts: [{ index: 0, spoolPath: file, filename: "part.ts", stem: "native-first", nativeKey: "native-first",
      title: "P1", bytes: stat.size, durationSec: 60, sealed: true, validated: true, confirmed: false,
      proof: "accepted", acceptedAt: 1_001, sourceFp }],
    pending: { kind: "append", submissionState: "accepted", partIndex: 0, stem: "native-first", title: "P1",
      bytes: stat.size, durationSec: 60, spoolPath: file, acceptedAt: 1_001, sourceFp },
  };
  const statePath = livePumpStatePath(dir, state.room);
  writeLivePumpState(statePath, state);
  appendConfirmedJournal(statePath, { index: 0, bv: "BV1", at: 1_002, createdAt: state.createdAt });
  return { dir, file, alias, state, statePath };
}

describe("protected live-pump handoff containment", () => {
  it.each([
    { marker: "queueManaged", spoolMode: "none" },
    { marker: "deliveryDeferred", spoolMode: "none" },
    { marker: "queueManaged", spoolMode: "full" },
    { marker: "deliveryDeferred", spoolMode: "full" },
  ] as const)("keeps $marker observation-paused on $spoolMode restart even with a matching archive", async ({ marker, spoolMode }) => {
    const test = seedProtected(marker);
    const before = readFileSync(test.statePath, "utf-8");
    const recover = vi.spyOn(LivePumpSession.prototype, "recover");
    const onHandoff = vi.fn(() => ({ status: "owned" as const }));
    const spawn = vi.fn(() => { throw new Error("Unexpected recorder spawn"); });
    setSpawnForTest(spawn);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ code: 0, data: {
      archive: { aid: 7, bvid: "BV1", title: "T", tid: 21 },
      videos: [{ filename: "native-first", title: "P1" }],
    } }));
    let polls = 0;

    const result = await runLivePump({
      cookiesPath: join(root, "cookies.json"), room: test.state.room, spoolDir: test.dir,
      title: "T", tid: 21, tag: "test", private: true, sizeCap: 10 * 1024 * 1024,
      submit: true, spoolMode, quality: "origin", waitForBroadcast: true, idlePollMs: 1,
      fetchImpl, fetch: async () => ({ living: false }), sleep: async () => { polls++; },
      shouldStop: () => polls >= 2, onHandoff, log: () => {},
      probeDuration: async () => 60, scanDtsGap: async () => null,
    });

    expect(result.ok).toBe(false);
    if (spoolMode === "none") {
      expect(result.uploadPending).toBeUndefined();
      expect(result.error).toContain("observation paused");
      expect(polls).toBe(0);
    } else {
      expect(result.uploadPending).toBe(true);
      expect(polls).toBeGreaterThan(0);
    }
    expect(recover).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onHandoff).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(procQueueDbPath(root))).toBe(false);
    expect(readFileSync(test.statePath, "utf-8")).toBe(before);
    expect(readLivePumpState(test.statePath)?.pending).toEqual(test.state.pending);
    expect(readLivePumpState(test.statePath)?.parts).toEqual(test.state.parts);
    expect(readFileSync(test.file, "utf-8")).toBe("video");
    expect(readFileSync(test.alias, "utf-8")).toBe("video");
  });

  it("does not let a stale owned adapter take a protected explicit spool-only order", async () => {
    const test = seedProtected("queueManaged");
    delete test.state.queueManaged;
    delete test.state.pending;
    delete test.state.parts[0]!.proof;
    delete test.state.parts[0]!.acceptedAt;
    writeLivePumpState(test.statePath, test.state);
    const before = readFileSync(test.statePath, "utf-8");
    const onHandoff = vi.fn(() => ({ status: "owned" as const }));
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("Unexpected archive request"); });
    let polls = 0;

    const result = await runLivePump({
      cookiesPath: join(root, "cookies.json"), room: test.state.room, spoolDir: test.dir,
      title: "T", tid: 21, tag: "test", private: true, sizeCap: 10 * 1024 * 1024,
      submit: true, submitMode: "spool", spoolMode: "full", quality: "origin", waitForBroadcast: true,
      idlePollMs: 1, fetchImpl, fetch: async () => ({ living: false }),
      sleep: async () => { polls++; }, shouldStop: () => polls >= 2, onHandoff, log: () => {},
      probeDuration: async () => 60, scanDtsGap: async () => null,
    });

    expect(result.ok).toBe(false);
    expect(result.uploadPending).toBe(true);
    expect(polls).toBeGreaterThan(0);
    expect(onHandoff).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(procQueueDbPath(root))).toBe(false);
    expect(readFileSync(test.statePath, "utf-8")).toBe(before);
    expect(readFileSync(test.file, "utf-8")).toBe("video");
    expect(readFileSync(test.alias, "utf-8")).toBe("video");
  });

  it.each([false, true])("reserves a pending native part index when earlier rows exist=%s", (withEarlierPart) => {
    const test = seedProtected("queueManaged");
    const pendingFile = join(test.dir, "pending.ts");
    writeFileSync(pendingFile, "video");
    const stat = statSync(pendingFile);
    test.state.pending = { ...test.state.pending!, partIndex: 4, stem: "native-pending", spoolPath: pendingFile,
      sourceFp: { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino } };
    if (!withEarlierPart) test.state.parts = [];
    writeLivePumpState(test.statePath, test.state);
    const before = readFileSync(test.statePath, "utf-8");

    const session = new LivePumpSession({ cookiesPath: join(root, "cookies.json"),
      room: test.state.room, spoolDir: test.dir, title: "T", tid: 21, tag: "test", log: () => {} });

    expect(session.nextPartIndex).toBe(5);
    expect(session.snapshot().pending).toEqual(test.state.pending);
    expect(readFileSync(test.statePath, "utf-8")).toBe(before);
    expect(readFileSync(test.file, "utf-8")).toBe("video");
    expect(readFileSync(test.alias, "utf-8")).toBe("video");
    expect(readFileSync(pendingFile, "utf-8")).toBe("video");
  });
});
