import { describe, expect, it } from "vitest";
import {
  classifyFfmpegLine,
  formatScanLine,
  formatOutputVerdict,
  parseFfmpegIssues,
  parseIntegrityAlerts,
  parseIntegrityWarnings,
  type MediaScanResult,
} from "./integrity.js";

const result = (p: Partial<MediaScanResult>): MediaScanResult => ({
  ok: true, errorCount: 0, problemCount: 0, infoCount: 0, samples: [], infoSamples: [], ...p,
});

describe("integrity — 分级判定(纯函数)", () => {
  it("重复时间戳 = ignore(实测是扫描管线伪影:-c copy/-f rawvideo 路径均 0 条 → 完全不统计)", () => {
    const line = "Application provided invalid, non monotonically increasing dts to muxer in stream 0: 22528 >= 22528";
    expect(classifyFfmpegLine(line)).toBe("ignore");
  });

  it("跳尾扫描的起始伪影 = info,但全片扫描时同样文案 = problem", () => {
    // 已用完好 TS 对照验证:-sseof 落到非关键帧必然报这两条,与文件好坏无关。
    // Missing reference picture 是同一家族(2026-09-28 实测:段 1~4 各 2~3 条,而成品全片扫 0 条)。
    for (const msg of ["co located POCs unavailable", "mmco: unref short failure", "Missing reference picture, default is 0"]) {
      expect(classifyFfmpegLine(msg, { seekTail: true })).toBe("info");
      expect(classifyFfmpegLine(msg, { seekTail: false })).toBe("problem");
    }
  });

  it("真正的解码损坏 = problem", () => {
    expect(classifyFfmpegLine("cbp too large (3199971767) at 32 16")).toBe("problem");
    expect(classifyFfmpegLine("error while decoding MB 32 16")).toBe("problem");
    expect(classifyFfmpegLine("Invalid data found when processing input")).toBe("problem");
  });

  it("parseFfmpegIssues:problem 计数、ignore 完全不计入、各自取样例", () => {
    const stderr = [
      "[h264 @ 0xaaa] cbp too large (3199971767) at 32 16",
      "[h264 @ 0xaaa] error while decoding MB 32 16",
      "[mpegts @ 0xbbb] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 1 >= 1",
      "[mpegts @ 0xbbb] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 2 >= 2",
    ].join("\n");
    const r = parseFfmpegIssues(stderr);
    expect(r.errorCount).toBe(2);   // dts 行不统计
    expect(r.problemCount).toBe(2);
    expect(r.infoCount).toBe(0);
    expect(r.ignored).toBe(2);
    expect(r.samples).toEqual(["cbp too large (3199971767) at 32 16", "error while decoding MB 32 16"]);
    expect(r.infoSamples).toEqual([]);
  });
});

describe("integrity — 结论行格式(CLI/hub 合同)", () => {
  it("全干净 → ✓", () => {
    expect(formatScanLine("末段 a.ts", result({}))).toBe("[integrity] ✓ 末段 a.ts: 解码正常");
  });

  it("只有 info → 仍是 ✓,附注说明,不触发 hub 告警", () => {
    const line = formatScanLine("末段 a.ts", result({ errorCount: 3, infoCount: 3 }));
    expect(line.startsWith("[integrity] ✓")).toBe(true);
    expect(line).toContain("另有 3 条跳尾提示");
    expect(parseIntegrityWarnings(line)).toEqual([]);
  });

  it("真问题 → ⚠ + 样例 + info 计数", () => {
    const line = formatScanLine("末段 a.ts", result({
      ok: false, errorCount: 5, problemCount: 2, infoCount: 3, samples: ["cbp too large (3199971767) at 32 16"],
    }));
    expect(line).toContain("[integrity] ⚠ 末段 a.ts: 2 处解码错误");
    expect(line).toContain("示例: cbp too large");
    expect(line).toContain("另有 3 条无画面影响的提示");
    expect(parseIntegrityWarnings(line)).toHaveLength(1);
  });

  it("扫描失败(ffmpeg 起不来/超时)单独标注,不与「解码正常」混淆", () => {
    const line = formatScanLine("段 1/3 x.ts", result({ ok: false, failed: true, samples: ["扫描超时被中止"] }));
    expect(line).toContain("扫描失败");
    expect(line).toContain("扫描超时被中止");
  });

  it("parseIntegrityWarnings:只挑 ⚠ 行(hub 管线据此告警),✓/普通输出忽略", () => {
    const output = [
      "[merge] seg: 3 段 → out.mp4",
      "[integrity] ✓ 末段 a.ts: 解码正常(另有 5 条跳尾提示,无画面影响)",
      "[integrity] ⚠ 末段 c.ts: 2 处解码错误(示例: cbp too large)",
      "[merge] 完成: /x/out.mp4",
    ].join("\n");
    expect(parseIntegrityWarnings(output)).toEqual(["[integrity] ⚠ 末段 c.ts: 2 处解码错误(示例: cbp too large)"]);
  });

  it("成品结论分级:0 处不打印、1 处只提示(ℹ)、≥2 处才 ❗ 告警", () => {
    expect(formatOutputVerdict(result({}))).toBe("");
    const one = formatOutputVerdict(result({ ok: false, problemCount: 1, errorCount: 1, samples: ["error while decoding MB 8 23"] }));
    expect(one.startsWith("[integrity] ℹ")).toBe(true);
    expect(parseIntegrityAlerts(one)).toEqual([]);
    const two = formatOutputVerdict(result({ ok: false, problemCount: 2, errorCount: 2, samples: ["cbp too large"] }));
    expect(two.startsWith("[integrity] ❗")).toBe(true);
    expect(parseIntegrityAlerts([one, two].join("\n"))).toHaveLength(1);
  });
});
