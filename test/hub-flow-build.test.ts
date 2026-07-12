import { describe, it, expect } from "vitest";
import { buildFlow, pickMetric } from "../packages/web/src/components/flow-build";

const keys = (g: { nodes: { key: string }[] }) => g.nodes.map((n) => n.key);
const doneJob = (steps: string[]) => ({ state: "done", steps: steps.flatMap((s) => [{ step: s }]) });

describe("buildFlow — 终态按 job.steps", () => {
  it("stage 模式只 danmu:线性,无 upload/append/livechat", () => {
    const g = buildFlow(doneJob(["select", "pull", "merge", "burn_danmu", "clean_source"]), undefined);
    expect(keys(g)).toEqual(["select", "pull", "merge", "burn_danmu", "clean_source", "__term__"]);
    // 线性:全 y=70
    expect(g.nodes.every((n) => n.y === 70)).toBe(true);
    expect(g.edges).toContainEqual(["merge", "burn_danmu"]);
    expect(g.edges).toContainEqual(["burn_danmu", "clean_source"]);
    expect(g.edges).toContainEqual(["clean_source", "__term__"]);
    expect(keys(g)).not.toContain("upload_plain");
    expect(keys(g)).not.toContain("append_danmu");
  });

  it("upload+双烧+清理:fork/join,burn 轨 y=10、upload 轨 y=130", () => {
    const g = buildFlow(doneJob([
      "select", "pull", "merge", "burn_danmu", "burn_livechat",
      "upload_plain", "append_danmu", "append_livechat", "clean_source",
    ]), undefined);
    expect(keys(g)).toContain("upload_plain");
    expect(g.nodes.find((n) => n.key === "burn_danmu")!.y).toBe(10);
    expect(g.nodes.find((n) => n.key === "upload_plain")!.y).toBe(130);
    expect(g.edges).toContainEqual(["merge", "burn_danmu"]);
    expect(g.edges).toContainEqual(["merge", "upload_plain"]);
    // join:两轨末节点都指向第一个 tail(append_danmu)
    expect(g.edges).toContainEqual(["upload_plain", "append_danmu"]);
  });
});

describe("buildFlow — 进行中按 cfg", () => {
  it("in-progress 只画规则开的节点", () => {
    const job = { state: "merging", steps: [{ step: "select" }, { step: "pull" }, { step: "merge" }] };
    const cfg = { steps: { burnDanmu: true, burnLivechat: false }, upload: { mode: "stage" }, cleanup: { sourceAfterDone: true } };
    const g = buildFlow(job, cfg);
    expect(keys(g)).toContain("burn_danmu");
    expect(keys(g)).not.toContain("burn_livechat");
    expect(keys(g)).not.toContain("upload_plain");
    expect(keys(g)).toContain("clean_source");
  });
});

describe("pickMetric", () => {
  it("非清理步取大小段", () => {
    expect(pickMetric("pull", "2 文件 · 1.9GB ← vps")).toBe("1.9GB");
    expect(pickMetric("merge", "4 段 → 90MB · 1h38m")).toBe("90MB");
  });
  it("清理步取删除计数", () => {
    expect(pickMetric("clean_source", "删 2 节点 · 4 文件")).toBe("删 2 节点");
  });
  it("无 detail 返 null", () => {
    expect(pickMetric("pull", undefined)).toBeNull();
  });
});
