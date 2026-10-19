/**
 * The "tool-only PRs do not bump" rule lives in two prose places (AGENTS.md and the
 * workflow doc) plus one machine source of truth (pr-gate.py RUNTIME_PATHS).
 * Nothing else enforces that the three agree, which is exactly the drift this guards.
 *
 * The gate list is read by importing the script (no source parsing); each doc list is
 * every backticked item between a start marker and a terminator, compared as an exact set.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

/** Runtime paths exactly as pr-gate.py declares them, read from the live module. */
function runtimePathsFromGate(): string[] {
  const code = "import importlib.util,json,sys;"
    + "s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);"
    + "s.loader.exec_module(m);print(json.dumps(list(m.RUNTIME_PATHS)))";
  return JSON.parse(execFileSync("python3", ["-c", code, join(ROOT, "scripts/pr-gate.py")], { encoding: "utf-8" }));
}

/** Backticked items between `marker` and the next `stop` in one doc. */
function runtimePathsFromDoc(doc: string, marker: string, stop: string): string[] {
  const at = doc.indexOf(marker);
  expect(at, `exemption paragraph marker not found: ${marker}`).toBeGreaterThan(-1);
  const start = at + marker.length;
  const end = doc.indexOf(stop, start);
  expect(end, "runtime list terminator not found").toBeGreaterThan(start);
  return [...doc.slice(start, end).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

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
    const inDoc = runtimePathsFromDoc(read("docs/agent-workflow.md"), "必须 bump 的运行时路径清单:", "\n   清单说明");
    expect(inDoc.sort()).toEqual([...gate].sort());
  });

  it("工具类目录不出现在运行时清单里(否则自相矛盾)", () => {
    for (const d of TOOL_DIRS) expect(gate, d).not.toContain(d);
  });

  it("两份文档都点名 RUNTIME_PATHS 单一真相", () => {
    for (const p of ["AGENTS.md", "docs/agent-workflow.md"]) expect(read(p)).toContain("RUNTIME_PATHS");
  });
});
