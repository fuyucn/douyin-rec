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

  it("upload+双烧+清理:fork/join,danmu 轨 y=10、upload 轨 y=70、livechat 轨 y=130,各轨 join 到 tail", () => {
    const g = buildFlow(doneJob([
      "select", "pull", "merge", "burn_danmu", "burn_livechat",
      "upload_plain", "append_danmu", "append_livechat", "clean_source",
    ]), undefined);
    expect(keys(g)).toContain("upload_plain");
    expect(g.nodes.find((n) => n.key === "burn_danmu")!.y).toBe(10);
    expect(g.nodes.find((n) => n.key === "upload_plain")!.y).toBe(70);
    expect(g.nodes.find((n) => n.key === "burn_livechat")!.y).toBe(130);
    expect(g.edges).toContainEqual(["merge", "burn_danmu"]);
    expect(g.edges).toContainEqual(["merge", "upload_plain"]);
    expect(g.edges).toContainEqual(["merge", "burn_livechat"]);
    // 每条轨内部 burn → append(拆 pipeline 后 append 属于自己轨,不再整成一条长尾)
    expect(g.edges).toContainEqual(["burn_danmu", "append_danmu"]);
    expect(g.edges).toContainEqual(["burn_livechat", "append_livechat"]);
    // P2 → P3 顺序依赖:append_danmu 完成才追 append_livechat
    expect(g.edges).toContainEqual(["append_danmu", "append_livechat"]);
    // join:三条轨末节点都指向第一个 tail(clean_source)
    expect(g.edges).toContainEqual(["upload_plain", "clean_source"]);
    expect(g.edges).toContainEqual(["append_danmu", "clean_source"]);
    expect(g.edges).toContainEqual(["append_livechat", "clean_source"]);
  });

  it("clean_stage_src 也是独立并行轨(y=190),merge 直连、末节点 join 到 tail", () => {
    const g = buildFlow(doneJob([
      "select", "pull", "merge", "burn_danmu", "append_danmu",
      "upload_plain", "burn_livechat", "append_livechat", "clean_stage_src", "__term__",
    ]), undefined);
    expect(g.nodes.find((n) => n.key === "clean_stage_src")!.y).toBe(190);
    expect(g.edges).toContainEqual(["merge", "clean_stage_src"]);
    expect(g.edges).toContainEqual(["clean_stage_src", "__term__"]);
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
