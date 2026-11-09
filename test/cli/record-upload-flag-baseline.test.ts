/**
 * Real cli entry coverage for the strict upload-switch parsing (H-974 fix).
 *
 * `record --rolling-upload` / `--stream-upload` are parsed with `parseRollingUploadFlag` /
 * `parseStreamUploadFlag` (packages/cli/src/cli-flags.ts, added in H-973): blank/absent = off,
 * the known off/on vocabulary = off/on, and any unknown value (a typo like `nope`, `disabled`,
 * `f`, `NOPE`, ` f ` or `Disabled`) must exit with code 2 and an error that names the flag,
 * quotes the raw value as typed, and lists the valid vocabulary (`0/1、on/off、yes/no、true/false`).
 * The old lenient behaviour (any unknown word = "on") is deliberately asserted as absent:
 * stdout must never say 「边录边传已开启」 and stderr must never reach the mutual-exclusion
 * message for an unknown value.
 *
 * There is deliberately no off-value control case: any argv that passes the mutual-exclusion
 * gate starts a real recorder or network call, which must not happen in a unit test (same
 * reasoning as test/cli/record-spool-flag.test.ts). The off/on vocabulary itself is covered by
 * test/cli/cli-flags.test.ts and packages/core/src/bool-flag.test.ts.
 *
 * When both flags parse as on (`1` + `1`), cli.ts hits the mutual-exclusion check and exits
 * with code 2 ("互斥") before initRecorderState, getStream or any network call — the sanity
 * path. `cli.ts` runs `parseAsync` on import, so it cannot be imported in a unit test; the
 * spawn approach is the only probe that reaches the real entry point.
 *
 * Like record-spool-flag, the CLI bundle is built into a private per-run temp directory
 * (DREC_BUNDLE_MAIN_OUT) directly via esbuild.config.mjs — never the shared dist/ and never
 * `pnpm bundle` (whose trailing `chmod +x` fails on a clean checkout). The child process gets
 * a fresh empty DOUYIN_REC_ROOT so nothing touches ./output-data, no db/hub rule files exist.
 * DOUYIN_REC_HUB_MASTER and DISCORD_WEBHOOK are removed so no hub ownership or webhook path is
 * taken. No --task-id, so no db or state files. The parse-error exit happens before the rolling
 * hook factory runs, before initRecorderState and before any network call, so a failing case
 * can never spawn a recorder; the 8s SIGKILL below would catch a regression that did.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ROOM = "https://live.douyin.com/1";
/** Unknown values: none of them is in the strict upload-switch vocabulary. */
const UNKNOWN_VALUES = ["nope", "disabled", "f"] as const;

/** Private per-run bundle: never the shared dist/. */
let ENTRY = "";
/** Fresh empty data root for the child process, so no ./output-data, db or hub rule files. */
let DATA_ROOT = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "drec-upload-flag-strict-"));
  ENTRY = join(dir, "douyin-rec.mjs");
  execFileSync(process.execPath, ["esbuild.config.mjs"], {
    cwd: ROOT,
    stdio: "pipe",
    timeout: 120_000,
    env: { ...process.env, DREC_BUNDLE_MAIN_OUT: ENTRY },
  });
  DATA_ROOT = mkdtempSync(join(tmpdir(), "drec-upload-flag-root-"));
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
  // Hub-master marking and the webhook would change the rolling-upload ownership / notify path;
  // these tests must be independent of any local env leakage.
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
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    // 8s SIGKILL: if an unknown value ever parsed as off/on and the run got past the parse gate,
    // it would start a recorder / network call — that must fail loudly here, not hang.
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Fix behaviour: an unknown value exits 2 with a parse error, never the exclusion gate. */
async function expectParseError(flag: string, raw: string, args: string[]): Promise<Result> {
  const r = await record(args);
  // Strict code === 2: a SIGKILL (code null, e.g. build failure or a run past the gate) or any
  // other exit must not count as a pass. Only stable fragments are asserted, not full stderr.
  expect(r.code, r.stderr || r.stdout).toBe(2);
  expect(r.stderr).toContain(`${flag} 取值无效: "${raw}"`);
  // The error must list the valid vocabulary (contains the on/off pair).
  expect(r.stderr).toContain("on/off");
  // Unknown values must be rejected before any feature turns on and before the mutual-exclusion
  // gate: no rolling-upload banner, no exclusion message.
  expect(r.stderr).not.toContain("互斥");
  expect(r.stdout).not.toContain("边录边传已开启");
  return r;
}

describe("record --rolling-upload / --stream-upload strict parsing (H-974 fix, real cli entry)", () => {
  it("sanity: two explicit on values hit the mutual-exclusion gate", async () => {
    const r = await record(["--rolling-upload", "1", "--stream-upload", "1"]);
    // Strict code === 2: a SIGKILL (code null, e.g. build failure or a run past the gate) or
    // any other exit must not count as a pass. Only the stable fragment is asserted.
    expect(r.code, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain("互斥");
  }, 12_000);

  it.each(UNKNOWN_VALUES)("unknown --rolling-upload %s exits 2 with a parse error, not the gate", async (v) => {
    await expectParseError("--rolling-upload", v, ["--rolling-upload", v, "--stream-upload", "1"]);
  }, 12_000);

  it.each(UNKNOWN_VALUES)("unknown --stream-upload %s exits 2 with a parse error, not the gate", async (v) => {
    await expectParseError("--stream-upload", v, ["--rolling-upload", "1", "--stream-upload", v]);
  }, 12_000);

  it("both unknown values report only the first bad flag (--rolling-upload) and exit 2", async () => {
    await expectParseError("--rolling-upload", "nope", ["--rolling-upload", "nope", "--stream-upload", "disabled"]);
    // Cross-check: only --rolling-upload is named, --stream-upload is not evaluated first.
    const r = await record(["--rolling-upload", "nope", "--stream-upload", "disabled"]);
    expect(r.stderr).not.toContain("--stream-upload 取值无效");
  }, 12_000);

  // One subprocess per `it` (each with its own timeout headroom): a single case never runs two
  // 8s-capped spawns inside one test, so a slow machine cannot trip the timeout by accident.
  it.each([
    ["--rolling-upload", "uppercase", "NOPE"],
    ["--rolling-upload", "surrounding whitespace", " f "],
    ["--rolling-upload", "capitalized", "Disabled"],
    ["--stream-upload", "uppercase", "NOPE"],
    ["--stream-upload", "surrounding whitespace", " f "],
    ["--stream-upload", "capitalized", "Disabled"],
  ])("case and whitespace cannot save an unknown value: %s side %s (%j)", async (flag, _label, v) => {
    const other = flag === "--rolling-upload" ? "--stream-upload" : "--rolling-upload";
    // Whitespace travels as its own argv element so commander never splits it; the error must
    // quote the raw value exactly as typed (untrimmed, original case).
    await expectParseError(flag, v, [flag, v, other, "1"]);
  }, 12_000);
});
