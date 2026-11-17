import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { registerUploadCommand } from "./upload-command.js";
import { registerUposUploadCommand } from "./upos-upload-command.js";

const h = vi.hoisted(() => ({
  events: [] as string[], locked: false, quota: vi.fn(), preflight: vi.fn(), upload: vi.fn(),
  preupload: vi.fn(), chunks: vi.fn(), complete: vi.fn(), submit: vi.fn(), notify: vi.fn(), root: vi.fn(),
}));
vi.mock("@drec/app", () => ({
  DEFAULT_COOKIES: "default-credentials", checkBiliup: h.preflight, upload: h.upload,
  makeNotifier: () => ({ notify: h.notify }), shouldSendWebhook: () => true, webhookTogglesFromEnv: () => ({}),
}));
vi.mock("@drec/zero-upload", () => ({
  preupload: h.preupload, uploadChunks: h.chunks, complete: h.complete, submitStudio: h.submit,
  UposRateLimited: class extends Error { constructor(_detail: unknown) { super("limited"); } },
}));
vi.mock("./upload-quota.js", () => ({ runWithUploadQuota: h.quota }));
vi.mock("./node-pipeline-commands.js", () => ({ applyNodeDataRoot: h.root }));

let root: string, cookies: string, video: string;
let output: MockInstance<typeof process.stdout.write>;
const exitCode = process.exitCode;

function parse(args: string[]) {
  const program = new Command().option("--discord-webhook <url>");
  registerUploadCommand(program);
  registerUposUploadCommand(program);
  return program.parseAsync(args, { from: "user" });
}
function upos(request: Record<string, unknown> = {}) {
  const b64 = Buffer.from(JSON.stringify({ files: [video], title: "test", tid: 21, tag: "test", ...request })).toString("base64");
  return parse(["_upos-upload", root, b64]);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  process.exitCode = undefined;
  root = mkdtempSync(join(tmpdir(), "drec-command-upload-"));
  cookies = join(root, "credentials.json");
  video = join(root, "part.mp4");
  writeFileSync(cookies, "{}");
  writeFileSync(video, "abcdefg");
  vi.stubEnv("BILIUP_COOKIE", cookies);
  h.events = []; h.locked = false;
  h.root.mockImplementation(async () => { h.events.push("root"); });
  h.quota.mockImplementation(async (_options, run) => {
    h.events.push("quota"); h.locked = true;
    try { return await run(); } finally { h.locked = false; h.events.push("release"); }
  });
  h.preflight.mockResolvedValue(null);
  h.upload.mockImplementation(async () => { expect(h.locked).toBe(true); return { bv: "test-bv" }; });
  h.preupload.mockImplementation(async () => { expect(h.locked).toBe(true); return { bucket: { chunkSize: 3 } }; });
  h.chunks.mockImplementation(async ({ readChunk, totalSize }) => {
    expect(h.locked).toBe(true); expect(totalSize).toBe(7);
    const bytes = await Promise.all([readChunk(0, 3), readChunk(1, 3), readChunk(2, 1)]);
    expect(Buffer.concat(bytes).toString()).toBe("abcdefg"); return [];
  });
  h.complete.mockImplementation(async () => { expect(h.locked).toBe(true); return { ok: true, stem: "confirmed-stem" }; });
  h.submit.mockImplementation(async () => { expect(h.locked).toBe(true); return { ok: true, bvid: "test-bv", aid: 7 }; });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  process.exitCode = exitCode;
  rmSync(root, { recursive: true, force: true });
});

it.each([
  [[], 600_000, false],
  [["--slot-wait", "0", "--public"], 0, true],
] as const)("upload preserves quota options and visibility for %j", async (args, wait, isPublic) => {
  await parse(["upload", "--video", video, "--title", "test", ...args]);
  expect(h.preflight).toHaveBeenCalledWith("default-credentials");
  expect(h.quota).toHaveBeenCalledWith(expect.objectContaining({ slotWaitMs: wait, cookiesPath: "default-credentials" }), expect.any(Function));
  expect(h.upload).toHaveBeenCalledWith(expect.objectContaining({ video, public: isPublic, tid: 21 }));
  expect(h.events).toEqual(["quota", "release"]);
  expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "uploadDone", bv: "test-bv" }));
});

it("upload preflight failure exits before quota and notifications", async () => {
  h.preflight.mockResolvedValue("missing executable");
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  await parse(["upload", "--video", video, "--title", "test"]);
  expect(exit).toHaveBeenCalledWith(2);
  expect(h.quota).not.toHaveBeenCalled(); expect(h.upload).not.toHaveBeenCalled();
  expect(h.notify).not.toHaveBeenCalled();
});

it("upload failure releases the quota scope, reports the error and rethrows", async () => {
  h.upload.mockRejectedValue(new Error("upload failed"));
  await expect(parse(["upload", "--video", video, "--title", "test"])).rejects.toThrow("upload failed");
  expect(h.events).toEqual(["quota", "release"]);
  expect(h.notify).toHaveBeenCalledWith({ kind: "error", stage: "upload", message: "upload failed" });
});

it("UPOS holds quota across chunks and private publication, retrying only preupload", async () => {
  const { UposRateLimited } = await import("@drec/zero-upload");
  h.preupload.mockRejectedValueOnce(new UposRateLimited({ stage: "preupload", raw: "limited" }));
  const run = upos();
  await vi.dynamicImportSettled(); await vi.runAllTimersAsync(); await run;
  expect(h.events).toEqual(["root", "quota", "release"]);
  expect(h.preupload).toHaveBeenCalledTimes(2); expect(h.chunks).toHaveBeenCalledTimes(1);
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ private: true, videos: [{ filename: "confirmed-stem", title: "part" }] }));
  expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ ok: true, aid: 7, parts: [{ file: "part.mp4", bytes: 7 }] });
});

it("UPOS caps throttling retries and returns a JSON error without uploading bytes", async () => {
  const { UposRateLimited } = await import("@drec/zero-upload");
  h.preupload.mockRejectedValue(new UposRateLimited({ stage: "preupload", raw: "limited" }));
  const start = Date.now(); const run = upos();
  await vi.dynamicImportSettled(); await vi.runAllTimersAsync(); await run;
  expect(h.preupload).toHaveBeenCalledTimes(9);
  expect(Date.now() - start).toBe(30_000 + 60_000 + 120_000 + 240_000 + 4 * 300_000);
  expect(h.chunks).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
  expect(h.events).toEqual(["root", "quota", "release"]);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual({ error: "limited" });
});

it("UPOS refuses an unconfirmed stem and does not publish a replacement", async () => {
  h.complete.mockResolvedValue({ ok: true, stem: "", raw: {} });
  await upos({ private: false });
  expect(h.submit).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(output.mock.calls.at(-1)![0])).error).toContain("stem");
});
