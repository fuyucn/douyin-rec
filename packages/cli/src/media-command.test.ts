import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerMergeCommand } from "./merge-command.js";
import { registerBurnCommand } from "./burn-command.js";

const h = vi.hoisted(() => ({
  groups: vi.fn(), merge: vi.fn(), mergeAll: vi.fn(), scan: vi.fn(), notify: vi.fn(),
  probe: vi.fn(), ass: vi.fn(), segments: vi.fn(), burn: vi.fn(),
}));
vi.mock("@drec/post-process", () => ({
  groupSessionsInDir: h.groups, mergeSession: h.merge, mergeSessions: h.mergeAll,
  scanMediaErrors: h.scan, formatScanLine: () => "scan verdict", formatOutputVerdict: () => "tail verdict",
  ffprobeVideo: h.probe, renderXmlToAss: h.ass, renderSegmentsToAss: h.segments, burn: h.burn, FONTS_DIR: "fonts",
}));
vi.mock("@drec/app", () => ({
  makeNotifier: () => ({ notify: h.notify }), shouldSendWebhook: () => true, webhookTogglesFromEnv: () => ({}),
}));
let root: string;
const exitCode = process.exitCode;
function parse(args: string[]) {
  const program = new Command();
  registerMergeCommand(program); registerBurnCommand(program);
  return program.parseAsync(args, { from: "user" });
}
beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), "drec-command-media-"));
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); process.exitCode = exitCode;
  rmSync(root, { recursive: true, force: true });
});

it("merge preserves same-day session names and scans the final input and output in order", async () => {
  const bases = ["owner_2026-01-01_10-00-00", "owner_2026-01-01_11-00-00"];
  h.groups.mockReturnValue(Object.fromEntries(bases.map(b => [b, { ts: [b + "-1.ts", b + "-2.ts"] }])));
  await parse(["merge", "--in", root, "--format", "mkv"]);
  expect(h.merge).toHaveBeenCalledTimes(2);
  for (const [i, b] of bases.entries()) {
    const out = join(root, b + ".mkv");
    expect(h.merge).toHaveBeenNthCalledWith(i + 1, [join(root, b + "-1.ts"), join(root, b + "-2.ts")], out);
    expect(h.scan).toHaveBeenNthCalledWith(i * 2 + 1, join(root, b + "-2.ts"));
    expect(h.scan).toHaveBeenNthCalledWith(i * 2 + 2, out, { lastSeconds: 60 });
    expect(h.scan.mock.invocationCallOrder[i * 2]).toBeLessThan(h.merge.mock.invocationCallOrder[i]);
    expect(h.merge.mock.invocationCallOrder[i]).toBeLessThan(h.scan.mock.invocationCallOrder[i * 2 + 1]);
    expect(h.notify).toHaveBeenNthCalledWith(i + 1, { kind: "mergeDone", file: out });
  }
});

it("merge-sessions sorts inputs, retains XML pairing and honors the output stem", async () => {
  h.groups.mockReturnValue({ later: { ts: ["second.ts"] }, earlier: { ts: ["first.ts"], xml: "first.xml" } });
  await parse(["merge", "--in", root, "--merge-sessions", "--out-base", "combined"]);
  expect(h.mergeAll).toHaveBeenCalledWith([
    { tsFiles: [join(root, "first.ts")], xmlPath: join(root, "first.xml") },
    { tsFiles: [join(root, "second.ts")], xmlPath: undefined },
  ], join(root, "combined.mp4"), join(root, "combined.xml"));
  expect(h.merge).not.toHaveBeenCalled();
  expect(h.scan).toHaveBeenNthCalledWith(1, join(root, "second.ts"));
});

it("burn falls back from failed dimension probing and preserves container and encoding options", async () => {
  const video = join(root, "plain.mkv"), xml = join(root, "comments.xml");
  writeFileSync(xml, "<i/>");
  h.probe.mockRejectedValue(new Error("unavailable"));
  h.ass.mockReturnValue({ ass: "rendered", danmaku: 3 });
  await parse(["burn", "--video", video, "--xml", xml, "--crf", "25", "--video-codec", "libx265", "--video-bitrate", "8M"]);
  expect(h.ass).toHaveBeenCalledWith("<i/>", { giftValueFilter: 0.9 });
  const out = join(root, "plain_danmu.mkv");
  expect(h.burn).toHaveBeenCalledWith(expect.objectContaining({
    inputMp4: video, assText: "rendered", outMp4: out, fontsDir: "fonts", hwaccel: "auto", crf: 25, videoCodec: "libx265", videoBitrate: "8M",
  }));
  expect(h.notify).toHaveBeenCalledWith({ kind: "burnDone", style: "danmu", file: out });
});

it("burn aligns segment pairs, uses video dimensions and reports render failure without burning", async () => {
  h.groups.mockReturnValue({ session: { ts: ["one.ts", "two.ts"], segmentXmls: ["one.xml"] } });
  h.probe.mockResolvedValue({ width: 1088, height: 1920 });
  h.segments.mockRejectedValue(new Error("render failed"));
  await expect(parse(["burn", "--indir", root, "--base", "session", "--style", "livechat"])).rejects.toThrow("render failed");
  expect(h.probe).toHaveBeenCalledWith(join(root, "session.mp4"));
  expect(h.segments).toHaveBeenCalledWith([{ xmlPath: join(root, "one.xml"), tsPath: join(root, "one.ts") }], "livechat", { giftValueFilter: 0.9, width: 1088, height: 1920 });
  expect(h.burn).not.toHaveBeenCalled();
  expect(h.notify).toHaveBeenCalledWith({ kind: "error", stage: "burn", message: "render failed" });
});
