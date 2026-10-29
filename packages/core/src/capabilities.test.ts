import { describe, it, expect } from "vitest";
import { satisfiesCapabilities, gateWorkers, explainRejections } from "./capabilities.js";

describe("satisfiesCapabilities", () => {
  it("无要求 → 恒真(即使 worker 无能力)", () => {
    expect(satisfiesCapabilities(undefined, undefined)).toBe(true);
    expect(satisfiesCapabilities([], [])).toBe(true);
    expect(satisfiesCapabilities(undefined, [])).toBe(true);
  });
  it("能力 ⊇ 要求 → 真;缺任一 → 假", () => {
    expect(satisfiesCapabilities(["danmu:douyin", "record"], ["danmu:douyin"])).toBe(true);
    expect(satisfiesCapabilities(["danmu:douyin"], ["danmu:douyin", "burn"])).toBe(false);
    expect(satisfiesCapabilities(undefined, ["danmu:douyin"])).toBe(false);
  });
});

describe("gateWorkers", () => {
  const caps: Record<string, string[]> = {
    local: ["record", "danmu:douyin", "burn", "upload"],
    vps1: ["record"],
    vps2: ["record"],
  };
  const capsOf = (id: string): string[] | undefined => caps[id];

  it("无要求 → 全部通过,无排除", () => {
    const r = gateWorkers(["local", "vps1", "vps2"], capsOf, undefined);
    expect(r.eligible).toEqual(["local", "vps1", "vps2"]);
    expect(r.rejected).toEqual([]);
  });
  it("要求 danmu:douyin → 只留有能力者,其余记缺失", () => {
    const r = gateWorkers(["local", "vps1", "vps2"], capsOf, ["danmu:douyin"]);
    expect(r.eligible).toEqual(["local"]);
    expect(r.rejected).toEqual([
      { workerId: "vps1", missing: ["danmu:douyin"] },
      { workerId: "vps2", missing: ["danmu:douyin"] },
    ]);
  });
  it("能力门控是过滤不是去重:多台合格 → 全部保留(不改变冗余语义)", () => {
    const caps2 = { a: ["danmu:douyin"], b: ["danmu:douyin"], c: ["record"] };
    const r = gateWorkers(["a", "b", "c"], (id) => caps2[id as keyof typeof caps2], ["danmu:douyin"]);
    expect(r.eligible).toEqual(["a", "b"]);
  });
  it("未知 worker(无能力)→ 被排除并记缺失", () => {
    const r = gateWorkers(["ghost"], () => undefined, ["danmu:douyin"]);
    expect(r.eligible).toEqual([]);
    expect(r.rejected).toEqual([{ workerId: "ghost", missing: ["danmu:douyin"] }]);
  });
  it("同一 worker 多会话(重复 id)→ 去重,不重复列出(警告不刷屏)", () => {
    // 断流重连:同 worker 一场 3 个会话 → members 里出现 3 次同一 id。
    const r = gateWorkers(["local", "vps2", "vps2", "vps2"], capsOf, ["danmu:douyin"]);
    expect(r.eligible).toEqual(["local"]);
    expect(r.rejected).toEqual([{ workerId: "vps2", missing: ["danmu:douyin"] }]);   // 只一条
  });
  it("无要求时也去重(eligible 不含重复)", () => {
    const r = gateWorkers(["a", "a", "b"], capsOf, undefined);
    expect(r.eligible).toEqual(["a", "b"]);
  });
});

describe("explainRejections", () => {
  it("空 → 空串", () => {
    expect(explainRejections([])).toBe("");
  });
  it("人话:列出每台缺的能力(可用 nameOf 换显示名)", () => {
    const s = explainRejections(
      [{ workerId: "vps1", missing: ["danmu:douyin"] }, { workerId: "vps2", missing: ["danmu:douyin", "burn"] }],
      (id) => (id === "vps1" ? "香港 VPS" : id),
    );
    expect(s).toContain("香港 VPS");
    expect(s).toContain("danmu:douyin");
    expect(s).toContain("vps2");
    expect(s).toContain("burn");
  });
});
