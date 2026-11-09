/**
 * H-972 baseline: records the current bug where unknown values turn the feature on. When the fix
 * lands, flip these assertions on purpose.
 *
 * `parseBoolFlag` (packages/core/src/bool-flag.ts) treats any value outside the off vocabulary
 * as "on" (a bare `--flag` and legacy provider names have always meant "on"). Because of that,
 * `record --rolling-upload nope|disabled|f` and `--stream-upload nope|disabled|f` currently
 * enable the feature (OFF_VALUES has `n` but not `f`, and unknown strings fall through to
 * `true`). These tests pin that behaviour as a regression baseline for the bug — they do NOT
 * assert what the parser should do after a fix.
 *
 * There is deliberately no off-value control case: any argv that passes the mutual-exclusion
 * gate starts a real recorder or network call, which must not happen in a unit test (same
 * reasoning as test/cli/record-spool-flag.test.ts). The off vocabulary itself is covered by
 * packages/core/src/bool-flag.test.ts.
 *
 * When both flags parse as on, cli.ts hits the mutual-exclusion check and exits with code 2
 * ("互斥") before initRecorderState, getStream or any network call — the only safe observable
 * path at this call site. `cli.ts` runs `parseAsync` on import, so it cannot be imported in a
 * unit test; the spawn approach is the only probe that reaches the real entry point.
 *
 * Like record-spool-flag, the CLI bundle is built into a private per-run temp directory
 * (DREC_BUNDLE_MAIN_OUT) directly via esbuild.config.mjs — never the shared dist/ and never
 * `pnpm bundle` (whose trailing `chmod +x` fails on a clean checkout). The child process gets
 * a fresh empty DOUYIN_REC_ROOT so nothing touches ./output-data, no db/hub rule files exist,
 * and the order of evaluation (rolling log first, then the exclusion check) never depends on
 * local state. DOUYIN_REC_HUB_MASTER and DISCORD_WEBHOOK are removed so no hub ownership or
 * webhook path is taken. No --task-id, so no db or state files.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ROOM = "https://live.douyin.com/1";
/** Unknown values: none of them is in parseBoolFlag's off vocabulary, so they currently parse as ON. */
const UNKNOWN_VALUES = ["nope", "disabled", "f"] as const;

/** Private per-run bundle: never the shared dist/. */
let ENTRY = "";
/** Fresh empty data root for the child process, so no ./output-data, db or hub rule files. */
let DATA_ROOT = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "drec-upload-flag-baseline-"));
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
  // this baseline must be independent of any local env leakage.
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
    // 8s SIGKILL: if an unknown value ever parsed as off and the run got past the exclusion
    // gate, it would start a recorder / network call — that must fail loudly here, not hang.
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Current bug: both flags end up on → mutual-exclusion exit 2, before any stream lookup. */
async function expectMutualExclusion(args: string[]): Promise<Result> {
  const r = await record(args);
  // Strict code === 2: a SIGKILL (code null, e.g. build failure or a run past the gate) or any
  // other exit must not count as a pass. Only the stable fragment is asserted, not full stderr.
  expect(r.code, r.stderr || r.stdout).toBe(2);
  expect(r.stderr).toContain("互斥");
  return r;
}

describe("record --rolling-upload / --stream-upload unknown values (H-972 bug baseline, real dist entry)", () => {
  it("sanity: two explicit on values hit the mutual-exclusion gate", async () => {
    await expectMutualExclusion(["--rolling-upload", "1", "--stream-upload", "1"]);
  }, 12_000);

  it.each(UNKNOWN_VALUES)("unknown --rolling-upload %s turns rolling upload on (stdout confirms), hits the gate", async (v) => {
    const r = await expectMutualExclusion(["--rolling-upload", v, "--stream-upload", "1"]);
    expect(r.stdout).toContain("边录边传已开启");
  }, 12_000);

  it.each(UNKNOWN_VALUES)("unknown --stream-upload %s turns stream upload on, hits the gate", async (v) => {
    await expectMutualExclusion(["--rolling-upload", "1", "--stream-upload", v]);
  }, 12_000);

  it("both unknown values still enable both features and hit the gate", async () => {
    await expectMutualExclusion(["--rolling-upload", "nope", "--stream-upload", "disabled"]);
  }, 12_000);

  it.each([
    ["uppercase", "NOPE"],
    ["surrounding whitespace", " f "],
    ["capitalized", "Disabled"],
  ])("case and whitespace cannot change the result: %s (%s)", async (_label, v) => {
    // Whitespace travels as its own argv element so commander never splits it; trim() inside
    // parseBoolFlag would still leave an unknown value, which the bug turns into "on".
    await expectMutualExclusion(["--rolling-upload", v, "--stream-upload", "1"]);
    await expectMutualExclusion(["--rolling-upload", "1", "--stream-upload", v]);
  }, 20_000);
});
