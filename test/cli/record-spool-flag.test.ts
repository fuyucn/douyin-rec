import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ENTRY = join(ROOT, "dist", "douyin-rec.mjs");
const ROOM = "https://live.douyin.com/1";

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

beforeAll(() => {
  // CI runs pnpm test before pnpm bundle, so dist is absent there. Bundling is ~200ms locally.
  if (!existsSync(ENTRY)) execSync("pnpm bundle", { cwd: ROOT, stdio: "pipe", timeout: 120_000 });
}, 120_000);

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
  // The gate sits after loadConfig and before platformForRoom / getStream, so the fake room
  // never reaches the network. dist is required to exercise the real cli.ts wiring.
  const r = await record(args);
  expect(r.code, r.stderr).toBe(2);
  expect(r.stderr).toContain("已禁用");
  expect(r.stderr).toContain("本地回退文件");
}

async function allowed(args: string[]): Promise<void> {
  // A live recorder may keep waiting / polling; wait about 2s, then kill it. The point is
  // that it did not take the explicit exit-2 no-spool gate and did not print its message.
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [ENTRY, "record", "--room", ROOM, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const finishedEarly = child.exitCode !== null;
  child.kill("SIGKILL");
  const code = await exit;
  expect(finishedEarly ? child.exitCode : code).not.toBe(2);
  expect(output).not.toContain("已禁用");
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

  it("full and the default keep running (no exit-2 gate)", async () => {
    await allowed(["--stream-upload-spool", "full"]);
    await allowed([]);
  }, 15_000);
});

