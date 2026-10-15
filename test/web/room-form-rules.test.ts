import { describe, it, expect } from "vitest";
import { shouldUseNodeSideUpload } from "../../packages/orchestrator/src/node-side-upload";
import {
  applyChange,
  cookieLock,
  deriveConstraints,
  flowSummary,
  methodFromStored,
  storedFromForm,
  type FormFacts,
} from "../../packages/web/src/lib/room-form-rules";

const facts = (over: Partial<FormFacts> = {}): FormFacts => ({
  danmu: true,
  danmuAvailable: true,
  cookieReady: true,
  cookieForStream: false,
  procEnabled: true,
  uploadOn: true,
  method: "after",
  tsDirect: false,
  mergeSegments: true,
  burnDanmu: false,
  burnLivechat: false,
  workers: ["local"],
  hasRule: true,
  ...over,
});

describe("deriveConstraints — 边录边传(复用 core resolveRollingPolicy)", () => {
  it("有规则 + 单节点 + 不烧录 → 可选", () => {
    expect(deriveConstraints(facts()).rolling).toEqual({ locked: false });
  });
  it("有规则 + 2 个节点 → 锁,原因 = 多节点", () => {
    const c = deriveConstraints(facts({ workers: ["local", "vps1"] }));
    expect(c.rolling).toEqual({ locked: true, reasonKey: "rooms.rollingReasonMultiNode" });
  });
  it("有规则 + 未勾选节点(= 全部节点)→ 锁", () => {
    expect(deriveConstraints(facts({ workers: [] })).rolling.locked).toBe(true);
  });
  it("开烧录 → 锁,原因 = 烧录互斥", () => {
    const c = deriveConstraints(facts({ burnLivechat: true }));
    expect(c.rolling).toEqual({ locked: true, reasonKey: "rooms.rollingNeedsBurn" });
  });
  it("无规则(单机任务)→ 不受节点数约束", () => {
    expect(deriveConstraints(facts({ hasRule: false, workers: [] })).rolling.locked).toBe(false);
  });
});

describe("deriveConstraints — 其余依赖", () => {
  it("抖音(Cookie 只服务弹幕):关录弹幕 → Cookie 与烧录都锁", () => {
    const c = deriveConstraints(facts({ danmu: false }));
    expect(c.cookie).toEqual({ locked: true, reasonKey: "roomForm.lock.needDanmu" });
    expect(c.burn).toEqual({ locked: true, reasonKey: "roomForm.lock.needDanmu" });
  });
  it("B站/快手(Cookie 用于取流):关录弹幕或平台无弹幕时 Cookie 仍可开", () => {
    expect(deriveConstraints(facts({ cookieForStream: true, danmu: false })).cookie.locked).toBe(false);
    expect(deriveConstraints(facts({ cookieForStream: true, danmuAvailable: false })).cookie.locked).toBe(false);
  });
  it("平台无弹幕 → 烧录锁", () => {
    expect(deriveConstraints(facts({ danmuAvailable: false })).burn.locked).toBe(true);
  });
  it("未登录 → Cookie 锁(原因 = 需登录,任何平台),烧录不锁", () => {
    const c = deriveConstraints(facts({ cookieReady: false }));
    expect(c.cookie).toEqual({ locked: true, reasonKey: "dialog.giftNeedCookie" });
    expect(deriveConstraints(facts({ cookieReady: false, cookieForStream: true })).cookie.locked).toBe(true);
    expect(c.burn.locked).toBe(false);
  });
  it("开烧录 → 节点侧上传锁", () => {
    expect(deriveConstraints(facts({ burnDanmu: true })).nodeSide.locked).toBe(true);
  });
  it(".ts 直传只在有效方式为节点侧上传时可用", () => {
    expect(deriveConstraints(facts({ method: "nodeSide" })).tsDirect.locked).toBe(false);
    expect(deriveConstraints(facts({ method: "after" })).tsDirect.locked).toBe(true);
    expect(deriveConstraints(facts({ method: "nodeSide", burnDanmu: true })).tsDirect.locked).toBe(true);
    expect(deriveConstraints(facts({ method: "nodeSide", uploadOn: false })).tsDirect.locked).toBe(true);
  });
  it("不合并 → 「合并后删 stage 源」锁;只合成 → 清空 stage 警示", () => {
    expect(deriveConstraints(facts({ mergeSegments: false })).clStageSourceAfterMerge.locked).toBe(true);
    expect(deriveConstraints(facts({ uploadOn: false })).clStageAfterDoneWarn).toBe(true);
    expect(deriveConstraints(facts()).clStageAfterDoneWarn).toBe(false);
  });
});

describe("applyChange — 当前方式失效时自动回落", () => {
  it("rolling 选中后开烧录 → 回落 after,且保留其它字段", () => {
    const f = { ...facts({ method: "rolling" }), extra: "keep" };
    const next = applyChange(f, "burnDanmu", true);
    expect(next.method).toBe("after");
    expect(next.burnDanmu).toBe(true);
    expect(next.extra).toBe("keep");
  });
  it("rolling 选中后加第二个节点 → 回落 after", () => {
    expect(applyChange(facts({ method: "rolling" }), "workers", ["local", "vps1"]).method).toBe("after");
  });
  it("节点侧上传选中后开烧录 → 回落 after", () => {
    expect(applyChange(facts({ method: "nodeSide" }), "burnLivechat", true).method).toBe("after");
  });
  it("未失效的改动不改变方式", () => {
    expect(applyChange(facts({ method: "rolling" }), "mergeSegments", false).method).toBe("rolling");
  });
});

describe("methodFromStored / storedFromForm 往返", () => {
  it.each([
    ["stage", false, { uploadOn: false, method: "after" }],
    ["upload", false, { uploadOn: true, method: "after" }],
    ["upload", true, { uploadOn: true, method: "nodeSide" }],
    ["rolling", false, { uploadOn: true, method: "rolling" }],
    ["rolling", true, { uploadOn: true, method: "rolling" }],
    [undefined, false, { uploadOn: false, method: "after" }],
  ] as const)("mode=%s nodeSide=%s", (mode, nodeSide, expected) => {
    expect(methodFromStored(mode, nodeSide)).toEqual(expected);
  });
  const noBurn = { burnDanmu: false, burnLivechat: false };
  it("三种方式与上传关写回存储", () => {
    expect(storedFromForm(facts({ method: "after" }))).toEqual({ mode: "upload", nodeSideUpload: false, ...noBurn });
    expect(storedFromForm(facts({ method: "nodeSide" }))).toEqual({ mode: "upload", nodeSideUpload: true, ...noBurn });
    expect(storedFromForm(facts({ method: "rolling" }))).toEqual({ mode: "rolling", nodeSideUpload: false, ...noBurn });
    expect(storedFromForm(facts({ uploadOn: false, method: "rolling" }))).toEqual({ mode: "stage", nodeSideUpload: false, ...noBurn });
  });
  it("被锁的方式按 after 写回(绝不把失效的 rolling 存进规则)", () => {
    expect(storedFromForm(facts({ method: "rolling", workers: ["a", "b"] }))).toEqual({ mode: "upload", nodeSideUpload: false, ...noBurn });
    expect(storedFromForm(facts({ method: "nodeSide", burnDanmu: true })))
      .toEqual({ mode: "upload", nodeSideUpload: false, burnDanmu: true, burnLivechat: false });
  });
});

describe("实际烧录:不录弹幕 = 不烧(锁定显示、判定同口径;存储一律写回实际值)", () => {
  const off = facts({ danmu: false, burnDanmu: true, burnLivechat: true });
  const burnOn = { burnDanmu: true, burnLivechat: true };
  const burnOff = { burnDanmu: false, burnLivechat: false };
  it("方式 after:存储写回实际值 false(无弹幕文件,存原值后端会烧录失败)", () => {
    expect(storedFromForm({ ...off, method: "after" })).toMatchObject(burnOff);
  });
  it("不录弹幕 + 原值开 + after:存储烧录 false,且流程摘要不含烧录步骤(二者一致)", () => {
    const f = { ...off, method: "after" as const };
    const s = storedFromForm(f);
    expect(s).toMatchObject(burnOff);
    const keys = flowSummary(f, true).map((x) => x.key);
    expect(keys).not.toContain("roomForm.flow.burnDanmu");
    expect(keys).not.toContain("roomForm.flow.burnLivechat");
    expect(flowSummary({ ...f, ...s }, true)).toEqual(flowSummary(f, true));
  });
  it("方式 nodeSide + 不录弹幕 + 原值开:存储烧录 = false,nodeSideUpload = true", () => {
    expect(storedFromForm({ ...off, method: "nodeSide" }))
      .toEqual({ mode: "upload", nodeSideUpload: true, burnDanmu: false, burnLivechat: false });
  });
  it("nodeSide 存储结果交给后端判定 → 节点侧上传适用(表单与实际一致)", () => {
    const s = storedFromForm({ ...off, method: "nodeSide" });
    expect(shouldUseNodeSideUpload(
      { uploadMode: s.mode as "upload", steps: { nodeSideUpload: s.nodeSideUpload } } as never,
      { burnDanmu: s.burnDanmu, burnLivechat: s.burnLivechat },
    )).toEqual({ ok: true });
  });
  it("只合成:存储写回实际值 false", () => {
    expect(storedFromForm({ ...off, uploadOn: false })).toEqual({ mode: "stage", nodeSideUpload: false, ...burnOff });
  });
  it("方式 rolling:存储写回关,避免后端据残留烧录开关判定边录边传「需烧录」", () => {
    expect(storedFromForm({ ...off, method: "rolling" })).toEqual({ mode: "rolling", nodeSideUpload: false, burnDanmu: false, burnLivechat: false });
  });
  it("录弹幕 + 开烧录:rolling 被锁并回落 after,存储烧录 = 原值 true", () => {
    const on = facts({ method: "rolling", burnDanmu: true, burnLivechat: true });
    expect(deriveConstraints(on).rolling.locked).toBe(true);
    expect(storedFromForm(on)).toEqual({ mode: "upload", nodeSideUpload: false, ...burnOn });
  });
  it("边录边传 / 节点侧不因残留烧录开关被锁", () => {
    const c = deriveConstraints(off);
    expect(c.rolling.locked).toBe(false);
    expect(c.nodeSide.locked).toBe(false);
  });
  it("流程摘要不出现烧录步骤", () => {
    expect(flowSummary(off, true).map((x) => x.key)).toEqual(["roomForm.flow.record", "roomForm.flow.merge", "roomForm.flow.upload"]);
  });
  it("平台无弹幕同理", () => {
    expect(storedFromForm(facts({ danmuAvailable: false, burnDanmu: true }))).toMatchObject(burnOff);
  });
});

describe("flowSummary", () => {
  const keys = (f: FormFacts, rec = true) => flowSummary(f, rec).map((s) => s.key.replace("roomForm.flow.", ""));
  it("合并 + 烧两版 + 投稿", () => {
    expect(keys(facts({ burnDanmu: true, burnLivechat: true }))).toEqual(["record", "merge", "burnDanmu", "burnLivechat", "upload"]);
  });
  it("边录边传:录制后直接投稿,无处理步骤", () => {
    expect(keys(facts({ method: "rolling" }))).toEqual(["record", "rolling"]);
  });
  it("失效的边录边传按收播后上传描述", () => {
    expect(keys(facts({ method: "rolling", workers: [] }))).toEqual(["record", "merge", "upload"]);
  });
  it("按分段 + 节点侧;只合成;处理关闭", () => {
    expect(keys(facts({ mergeSegments: false, method: "nodeSide" }))).toEqual(["record", "split", "nodeSide"]);
    expect(keys(facts({ uploadOn: false }))).toEqual(["record", "merge", "stageOnly"]);
    expect(flowSummary(facts({ procEnabled: false }), false)).toEqual([
      { key: "roomForm.flow.record", on: false },
      { key: "roomForm.flow.noProcess", on: false },
    ]);
  });
  it("规则停用 = 暂停整个房间:即便任务启用,录制也显示为停(各节点停录)", () => {
    expect(flowSummary(facts({ procEnabled: false }), true)[0]).toEqual({ key: "roomForm.flow.record", on: false });
  });
  it("无规则(单机任务)处理关闭时录制照常", () => {
    expect(flowSummary(facts({ procEnabled: false, hasRule: false }), true)[0]).toEqual({ key: "roomForm.flow.record", on: true });
  });
});

describe("cookieLock — 任务弹窗单独使用,与 deriveConstraints 同口径", () => {
  const base = { danmu: true, danmuAvailable: true, cookieReady: true, cookieForStream: false };
  it("已登录 + 录弹幕 → 可开", () => {
    expect(cookieLock(base)).toEqual({ locked: false });
  });
  it("未登录 → 锁(任何平台)", () => {
    expect(cookieLock({ ...base, cookieReady: false })).toEqual({ locked: true, reasonKey: "dialog.giftNeedCookie" });
    expect(cookieLock({ ...base, cookieReady: false, cookieForStream: true }).locked).toBe(true);
  });
  it("抖音不录弹幕 → 锁;取流平台不录弹幕 → 可开", () => {
    expect(cookieLock({ ...base, danmu: false })).toEqual({ locked: true, reasonKey: "roomForm.lock.needDanmu" });
    expect(cookieLock({ ...base, danmu: false, cookieForStream: true }).locked).toBe(false);
  });
  it("与 deriveConstraints().cookie 一致", () => {
    const f = facts({ danmu: false });
    expect(cookieLock(f)).toEqual(deriveConstraints(f).cookie);
  });
});
