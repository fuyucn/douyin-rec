/**
 * Real cli entry coverage for the strict upload-switch parsing (H-974 fix, H-976 rework).
 *
 * This baseline now depends directly on the exported parsers `parseRollingUploadFlag` /
 * `parseStreamUploadFlag` (packages/cli/src/cli-flags.ts, added in H-973) instead of asserting
 * only hand-written stderr fragments. Two layers:
 *
 *   1. Pure parser calls (no spawning): blank/absent = off, the known off/on vocabulary = off/on,
 *      and any unknown value (a typo like `nope`, `disabled`, `f`, `NOPE`, ` f ` or `Disabled`)
 *      gives `{ok:false, error}` that names the flag, quotes the raw value as typed, and lists
 *      the valid vocabulary (`0/1、on/off、yes/no、true/false`). The parsers never throw and a
 *      failure never carries a `value` key — no silent "on" fallback (the old lenient behaviour).
 *
 *   2. End-to-end through the real `record` entry (the call site in cli.ts: the strict parse sits
 *      before the mutual-exclusion check, initRecorderState and any network call). The expected
 *      stderr line is built from the parser output itself — `` `[rec] ${parse(raw).error}` `` —
 *      the same expression cli.ts prints, instead of a hard-coded copy of the message text.
 *      stdout must never say 「边录边传已开启」 and stderr must never reach the mutual-exclusion
 *      message for an unknown value.
 *
 * There is deliberately no off-value control spawn case: any argv that passes the mutual-exclusion
 * gate starts a real recorder or network call, which must not happen in a unit test (same
 * reasoning as test/cli/record-spool-flag.test.ts). Blank/off paths are asserted only through the
 * direct parser calls above; the off/on vocabulary itself is covered by test/cli/cli-flags.test.ts
 * and packages/core/src/bool-flag.test.ts.
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
import { parseRollingUploadFlag, parseStreamUploadFlag, type UploadFlagResult } from "../../packages/cli/src/cli-flags.js";

const ROOT = join(__dirname, "..", "..");
const ROOM = "https://live.douyin.com/1";
/** Unknown values: none of them is in the strict upload-switch vocabulary. */
const UNKNOWN_VALUES = ["nope", "disabled", "f"] as const;
/** Unknown values in odd case / with surrounding whitespace: trimming must not rescue them. */
const ODD_UNKNOWN_VALUES = ["NOPE", " f ", "Disabled"] as const;
/** The single valid-vocabulary fragment every parse error must list. */
const VOCAB = "0/1、on/off、yes/no、true/false";

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

/** Assert a failure result of the strict parser: no throw, no `value` key, full error contract. */
function assertParserError(
  parse: (v: string | undefined) => UploadFlagResult,
  v: string,
  flag: string,
  otherFlag: string,
): string {
  const p = parse(v);
  expect(p.ok).toBe(false);
  if (p.ok) throw new Error(`parser unexpectedly accepted ${flag} ${JSON.stringify(v)}`);
  // A failure carries no `value` key: nothing about the result may look like a parsed boolean.
  expect("value" in p).toBe(false);
  // The error names the flag, quotes the raw value exactly as typed (untrimmed, original case)
  // and lists the valid vocabulary; it never names the other flag.
  expect(p.error).toContain(flag);
  expect(p.error).toContain(`"${v}"`);
  expect(p.error).toContain(VOCAB);
  expect(p.error).not.toContain(otherFlag);
  return p.error;
}

/**
 * Fix behaviour: an unknown value exits 2 with the *full* error line built from the parser output
 * (`` `[rec] ${parse(raw).error}` ``, the same expression cli.ts prints), never the exclusion gate.
 */
async function expectParseError(
  flag: string,
  raw: string,
  parse: (v: string | undefined) => UploadFlagResult,
  args: string[],
): Promise<Result> {
  const p = parse(raw);
  expect(p.ok).toBe(false);
  if (p.ok) throw new Error(`parser unexpectedly accepted ${flag} ${JSON.stringify(raw)}`);
  const expectedLine = `[rec] ${p.error}`;
  const r = await record(args);
  // Strict code === 2: a SIGKILL (code null, e.g. build failure or a run past the gate) or any
  // other exit must not count as a pass.
  expect(r.code, r.stderr || r.stdout).toBe(2);
  // The full line cli.ts prints comes from the parser output, not a hand-written copy.
  expect(r.stderr).toContain(expectedLine);
  // QA (H-976): the parser line is a whole stderr line (no prefix/suffix glued on), printed exactly
  // once, and never leaks to stdout.
  const lines = r.stderr.split(/\r?\n/);
  expect(lines.filter((l) => l === expectedLine)).toHaveLength(1);
  expect(r.stdout).not.toContain(p.error);
  // Unknown values must be rejected before any feature turns on and before the mutual-exclusion
  // gate: no rolling-upload banner, no exclusion message.
  expect(r.stderr).not.toContain("互斥");
  expect(r.stdout).not.toContain("边录边传已开启");
  return r;
}

describe("strict upload-switch parsers (exported from packages/cli/src/cli-flags.ts)", () => {
  it.each([
    ["--rolling-upload", parseRollingUploadFlag],
    ["--stream-upload", parseStreamUploadFlag],
  ] as const)("pure: %s absent/blank/off words → {ok:true,value:false}", (_flag, parse) => {
    for (const v of [undefined, "", "   ", "\t\n", "no", "n", "false", "0", "off", "none", " NO ", "Off"]) {
      expect(parse(v), `value ${JSON.stringify(v)}`).toEqual({ ok: true, value: false });
    }
  });

  it.each([
    ["--rolling-upload", "--stream-upload", parseRollingUploadFlag],
    ["--stream-upload", "--rolling-upload", parseStreamUploadFlag],
  ] as const)("pure: %s unknown values → {ok:false,error}, no value key, no throw", (flag, otherFlag, parse) => {
    for (const v of [...UNKNOWN_VALUES, ...ODD_UNKNOWN_VALUES]) {
      expect(() => parse(v)).not.toThrow();
      assertParserError(parse, v, flag, otherFlag);
    }
  });

  // QA (H-976) edge cases on the exported parsers.
  it.each([
    ["--rolling-upload", parseRollingUploadFlag],
    ["--stream-upload", parseStreamUploadFlag],
  ] as const)("pure: %s on words (any case/whitespace) → {ok:true,value:true}", (_flag, parse) => {
    for (const v of ["yes", "y", "true", "1", "on", " ON ", "True", "\tY\n"]) {
      expect(parse(v), `value ${JSON.stringify(v)}`).toEqual({ ok: true, value: true });
    }
  });

  it("pure: both parsers give the same error text apart from the flag name", () => {
    for (const v of [...UNKNOWN_VALUES, ...ODD_UNKNOWN_VALUES, "\tnope", "enble"]) {
      const a = parseRollingUploadFlag(v);
      const b = parseStreamUploadFlag(v);
      if (a.ok || b.ok) throw new Error(`unexpected ok for ${JSON.stringify(v)}`);
      expect(b.error).toBe(a.error.split("--rolling-upload").join("--stream-upload"));
    }
  });

  it("pure: raw value with inner tab/leading whitespace is quoted verbatim, not normalized", () => {
    const p = parseRollingUploadFlag("\tnope");
    if (p.ok) throw new Error("unexpected ok");
    expect(p.error).toContain(`"\tnope"`);
    expect(p.error).not.toContain(`"nope"`);
  });

  it("pure: parsers are deterministic (same input → equal result, no hidden state)", () => {
    for (const v of [undefined, "", "off", "1", "nope", " f "]) {
      expect(parseRollingUploadFlag(v)).toEqual(parseRollingUploadFlag(v));
      expect(parseStreamUploadFlag(v)).toEqual(parseStreamUploadFlag(v));
    }
  });

  it("pure: \"1\" parses as true for both switches (the sanity e2e case depends on this)", () => {
    expect(parseRollingUploadFlag("1")).toEqual({ ok: true, value: true });
    expect(parseStreamUploadFlag("1")).toEqual({ ok: true, value: true });
  });
});

describe("record --rolling-upload / --stream-upload strict parsing (H-974 fix, real cli entry)", () => {
  it("sanity: two explicit on values hit the mutual-exclusion gate", async () => {
    const r = await record(["--rolling-upload", "1", "--stream-upload", "1"]);
    // Strict code === 2: a SIGKILL (code null, e.g. build failure or a run past the gate) or
    // any other exit must not count as a pass. "1" must parse as on (asserted purely above too),
    // otherwise the run would never reach the gate.
    expect(r.code, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain("互斥");
    expect(parseRollingUploadFlag("1")).toEqual({ ok: true, value: true });
    expect(parseStreamUploadFlag("1")).toEqual({ ok: true, value: true });
  }, 12_000);

  it.each(UNKNOWN_VALUES)("unknown --rolling-upload %s exits 2 with the parser's error line", async (v) => {
    await expectParseError("--rolling-upload", v, parseRollingUploadFlag, [
      "--rolling-upload", v, "--stream-upload", "1",
    ]);
  }, 12_000);

  it.each(UNKNOWN_VALUES)("unknown --stream-upload %s exits 2 with the parser's error line", async (v) => {
    await expectParseError("--stream-upload", v, parseStreamUploadFlag, [
      "--rolling-upload", "1", "--stream-upload", v,
    ]);
  }, 12_000);

  it("both unknown values report only the first bad flag (--rolling-upload) and exit 2", async () => {
    // Parse order in cli.ts is rolling then stream, so only the rolling error line appears.
    const expectedLine = `[rec] ${parseRollingUploadFlag("nope").error}`;
    const streamLine = parseStreamUploadFlag("disabled").error;
    expect(parseRollingUploadFlag("nope").ok).toBe(false);
    expect(parseStreamUploadFlag("disabled").ok).toBe(false);
    const r = await record(["--rolling-upload", "nope", "--stream-upload", "disabled"]);
    expect(r.code, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain(expectedLine);
    expect(r.stderr).not.toContain(streamLine);
    // Cross-check: only --rolling-upload is named, --stream-upload is not evaluated first.
    expect(r.stderr).not.toContain("--stream-upload 取值无效");
    expect(r.stderr).not.toContain("互斥");
    expect(r.stdout).not.toContain("边录边传已开启");
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
    const parse = flag === "--rolling-upload" ? parseRollingUploadFlag : parseStreamUploadFlag;
    // Whitespace travels as its own argv element so commander never splits it; the parser output
    // quotes the raw value exactly as typed (untrimmed, original case), and the e2e line is the
    // parser's error verbatim.
    await expectParseError(flag, v, parse, [flag, v, other, "1"]);
  }, 12_000);
});
