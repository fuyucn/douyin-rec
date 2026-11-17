import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import * as core from "@drec/core";
import * as app from "@drec/app";
import * as pump from "@drec/zero-upload";
import * as ledger from "@drec/orchestrator";
import * as submitter from "./live-pump-submitter.js";
import { runStreamUploadRecord } from "./stream-upload-record.js";
import { registerLivePumpCommand } from "./live-pump-command.js";
import { zeroDiskSpoolName } from "./zero-disk-room.js";
import type { StreamUploadInput } from "./stream-upload-setup.js";

vi.mock("@drec/zero-upload", async (original) => ({
  ...await original<typeof import("@drec/zero-upload")>(), runLivePump: vi.fn(),
}));
vi.mock("@drec/app", async (original) => ({
  ...await original<typeof import("@drec/app")>(),
  LiveUploadReporter: vi.fn(function () { return { event: vi.fn() }; }),
  createZeroDiskReporter: vi.fn(), makeNodeSubmitGate: vi.fn(),
  zeroDiskNodePreflight: vi.fn(), writeZeroDiskStatus: vi.fn(),
  enqueueLivePumpPending: vi.fn(),
}));
vi.mock("@drec/orchestrator", async (original) => ({
  ...await original<typeof import("@drec/orchestrator")>(), recordStreamUpload: vi.fn(),
}));

let root: string;
let input: StreamUploadInput;
let exit: MockInstance<typeof process.exit>;
let build: MockInstance<typeof submitter.buildLivePumpSubmitter>;
let listenerCounts: number[];
const signals = ["SIGINT", "SIGTERM", "SIGUSR2"] as const;
const ref = { targetId: "bilibili-upos", id: "BILIfake1" };
const gate = { noteSubmit: vi.fn(), noteRateLimited: vi.fn() };
const reporter = { running: vi.fn(), finish: vi.fn(), failed: vi.fn(), partConfirmed: vi.fn() };

function result(overrides: Partial<pump.RunLivePumpResult> = {}): pump.RunLivePumpResult {
  return { ok: true, outcome: "idle", title: "T", segments: [], spoolDir: input.recording.outDir,
    statePath: pump.livePumpStatePath(input.recording.outDir, "test-room"), ...overrides };
}

function writeState(dir: string, room = "test-room", spoolName = "pending.ts"): void {
  mkdirSync(dir, { recursive: true });
  pump.writeLivePumpState(pump.livePumpStatePath(dir, room), {
    schemaVersion: 1, room, createdAt: 1, updatedAt: 1, title: "T", tid: 21, tag: "test",
    private: true, parts: [{ index: 0, spoolPath: join(dir, spoolName),
      filename: spoolName, stem: "pending", title: "P1", bytes: 1, durationSec: 180,
      confirmed: false }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "drec-stream-entry-"));
  vi.stubEnv("DOUYIN_REC_ROOT", root);
  vi.stubEnv("BILIUP_COOKIE", join(root, "upload.json"));
  vi.stubEnv("DREC_LIVE_PUMP_DRIVER", "0");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external request"); }));
  writeFileSync(join(root, "upload.json"), JSON.stringify({ cookie_info: { cookies: [
    { name: "SESSDATA", value: "test-session" }, { name: "bili_jct", value: "test-csrf" },
  ] } }));
  input = {
    enabled: true, options: { room: "https://live.douyin.com/test-room", danmu: "0",
      cookiesFile: join(root, "recording-cookie.txt") },
    platform: core.platformForRoom("test-room"),
    recording: { outDir: join(root, "output"), quality: "origin", segmentSec: 0 },
    notifier: { notify: vi.fn(async () => {}) },
  };
  mkdirSync(input.recording.outDir);
  vi.spyOn(app, "readOutputLayout").mockReturnValue("room");
  vi.spyOn(app, "resolveStreamUploadMeta").mockReturnValue({ tid: 21, tag: "local", private: true });
  vi.spyOn(app, "effectiveHubConfig").mockReturnValue({ path: "unused", json: '{"resources":{"diskMinGB":0}}' });
  vi.mocked(app.createZeroDiskReporter).mockReturnValue(reporter);
  vi.mocked(app.makeNodeSubmitGate).mockReturnValue(gate);
  reporter.finish.mockReturnValue({ receiptWritten: true });
  vi.mocked(ledger.recordStreamUpload).mockReturnValue({ ok: true, bvid: ref.id });
  vi.mocked(pump.runLivePump).mockResolvedValue(result());
  build = vi.spyOn(submitter, "buildLivePumpSubmitter");
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  listenerCounts = signals.map((signal) => process.listenerCount(signal));
});

afterEach(() => {
  expect(signals.map((signal) => process.listenerCount(signal))).toEqual(listenerCounts);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("production stream-upload entry", () => {
  it("disabled mode has no upload, filesystem, reporter or signal side effects", async () => {
    input.enabled = false;
    const before = readdirSync(root);
    expect(await runStreamUploadRecord(input)).toBe(false);
    expect(readdirSync(root)).toEqual(before);
    expect(readdirSync(input.recording.outDir)).toEqual([]);
    expect(app.readOutputLayout).not.toHaveBeenCalled();
    expect(app.zeroDiskNodePreflight).not.toHaveBeenCalled();
    expect(app.LiveUploadReporter).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(pump.runLivePump).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("enabled mode uses the real default driver, sticky state and distinct drain/stop signals", async () => {
    writeState(input.recording.outDir);
    const draining = vi.spyOn(core, "noteRecorderDraining").mockImplementation(() => {});
    vi.spyOn(core, "noteRecorderSignal").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      code: 0, data: { aid: 7, bvid: ref.id },
    })));
    vi.mocked(pump.runLivePump).mockImplementationOnce(async (options) => {
      expect(options).toMatchObject({ room: "test-room", spoolDir: input.recording.outDir,
        cookiesPath: join(root, "upload.json"), submit: true, spoolMode: "full",
        waitForBroadcast: true, diskMinGB: 0, maxSegments: 0 });
      expect(options.submitter).toBe(build.mock.results[0].value);
      const published = await options.submitter!.ensureStreamedArchive({
        archive: { title: "T", tid: 21, tags: ["test"], desc: "", policy: {
          visibility: "private", copyright: "self", watermark: false } },
        name: "stem", skipFindRecent: true,
      });
      expect(published.ref).toEqual(ref);
      process.emit("SIGUSR2");
      process.emit("SIGUSR2");
      expect(draining).toHaveBeenCalledTimes(1);
      expect(options.drainSignal?.aborted).toBe(true);
      expect(options.signal?.aborted).toBe(false);
      process.emit("SIGTERM");
      expect(options.signal?.aborted).toBe(true);
      expect(core.noteRecorderSignal).toHaveBeenCalledWith("SIGTERM");
      return result();
    });
    expect(await runStreamUploadRecord(input)).toBe(true);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(app.createZeroDiskReporter).not.toHaveBeenCalled();
    expect(ledger.recordStreamUpload).not.toHaveBeenCalled();
  });

  it("latches the first live time across reconnects while refreshing the stream owner", async () => {
    const firstLive = new Date("2025-01-02T03:04:05Z").getTime();
    const clock = vi.spyOn(Date, "now").mockReturnValue(firstLive - 60_000);
    const stream = vi.spyOn(input.platform, "getStream")
      .mockResolvedValueOnce({ living: false, owner: "Waiting" })
      .mockResolvedValueOnce({ living: true, owner: "First", url: "https://test.invalid/stream" })
      .mockResolvedValueOnce({ living: false })
      .mockResolvedValueOnce({ living: true, owner: "Updated", url: "https://test.invalid/reconnected" });
    vi.mocked(pump.runLivePump).mockImplementationOnce(async (options) => {
      await options.fetch(options.room, options.quality);
      clock.mockReturnValue(firstLive);
      await options.fetch(options.room, options.quality);
      const titleContext = { platform: "douyin", roomSlug: "test-room", startMs: firstLive,
        anchorName: "First", liveTitle: "Broadcast" };
      expect(options.titleForLive!("Broadcast")).toBe(app.resolveStreamUploadTitle(titleContext));
      expect(options.partTitle!(1, "Broadcast")).toBe(app.resolveStreamPartTitle({ ...titleContext, partIndex: 1 }));
      expect(options.spoolName!(0)).toBe(zeroDiskSpoolName("test-room", firstLive, 0));
      clock.mockReturnValue(firstLive + 180_000);
      await options.fetch(options.room, options.quality);
      clock.mockReturnValue(firstLive + 300_000);
      await options.fetch(options.room, options.quality);
      expect(options.titleForLive!("Broadcast")).toBe(app.resolveStreamUploadTitle({
        ...titleContext, anchorName: "Updated",
      }));
      expect(options.spoolName!(1)).toBe(zeroDiskSpoolName("test-room", firstLive, 1));
      return result({ bvid: ref.id, outcome: "uploaded" });
    });
    await runStreamUploadRecord(input);
    expect(stream.mock.calls).toEqual(Array.from({ length: 4 }, () => ["test-room", "origin"]));
    expect(ledger.recordStreamUpload).toHaveBeenCalledWith(expect.objectContaining({
      startMs: firstLive, streamKey: core.zeroDiskStreamKey("douyin", "test-room", firstLive),
    }));
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("managed runs use only delivered metadata and verified credentials, then write a receipt", async () => {
    Object.assign(input.options, { zeroDiskManaged: "1", streamUploadTid: "99",
      streamUploadTag: "ignored", streamUploadPrivate: "1" });
    const delivery: core.ZeroDiskDelivery = { v: 1, accountKey: "bilibili:test", meta: {
      tid: 21, tag: "delivered", private: false, desc: "description", seasonSectionId: 7,
      submissionTitleTemplate: "archive-{name}-{title}", partTitleTemplate: "part-{name}-{title}",
    } };
    vi.mocked(app.zeroDiskNodePreflight).mockReturnValue({ ok: true, delivery,
      cookiesPath: join(root, "verified.json"), credentialSource: "delivered-path" });
    vi.mocked(pump.runLivePump).mockImplementationOnce(async (options) => {
      expect(options).toMatchObject({ cookiesPath: join(root, "verified.json"),
        tid: 21, tag: "delivered", private: false, desc: "description", seasonSectionId: 7, submitGate: gate });
      expect(build).toHaveBeenCalledWith(expect.objectContaining({ submitGate: gate,
        cookiesPath: join(root, "verified.json"), spoolDir: options.spoolDir, pumpRoom: options.room }));
      expect(options.title).toBe("archive-test-room-");
      expect(options.titleForLive?.("live")).toBe("archive-test-room-live");
      expect(options.partTitle?.(1, "live")).toBe("part-test-room-live");
      options.onPartConfirmed?.({ count: 1, bvid: ref.id });
      return result({ outcome: "uploaded", bvid: ref.id });
    });
    await runStreamUploadRecord(input);
    expect(reporter.running).toHaveBeenCalledOnce();
    expect(reporter.partConfirmed).toHaveBeenCalledWith({ count: 1, bvid: ref.id });
    expect(reporter.finish).toHaveBeenCalledWith(expect.objectContaining({ ok: true, bvid: ref.id }));
    expect(ledger.recordStreamUpload).not.toHaveBeenCalled();
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("refused managed preflight exits before a submitter, pump or reporting session is created", async () => {
    input.options.zeroDiskManaged = "1";
    vi.mocked(app.zeroDiskNodePreflight).mockReturnValue({ ok: false,
      refusal: { code: "account_mismatch", message: "Wrong account" } });
    exit.mockImplementation(() => { throw new Error("exit 2"); });
    await expect(runStreamUploadRecord(input)).rejects.toThrow("exit 2");
    expect(exit.mock.calls).toEqual([[2]]);
    expect(app.writeZeroDiskStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "refused" }));
    expect(input.notifier.notify).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
    expect(pump.runLivePump).not.toHaveBeenCalled();
    expect(app.LiveUploadReporter).not.toHaveBeenCalled();
  });

  it("failed early and final handoffs retain the pending result and exit 75, never claim ownership", async () => {
    vi.mocked(app.enqueueLivePumpPending).mockImplementation(() => { throw new Error("queue unavailable"); });
    vi.mocked(pump.runLivePump).mockImplementationOnce(async (options) => {
      expect(await options.onHandoff!(result().statePath)).toEqual({ status: "retryable", detail: "queue unavailable" });
      return result({ ok: false, uploadPending: true, error: "pending upload" });
    });
    await runStreamUploadRecord(input);
    expect(app.enqueueLivePumpPending).toHaveBeenCalledTimes(2);
    expect(exit.mock.calls).toEqual([[75]]);
  });

  it("awaits a ledger-failure notification before the otherwise successful process exits", async () => {
    vi.mocked(pump.runLivePump).mockResolvedValue(result({ bvid: ref.id, outcome: "uploaded" }));
    vi.mocked(ledger.recordStreamUpload).mockReturnValue({ ok: false, error: "ledger unavailable" });
    let release!: () => void;
    const notification = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(input.notifier.notify).mockReturnValue(notification);
    const run = runStreamUploadRecord(input);
    await vi.waitFor(() => expect(input.notifier.notify).toHaveBeenCalledOnce());
    expect(exit).not.toHaveBeenCalled();
    release();
    await run;
    expect(ledger.recordStreamUpload).toHaveBeenCalledWith(expect.objectContaining({ bvid: ref.id, parts: 0 }));
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it.each(["no-stream", "exception"])("%s is a failure, not a successful idle stop", async (ending) => {
    if (ending === "no-stream") vi.mocked(pump.runLivePump).mockResolvedValue(result({ outcome: "no-stream" }));
    else {
      input.options.zeroDiskManaged = "1";
      vi.mocked(app.zeroDiskNodePreflight).mockReturnValue({ ok: true,
        delivery: { v: 1, accountKey: "bilibili:test", meta: { tid: 21, tag: "test", private: true } },
        cookiesPath: join(root, "upload.json"), credentialSource: "env" });
      vi.mocked(pump.runLivePump).mockRejectedValue(new Error("transport failed"));
    }
    await runStreamUploadRecord(input);
    expect(exit.mock.calls).toEqual([[1]]);
    if (ending === "exception") expect(reporter.failed).toHaveBeenCalledWith("transport failed");
    expect(reporter.finish).not.toHaveBeenCalled();
  });

  it("warns about room-directory pending state when a layout rollback selects the legacy root", async () => {
    const dirs = app.resolveZeroDiskPumpDirs({ platform: input.platform, rawRoom: input.options.room,
      outDir: input.recording.outDir, anchorName: "", layout: "legacy" });
    writeState(dirs.roomDir);
    vi.mocked(app.readOutputLayout).mockReturnValue("legacy");
    await runStreamUploadRecord(input);
    expect(pump.runLivePump).toHaveBeenCalledWith(expect.objectContaining({ spoolDir: input.recording.outDir }));
    expect(input.notifier.notify).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining(pump.livePumpStatePath(dirs.roomDir, "test-room")),
    }));
    expect(existsSync(pump.livePumpStatePath(dirs.roomDir, "test-room"))).toBe(true);
  });

  it.each([false, true])("protects every root state's spool and skips an unreadable root (corrupt=%s)", async (corrupt) => {
    const dir = input.recording.outDir;
    const owned = join(dir, "live-pump-1-0.ts");
    const archived = join(dir, "live-pump-1-1.ts");
    const orphan = join(dir, "live-pump-1-2.ts");
    for (const path of [owned, archived, orphan]) {
      writeFileSync(path, "video");
      utimesSync(path, new Date(0), new Date(0));
    }
    writeState(dir, "other-room", "live-pump-1-0.ts");
    writeState(dir, "old-room", "live-pump-1-1.ts");
    const state = pump.livePumpStatePath(dir, "old-room");
    renameSync(state, state + ".previous");
    writeFileSync(state + ".confirmed", "journal, not a state");
    writeFileSync(state + ".activity", "activity, not a state");
    writeFileSync(state + ".tmp.test", "partial write, not a state");
    if (corrupt) writeFileSync(pump.livePumpStatePath(dir, "unreadable-room"), "invalid JSON");
    await runStreamUploadRecord(input);
    expect(existsSync(owned)).toBe(true);
    expect(existsSync(archived)).toBe(true);
    expect(existsSync(orphan)).toBe(corrupt);
    expect(exit.mock.calls).toEqual([[0]]);
  });
});

describe("manual live-pump registration", () => {
  it.each([false, true])("only explicit --submit publishes (submit=%s)", async (publish) => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const command = new Command();
    registerLivePumpCommand(command);
    await command.parseAsync(["_live-pump", input.options.room, "--cookies", join(root, "upload.json"),
      "--spool-dir", input.recording.outDir, ...(publish ? ["--submit"] : [])], { from: "user" });
    expect(pump.runLivePump).toHaveBeenCalledWith(expect.objectContaining({
      room: "test-room", submit: publish, private: true, maxSegments: 1,
      submitter: build.mock.results[0].value,
    }));
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({ ok: true, submitted: false });
    expect(exit).not.toHaveBeenCalled();
  });
});
