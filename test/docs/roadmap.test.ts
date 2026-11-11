import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const roadmap = readFileSync(join(ROOT, "docs", "roadmap.md"), "utf8");
const todo = readFileSync(join(ROOT, "TODO.md"), "utf8");
const doneSection = todo.slice(todo.indexOf("## 已完成"));

describe("路线图与台账一致", () => {
  it("roadmap 存在并回答三件事", () => {
    for (const head of ["## 一、已完成", "## 二、下一步", "## 三、在等人的事"]) {
      expect(roadmap, `roadmap 缺段落: ${head}`).toContain(head);
    }
  });

  it("roadmap 说已完成的 PR,在 TODO.md 已完成段里必须有对应条目", () => {
    const prs = [...roadmap.matchAll(/PR #(\d+)/g)].map((m) => m[1]!);
    expect(prs.length).toBeGreaterThan(3);
    const has = (n: string) => doneSection.includes(`PR [#${n}]`) || doneSection.includes(`PR #${n}`);
    const missing = prs.filter((n) => !has(n));
    expect(missing, `roadmap 与 TODO.md 漂移,这些 PR 在台账里找不到: ${missing.join(", ")}`).toEqual([]);
  });
});
