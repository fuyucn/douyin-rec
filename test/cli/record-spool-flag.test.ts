/**
 * Real dist entry coverage for the retired --stream-upload-spool none flag.
 *
 * This file only guards the rejection paths. We initially wanted to prove that full / absent
 * is not rejected, but any argv that passes the gate starts a real recorder: blank room,
 * unknown URL, invalid engine and missing config either fall back or fail before the gate.
 * Spawning that path would reach platform/network code, so it belongs to production validation,
 * not a unit test. The safe half is covered elsewhere:
 *   - test/app/record-args.test.ts: buildRecordArgs never emits --stream-upload-spool,
 *     including legacy streamUploadSpool=false rows;
 *   - test/cli/cli-flags.test.ts: rejectsNoSpoolFlag(full/FULL/empty/undefined) is false.
 * Rejection happens after loadConfig and before platformForRoom/getStream, so the fake room
 * never reaches the network.
 *
 * The CLI bundle is built into a private temp directory (DREC_BUNDLE_MAIN_OUT) on every run, from
 * the current source. Sharing dist/ with other test files was rejected: deleting it broke their
 * `describe.skipIf(existsSync(dist))` guards, and keeping it let a reverted wiring fix pass against
 * a stale artifact. A per-run path has neither problem and needs no lock.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ROOM = "https://live.douyin.com/1";
/** Private per-run bundle: never the shared dist/, so no other test file can observe it. */
let ENTRY = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "drec-cli-entry-"));
  ENTRY = join(dir, "douyin-rec.mjs");
  // Run the esbuild script directly, never `pnpm bundle`: that script ends with
  // `chmod +x dist/douyin-rec.mjs`, which would fail on a clean CI checkout (no dist/) and
  // would touch shared state even when dist exists. The env var also makes esbuild skip the
  // TUI and launcher outputs, so this build writes only to the private temp directory.
  execFileSync(process.execPath, ["esbuild.config.mjs"], {
    cwd: ROOT,
    stdio: "pipe",
    timeout: 120_000,
    env: { ...process.env, DREC_BUNDLE_MAIN_OUT: ENTRY },
  });
}, 120_000);

afterAll(() => {
  if (ENTRY) rmSync(join(ENTRY, ".."), { recursive: true, force: true });
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function record(args: string[], timeoutMs = 8_000): Promise<Result> {
  return new Promise((resolve) => {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [ENTRY, "record", "--room", ROOM, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function rejected(args: string[]): Promise<void> {
  const r = await record(args);
  expect(r.code, r.stderr).toBe(2);
  expect(r.stderr).toContain("已禁用");
  expect(r.stderr).toContain("本地回退文件");
}

describe("record --stream-upload-spool (real dist entry)", () => {
  it("a lone none is rejected before any stream lookup", async () => {
    await rejected(["--stream-upload-spool", "none"]);
  }, 12_000);

  it("none is rejected even when --stream-upload 1 is present", async () => {
    await rejected(["--stream-upload", "1", "--stream-upload-spool", "none"]);
  }, 12_000);

  it("case and surrounding whitespace cannot bypass the gate", async () => {
    await rejected(["--stream-upload-spool", "NONE"]);
    await rejected(["--stream-upload-spool", " none "]);
  }, 20_000);
});

