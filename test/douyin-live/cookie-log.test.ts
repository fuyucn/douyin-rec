import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

// douyin_api.js 是 vendored 副本且顶层 import 无法在 vitest 加载(sm-crypto/ESM 坑),按 issue #425
// 用文本断言钉住:错误模板不得把登录串值插进消息。douyin_api/stream 改动必须过这道闸。
describe("取流错误消息不携带登录串 (issue #425)", () => {
  it("douyin_api.js 的 assert 模板不含登录串插值", () => {
    const src = read("packages/douyin-live/src/stream/douyin_api.js");
    expect(src).not.toMatch(/cookies:\s*\$\{cookies\}/);
    expect(src).toContain("登录串: ${cookies ? `有(${cookies.length})` : \"无\"}");
  });

  it("loadBalancer 的日志出口对登录串字段脱敏", () => {
    const src = read("packages/douyin-live/src/stream/loadBalancer/loadBalancer.js");
    expect(src.match(/console\.warn/g)?.length).toBe(2);
    expect((src.match(/已隐去/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/console\.warn\([^)]*lastError\.message\);/);
    expect(src).not.toMatch(/Next retry at: \$\{\(new Date\(/);
  });
});
