/**
 * The "tool-only PRs do not bump" rule lives in two prose places (AGENTS.md and the
 * workflow doc) plus one machine source of truth (pr-gate.py RUNTIME_PATHS).
 * Nothing else enforces that the three agree, which is exactly the drift this guards.
 *
 * Both lists are parsed from their own text — no hardcoded copy here — so adding,
 * removing or reordering an entry on any side fails.
 *
 * The only normalization applied is dropping a leading backticked command name
 * (`pnpm bundle`) that happens to sit inside the same sentence; nothing else.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

/** Runtime paths exactly as pr-gate.py declares them. */
function runtimePathsFromGate(): string[] {
  const src = read("scripts/pr-gate.py");
  const start = src.indexOf("RUNTIME_PATHS = (");
  expect(start, "pr-gate.py must still define RUNTIME_PATHS").toBeGreaterThan(-1);
  const open = src.indexOf("(", start);
  const close = src.indexOf(")", open);
  return [...src.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Backticked items of the runtime list in one doc paragraph.
 * AGENTS.md: between 「必须 bump 并重新 bundle——」 and 「。其中」.
 * Workflow doc: between 「之一就必须 bump」 and 「(configs/」.
 */
function runtimePathsFromDoc(doc: string, marker: string, stop: string): string[] {
  const start = doc.indexOf(marker) + marker.length;
  expect(start, "exemption paragraph not found").toBeGreaterThan(-1);
  const end = doc.indexOf(stop, start);
  expect(end, "runtime list terminator not found").toBeGreaterThan(start);
  // The list itself may be preceded by a backticked command inside the same
  // sentence ("必须 bump + `pnpm bundle`(`packages/`、…)"), so drop any leading
  // backticked token that is not a path.
  const items = [...doc.slice(start, end).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return items.filter((p) => p !== "pnpm bundle");
}

const FLOW_STOP = "(`configs/` 会内联进产物";
const TOOL_DIRS = ["scripts/", "docs/", "test/", ".github/", "plans/", "dev/", "remote/"];

describe("工具类免 bump 豁免:文档与机器口径一致", () => {
  const gate = runtimePathsFromGate();

  it("pr-gate.py 自身仍然把声明的清单当作运行时路径", () => {
    // Sanity: the parse must yield the real constant, not an empty match.
    expect(gate).toContain("packages/");
    expect(gate).toContain("package.json");
    expect(gate).toContain("dist/");
  });

  it("AGENTS.md 的运行时清单与 pr-gate.py 逐项相同", () => {
    const inDoc = runtimePathsFromDoc(read("AGENTS.md"), "必须 bump 并重新 bundle", "\n  其中");
    expect(inDoc.sort()).toEqual([...gate].sort());
  });

  it("流程文档的运行时清单与 pr-gate.py 逐项相同", () => {
    const inDoc = runtimePathsFromDoc(read("docs/agent-workflow.md"), "路径之一就必须 bump", FLOW_STOP);
    expect(inDoc.sort()).toEqual([...gate].sort());
  });

  it("工具类目录不出现在运行时清单里(否则自相矛盾)", () => {
    for (const d of TOOL_DIRS) expect(gate, d).not.toContain(d);
  });

  it("两份文档都点名 RUNTIME_PATHS 单一真相", () => {
    for (const p of ["AGENTS.md", "docs/agent-workflow.md"]) expect(read(p)).toContain("RUNTIME_PATHS");
  });
});
