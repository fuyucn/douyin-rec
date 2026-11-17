import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as core from "@drec/core";
import * as app from "@drec/app";
import { PollingRecorder } from "@drec/record-engine";
import { RecordingSession } from "@drec/manager";
import { runStreamUploadRecord } from "./stream-upload-record.js";
import { registerRecordCommand } from "./record-command.js";

const fake = vi.hoisted(() => ({
  engine: { id: "ffmpeg" },
  platform: { id: "douyin", defaultEngine: "ffmpeg",
    roomToUrl: (room: string) => "https://live.douyin.com/" + room,
    extractRoomSlug: () => "test-room" },
  session: { start: vi.fn(), stop: vi.fn(), drain: vi.fn() },
  gate: vi.fn(), rolling: vi.fn(), remux: vi.fn(),
  notify: vi.fn(), closeQueue: vi.fn(), releaseLease: vi.fn(),
  listTasks: vi.fn(), closeStore: vi.fn(), exitHook: vi.fn(),
}));
vi.mock("@drec/core", async (original) => ({
  ...await original<typeof import("@drec/core")>(), loadConfig: vi.fn(),
  getEngine: vi.fn(() => fake.engine), platformForRoom: vi.fn(() => fake.platform),
  initRecorderState: vi.fn(() => ({ installExitHook: fake.exitHook })),
  noteRecorderDraining: vi.fn(), noteRecorderSignal: vi.fn(),
}));
vi.mock("@drec/record-engine", () => ({
  PollingRecorder: vi.fn(function () { return { name: "test-recorder" }; }),
}));
vi.mock("@drec/manager", () => ({
  RecordingSession: vi.fn(function () { return fake.session; }),
}));
vi.mock("./stream-upload-record.js", () => ({ runStreamUploadRecord: vi.fn() }));
vi.mock("@drec/app", () => ({
  drecRoot: () => "/test-data", rootOutputDir: () => "/test-data/recordings",
  readOutputLayout: vi.fn(() => "room"),
  makeNotifier: vi.fn(() => ({ notify: fake.notify })),
  shouldSendWebhook: vi.fn(() => true), webhookTogglesFromEnv: vi.fn(() => ({})),
  makeNewBroadcastGate: vi.fn(() => fake.gate), effectiveHubConfig: vi.fn(),
  makeRollingUploadHookFactory: vi.fn(() => fake.rolling), rollingQueueModeEnabled: () => true,
  TaskStore: vi.fn(function () { return { listTasks: fake.listTasks, close: fake.closeStore }; }),
  resolveDbPath: () => "/test-data/tasks.db", rootHubDir: () => "/test-data/hub",
  shouldDecideUploadOwner: vi.fn(), uploadOwnerForTask: vi.fn(),
  enqueueHubOwnedSkip: vi.fn(() => true), masterOwnedWithoutRule: vi.fn(),
  enabledHubRuleForTask: vi.fn(),
  recoverNodeRemuxInBackground: vi.fn(),
  makeNodeRemuxHookFactory: vi.fn(() => fake.remux),
  RemuxQueue: { open: vi.fn() },
}));

let root: string;
const signals = new Map<string, () => void>();
function record(args: string[] = [], globals: string[] = []) {
  const program = new Command().exitOverride()
    .option("--discord-webhook <url>").option("--discord-webhook-file <path>");
  registerRecordCommand(program);
  return program.parseAsync([...globals, "record", "--room", "test-room", ...args], { from: "user" });
}
function sessionOptions() { return vi.mocked(RecordingSession).mock.calls[0][1]!; }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "drec-record-entry-"));
  signals.clear();
  vi.stubEnv("DOUYIN_REC_HUB_MASTER", "");
  vi.mocked(core.loadConfig).mockReturnValue({ ...core.DEFAULT_CONFIG, outDir: "" });
  vi.mocked(runStreamUploadRecord).mockImplementation(async (input) => input.enabled);
  vi.mocked(app.effectiveHubConfig).mockReturnValue({ path: "/test-data/hub.json", json: '{"diskMinGB":3}' });
  vi.mocked(app.RemuxQueue.open).mockReturnValue({
    close: fake.closeQueue, releaseLeaseSync: fake.releaseLease,
  } as unknown as app.RemuxQueue);
  vi.mocked(app.recoverNodeRemuxInBackground).mockReturnValue(Promise.resolve(undefined));
  vi.mocked(app.shouldDecideUploadOwner).mockReturnValue(false);
  vi.mocked(app.masterOwnedWithoutRule).mockReturnValue(false);
  vi.mocked(app.shouldSendWebhook).mockReturnValue(true);
  fake.notify.mockResolvedValue(undefined);
  fake.closeQueue.mockResolvedValue(undefined);
  fake.session.start.mockResolvedValue(undefined);
  fake.session.stop.mockResolvedValue(undefined);
  fake.session.drain.mockResolvedValue(undefined);
  fake.listTasks.mockReturnValue([]);
  fake.gate.mockResolvedValue(false);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  const on = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (typeof event === "string" && ["SIGINT", "SIGTERM", "SIGUSR2", "exit"].includes(event)) {
      signals.set(event, listener);
      return process;
    }
    return on(event, listener);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("starts file recording with sticky layout, CLI precedence and the inline disk admission gate", async () => {
  const cookies = join(root, "cookies.txt");
  const webhook = join(root, "webhook.txt");
  writeFileSync(cookies, " file-cookie ");
  writeFileSync(webhook, " https://example.invalid/webhook ");
  await record(["--task-id", "7", "--cookies", "inline", "--cookies-file", cookies,
    "--quality", "hd", "--segment", "0", "--danmu", "0", "--reconnect", "2",
    "--name", " test ", "--danmu-xml-mode", "segment"], ["--discord-webhook-file", webhook]);
  expect(fake.session.start).toHaveBeenCalledWith("https://live.douyin.com/test-room", {
    quality: "hd", cookies: "file-cookie", outDir: "/test-data/recordings",
    segmentSec: 0, name: "test", outputLayout: "room", danmuXmlMode: "segment",
  }, { anchorName: "" });
  expect(app.readOutputLayout).toHaveBeenCalledTimes(1);
  expect(app.makeNotifier).toHaveBeenCalledWith("https://example.invalid/webhook");
  expect(sessionOptions()).toMatchObject({ danmuEnabled: false, reconnectDelaySec: 2, admitNewBroadcast: fake.gate });
  expect(app.makeNewBroadcastGate).toHaveBeenCalledWith(expect.objectContaining({
    outDir: "/test-data/recordings", hubConfigPath: "/test-data/hub.json", hubConfigJson: '{"diskMinGB":3}',
  }));
  expect(core.initRecorderState).toHaveBeenCalledWith(expect.objectContaining({ taskId: 7, mode: "file" }));
  expect(fake.exitHook.mock.invocationCallOrder[0]).toBeLessThan(fake.session.start.mock.invocationCallOrder[0]);
  expect(app.makeRollingUploadHookFactory).not.toHaveBeenCalled();
  expect(app.RemuxQueue.open).not.toHaveBeenCalled();
});

it("stream mode forwards the parsed switch and state before short-circuiting file recording", async () => {
  await record(["--stream-upload", " On ", "--task-id", "7", "--output-format", "invalid"]);
  expect(runStreamUploadRecord).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  expect(core.initRecorderState).toHaveBeenCalledWith(expect.objectContaining({ mode: "live" }));
  expect(fake.exitHook.mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(runStreamUploadRecord).mock.invocationCallOrder[0]);
  expect(RecordingSession).not.toHaveBeenCalled();
  expect(app.RemuxQueue.open).not.toHaveBeenCalled();
  expect(signals.size).toBe(0);
});

it.each([
  { flag: "rolling", rolling: "enble", stream: "wrong", raw: "enble" },
  { flag: "stream", rolling: "0", stream: "wrong", raw: "wrong" },
])("rejects invalid $flag before platform, hooks and recorder state", async ({ flag, rolling, stream, raw }) => {
  const exited = new Error("exit");
  vi.mocked(process.exit).mockImplementation(() => { throw exited; });
  await expect(record(["--rolling-upload", rolling, "--stream-upload", stream, "--task-id", "7"]))
    .rejects.toBe(exited);
  expect(process.exit).toHaveBeenCalledWith(2);
  expect(console.error).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--" + flag + '-upload 取值无效: "' + raw + '"'));
  expect(core.platformForRoom).not.toHaveBeenCalled();
  expect(PollingRecorder).not.toHaveBeenCalled();
  expect(app.makeRollingUploadHookFactory).not.toHaveBeenCalled();
  expect(core.initRecorderState).not.toHaveBeenCalled();
  expect(runStreamUploadRecord).not.toHaveBeenCalled();
});

it("rolling upload keeps hub ownership, skip receipts and alerts, and suppresses remux", async () => {
  vi.stubEnv("DOUYIN_REC_HUB_MASTER", "1");
  vi.mocked(app.shouldSendWebhook).mockReturnValue(false);
  const task = { id: 7, room: "test-room" };
  fake.listTasks.mockReturnValue([task]);
  vi.mocked(app.shouldDecideUploadOwner).mockReturnValue(true);
  vi.mocked(app.uploadOwnerForTask).mockReturnValue("master");
  vi.mocked(app.masterOwnedWithoutRule).mockReturnValue(true);
  await record(["--rolling-upload", "1", "--task-id", "7", "--output-format", "mkv"]);
  expect(app.shouldDecideUploadOwner).toHaveBeenCalledWith(task, true);
  expect(app.TaskStore).toHaveBeenCalledWith("/test-data/tasks.db");
  expect(fake.closeStore).toHaveBeenCalledTimes(1);
  const hook = vi.mocked(app.makeRollingUploadHookFactory).mock.calls[0][0];
  expect(hook).toMatchObject({ enabled: true, queueMode: true, platform: "douyin", roomSlug: "test-room", taskId: 7 });
  expect(hook.uploadOwner?.()).toBe("master");
  expect(app.uploadOwnerForTask).toHaveBeenLastCalledWith(task, "/test-data/hub");
  const part = { file: "part.ts", index: 0, seq: 2, streamKey: "test-stream" };
  expect(hook.enqueueHubSkipped?.(part)).toBe(true);
  expect(app.enqueueHubOwnedSkip).toHaveBeenCalledWith({ ...part, taskId: 7 });
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("没有 uploader(task=7)"));
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  hook.notify?.("upload failed");
  await vi.waitFor(() => expect(stdout).toHaveBeenCalledWith(expect.stringContaining("@@DREC_ALERT@@")));
  expect(fake.notify).not.toHaveBeenCalled();
  expect(sessionOptions().makeRolling).toBe(fake.rolling);
  expect(core.initRecorderState).toHaveBeenCalledWith(expect.objectContaining({ mode: "rolling" }));
  expect(app.RemuxQueue.open).not.toHaveBeenCalled();
});

it("starts while remux recovery is pending and waits for stop and queue close before exiting", async () => {
  vi.mocked(app.recoverNodeRemuxInBackground).mockReturnValue(deferred().promise.then(() => undefined));
  const stopped = deferred(), closed = deferred();
  fake.session.stop.mockReturnValue(stopped.promise);
  fake.closeQueue.mockReturnValue(closed.promise);
  await record(["--output-format", "mp4", "--task-id", "7"]);
  expect(fake.session.start).toHaveBeenCalledTimes(1);
  expect(sessionOptions().makeRolling).toBe(fake.remux);
  expect(app.RemuxQueue.open).toHaveBeenCalledWith(expect.objectContaining({
    owner: "test-room", taskId: 7, outDir: "/test-data/recordings",
  }));
  signals.get("SIGTERM")!();
  signals.get("SIGINT")!();
  signals.get("SIGUSR2")!();
  expect(fake.session.stop).toHaveBeenCalledTimes(1);
  expect(fake.session.drain).not.toHaveBeenCalled();
  expect(core.noteRecorderSignal).toHaveBeenCalledWith("SIGTERM");
  expect(fake.closeQueue).not.toHaveBeenCalled();
  stopped.resolve();
  await vi.waitFor(() => expect(fake.closeQueue).toHaveBeenCalledTimes(1));
  expect(process.exit).not.toHaveBeenCalled();
  closed.resolve();
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
  signals.get("exit")!();
  expect(fake.releaseLease).toHaveBeenCalledTimes(1);
});

it("drains only once but still accepts a hard stop and reports failed queue closure", async () => {
  fake.session.drain.mockReturnValue(deferred().promise);
  fake.closeQueue.mockRejectedValue(new Error("queue close failed"));
  await record(["--output-format", "mp4"]);
  signals.get("SIGUSR2")!();
  signals.get("SIGUSR2")!();
  expect(fake.session.drain).toHaveBeenCalledTimes(1);
  expect(core.noteRecorderDraining).toHaveBeenCalledTimes(1);
  expect(fake.session.stop).not.toHaveBeenCalled();
  expect(fake.closeQueue).not.toHaveBeenCalled();
  signals.get("SIGINT")!();
  expect(fake.session.stop).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(console.error).toHaveBeenCalledWith("[rec] 停止时出错:", expect.objectContaining({ message: "queue close failed" }));
});

it("keeps the serial remux fallback when the durable queue is unavailable", async () => {
  vi.mocked(app.RemuxQueue.open).mockReturnValue(null);
  await record(["--output-format", "mkv"]);
  expect(app.makeNodeRemuxHookFactory).toHaveBeenCalledWith(expect.objectContaining({ format: "mkv", queue: null }));
  expect(sessionOptions().makeRolling).toBe(fake.remux);
  expect(signals.has("exit")).toBe(false);
  signals.get("SIGUSR2")!();
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
  expect(fake.closeQueue).not.toHaveBeenCalled();
});
