/** issue #137:输出格式注册表 / 白名单 / 生效判定 / 扩展名识别(core 唯一真理源)。 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_OUTPUT_FORMAT, OUTPUT_FORMATS, STAGE_CONTAINERS, VIDEO_EXTS,
  effectiveStageFormat, isVideoFileName, outputFormatLocked, parseOutputFormat, readOutputFormat,
  segmentIndexOf, sessionBaseOf, stageContainerOfPath, stageExt, stampedSessionBaseOf, stripVideoExt,
  isVideoSegment,
} from "@drec/core";

describe("effectiveStageFormat", () => {
  it("缺省 / original → mp4(现状不变),三种上传形态都一样", () => {
    for (const mode of ["stage", "upload", "rolling", undefined] as const) {
      expect(effectiveStageFormat(undefined, mode)).toBe("mp4");
      expect(effectiveStageFormat("original", mode)).toBe("mp4");
    }
  });
  it("存档(stage)按所选;mp4 / mkv 各自生效", () => {
    expect(effectiveStageFormat("mkv", "stage")).toBe("mkv");
    expect(effectiveStageFormat("mp4", "stage")).toBe("mp4");
    expect(effectiveStageFormat("mkv", undefined)).toBe("mkv");
  });
  it("投稿(upload / rolling,含节点侧)一律强制 mp4,选项被锁", () => {
    expect(effectiveStageFormat("mkv", "upload")).toBe("mp4");
    expect(effectiveStageFormat("mkv", "rolling")).toBe("mp4");
    expect(outputFormatLocked("upload")).toBe(true);
    expect(outputFormatLocked("rolling")).toBe(true);
    expect(outputFormatLocked("stage")).toBe(false);
  });
});

describe("白名单校验", () => {
  it("缺省 → original;白名单内原样返回", () => {
    expect(parseOutputFormat(undefined)).toBe("original");
    expect(parseOutputFormat(null)).toBe("original");
    for (const f of OUTPUT_FORMATS) expect(parseOutputFormat(f)).toBe(f);
  });
  it.each(["avi", "MKV", "", " mp4", "mp4 ", 1, true, {}])("拒绝白名单外的值 %j", (bad) => {
    expect(() => parseOutputFormat(bad)).toThrow(/outputFormat/);
  });
  it("readOutputFormat 宽松:非法值回落 original,不抛", () => {
    expect(readOutputFormat("webm")).toBe(DEFAULT_OUTPUT_FORMAT);
    expect(readOutputFormat(undefined)).toBe("original");
    expect(readOutputFormat("mkv")).toBe("mkv");
  });
});

describe("注册表 ffmpeg 封装参数", () => {
  it("mp4:时基 90000 + faststart(现状);mkv:不带任何 mov muxer 私有参数", () => {
    expect(STAGE_CONTAINERS.mp4.remuxArgs).toEqual(["-video_track_timescale", "90000", "-movflags", "+faststart"]);
    expect(STAGE_CONTAINERS.mp4.finalizeArgs).toEqual(["-movflags", "+faststart"]);
    expect(STAGE_CONTAINERS.mkv.remuxArgs).toEqual([]);
    expect(STAGE_CONTAINERS.mkv.finalizeArgs).toEqual([]);
    expect(stageExt("mkv")).toBe(".mkv");
    expect(stageExt("mp4")).toBe(".mp4");
  });
  it("按路径扩展名反查;未登记扩展名回落 mp4", () => {
    expect(stageContainerOfPath("/a/b.MKV").ext).toBe(".mkv");
    expect(stageContainerOfPath("/a/b.mp4").ext).toBe(".mp4");
    expect(stageContainerOfPath("/a/b.xyz").ext).toBe(".mp4");
  });
});

describe("扩展名识别(ts/flv/mp4/mkv 统一)", () => {
  it("VIDEO_EXTS 含 mkv 与已有 mp4", () => {
    expect([...VIDEO_EXTS].sort()).toEqual([".flv", ".mkv", ".mp4", ".ts"]);
  });
  it("isVideoFileName / isVideoSegment:认 mkv,xml/ass 恒不是视频", () => {
    for (const n of ["a.ts", "a.FLV", "a.mp4", "a.MKV"]) {
      expect(isVideoFileName(n)).toBe(true);
      expect(isVideoSegment(n)).toBe(true);
    }
    for (const n of ["a.xml", "a.ass", "a.json", "mkv"]) {
      expect(isVideoFileName(n)).toBe(false);
      expect(isVideoSegment(n)).toBe(false);
    }
  });
  it("stripVideoExt 只剥视频扩展名", () => {
    expect(stripVideoExt("x_000.mkv")).toBe("x_000");
    expect(stripVideoExt("x.xml")).toBe("x.xml");
  });
  it("会话基名 / 段号 / 锚定基名都认 mkv", () => {
    expect(sessionBaseOf("主播_2026-06-11_15-01-27_001.mkv")).toBe("主播_2026-06-11_15-01-27");
    expect(segmentIndexOf("主播_2026-06-11_15-01-27_007.mkv")).toBe(7);
    expect(stampedSessionBaseOf("主播_2026-06-11_15-01-27_001.mkv")).toBe("主播_2026-06-11_15-01-27");
    expect(stampedSessionBaseOf("主播_2026-06-11_15-01-27.mp4")).toBe("主播_2026-06-11_15-01-27");
    expect(stampedSessionBaseOf("无时间戳.mkv")).toBeUndefined();
  });
});
