/**
 * Guard (issue #333): stage / recording / job-log paths and the directory-name sanitize rule have ONE
 * implementation, in core `output-paths.ts`. Outside it (and the hub-ledger-contract that owns
 * sanitizeStreamKey) non-test code must not
 *   - join a stage/room directory with `sanitizeStreamKey(...)` by hand,
 *   - carry its own illegal-filename-character regex,
 *   - use the `job.log` file-name literal.
 * Scans packages/*\/src non-test code lines (comments stripped).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const OWNERS = new Set(["packages/core/src/output-paths.ts", "packages/core/src/hub-ledger-contract.ts"]);

export const RULES: { name: string; re: RegExp }[] = [
  { name: "hand-built stage path from sanitizeStreamKey", re: /(?:join|resolve)\([^)]*sanitizeStreamKey\(/ },
  { name: "template-built path from sanitizeStreamKey", re: /\$\{[^}]*sanitizeStreamKey\([^}]*\}\// },
  { name: "own sanitize-name regex", re: /\[\/\\\\:\*\?"<>\|\]/ },
  { name: "job.log literal", re: /["'`]job\.log["'`]/ },
];

export function violations(rel: string, src: string): string[] {
  if (OWNERS.has(rel)) return [];
  const out: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
    const code = line.replace(/\s\/\/.*$/, "");
    for (const r of RULES) if (r.re.test(code)) out.push(`${rel}:${i + 1} ${r.name}`);
  });
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}

describe("output path resolver is the only path builder (issue #333)", () => {
  it("the rules recognise each hand-written form", () => {
    expect(violations("x.ts", 'join(stage, sanitizeStreamKey(k))')).toHaveLength(1);
    expect(violations("x.ts", 'new FileLogger(`${d}/${sanitizeStreamKey(k)}/x`)')).toHaveLength(1);
    expect(violations("x.ts", 'name.replace(/[/\\\\:*?"<>|]/g, "")')).toHaveLength(1);
    expect(violations("x.ts", 'join(d, "job.log")')).toHaveLength(1);
    expect(violations("packages/core/src/output-paths.ts", 'join(d, "job.log")')).toHaveLength(0);
    expect(violations("x.ts", " * join(d, 'job.log') in a comment")).toHaveLength(0);
  });

  it("no non-test source outside core builds these paths by hand", () => {
    const files: string[] = [];
    for (const pkg of readdirSync(join(ROOT, "packages"))) {
      const src = join(ROOT, "packages", pkg, "src");
      try { if (statSync(src).isDirectory()) walk(src, files); } catch { /* no src */ }
    }
    const bad = files.flatMap((f) => violations(relative(ROOT, f), readFileSync(f, "utf-8")));
    expect(bad).toEqual([]);
  });

  it("the hub run logger is wired to the logs dir (issue #334), not into stage", () => {
    const cli = readFileSync(join(ROOT, "packages/cli/src/cli.ts"), "utf-8");
    const m = /makeRunLogger:[\s\S]{0,400}?resolveJobLogPath\(([^;]*)\)\),/.exec(cli);
    expect(m, "makeRunLogger must build its path via resolveJobLogPath").not.toBeNull();
    expect(m![1]).toMatch(/layout:\s*"room"/);
    expect(m![1]).toMatch(/logsRoot:\s*rootLogsDir\(\)/);
  });
});

describe("node-side stage is never removed as a whole directory (issue #335)", () => {
  it("app node pipeline and node commands do not use the empty-dir remover or rmdir", () => {
    for (const f of ["packages/app/src/node-pipeline.ts", "packages/cli/src/node-pipeline-commands.ts", "packages/app/src/node-enqueue.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf-8");
      expect(src, f).not.toMatch(/removeEmptyStageDir|rmdirSync/);
    }
  });
});
