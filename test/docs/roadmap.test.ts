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

describe("阶段 1b 的执行清单", () => {
  const ROOT = join(import.meta.dirname, "../..");
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

  it("roadmap 的下一步指向 §8.1", () => {
    const roadmap = read("docs/roadmap.md");
    expect(roadmap).toContain("plans/049 §8.1");
  });

  it("§8.1 段内列出五条并行上传路径与五批,且每批都标了决策门", () => {
    const plan = read("plans/049_upload_target_contract.md");
    // 只取 §8.1 这一节,避免别的章节凑满足断言。
    const from = plan.indexOf("### 8.1 阶段 1b 执行清单");
    expect(from).toBeGreaterThan(-1);
    const section = plan.slice(from, plan.indexOf("## §9", from));

    // 五条路径一个都不能少:漏一条就会以为「上传轴已接完」。
    for (const p of [
      "orchestrator/workflow.ts:229",
      "orchestrator/segment-pipeline.ts:571-573",
      "orchestrator/pipeline.ts:1550-1551",
      "app/rolling-upload.ts:1355",
      "processors/biliup.ts:298",
    ]) expect(section).toContain(p);

    // 五批,且 1b-1…1b-4 各需人工拍板(上传是危险类)。
    for (const b of ["1b-1", "1b-2", "1b-3", "1b-4", "1b-5"]) expect(section).toContain(b);
    expect(section.match(/needs-decision/g)?.length ?? 0).toBeGreaterThanOrEqual(5);

    // 「等价」与「proof: unknown 有意改变」必须分开写,不能混成一句「新增 proof 判定」。
    expect(section).toContain("有意改变");
    expect(section).toContain("不重试、转人工");

    // 1b-1 的取舍与 1b-5 的收口条件都要在段内(否则兼容字段会永久化)。
    expect(section).toContain("保留旧字段做兼容");
    expect(section).toContain("引用归零");
  });
});
