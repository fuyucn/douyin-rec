import { describe, it, expect } from "vitest";
import {
  applyTitleTemplate,
  DEFAULT_TITLE_TEMPLATE,
  formatBiliTitle,
  formatUploadTitle,
  formatPartTitle,
  partTitleToFilename,
  parseSessionStamp,
  resolveOutputStem,
  sanitizeLiveTitle,
  validateLooseTitleTemplate,
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

describe("{title} 直播标题", () => {
  const ctx = {
    sessionBase: "某某_2026-09-12_14-30-05",
    liveTitle: "今晚打打王者!!!",
  };

  it("sanitizeLiveTitle: 标点/表情/空白 → '-',折叠去重,限长", () => {
    expect(sanitizeLiveTitle("今晚打打王者!!!")).toBe("今晚打打王者");
    expect(sanitizeLiveTitle("  a   b  ")).toBe("a-b");
    expect(sanitizeLiveTitle("主播😀好帅")).toBe("主播-好帅");
    expect(sanitizeLiveTitle("")).toBe("");
    expect(sanitizeLiveTitle(null)).toBe("");
    expect(sanitizeLiveTitle("x".repeat(60)).length).toBe(40);
  });

  it("文件名侧(stage stem)用清洗后的标题,保持严格字符集", () => {
    // 直播标题含 '!' → 清洗为空,stem 里不出现非法字符,也不产生空片段
    expect(formatUploadTitle("{name}_{title}_{date}", { ...ctx, liveTitle: "!!!" })).toBe("某某__2026-09-12");
    expect(formatUploadTitle("{name}_{title}_{date}", ctx)).toBe("某某_今晚打打王者_2026-09-12");
  });

  it("B 站标题侧更宽松: 允许空格/标点,只截断到 80 字", () => {
    const long = "标点 与 空格 都在 " + "a".repeat(90);
    const out = formatBiliTitle("{name}_{title}_{date}", { ...ctx, liveTitle: long });
    expect(out.startsWith("某某_标点-与-空格-都在")).toBe(true); // 仍走清洗(替换非法字符)
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("模板不含 {title} 时,两侧渲染一致(不引入行为分叉)", () => {
    const a = formatUploadTitle("{name}_{date}", ctx);
    const b = formatBiliTitle("{name}_{date}", ctx);
    expect(a).toBe(b);
  });

  it("无直播标题时 {title} 渲染为空,不报错", () => {
    const t = formatBiliTitle("{name}_{title}_{date}", { sessionBase: "某某_2026-09-12_14-30-05" });
    expect(t).toBe("某某__2026-09-12");
  });

  it("{title} 是合法占位符(不被判为未知)", () => {
    expect(validateTitleTemplate("{name}_{title}_{date}")).toBeNull();
  });
});

describe("分 P 标题(与稿件名分开)", () => {
  const ctx = { sessionBase: "某某_2026-09-12_14-30-05", liveTitle: "今晚直播" };

  it("formatPartTitle: 未配置模板 → null(不改名,行为不变)", () => {
    expect(formatPartTitle("", ctx)).toBeNull();
    expect(formatPartTitle(undefined, ctx)).toBeNull();
    expect(formatPartTitle("   ", ctx)).toBeNull();
  });

  it("formatPartTitle: {part}/{parts} 渲染", () => {
    expect(formatPartTitle("{name}_P{part}", { ...ctx, partIndex: 2, partTotal: 3 }))
      .toBe("某某_P2");
    expect(formatPartTitle("{name}_{part}of{parts}", { ...ctx, partIndex: 3, partTotal: 3 }))
      .toBe("某某_3of3");
  });

  it("formatPartTitle: 类型后缀自动追加(plain 无 / _danmu / _livechat)", () => {
    expect(formatPartTitle("{name}_{date}", { ...ctx, partIndex: 1, partTotal: 3 }, "plain"))
      .toBe("某某_2026-09-12");
    expect(formatPartTitle("{name}_{date}", { ...ctx, partIndex: 2, partTotal: 3 }, "danmu"))
      .toBe("某某_2026-09-12_danmu");
    expect(formatPartTitle("{name}_{date}", { ...ctx, partIndex: 3, partTotal: 3 }, "livechat"))
      .toBe("某某_2026-09-12_livechat");
    // 与「不配模板」时 stage 默认命名完全一致
    expect(formatPartTitle("{name}_{date}", ctx)).toBe("某某_2026-09-12");
  });

  it("formatPartTitle: 截断时为类型后缀留位,不会切掉 _livechat", () => {
    const longName = "字".repeat(90);
    const out = formatPartTitle("{name}", { sessionBase: `${longName}_2026-09-12_14-30-05`, liveTitle: null }, "livechat")!;
    expect(out.endsWith("_livechat")).toBe(true);
    expect(out.length).toBe(80);
  });

  it("formatPartTitle: 模板已带后缀时不重复追加(幂等)", () => {
    expect(formatPartTitle("{name}_danmu", ctx, "danmu")).toBe("某某_danmu");
    expect(formatPartTitle("{name}_livechat", ctx, "livechat")).toBe("某某_livechat");
  });

  it("partTitleToFilename: 截断时保留类型后缀", () => {
    const out = partTitleToFilename("a".repeat(80) + "_livechat")!;
    expect(out.length).toBe(60);
    expect(out.endsWith("_livechat")).toBe(true);
  });

  it("formatPartTitle: 无分P上下文时 {part}/{parts} 渲染成空", () => {
    expect(formatPartTitle("[{part}/{parts}]{name}", ctx)).toBe("[/]某某");
  });

  it("partTitleToFilename: 清洗成合法文件名,空了返回 null", () => {
    expect(partTitleToFilename("某某 P2")).toBe("某某-P2");
    expect(partTitleToFilename("a/b:c")).toBe("a-b-c");
    expect(partTitleToFilename("!!!")).toBeNull();
    expect(partTitleToFilename("")).toBeNull();
    expect(partTitleToFilename(null)).toBeNull();
  });

  it("partTitleToFilename: 超长截断且不留尾部分隔符", () => {
    const out = partTitleToFilename("a".repeat(80))!;
    expect(out.length).toBe(60);
  });

  it("{part}/{parts} 是合法占位符;{kind} 已移除", () => {
    expect(validateTitleTemplate("{name}_P{part}")).toBeNull();
    expect(validateTitleTemplate("{name}_{parts}")).toBeNull();
    expect(validateTitleTemplate("{name}_{kind}")).toContain("未知占位符");
  });

  it("validateLooseTitleTemplate: 宽松模板也拒绝已移除的 {kind}", () => {
    expect(validateLooseTitleTemplate("{name}_{date} 直播回放")).toBeNull();
    expect(validateLooseTitleTemplate("{name}_P{part}")).toBeNull();
    expect(validateLooseTitleTemplate("{name}_{kind}")).toContain("未知占位符");
    expect(validateLooseTitleTemplate("{name")).toContain("未闭合");
  });

  it("三者独立:文件名严格、稿件名宽松可含空格标点", () => {
    const ctx = { sessionBase: "某某_2026-09-12_14-30-05" };
    // 文件名规则(stage stem 侧):严格字符集
    expect(formatUploadTitle("{name}_{date}_{HH}-{mm}-{ss}", ctx)).toBe("某某_2026-09-12_14-30-05");
    // 稿件名:可含空格(文件名侧会拒绝,这里必须允许)
    expect(formatBiliTitle("{name}_{date} 直播回放", ctx)).toBe("某某_2026-09-12 直播回放");
    expect(() => formatUploadTitle("{name}_{date} 直播回放", ctx)).toThrow();
    // 分P名:可含空格,渲染成宽松标题;类型后缀自动加
    expect(formatPartTitle("P{part} 弹幕版", { ...ctx, partIndex: 2, partTotal: 3 }, "danmu"))
      .toBe("P2 弹幕版_danmu");
  });
});
