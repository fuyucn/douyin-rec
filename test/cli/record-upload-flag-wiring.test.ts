/** Real CLI error precedence and accepted upload-switch vocabulary (H-974). */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ROOM = "https://live.douyin.com/1";
const VOCAB = "0/1、on/off、yes/no、true/false";

let ENTRY = "";
let DATA_ROOT = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "drec-upload-flag-wiring-"));
  ENTRY = join(dir, "douyin-rec.mjs");
  execFileSync(process.execPath, ["esbuild.config.mjs"], {
    cwd: ROOT,
    stdio: "pipe",
    timeout: 120_000,
    env: { ...process.env, DREC_BUNDLE_MAIN_OUT: ENTRY },
  });
  DATA_ROOT = mkdtempSync(join(tmpdir(), "drec-upload-flag-wiring-root-"));
}, 120_000);

afterAll(() => {
  if (ENTRY) rmSync(join(ENTRY, ".."), { recursive: true, force: true });
  if (DATA_ROOT) rmSync(DATA_ROOT, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function record(args: string[], timeoutMs = 8_000): Promise<Result> {
  const env = { ...process.env, DOUYIN_REC_ROOT: DATA_ROOT };
  delete env.DOUYIN_REC_HUB_MASTER;
  delete env.DISCORD_WEBHOOK;
  return new Promise((resolve) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [ENTRY, "record", "--room", ROOM, ...args],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("record upload switches through the real cli entry (H-974)", () => {
  it.each([
    ["--rolling-upload", "--stream-upload"],
    ["--stream-upload", "--rolling-upload"],
  ])("typo %s enble exits 2 with [rec] prefix and the full vocabulary list", async (flag, other) => {
    const r = await record([flag, "enble", other, "1"]);
    expect(r.code, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain(`[rec] ${flag} 取值无效: "enble"`);
    expect(r.stderr).toContain(VOCAB);
    expect(r.stderr).not.toContain("互斥");
    expect(r.stdout).not.toContain("边录边传已开启");
  }, 12_000);

  it.each([
    ["TRUE", " On "],
    ["Yes", "y"],
    ["\ton\n", "1"],
  ])("valid on-words (%j, %j) are case/whitespace-insensitive and still hit the gate", async (a, b) => {
    const r = await record(["--rolling-upload", a, "--stream-upload", b]);
    expect(r.code, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain("互斥");
    expect(r.stderr).not.toContain("取值无效");
  }, 12_000);

  it("invalid stream value next to an odd-case valid rolling value reports only the stream error", async () => {
    const r = await record(["--rolling-upload", " YES ", "--stream-upload", "enble"]);
    expect(r.code, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain('--stream-upload 取值无效: "enble"');
    expect(r.stderr).not.toContain("--rolling-upload 取值无效");
    expect(r.stderr).not.toContain("互斥");
    expect(r.stdout).not.toContain("边录边传已开启");
  }, 12_000);

  it("--stream-upload-spool none is still rejected first, before the strict parse error", async () => {
    const r = await record([
      "--stream-upload-spool", "none", "--rolling-upload", "enble", "--stream-upload", "1",
    ]);
    expect(r.code, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain("--stream-upload-spool none 已禁用");
    expect(r.stderr).not.toContain("取值无效");
  }, 12_000);
});
