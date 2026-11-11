/**
 * H-974: `task add` / `task edit --rolling-upload` use the core strict parser.
 *
 * Source-level checks pin the wiring in packages/app/src/cli-task.ts. Real-entry checks spawn a
 * private CLI bundle (DREC_BUNDLE_MAIN_OUT, never the shared dist/) and assert an unknown value
 * exits exactly 2 with the shared error format, before any db file is created. The room is a
 * numeric douyin URL so even a regression past the gate makes no short-URL network call; the
 * 8s SIGKILL catches any hang.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = readFileSync(join(ROOT, "packages/app/src/cli-task.ts"), "utf8");

/** Slice the body of one `task.command("<name>")` chain, up to the next `.command(`. */
function commandBlock(name: string): string {
  const start = SRC.indexOf(`.command("${name}")`);
  expect(start, `task ${name} not found`).toBeGreaterThanOrEqual(0);
  const next = SRC.indexOf(".command(", start + 10);
  return SRC.slice(start, next < 0 ? undefined : next);
}

describe("cli-task.ts source wiring (H-974)", () => {
  it("no lenient parseBoolFlag(o.rollingUpload remains", () => {
    expect(SRC).not.toMatch(/parseBoolFlag\(o\.rollingUpload/);
  });

  it.each(["add", "edit"])("task %s strict-parses --rolling-upload before new TaskStore(", (name) => {
    const block = commandBlock(name);
    const parse = block.indexOf('parseStrictBoolFlag("--rolling-upload"');
    const store = block.indexOf("new TaskStore(");
    expect(parse, `parseStrictBoolFlag missing in task ${name}`).toBeGreaterThanOrEqual(0);
    expect(store).toBeGreaterThan(parse);
  });

  it("task add strict parse comes before platform resolution / short-url resolution", () => {
    const block = commandBlock("add");
    const parse = block.indexOf('parseStrictBoolFlag("--rolling-upload"');
    expect(parse).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("platformForRoom(")).toBeGreaterThan(parse);
    expect(block.indexOf("resolveShortUrl")).toBeGreaterThan(parse);
  });
});

let ENTRY = "";
let DATA_ROOT = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "drec-task-rolling-bundle-"));
  ENTRY = join(dir, "douyin-rec.mjs");
  execFileSync(process.execPath, ["esbuild.config.mjs"], {
    cwd: ROOT,
    stdio: "pipe",
    timeout: 120_000,
    env: { ...process.env, DREC_BUNDLE_MAIN_OUT: ENTRY },
  });
  DATA_ROOT = mkdtempSync(join(tmpdir(), "drec-task-rolling-root-"));
}, 120_000);

afterAll(() => {
  if (ENTRY) rmSync(join(ENTRY, ".."), { recursive: true, force: true });
  if (DATA_ROOT) rmSync(DATA_ROOT, { recursive: true, force: true });
});

interface Result { code: number | null; stdout: string; stderr: string }

function run(args: string[], timeoutMs = 8_000): Promise<Result> {
  const env = { ...process.env, DOUYIN_REC_ROOT: DATA_ROOT };
  delete env.DOUYIN_REC_HUB_MASTER;
  delete env.DISCORD_WEBHOOK;
  delete env.DOUYIN_REC_DB;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function expectRejected(r: Result, raw: string): void {
  expect(r.code, r.stderr || r.stdout).toBe(2);
  expect(r.stderr).toContain(`--rolling-upload 取值无效: "${raw}"`);
  expect(r.stderr).toContain("0/1、on/off、yes/no、true/false");
}

describe("task --rolling-upload strict parsing (H-974, real cli entry)", () => {
  it.each(["enble", "NOPE", " f ", "flv"])("task add --rolling-upload %j exits 2 and creates no db", async (raw) => {
    const tmp = mkdtempSync(join(tmpdir(), "drec-task-add-"));
    try {
      const db = join(tmp, "x.db");
      const r = await run(["task", "add", "--room", "https://live.douyin.com/1", "--rolling-upload", raw, "--db", db]);
      expectRejected(r, raw);
      expect(existsSync(db), "db must not be created on a parse error").toBe(false);
      expect(r.stdout + r.stderr).not.toContain("已创建任务");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 12_000);

  it("task edit 1 --rolling-upload enble exits 2 and creates no db", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drec-task-edit-"));
    try {
      const db = join(tmp, "x.db");
      const r = await run(["task", "edit", "1", "--rolling-upload", "enble", "--db", db]);
      expectRejected(r, "enble");
      expect(existsSync(db), "db must not be created on a parse error").toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 12_000);
});
