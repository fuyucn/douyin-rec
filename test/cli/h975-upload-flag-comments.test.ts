/**
 * H-975 acceptance: comments for the two upload switches (`--rolling-upload` / `--stream-upload`)
 * and `cli-flags` must describe the strict value protocol from H-973/H-974 and must not keep
 * stale notes that contradict it. Source-level checks only (comments are not observable at
 * runtime); each test pins one of the brief's Acceptance checks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

const CLI = read("packages", "cli", "src", "cli.ts");
const FLAGS = read("packages", "cli", "src", "cli-flags.ts");
const BOOL = read("packages", "core", "src", "bool-flag.ts");

/** All comment text in a TS source (block + line comments), string literals not stripped. */
function comments(src: string): string {
  const out: string[] = [];
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0]);
  for (const m of src.matchAll(/(^|[^:"'`])\/\/(.*)$/gm)) out.push(m[2]);
  return out.join("\n");
}

/** The `/** … *\/` JSDoc block that ends right before `anchor` (only whitespace between). */
function docBefore(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const head = src.slice(0, at);
  const end = head.lastIndexOf("*/");
  expect(end, `no doc comment before ${anchor}`).toBeGreaterThanOrEqual(0);
  expect(head.slice(end + 2).trim(), `doc comment is not directly above ${anchor}`).toBe("");
  const start = head.lastIndexOf("/**", end);
  return head.slice(start, end + 2);
}

/** Consecutive `//` lines directly above `anchor`. */
function lineCommentsBefore(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const lines = src.slice(0, at).split("\n");
  lines.pop(); // the anchor's own line prefix
  const block: string[] = [];
  for (let i = lines.length - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) block.unshift(lines[i]);
  return block.join("\n");
}

const OFF_WORDS = ["no", "n", "false", "0", "off", "none"];
const ON_WORDS = ["yes", "y", "true", "1", "on"];

function expectProtocol(doc: string, what: string): void {
  expect(doc, `${what}: lists off words`).toContain(OFF_WORDS.join("/"));
  expect(doc, `${what}: lists on words`).toContain(ON_WORDS.join("/"));
  expect(doc, `${what}: blank/absent → default`).toMatch(/absent|missing|blank|空/i);
  expect(doc, `${what}: case/whitespace-insensitive`).toMatch(/case/i);
  expect(doc, `${what}: unknown values`).toMatch(/unknown|未知/i);
  expect(doc, `${what}: failure result`).toMatch(/ok:\s*false/);
  expect(doc, `${what}: exit 2 at the caller`).toMatch(/exit\(?\s*2/);
  expect(doc, `${what}: never "on"`).toMatch(/never[^.]*"on"|绝不回落为开/i);
}

describe("cli.ts SIGUSR2 drain comment (scope item 1)", () => {
  it("no longer claims `--stream-upload-spool none` drops the local copy / loses the video", () => {
    const c = comments(CLI);
    expect(c).not.toMatch(/lost\s+for\s+good/i);
    expect(c).not.toMatch(/no local copy/i);
    const block = lineCommentsBefore(CLI, "const drain = new AbortController();");
    expect(block).not.toMatch(/spool\s+none/);
  });

  it("keeps the still-true reasons: exit 159 mid-upload and the false 「直播自然收播，排空完成」 log", () => {
    const block = lineCommentsBefore(CLI, "const drain = new AbortController();");
    expect(block).toMatch(/SIGUSR2/);
    expect(block).toMatch(/159/);
    expect(block).toMatch(/in-flight part/);
    expect(block).toMatch(/stopGraceful/);
    expect(block).toContain("直播自然收播，排空完成");
  });

  it("every `spool none` mention in cli.ts is about the startup rejection", () => {
    const lines = CLI.split("\n").filter((l) => /spool none/.test(l));
    for (const l of lines) expect(l, l).toMatch(/Reject|已禁用|rejectsNoSpoolFlag|不再生效/);
  });
});

describe("cli.ts RecordCliOpts upload-switch field docs (scope item 4)", () => {
  for (const [field, parser] of [
    ["rollingUpload?: string;", "parseRollingUploadFlag"],
    ["streamUpload?: string;", "parseStreamUploadFlag"],
  ] as const) {
    it(`${field} has a doc pointing at ${parser} and the strict protocol`, () => {
      const doc = docBefore(CLI, field);
      expect(doc).toContain(parser);
      expect(doc).toMatch(/严格|strict/i);
      expect(doc).toMatch(/未知|unknown/i);
      expect(doc).toMatch(/exit 2/);
    });
  }

  it("leaves the --rolling-upload / --stream-upload help strings byte-identical", () => {
    expect(CLI).toContain(
      '.option("--rolling-upload <0|1>", "边录边传: 1=录制中每封口一段就上传并删该段源 0=整场录完再处理 (默认 0)")',
    );
    expect(CLI).toContain(
      '.option("--stream-upload <0|1>", "直播直传: 1=ffmpeg stdout 直传 UPOS 并续同一稿件,上传确认后删本地回退文件;0=关闭(默认)")',
    );
  });
});

describe("cli-flags.ts comments (scope items 2-3)", () => {
  it("has no vague 'off today' / 'the current default' wording", () => {
    expect(FLAGS).not.toMatch(/off today|the current default/);
  });

  it("header names bool-flag.ts as the single word list shared by both parsers", () => {
    const header = FLAGS.slice(0, FLAGS.indexOf("*/") + 2);
    expect(header).toContain("parseStrictBoolFlag");
    expect(header).toContain("bool-flag.ts");
    expect(header).toContain("--danmu");
    expect(header).not.toMatch(/vocabulary itself lives in core \(`\w+`\)\.\s*\*\/?$/m);
  });

  it("parseRollingUploadFlag doc states the full protocol", () => {
    expectProtocol(docBefore(FLAGS, "export function parseRollingUploadFlag"), "parseRollingUploadFlag");
  });

  it("parseStreamUploadFlag doc states the full protocol", () => {
    expectProtocol(docBefore(FLAGS, "export function parseStreamUploadFlag"), "parseStreamUploadFlag");
  });

  it("parseStrictUploadFlag doc states the full protocol", () => {
    expectProtocol(docBefore(FLAGS, "function parseStrictUploadFlag"), "parseStrictUploadFlag");
  });

  it("does not describe the error value as normalized (it quotes the raw value)", () => {
    const c = comments(FLAGS);
    expect(c).toMatch(/raw value/);
    expect(c).not.toMatch(/(normali[sz]ed|trimmed|lower-?cased) value/i);
  });
});

describe("bool-flag.ts comments (scope item 5)", () => {
  const exported = new Set(
    [...BOOL.matchAll(/^export (?:function|type|const) (\w+)/gm)].map((m) => m[1]),
  );

  it("every backticked camelCase identifier in comments is exported by bool-flag.ts", () => {
    const names = [...comments(BOOL).matchAll(/`([A-Za-z_]\w*)`/g)]
      .map((m) => m[1])
      .filter((n) => /[a-z][A-Z]|^[A-Z][a-z]/.test(n));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(exported.has(n), `\`${n}\` is not exported`).toBe(true);
  });

  it("lenient parser doc says its unknown→on rule does not apply to the upload switches", () => {
    const lenient = [...BOOL.matchAll(/^export function (\w+)\(v: string \| undefined, def: boolean\): boolean/gm)];
    expect(lenient).toHaveLength(1);
    const doc = docBefore(BOOL, lenient[0][0]);
    expect(doc).toMatch(/--rolling-upload/);
    expect(doc).toMatch(/--stream-upload/);
    expect(doc).toMatch(/not apply|不适用/i);
    expect(doc).toContain("parseStrictBoolFlag");
  });

  it("parseStrictBoolFlag doc names the lenient parser by its exported name and keeps the caller list", () => {
    const doc = docBefore(BOOL, "export function parseStrictBoolFlag");
    const lenientName = [...BOOL.matchAll(/^export function (\w+)\(v: string \| undefined, def: boolean\)/gm)][0][1];
    expect(doc).toContain(`\`${lenientName}\``);
    expect(doc).toMatch(/`record`/);
    expect(doc).toMatch(/`task add\/edit`/);
    expect(doc).toMatch(/rolling-queue/);
  });
});

/**
 * Round-2 Reviewer finding: the lenient parser is NOT `--danmu`-only — `task add/edit --use-cookie`
 * (`cli-task.ts`) and `task-input.ts` call it too. Comments must not claim exclusivity, and the
 * descriptions of the lenient parser must name a non-danmu user, derived from the real call sites.
 */
describe("lenient parser comments match its real callers (round-2 review)", () => {
  const lenientName = [...BOOL.matchAll(/^export function (\w+)\(v: string \| undefined, def: boolean\)/gm)][0][1];
  const CLI_TASK = read("packages", "app", "src", "cli-task.ts");
  const TASK_INPUT = read("packages", "app", "src", "task-input.ts");
  const callRe = new RegExp(`\\b${lenientName}\\(`);

  it("the lenient parser really has callers beyond --danmu (precondition)", () => {
    expect(CLI_TASK).toMatch(new RegExp(`useCookie[^\\n]*${lenientName}\\(`));
    expect(TASK_INPUT).toMatch(callRe);
  });

  const exclusive = [
    /--danmu`?\s*\)?\s*only/i,
    /only\s+(?:by|for|used by)\s+`?--danmu/i,
    /used\s+only\s+(?:by|for)\s+`?--danmu/i,
    /only\s+the\s+lenient\s+`?--danmu`?\s+parser/i,
    /仅(?:限|用于|被)?\s*`?--danmu/,
  ];

  for (const [label, src] of [
    ["bool-flag.ts", BOOL],
    ["cli-flags.ts", FLAGS],
  ] as const) {
    it(`${label} comments never say the lenient parser is --danmu-only`, () => {
      const text = comments(src).replace(/\s*\n\s*\*?\s*/g, " ");
      for (const re of exclusive) expect(text, `matches ${re}`).not.toMatch(re);
    });

    it(`${label} header names a non-danmu user of the lenient parser (--use-cookie)`, () => {
      const header = src.slice(0, src.indexOf("*/") + 2);
      expect(header).toContain(lenientName);
      expect(header).toMatch(/--use-cookie|use-cookie|useCookie/);
    });
  }
});
