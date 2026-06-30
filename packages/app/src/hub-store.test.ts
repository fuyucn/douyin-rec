import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHubRules, getHubRule, upsertHubRule, updateHubRule, removeHubRule, hubKey } from "./hub-store.js";

// 这些测试不碰 sm-crypto;normalizeRoom + platformForRoom 经 store→core,test/setup 注册假平台。
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-store-"));
});

describe("hub-store(文件版,按平台限定 key)", () => {
  it("upsert 由 room 派生 {platform}.{roomSlug} 写文件 + get/list 往返", () => {
    const pipeline = { steps: { burnDanmu: false }, upload: { mode: "stage" as const, tag: "t", tid: 21 } };
    const r = upsertHubRule(dir, { room: "https://live.douyin.com/123456", pipeline });
    expect(r.roomSlug).toBe("123456");
    expect(r.platform).toBe("douyin");
    expect(r.key).toBe("douyin.123456");
    expect(r.enabled).toBe(true);
    // 文件名 = {platform}.{roomSlug}.json
    expect(existsSync(join(dir, "douyin.123456.json"))).toBe(true);
    expect(getHubRule(dir, "douyin.123456")!.pipeline).toEqual(pipeline);
    expect(listHubRules(dir).map((x) => x.key)).toEqual(["douyin.123456"]);
  });

  it("跨平台同房间号不撞(douyin.123 vs bilibili.123)", () => {
    upsertHubRule(dir, { room: "https://live.douyin.com/123", pipeline: { steps: { burnDanmu: true } } });
    upsertHubRule(dir, { room: "https://live.bilibili.com/123", pipeline: { steps: { burnDanmu: false } } });
    expect(existsSync(join(dir, "douyin.123.json"))).toBe(true);
    expect(existsSync(join(dir, "bilibili.123.json"))).toBe(true);
    expect(listHubRules(dir)).toHaveLength(2);
    expect(getHubRule(dir, "douyin.123")!.pipeline.steps?.burnDanmu).toBe(true);
    expect(getHubRule(dir, "bilibili.123")!.pipeline.steps?.burnDanmu).toBe(false);
  });

  it("upsert 同 key = 覆盖;缺省字段沿用已有", () => {
    upsertHubRule(dir, { room: "https://live.douyin.com/123456", enabled: true, pipeline: { steps: { burnDanmu: true } } });
    const r2 = upsertHubRule(dir, { room: "https://live.douyin.com/123456", enabled: false });
    expect(r2.enabled).toBe(false);
    expect(r2.pipeline).toEqual({ steps: { burnDanmu: true } });
    expect(listHubRules(dir)).toHaveLength(1);
  });

  it("update 部分改(按 key);不存在返回 null", () => {
    upsertHubRule(dir, { room: "https://live.douyin.com/123456" });
    expect(updateHubRule(dir, "douyin.123456", { enabled: false })!.enabled).toBe(false);
    expect(updateHubRule(dir, "douyin.nope", { enabled: true })).toBeNull();
  });

  it("remove 删文件(按 key);不存在返回 false", () => {
    upsertHubRule(dir, { room: "https://live.douyin.com/123456" });
    expect(removeHubRule(dir, "douyin.123456")).toBe(true);
    expect(existsSync(join(dir, "douyin.123456.json"))).toBe(false);
    expect(getHubRule(dir, "douyin.123456")).toBeNull();
    expect(removeHubRule(dir, "douyin.123456")).toBe(false);
  });

  it("坏 JSON / 缺失目录不抛:list 跳过、get 返 null", () => {
    expect(listHubRules(join(dir, "nonexistent"))).toEqual([]);
    writeFileSync(join(dir, "douyin.bad.json"), "{not json", "utf-8");
    upsertHubRule(dir, { room: "https://live.douyin.com/999" });
    expect(listHubRules(dir).map((r) => r.key)).toEqual(["douyin.999"]);
    expect(getHubRule(dir, "douyin.bad")).toBeNull();
  });

  it("hubKey 拼接", () => {
    expect(hubKey("douyin", "767116735823")).toBe("douyin.767116735823");
  });
});
