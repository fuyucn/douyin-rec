import { describe, it, expect } from "vitest";
import {
  applyTitleTemplate,
  DEFAULT_TITLE_TEMPLATE,
  formatUploadTitle,
  parseSessionStamp,
  resolveOutputStem,
  validateTitleTemplate,
  zonedStamp,
} from "./title-template.js";

describe("parseSessionStamp", () => {
  it("完整 {name}_{date}_{HH-MM-SS}", () => {
    expect(parseSessionStamp("某某_2026-09-12_14-30-05")).toEqual({
      name: "某某", date: "2026-09-12", hh: "14", mm: "30", ss: "05", hasTime: true,
    });
  });
  it("旧格式无秒", () => {
    expect(parseSessionStamp("z_2026-06-27_07-54")?.hasTime).toBe(true);
    expect(parseSessionStamp("z_2026-06-27_07-54")?.ss).toBe("00");
  });
  it("仅日期", () => {
    expect(parseSessionStamp("主播名_2026-06-27")).toMatchObject({
      name: "主播名", date: "2026-06-27", hasTime: false,
    });
  });
  it("名字可含下划线", () => {
    expect(parseSessionStamp("一勺_小苏打_2026-06-27_07-54-33")?.name).toBe("一勺_小苏打");
  });
});

describe("zonedStamp", () => {
  const ms = Date.parse("2026-09-12T06:30:05Z");
  it("上海 = 当天 14:30:05", () => {
    expect(zonedStamp(ms, "Asia/Shanghai")).toEqual({
      date: "2026-09-12", hh: "14", mm: "30", ss: "05",
    });
  });
  it("洛杉矶 = 前一天 23:30:05", () => {
    expect(zonedStamp(ms, "America/Los_Angeles")).toEqual({
      date: "2026-09-11", hh: "23", mm: "30", ss: "05",
    });
  });
});

describe("formatUploadTitle", () => {
  const ctx = { sessionBase: "某某_2026-09-12_14-30-05" };
  it("默认 {name}_{date}", () => {
    expect(formatUploadTitle(undefined, ctx)).toBe("某某_2026-09-12");
    expect(formatUploadTitle("  ", ctx)).toBe("某某_2026-09-12");
    expect(DEFAULT_TITLE_TEMPLATE).toBe("{name}_{date}");
  });
  it("带开播时分秒", () => {
    expect(formatUploadTitle("{name}_{date}_{HHmmss}", ctx)).toBe("某某_2026-09-12_143005");
    expect(formatUploadTitle("{name}_{datetime}", ctx)).toBe("某某_2026-09-12_14-30-05");
  });
  it("可自由拼 HH-mm / 年月日零件(对齐 biliLive-tools)", () => {
    expect(formatUploadTitle("{name}_{date}_{HH}-{mm}", ctx)).toBe("某某_2026-09-12_14-30");
    expect(formatUploadTitle("{name}_{yyyy}-{MM}-{dd}_{HH}-{mm}-{ss}", ctx)).toBe("某某_2026-09-12_14-30-05");
    expect(formatUploadTitle("{user}_{year}{month}{day}_{hour}-{min}", ctx)).toBe("某某_20260912_14-30");
  });
  it("固定词 + 占位符", () => {
    expect(formatUploadTitle("【回放】_{name}_{date}_{HHmm}", ctx)).toBe("【回放】_某某_2026-09-12_1430");
  });
  it("文件名戳优先于 startMs 时区", () => {
    const ms = Date.parse("2026-09-12T06:30:05Z");
    expect(formatUploadTitle("{name}_{date}_{time}", {
      sessionBase: "某某_2026-09-12_14-30-05",
      startMs: ms,
      timeZone: "America/Los_Angeles",
    })).toBe("某某_2026-09-12_14-30-05");
  });
  it("仅日期的 sessionBase 用 startMs 补时分秒", () => {
    const ms = Date.parse("2026-09-12T06:30:05Z");
    expect(formatUploadTitle("{name}_{date}_{HHmmss}", {
      sessionBase: "某某_2026-09-12",
      startMs: ms,
      timeZone: "Asia/Shanghai",
    })).toBe("某某_2026-09-12_143005");
  });
  it("超长抛错", () => {
    const long = "{name}_" + "啊".repeat(80);
    expect(() => formatUploadTitle(long, ctx)).toThrow(/超过 80/);
  });
});

describe("validateTitleTemplate", () => {
  it("空 / 默认合法", () => {
    expect(validateTitleTemplate("")).toBeNull();
    expect(validateTitleTemplate("{name}_{date}")).toBeNull();
    expect(validateTitleTemplate("{name}_{date}_{HHmmss}")).toBeNull();
    expect(validateTitleTemplate("{name}_{date}_{HH}-{mm}")).toBeNull();
    expect(validateTitleTemplate("【回放】_{name}")).toBeNull();
  });
  it("拒绝冒号空格未知占位符", () => {
    expect(validateTitleTemplate("{name}_{date}_{hh}:{mm}")).toMatch(/非法字符/);
    expect(validateTitleTemplate("{name} {date}")).toMatch(/非法字符/);
    expect(validateTitleTemplate("{name}_{foo}")).toMatch(/未知占位符/);
  });
});

describe("resolveOutputStem", () => {
  it("已有 stem 不再渲染", () => {
    expect(resolveOutputStem({
      template: "{name}_{date}_{HHmmss}",
      sessionBase: "某某_2026-09-12_14-30-05",
      existingStem: "旧_2026-09-12",
    })).toBe("旧_2026-09-12");
  });
});

describe("applyTitleTemplate", () => {
  it("未知 token 原样保留(预览可见)", () => {
    const parts = { name: "a", date: "2026-01-01", hh: "01", mm: "02", ss: "03" };
    expect(applyTitleTemplate("{name}_{foo}", parts)).toBe("a_{foo}");
  });
});
