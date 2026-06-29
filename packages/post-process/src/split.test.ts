import { describe, it, expect } from "vitest";
import { planSizeSplit, buildSplitArgs, splitToSizeLimit, BILI_FILE_LIMIT_BYTES } from "./split.js";

const GiB = 1024 ** 3;

describe("planSizeSplit", () => {
  it("≤ 上限 → 不切(parts=1)", () => {
    expect(planSizeSplit(15.81 * GiB, 20482, BILI_FILE_LIMIT_BYTES)).toEqual({ parts: 1, segmentTimeSec: 0 });
  });
  it("18.7GB / 16GB 上限 → 切 2 段(复刻今天 danmu)", () => {
    const p = planSizeSplit(18.7 * GiB, 20482, BILI_FILE_LIMIT_BYTES);
    expect(p.parts).toBe(2);
    expect(p.segmentTimeSec).toBe(Math.ceil(20482 / 2));
  });
  it("超限时至少 2 段(margin 防取整超限)", () => {
    // 刚过上限 → margin 使 ceil 仍 ≥2
    expect(planSizeSplit(BILI_FILE_LIMIT_BYTES + 1, 100).parts).toBeGreaterThanOrEqual(2);
  });
  it("40GB → 3 段", () => {
    expect(planSizeSplit(40 * GiB, 30000).parts).toBe(3);
  });
});

describe("buildSplitArgs", () => {
  it("-c copy + segment 按时长切到 %d 模板", () => {
    const s = buildSplitArgs("/o/x.mp4", 10250, "/o/x_part%d.mp4").join(" ");
    expect(s).toContain("-c copy -map 0");
    expect(s).toContain("-f segment -segment_time 10250 -reset_timestamps 1");
    expect(s).toContain("/o/x_part%d.mp4");
  });
});

describe("splitToSizeLimit（注入 fs/ffmpeg）", () => {
  it("≤ 上限 → 原样返回单文件,不调 ffmpeg", async () => {
    let ran = false;
    const r = await splitToSizeLimit("/o/small.mp4", BILI_FILE_LIMIT_BYTES, {
      statSize: () => 10 * GiB,
      probeDuration: async () => 1000,
      run: async () => { ran = true; },
    });
    expect(r).toEqual(["/o/small.mp4"]);
    expect(ran).toBe(false);
  });
  it("超限 → 切 2 段并返回 part 路径", async () => {
    let argv: string[] = [];
    const r = await splitToSizeLimit("/o/big.mp4", BILI_FILE_LIMIT_BYTES, {
      statSize: () => 18.7 * GiB,
      probeDuration: async () => 20482,
      run: async (a) => { argv = a; },
    });
    expect(r).toEqual(["/o/big_part0.mp4", "/o/big_part1.mp4"]);
    expect(argv.join(" ")).toContain("-segment_time 10241");
  });
});
