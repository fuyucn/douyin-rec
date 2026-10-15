import { describe, it, expect } from "vitest";
import { previewPartTitles, previewTitle } from "../../packages/web/src/lib/title-preview";

describe("previewTitle — 投稿标题模板预览", () => {
  it("空模板回落默认 {name}_{date}", () => {
    expect(previewTitle("  ", "主播")).toBe("主播_2026-09-12");
  });
  it("时间 token 与未知 token(原样保留)", () => {
    expect(previewTitle("{name}_{date}_{HH}-{mm}-{ss}", "A")).toBe("A_2026-09-12_14-30-05");
    expect(previewTitle("{name}_{nope}", "A")).toBe("A_{nope}");
  });
  it("未给分P样例时 {part}/{parts} 渲染为空(稿件名模板)", () => {
    expect(previewTitle("{name}_P{part}of{parts}", "A")).toBe("A_Pof");
  });
  it("分P样例按类型追加后缀:plain 无、danmu/_livechat", () => {
    expect(previewTitle("{name}_P{part}", "A", { part: "1", parts: "3", kind: "plain" })).toBe("A_P1");
    expect(previewTitle("{name}_P{part}", "A", { part: "2", parts: "3", kind: "danmu" })).toBe("A_P2_danmu");
    expect(previewTitle("{name}_P{part}", "A", { part: "3", parts: "3", kind: "livechat" })).toBe("A_P3_livechat");
  });
  it("previewPartTitles 给出 P1/P2/P3 三个分P名", () => {
    expect(previewPartTitles("{name}_P{part}", "A")).toBe("A_P1 / A_P2_danmu / A_P3_livechat");
  });
});
