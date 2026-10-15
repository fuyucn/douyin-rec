/** issue #137:规则模块的 outputFormat 联动(投稿锁定为 mp4 / 存储写回 / 往返 / 流程摘要)。 */
import { describe, it, expect } from "vitest";
import {
  deriveConstraints, flowSummary, outputFormatFromStored, shownOutputFormat, storedFromForm, type FormFacts,
} from "../../packages/web/src/lib/room-form-rules";

const facts = (over: Partial<FormFacts> = {}): FormFacts => ({
  danmu: true, danmuAvailable: true, cookieReady: true, cookieForStream: false,
  procEnabled: true, uploadOn: false, method: "after", tsDirect: false, mergeSegments: true,
  burnDanmu: false, burnLivechat: false, clKeepArchive: true, outputFormat: "original",
  workers: ["local"], hasRule: true,
  ...over,
});

describe("outputFormat 锁定", () => {
  it("不投稿(存档):不锁,下拉显示所选值", () => {
    const f = facts({ uploadOn: false, outputFormat: "mkv" });
    expect(deriveConstraints(f).outputFormat.locked).toBe(false);
    expect(shownOutputFormat(f)).toBe("mkv");
  });
  it("投稿:锁定,原因 key 指向新文案,下拉恒显示 mp4", () => {
    const f = facts({ uploadOn: true, outputFormat: "mkv" });
    const c = deriveConstraints(f).outputFormat;
    expect(c).toEqual({ locked: true, reasonKey: "roomForm.lock.outputFormatUpload" });
    expect(shownOutputFormat(f)).toBe("mp4");
  });
  it("三种投稿方式(收播后 / 节点侧 / 边录边传)都锁", () => {
    for (const method of ["after", "nodeSide", "rolling"] as const) {
      expect(deriveConstraints(facts({ uploadOn: true, method })).outputFormat.locked).toBe(true);
    }
  });
});

describe("存储写回(统一出口 storedFromForm)", () => {
  it("存档:原样写回所选格式(original / mp4 / mkv)", () => {
    for (const outputFormat of ["original", "mp4", "mkv"] as const) {
      expect(storedFromForm(facts({ uploadOn: false, outputFormat })).outputFormat).toBe(outputFormat);
    }
  });
  it("投稿:mkv 写回 mp4(被锁);original 保持 original(同为 mp4,不制造无谓改动)", () => {
    expect(storedFromForm(facts({ uploadOn: true, outputFormat: "mkv" })).outputFormat).toBe("mp4");
    expect(storedFromForm(facts({ uploadOn: true, outputFormat: "mp4" })).outputFormat).toBe("mp4");
    expect(storedFromForm(facts({ uploadOn: true, outputFormat: "original" })).outputFormat).toBe("original");
  });
  it("读入缺省 / 老数据 / 非法值 → original;往返不丢字段", () => {
    expect(outputFormatFromStored(undefined)).toBe("original");
    expect(outputFormatFromStored(null)).toBe("original");
    expect(outputFormatFromStored("avi")).toBe("original");
    for (const v of ["original", "mp4", "mkv"] as const) {
      const f = facts({ outputFormat: outputFormatFromStored(v) });
      expect(outputFormatFromStored(storedFromForm(f).outputFormat)).toBe(v);
    }
  });
});

describe("流程摘要", () => {
  const keys = (f: FormFacts): string[] => flowSummary(f, true).map((s) => s.key);
  it("存档形态末尾带所选格式;original 不带(与现状一致)", () => {
    const steps = flowSummary(facts({ outputFormat: "mkv" }), true);
    expect(steps[steps.length - 1]).toEqual({ key: "roomForm.flow.format", on: false, vars: { fmt: "MKV" } });
    expect(keys(facts({ outputFormat: "original" }))).not.toContain("roomForm.flow.format");
  });
  it("投稿形态不带格式(即使存的是 mkv)", () => {
    expect(keys(facts({ uploadOn: true, outputFormat: "mkv" }))).not.toContain("roomForm.flow.format");
  });
});
