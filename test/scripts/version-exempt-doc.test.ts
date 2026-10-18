/**
 * The "tool-only PRs do not bump" rule exists in two prose places (AGENTS.md and the
 * workflow doc) plus one machine source of truth (pr-gate.py RUNTIME_PATHS).
 * Nothing enforces that the three agree, which is exactly the drift this guards.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

/** The paths pr-gate.py treats as runtime; kept literal so a change there fails here. */
const RUNTIME = ["packages/", "package.json", "Dockerfile", "docker-compose", "dist/"];
const TOOL = ["scripts/", "docs/", "test/", ".github/", "plans/", "configs/", "dev/", "remote/"];

describe("工具类免 bump 豁免:文档与机器口径一致", () => {
  const gate = read("scripts/pr-gate.py");
  const agents = read("AGENTS.md");
  const flow = read("docs/agent-workflow.md");

  it("pr-gate.py 的 RUNTIME_PATHS 就是这份清单(逐字)", () => {
    const line = gate.split("\n").find((l) => l.startsWith("RUNTIME_PATHS ="))!;
    for (const p of RUNTIME) expect(line).toContain(`"${p}"`);
  });

  it.each([
    ["AGENTS.md", agents],
    ["docs/agent-workflow.md", flow],
  ])("%s 写明「非运行时豁免」并指向 RUNTIME_PATHS 单一真相", (_name, doc) => {
    expect(doc).toContain("非运行时豁免");
    expect(doc).toContain("RUNTIME_PATHS");
    for (const p of TOOL) expect(doc, p).toContain(p);
  });

  it("两份文档列的运行时路径与 pr-gate.py 一致(多一个少一个都红)", () => {
    const line = gate.split("\n").find((l) => l.startsWith("RUNTIME_PATHS ="))!;
    const fromGate = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const p of RUNTIME) {
      expect(agents, `AGENTS.md 缺 ${p}`).toContain(p);
      expect(flow, `流程文档缺 ${p}`).toContain(p);
    }
    // A doc-only change must never trip the exemption, and any runtime path named in
    // the docs must be one pr-gate actually checks.
    for (const doc of [agents, flow]) {
      const sec = doc.slice(doc.indexOf("非运行时豁免"), doc.indexOf("非运行时豁免") + 900);
      for (const p of RUNTIME) if (sec.includes(p)) expect(fromGate, p).toContain(p);
    }
  });
});
