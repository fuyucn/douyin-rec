/**
 * 守护:所有「解析不到稿件号」的抛出点都必须带 `PLAIN_NO_BV_MARKER`。
 *
 * 为什么需要它:`isPlainNoBv()` 是建稿「结果不确定」的唯一判据。少一个抛错点,
 * 那条路径的失败就会被上层当成普通错误并重试 → 重复建稿。这类遗漏靠人眼 grep 抓不住
 * (gpt-6.1-sol 第三轮复核就抓到第四个漏点),所以用断言钉住。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLAIN_NO_BV_MARKER, isPlainNoBv } from "@drec/core";

const SRC = fileURLToPath(new URL("../../packages/processors/src/run-biliup.ts", import.meta.url));

describe("biliup 的稿件号解析失败标记", () => {
  it("run-biliup.ts 里每一处「解析不到 BV」的抛错都带标记", () => {
    const text = readFileSync(SRC, "utf-8");
    // 找齐所有抛错点(可能跨行,所以按「throw new Error(`」到反引号结束粗切)。
    const throws = text.split("throw new Error(`").slice(1).map((s) => s.split("`")[0]);
    const noBv = throws.filter((t) => t.includes("解析不到 BV"));
    expect(noBv.length).toBeGreaterThanOrEqual(4);
    const missing = noBv.filter((t) => !t.includes("PLAIN_NO_BV_MARKER"));
    expect(missing).toEqual([]);
  });

  it("标记能穿过 isPlainNoBv：带标记的措辞变化仍被识别", () => {
    expect(isPlainNoBv(new Error(`${PLAIN_NO_BV_MARKER} 换了一种说法`))).toBe(true);
    expect(isPlainNoBv(new Error("解析不到 BV"))).toBe(false);
  });
});
