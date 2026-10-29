import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHubRules, getHubRule, upsertHubRule, updateHubRule, removeHubRule, reorderHubRules, localSuppressedSourceTaskIds, hubKey } from "./hub-store.js";

// 这些测试不碰 sm-crypto;normalizeRoom + platformForRoom 经 store→core,test/setup 注册假平台。
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-store-"));
});

describe("hub-store(文件版,按平台限定 key)", () => {
  it("upsert 由 platform+roomSlug 写 {key}.json + get/list 往返", () => {
    const pipeline = { steps: { burnDanmu: false }, upload: { mode: "stage" as const, tag: "t", tid: 21 } };
    const r = upsertHubRule(dir, { platform: "douyin", roomSlug: "123456", room: "https://live.douyin.com/123456", pipeline });
    expect(r.roomSlug).toBe("123456");
    expect(r.platform).toBe("douyin");
    expect(r.key).toBe("douyin.123456");
    expect(r.enabled).toBe(true);
    expect(r.room).toBe("https://live.douyin.com/123456");
    // 文件名 = {platform}.{roomSlug}.json
    expect(existsSync(join(dir, "douyin.123456.json"))).toBe(true);
    expect(getHubRule(dir, "douyin.123456")!.pipeline).toEqual(pipeline);
    expect(listHubRules(dir).map((x) => x.key)).toEqual(["douyin.123456"]);
  });

  it("跨平台同房间号不撞(douyin.123 vs bilibili.123)", () => {
    upsertHubRule(dir, { platform: "douyin", roomSlug: "123", pipeline: { steps: { burnDanmu: true } } });
    upsertHubRule(dir, { platform: "bilibili", roomSlug: "123", pipeline: { steps: { burnDanmu: false } } });
    expect(existsSync(join(dir, "douyin.123.json"))).toBe(true);
    expect(existsSync(join(dir, "bilibili.123.json"))).toBe(true);
    expect(listHubRules(dir)).toHaveLength(2);
    expect(getHubRule(dir, "douyin.123")!.pipeline.steps?.burnDanmu).toBe(true);
    expect(getHubRule(dir, "bilibili.123")!.pipeline.steps?.burnDanmu).toBe(false);
  });

  it("upsert 同 key = 覆盖;缺省字段沿用已有", () => {
    upsertHubRule(dir, { platform: "douyin", roomSlug: "123456", enabled: true, pipeline: { steps: { burnDanmu: true } } });
    const r2 = upsertHubRule(dir, { platform: "douyin", roomSlug: "123456", enabled: false });
    expect(r2.enabled).toBe(false);
    expect(r2.pipeline).toEqual({ steps: { burnDanmu: true } });
    expect(listHubRules(dir)).toHaveLength(1);
  });

  it("update 部分改(按 key);不存在返回 null", () => {
    upsertHubRule(dir, { platform: "douyin", roomSlug: "123456" });
    expect(updateHubRule(dir, "douyin.123456", { enabled: false })!.enabled).toBe(false);
    expect(updateHubRule(dir, "douyin.nope", { enabled: true })).toBeNull();
  });

  // ── pipeline 深合并(修静默数据丢失)─────────────────────────────────────────
  // 背景:前端房间编辑面板只提交它知道的字段(步骤 + upload 的 mode/private/tag/tid/desc)。
  // 若 update 整体替换 pipeline,一次「只改一个步骤」的保存就会把 cleanup(清理开关)
  // 与 titleTemplate 等标题模板静默抹掉 —— 它们不在该表单里,用户看不出自己弄丢了什么。
  it("update 深合并 pipeline:未提交的 cleanup / 标题模板不被抹掉(静默丢失回归)", () => {
    upsertHubRule(dir, {
      platform: "douyin",
      roomSlug: "123456",
      pipeline: {
        steps: { mergeSegments: true, burnDanmu: true },
        cleanup: { sourceAfterDone: true, stageAfterDone: true },
        upload: { mode: "upload", tid: 21, tag: "旧tag", titleTemplate: "{name}_{date}", partTitleTemplate: "P{part}" },
        minSegmentSec: 5,
      },
    });
    // 模拟面板保存:只提交 steps 的一个开关 + upload 的部分字段(不含 cleanup/标题模板)。
    updateHubRule(dir, "douyin.123456", {
      pipeline: { steps: { burnDanmu: false }, upload: { mode: "upload", private: true } },
    });
    const p = getHubRule(dir, "douyin.123456")!.pipeline;
    // 提交的字段生效
    expect(p.steps?.burnDanmu).toBe(false);
    expect(p.upload?.private).toBe(true);
    // 同层未提交的字段保留(不是被整体替换清空)
    expect(p.steps?.mergeSegments).toBe(true);
    expect(p.upload?.tag).toBe("旧tag");
    expect(p.upload?.tid).toBe(21);
    expect(p.upload?.titleTemplate).toBe("{name}_{date}");
    expect(p.upload?.partTitleTemplate).toBe("P{part}");
    // 外层未提交的字段保留
    expect(p.cleanup).toEqual({ sourceAfterDone: true, stageAfterDone: true });
    expect(p.minSegmentSec).toBe(5);
  });

  it("upsert 也深合并 pipeline(同 key 二次写不丢 cleanup)", () => {
    upsertHubRule(dir, {
      platform: "douyin",
      roomSlug: "123456",
      pipeline: { steps: { burnDanmu: true }, cleanup: { sourceAfterDone: true } },
    });
    upsertHubRule(dir, {
      platform: "douyin",
      roomSlug: "123456",
      pipeline: { steps: { burnLivechat: true } },
    });
    const p = getHubRule(dir, "douyin.123456")!.pipeline;
    expect(p.steps).toEqual({ burnDanmu: true, burnLivechat: true });
    expect(p.cleanup).toEqual({ sourceAfterDone: true });
  });

  it("remove 删文件(按 key);不存在返回 false", () => {
    upsertHubRule(dir, { platform: "douyin", roomSlug: "123456" });
    expect(removeHubRule(dir, "douyin.123456")).toBe(true);
    expect(existsSync(join(dir, "douyin.123456.json"))).toBe(false);
    expect(getHubRule(dir, "douyin.123456")).toBeNull();
    expect(removeHubRule(dir, "douyin.123456")).toBe(false);
  });

  it("坏 JSON / 缺失目录不抛:list 跳过、get 返 null", () => {
    expect(listHubRules(join(dir, "nonexistent"))).toEqual([]);
    writeFileSync(join(dir, "douyin.bad.json"), "{not json", "utf-8");
    upsertHubRule(dir, { platform: "douyin", roomSlug: "999" });
    expect(listHubRules(dir).map((r) => r.key)).toEqual(["douyin.999"]);
    expect(getHubRule(dir, "douyin.bad")).toBeNull();
  });

  it("room 可选:不带 room 落盘不写该字段,读取由文件名还原 roomSlug", () => {
    const r = upsertHubRule(dir, { platform: "douyin", roomSlug: "123456" });
    expect(r.room).toBe("");
    expect(r.roomSlug).toBe("123456");
    expect(JSON.parse(readFileSync(join(dir, "douyin.123456.json"), "utf-8")).room).toBeUndefined();
  });

  it("遗留文件含 room 字段仍按 room 还原显示", () => {
    writeFileSync(join(dir, "douyin.123456.json"), JSON.stringify({ room: "https://live.douyin.com/123456", enabled: false }));
    const r = getHubRule(dir, "douyin.123456")!;
    expect(r.room).toBe("https://live.douyin.com/123456");
    expect(r.roomSlug).toBe("123456");
    expect(r.enabled).toBe(false);
  });

  it("hubKey 拼接", () => {
    expect(hubKey("douyin", "767116735823")).toBe("douyin.767116735823");
  });

  it("workers 字段创建/更新往返 + 其余字段(room/enabled/pipeline)保留", () => {
    const pipeline = { steps: { burnDanmu: false }, upload: { mode: "stage" as const, tag: "t", tid: 21 } };
    const r = upsertHubRule(dir, { platform: "douyin", roomSlug: "123456", room: "https://live.douyin.com/123456", pipeline, workers: ["local", "vps2"] });
    expect(r.workers).toEqual(["local", "vps2"]);
    // 落盘往返
    expect(getHubRule(dir, "douyin.123456")!.workers).toEqual(["local", "vps2"]);
    // update 只改 workers,其余保留
    const u = updateHubRule(dir, "douyin.123456", { workers: ["local"] })!;
    expect(u.workers).toEqual(["local"]);
    expect(u.pipeline).toEqual(pipeline);   // pipeline 保留
    expect(u.enabled).toBe(true);           // enabled 保留
    // 缺省(老规则)= 无 workers 字段
    const bare = upsertHubRule(dir, { platform: "douyin", roomSlug: "999" });
    expect(bare.workers).toBeUndefined();
  });

  it("requires 字段创建/更新往返;空数组视为无要求(不落盘)", () => {
    const r = upsertHubRule(dir, { platform: "douyin", roomSlug: "123456", requires: ["danmu:douyin"] });
    expect(r.requires).toEqual(["danmu:douyin"]);
    expect(getHubRule(dir, "douyin.123456")!.requires).toEqual(["danmu:douyin"]);
    // update 改 requires
    const u = updateHubRule(dir, "douyin.123456", { requires: ["danmu:douyin", "burn"] })!;
    expect(u.requires).toEqual(["danmu:douyin", "burn"]);
    // 空数组 → 清空(undefined)
    const cleared = updateHubRule(dir, "douyin.123456", { requires: [] })!;
    expect(cleared.requires).toBeUndefined();
    // 缺省 = 无要求
    const bare = upsertHubRule(dir, { platform: "douyin", roomSlug: "999" });
    expect(bare.requires).toBeUndefined();
  });

  it("reorder:整体重排写 order;upsert/update 沿用 order;集合不匹配则拒绝", () => {
    upsertHubRule(dir, { platform: "douyin", roomSlug: "aaa" });
    upsertHubRule(dir, { platform: "douyin", roomSlug: "bbb" });
    upsertHubRule(dir, { platform: "bilibili", roomSlug: "ccc" });
    // 默认按 key 排序
    expect(listHubRules(dir).map((r) => r.key)).toEqual(["bilibili.ccc", "douyin.aaa", "douyin.bbb"]);
    reorderHubRules(dir, ["douyin.bbb", "bilibili.ccc", "douyin.aaa"]);
    expect(listHubRules(dir).map((r) => r.key)).toEqual(["douyin.bbb", "bilibili.ccc", "douyin.aaa"]);
    // upsert/update 保留 order
    updateHubRule(dir, "douyin.aaa", { enabled: false });
    expect(listHubRules(dir).map((r) => r.key)).toEqual(["douyin.bbb", "bilibili.ccc", "douyin.aaa"]);
    // 缺 key / 重复 / 未知 key → 报错且不改盘
    expect(() => reorderHubRules(dir, ["douyin.aaa"])).toThrow();
    expect(() => reorderHubRules(dir, ["douyin.aaa", "douyin.bbb", "nope.zzz"])).toThrow();
    expect(listHubRules(dir).map((r) => r.key)).toEqual(["douyin.bbb", "bilibili.ccc", "douyin.aaa"]);
  });

  it("localSuppressedSourceTaskIds:源任务被绑 + workers 不含 local + 远端 worker 真实存在 → 本机抑制", () => {
    upsertHubRule(dir, { platform: "douyin", roomSlug: "111", recording: { sourceTaskId: 10 }, workers: ["vps2"] });
    upsertHubRule(dir, { platform: "douyin", roomSlug: "222", recording: { sourceTaskId: 11 }, workers: ["local", "vps2"] });
    upsertHubRule(dir, { platform: "douyin", roomSlug: "333", recording: { sourceTaskId: 12 }, enabled: false, workers: ["vps2"] });
    upsertHubRule(dir, { platform: "douyin", roomSlug: "444", recording: { sourceTaskId: 13 } }); // workers 缺省=全部
    expect([...localSuppressedSourceTaskIds(dir, new Set(["local", "vps2"]))].sort()).toEqual([10]);
  });

  it("localSuppressedSourceTaskIds:远端 worker 已被删除(幽灵 id)→ 不抑制本机,避免两头都不录", () => {
    upsertHubRule(dir, { platform: "douyin", roomSlug: "111", recording: { sourceTaskId: 10 }, workers: ["ghost"] });
    expect([...localSuppressedSourceTaskIds(dir, new Set(["local"]))]).toEqual([]);
  });

  it("T-10 能力门控:远端存在但缺 requires 能力 → 不抑制本机(否则两头都不录)", () => {
    // vps2 存在,但规则要求 danmu:douyin,而 vps2 无此能力 → reconciler 会排除它 → 本机必须实跑。
    upsertHubRule(dir, { platform: "douyin", roomSlug: "111", recording: { sourceTaskId: 10 }, workers: ["vps2"], requires: ["danmu:douyin"] });
    const capsNoDanmu = () => undefined;                                  // vps2 无能力
    expect([...localSuppressedSourceTaskIds(dir, new Set(["local", "vps2"]), capsNoDanmu)]).toEqual([]);
    // 同一规则:vps2 具备 danmu:douyin → 远端能接 → 本机抑制。
    const capsWithDanmu = (id: string) => (id === "vps2" ? ["danmu:douyin"] : undefined);
    expect([...localSuppressedSourceTaskIds(dir, new Set(["local", "vps2"]), capsWithDanmu)]).toEqual([10]);
  });

  it("T-10:无能力信息时不抑制(安全默认:宁可本机实跑,也不冒「两头都不录」的风险)", () => {
    upsertHubRule(dir, { platform: "douyin", roomSlug: "111", recording: { sourceTaskId: 10 }, workers: ["vps2"], requires: ["danmu:douyin"] });
    // 不传第 3 参(拿不到能力)→ 无法证明远端合格 → 不抑制本机(与 reconciler 同判定:
    // requires 非空时 satisfiesCapabilities(undefined, requires)=false)。
    expect([...localSuppressedSourceTaskIds(dir, new Set(["local", "vps2"]))]).toEqual([]);
  });
});
