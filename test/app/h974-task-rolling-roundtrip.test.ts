/**
 * H-974 QA: end-to-end round-trip of `task add` / `task edit --rolling-upload` through the real
 * CLI entry (private bundle via DREC_BUNDLE_MAIN_OUT, never the shared dist/), plus the stored
 * rollingQueueMode fail-closed gaps named in the brief.
 *
 * Covers what the existing H-974 files do not:
 *   - db path given through env DOUYIN_REC_DB (the brief's acceptance form), not --db;
 *   - blank / whitespace-only value → stored false with no error (site default);
 *   - odd case / whitespace on-words (" ON ", "True") → stored true; "NONE" → false;
 *   - `task edit` without the flag keeps the stored value; with an invalid value exits 2 and
 *     leaves the stored value untouched on an existing db;
 *   - stored rollingQueueMode "ofl" / "   " → false.
 * Rooms are numeric douyin URLs, so no short-URL network call happens; 8s SIGKILL guards hangs.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLLING_QUEUE_MODE_SETTING } from "@drec/core";
import { TaskStore } from "../../packages/app/src/store.js";
import { rollingQueueModeEnabled } from "../../packages/app/src/rolling-queue.js";

const ROOT = join(__dirname, "..", "..");
const VOCAB = "0/1、on/off、yes/no、true/false";
let ENTRY = "";
let DATA_ROOT = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "drec-h974-qa-bundle-"));
  ENTRY = join(dir, "douyin-rec.mjs");
  execFileSync(process.execPath, ["esbuild.config.mjs"], {
    cwd: ROOT,
    stdio: "pipe",
    timeout: 120_000,
    env: { ...process.env, DREC_BUNDLE_MAIN_OUT: ENTRY },
  });
  DATA_ROOT = mkdtempSync(join(tmpdir(), "drec-h974-qa-root-"));
}, 120_000);

afterAll(() => {
  if (ENTRY) rmSync(join(ENTRY, ".."), { recursive: true, force: true });
  if (DATA_ROOT) rmSync(DATA_ROOT, { recursive: true, force: true });
});

interface Result { code: number | null; stdout: string; stderr: string }

function run(args: string[], db: string): Promise<Result> {
  const env: NodeJS.ProcessEnv = { ...process.env, DOUYIN_REC_ROOT: DATA_ROOT, DOUYIN_REC_DB: db };
  delete env.DOUYIN_REC_HUB_MASTER;
  delete env.DISCORD_WEBHOOK;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function storedRolling(db: string, id = 1): boolean | undefined {
  const s = new TaskStore(db);
  try { return s.getTask(id)?.rollingUpload; } finally { s.close(); }
}

async function withDb(fn: (db: string) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "drec-h974-qa-"));
  try { await fn(join(tmp, "x.db")); } finally { rmSync(tmp, { recursive: true, force: true }); }
}

describe("task add --rolling-upload via env DOUYIN_REC_DB (H-974 acceptance form)", () => {
  it("unknown value 'enble' exits 2, prints the vocabulary, creates no db", async () => {
    await withDb(async (db) => {
      const r = await run(["task", "add", "--room", "1", "--rolling-upload", "enble"], db);
      expect(r.code, r.stderr || r.stdout).toBe(2);
      expect(r.stderr).toContain('--rolling-upload 取值无效: "enble"');
      expect(r.stderr).toContain(VOCAB);
      expect(existsSync(db)).toBe(false);
    });
  }, 15_000);

  it.each([
    ["", false],
    ["   ", false],
    ["NONE", false],
    [" ON ", true],
    ["True", true],
  ])("value %j is accepted and stored as %s", async (raw, want) => {
    await withDb(async (db) => {
      const r = await run(["task", "add", "--room", "https://live.douyin.com/1", "--rolling-upload", raw], db);
      expect(r.code, r.stderr || r.stdout).toBe(0);
      expect(r.stderr).not.toContain("取值无效");
      expect(storedRolling(db)).toBe(want);
    });
  }, 15_000);

  it("flag omitted → stored false (site default)", async () => {
    await withDb(async (db) => {
      const r = await run(["task", "add", "--room", "https://live.douyin.com/1"], db);
      expect(r.code, r.stderr || r.stdout).toBe(0);
      expect(storedRolling(db)).toBe(false);
    });
  }, 15_000);
});

describe("task edit --rolling-upload on an existing task (H-974)", () => {
  it("invalid value exits 2 and leaves the stored value; omitted flag keeps it; valid value updates it", async () => {
    await withDb(async (db) => {
      const add = await run(["task", "add", "--room", "https://live.douyin.com/1", "--rolling-upload", "1"], db);
      expect(add.code, add.stderr || add.stdout).toBe(0);
      expect(storedRolling(db)).toBe(true);

      const bad = await run(["task", "edit", "1", "--rolling-upload", "ofl"], db);
      expect(bad.code, bad.stderr || bad.stdout).toBe(2);
      expect(bad.stderr).toContain('--rolling-upload 取值无效: "ofl"');
      expect(bad.stderr).toContain(VOCAB);
      expect(storedRolling(db)).toBe(true);

      const keep = await run(["task", "edit", "1", "--name", "x"], db);
      expect(keep.code, keep.stderr || keep.stdout).toBe(0);
      expect(storedRolling(db)).toBe(true);

      const off = await run(["task", "edit", "1", "--rolling-upload", " Off "], db);
      expect(off.code, off.stderr || off.stdout).toBe(0);
      expect(storedRolling(db)).toBe(false);
    });
  }, 30_000);
});

describe("stored rollingQueueMode typo / blank fail closed (H-974)", () => {
  it.each(["ofl", "   ", "enable", "of"])("stored %j → false", (v) => {
    const tmp = mkdtempSync(join(tmpdir(), "drec-h974-rq-"));
    try {
      const p = join(tmp, "t.db");
      const s = new TaskStore(p);
      s.setSetting(ROLLING_QUEUE_MODE_SETTING, v);
      s.close();
      expect(rollingQueueModeEnabled(p)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
