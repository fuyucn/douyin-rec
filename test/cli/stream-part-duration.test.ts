/**
 * 0 落盘流式直传的分 P 时长(plans/039):分 P 大小参考任务设置的录制时段长度。
 * 显式 --stream-upload-sec 优先;否则用任务的 --segment;0/缺失/非法 = 只用字节兜底。
 */
import { describe, it, expect } from "vitest";
import { streamPartMaxMs } from "../../packages/cli/src/stream-part-duration.js";

describe("streamPartMaxMs", () => {
  it("未给 stream-upload-sec 时用任务的 --segment(1800s → 1800_000ms)", () => {
    expect(streamPartMaxMs(undefined, "1800")).toBe(1_800_000);
  });
  it("显式 stream-upload-sec 优先于 --segment", () => {
    expect(streamPartMaxMs("45", "1800")).toBe(45_000);
    expect(streamPartMaxMs("45", undefined)).toBe(45_000);
  });
  it("segment=0(不分段)或缺失 → 只用字节兜底(undefined)", () => {
    expect(streamPartMaxMs(undefined, "0")).toBeUndefined();
    expect(streamPartMaxMs(undefined, undefined)).toBeUndefined();
  });
  it("非法/负数 → 不产生时长上限", () => {
    expect(streamPartMaxMs(undefined, "abc")).toBeUndefined();
    expect(streamPartMaxMs("0", "1800")).toBeUndefined();
    expect(streamPartMaxMs("-5", "1800")).toBeUndefined();
  });
});
