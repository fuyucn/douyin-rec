import { describe, it, expect } from "vitest";
// sanitizePathSegment 随 4 个录制器包合并为通用录制器(@drec/record-engine)后移入该包。
// 引包入口即可(record-engine 是纯 node 依赖,无 sm-crypto)。
import { sanitizePathSegment } from "@drec/record-engine";

describe("sanitizePathSegment", () => {
  it("keeps CJK / letters / digits / space / - / _", () => {
    expect(sanitizePathSegment("一勺小苏打")).toBe("一勺小苏打");
    expect(sanitizePathSegment("Anchor_01 - test")).toBe("Anchor_01 - test");
  });

  it("strips path-illegal chars (/ \\ : * ? \" < > |)", () => {
    expect(sanitizePathSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
  });

  it("strips control chars and collapses whitespace", () => {
    // \t (0x09) is a control char → removed (joins b+c); runs of spaces collapse to one
    expect(sanitizePathSegment("a b\tc   d")).toBe("a bc d");
    // a plain space (0x20) is kept
    expect(sanitizePathSegment("x y")).toBe("x y");
  });

  it("returns empty when nothing usable remains", () => {
    expect(sanitizePathSegment("///")).toBe("");
    expect(sanitizePathSegment("   ")).toBe("");
  });
});
