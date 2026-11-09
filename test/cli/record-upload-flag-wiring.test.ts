/**
 * H-974 acceptance: the `record` action consumes the strict upload-switch parsers.
 *
 * Two halves:
 *   1. Source-level wiring of packages/cli/src/cli.ts (the brief's grep acceptance checks, pinned
 *      as tests): no lenient `parseBoolFlag` left in cli.ts, both strict parsers imported from
 *      ./cli-flags.js and called on `o.rollingUpload` / `o.streamUpload`, no bare-string compares
 *      on either switch, and the strict parse sits before platformForRoom, the rolling hook
 *      factory, the mutual-exclusion gate and initRecorderState inside the record action.
 *   2. Real cli entry (private esbuild bundle, same isolation as record-upload-flag-baseline):
 *      the brief's `enble` typo case with the full vocabulary list and `[rec] ` prefix, valid
 *      on-words in odd case/whitespace still reaching the mutual-exclusion gate, an invalid value
 *      next to a valid odd-case on-word giving the parse error (not the gate), and
 *      `--stream-upload-spool none` still rejected first with its own message.
 *
 * Every spawned argv keeps the *other* switch at an on value, so even on a regression (lenient
 * parse) the run stops at the mutual-exclusion gate before any recorder/network call; the 8s
 * SIGKILL is the last-resort guard.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const CLI_SRC = readFileSync(join(ROOT, "packages", "cli", "src", "cli.ts"), "utf8");
const ROOM = "https://live.douyin.com/1";
const VOCAB = "0/1、on/off、yes/no、true/false";

/** Body of the `record` action: from `.command("record")` to the next `.command(`. */
function recordAction(): string {
  const start = CLI_SRC.indexOf('.command("record")');
  expect(start, "record command not found in cli.ts").toBeGreaterThanOrEqual(0);
  const end = CLI_SRC.indexOf(".command(", start + 1);
  return CLI_SRC.slice(start, end < 0 ? undefined : end);
}

describe("cli.ts wiring of the strict upload-switch parsers (H-974)", () => {
  it("has no lenient parseBoolFlag on --rolling-upload / --stream-upload", () => {
    expect(CLI_SRC).not.toMatch(/parseBoolFlag\((o\.)?(rollingUpload|streamUpload)/);
  });

  it("does not reference parseBoolFlag at all", () => {
    expect(CLI_SRC).not.toContain("parseBoolFlag");
  });

  it("imports both strict parsers from ./cli-flags.js", () => {
    const imp = CLI_SRC.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/cli-flags\.js"/);
    expect(imp, "no ./cli-flags.js import").not.toBeNull();
    const names = imp![1].split(",").map((s) => s.trim());
    expect(names).toContain("parseRollingUploadFlag");
    expect(names).toContain("parseStreamUploadFlag");
  });

  it("calls the strict parsers on o.rollingUpload / o.streamUpload inside the record action", () => {
    const body = recordAction();
    expect(body).toMatch(/parseRollingUploadFlag\(\s*o\.rollingUpload\s*\)/);
    expect(body).toMatch(/parseStreamUploadFlag\(\s*o\.streamUpload\s*\)/);
  });

  it("has no bare-string comparisons on either switch", () => {
    // Line by line, like the brief's `grep -nE` (in JS `[^P]*` would otherwise span newlines).
    const hits = CLI_SRC.split("\n").filter((l) => /(rollingUpload|streamUpload)\b[^P]*[!=]== ?"/.test(l));
    expect(hits).toEqual([]);
  });

  it("parses rolling before stream, after the spool-none gate, before platform/factory/gate/state", () => {
    const body = recordAction();
    const at = (needle: string): number => {
      const i = body.indexOf(needle);
      expect(i, `${needle} not found in record action`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const rolling = at("parseRollingUploadFlag(");
    const stream = at("parseStreamUploadFlag(");
    expect(at("rejectsNoSpoolFlag(")).toBeLessThan(rolling);
    expect(rolling).toBeLessThan(stream);
    for (const later of ["platformForRoom(", "makeRollingUploadHookFactory(", "--rolling-upload 互斥", "initRecorderState("]) {
      expect(stream, `strict parse must precede ${later}`).toBeLessThan(at(later));
    }
  });
});

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
