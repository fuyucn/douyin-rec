import { describe, it, expect } from "vitest";
import { shouldUseNodeSideUpload } from "../../packages/orchestrator/src/node-side-upload";
import {
  applyChange,
  burnVersionsApply,
  keepArchiveFromStored,
  accountToggleCopy,
  cookieLock,
  cookieReadyFor,
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
  clKeepArchive: true,
  workers: ["local"],
  hasRule: true,
  outputFormat: "original",
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
  it("不合并 → 「合并后删存档源」锁", () => {
    expect(deriveConstraints(facts({ mergeSegments: false })).clStageSourceAfterMerge.locked).toBe(true);
  });
});

describe("投稿后保留存档(存储 cleanup.stageAfterDone 取反)", () => {
  it("不投稿 → 锁定并给原因;投稿 → 可操作", () => {
    expect(deriveConstraints(facts({ uploadOn: false })).clKeepArchive)
      .toEqual({ locked: true, reasonKey: "roomForm.lock.needUploadForCleanArchive" });
    expect(deriveConstraints(facts()).clKeepArchive).toEqual({ locked: false });
  });
  it("不投稿时存储一律写 stageAfterDone=false,不管表单原值", () => {
    expect(storedFromForm(facts({ uploadOn: false, clKeepArchive: false })).stageAfterDone).toBe(false);
    expect(storedFromForm(facts({ uploadOn: false, clKeepArchive: true })).stageAfterDone).toBe(false);
  });
  it("投稿时可开可关,原值往返", () => {
    expect(storedFromForm(facts({ clKeepArchive: true })).stageAfterDone).toBe(false);
    expect(storedFromForm(facts({ clKeepArchive: false })).stageAfterDone).toBe(true);
  });
  it("读入取反:旧规则 stageAfterDone=true → 不保留;false/缺省 → 保留", () => {
    expect(keepArchiveFromStored(true)).toBe(false);
    expect(keepArchiveFromStored(false)).toBe(true);
    expect(keepArchiveFromStored(undefined)).toBe(true);
  });
  it("存储 → 表单 → 存储 往返一致(投稿)", () => {
    for (const stored of [true, false]) {
      const back = storedFromForm(facts({ clKeepArchive: keepArchiveFromStored(stored) })).stageAfterDone;
      expect(back).toBe(stored);
    }
  });
  it("不投稿 → 再切回投稿:表单原值保留(锁只影响写回)", () => {
    const off = applyChange(facts({ clKeepArchive: false }), "uploadOn", false);
    expect(off.clKeepArchive).toBe(false);
    expect(applyChange(off, "uploadOn", true).clKeepArchive).toBe(false);
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
    expect(storedFromForm(facts({ method: "after" }))).toEqual({ mode: "upload", stageAfterDone: false, outputFormat: "original", nodeSideUpload: false, ...noBurn });
    expect(storedFromForm(facts({ method: "nodeSide" }))).toEqual({ mode: "upload", stageAfterDone: false, outputFormat: "original", nodeSideUpload: true, ...noBurn });
    expect(storedFromForm(facts({ method: "rolling" }))).toEqual({ mode: "rolling", stageAfterDone: false, outputFormat: "original", nodeSideUpload: false, ...noBurn });
    expect(storedFromForm(facts({ uploadOn: false, method: "rolling" }))).toEqual({ mode: "stage", stageAfterDone: false, outputFormat: "original", nodeSideUpload: false, ...noBurn });
  });
  it("被锁的方式按 after 写回(绝不把失效的 rolling 存进规则)", () => {
    expect(storedFromForm(facts({ method: "rolling", workers: ["a", "b"] }))).toEqual({ mode: "upload", stageAfterDone: false, outputFormat: "original", nodeSideUpload: false, ...noBurn });
    expect(storedFromForm(facts({ method: "nodeSide", burnDanmu: true })))
      .toEqual({ mode: "upload", stageAfterDone: false, outputFormat: "original", nodeSideUpload: false, burnDanmu: true, burnLivechat: false });
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
      .toEqual({ mode: "upload", stageAfterDone: false, outputFormat: "original", nodeSideUpload: true, burnDanmu: false, burnLivechat: false });
  });
  it("nodeSide 存储结果交给后端判定 → 节点侧上传适用(表单与实际一致)", () => {
    const s = storedFromForm({ ...off, method: "nodeSide" });
    expect(shouldUseNodeSideUpload(
      { uploadMode: s.mode as "upload", steps: { nodeSideUpload: s.nodeSideUpload } } as never,
      { burnDanmu: s.burnDanmu, burnLivechat: s.burnLivechat },
    )).toEqual({ ok: true });
  });
  it("只合成:存储写回实际值 false", () => {
    expect(storedFromForm({ ...off, uploadOn: false })).toEqual({ mode: "stage", stageAfterDone: false, outputFormat: "original", nodeSideUpload: false, ...burnOff });
  });
  it("方式 rolling:存储写回关,避免后端据残留烧录开关判定边录边传「需烧录」", () => {
    expect(storedFromForm({ ...off, method: "rolling" })).toEqual({ mode: "rolling", stageAfterDone: false, outputFormat: "original", nodeSideUpload: false, burnDanmu: false, burnLivechat: false });
  });
  it("录弹幕 + 开烧录:rolling 被锁并回落 after,存储烧录 = 原值 true", () => {
    const on = facts({ method: "rolling", burnDanmu: true, burnLivechat: true });
    expect(deriveConstraints(on).rolling.locked).toBe(true);
    expect(storedFromForm(on)).toEqual({ mode: "upload", stageAfterDone: false, outputFormat: "original", nodeSideUpload: false, ...burnOn });
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

describe("cookieReadyFor — account readiness of the room's own platform (#85)", () => {
  const st = [
    { platform: "douyin", hasSession: false },
    { platform: "bilibili", hasSession: true },
    { platform: "kuaishou", hasSession: false },
  ];
  it("uses the room's platform, not the douyin login", () => {
    expect(cookieReadyFor("bilibili", st, false)).toBe(true);
    expect(cookieReadyFor("kuaishou", st, true)).toBe(false);
    expect(cookieReadyFor("douyin", st, true)).toBe(false); // loaded status wins over the global atom
  });
  it("statuses not loaded: douyin / unknown room fall back to the global douyin status, others are not blocked", () => {
    expect(cookieReadyFor("douyin", null, false)).toBe(false);
    expect(cookieReadyFor(undefined, null, true)).toBe(true);
    expect(cookieReadyFor("bilibili", null, false)).toBe(true);
  });
  it("platform missing from the list behaves like not loaded", () => {
    expect(cookieReadyFor("bilibili", [{ platform: "douyin", hasSession: false }], false)).toBe(true);
  });
});

describe("accountToggleCopy — toggle copy by what the account does (#85)", () => {
  it("douyin: gifts / entries", () => {
    expect(accountToggleCopy({ cookieForStream: false, danmuAvailable: true }))
      .toEqual({ labelKey: "rooms.useCookie", hintKey: "rooms.useCookieHintDouyin" });
  });
  it("stream + danmu (bilibili)", () => {
    expect(accountToggleCopy({ cookieForStream: true, danmuAvailable: true }))
      .toEqual({ labelKey: "roomForm.useCookieStream", hintKey: "rooms.useCookieHintOther" });
  });
  it("stream only, no danmu (kuaishou)", () => {
    expect(accountToggleCopy({ cookieForStream: true, danmuAvailable: false }))
      .toEqual({ labelKey: "roomForm.useCookieStreamOnly", hintKey: "rooms.useCookieHintStreamOnly" });
  });
});

describe("burnVersionsApply — VERSIONS chips only where they can take effect (#284)", () => {
  it("no processing rule → hidden (rule is the only thing that can burn)", () => {
    expect(burnVersionsApply(facts({ hasRule: false }))).toBe(false);
  });
  it("rule disabled → hidden (nothing runs while the rule is paused)", () => {
    expect(burnVersionsApply(facts({ procEnabled: false }))).toBe(false);
  });
  it("enabled rule → shown, for archive and upload alike", () => {
    expect(burnVersionsApply(facts({ uploadOn: true }))).toBe(true);
    expect(burnVersionsApply(facts({ uploadOn: false }))).toBe(true);
  });
});
