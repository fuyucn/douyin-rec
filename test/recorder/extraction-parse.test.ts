/**
 * extraction-parse.test.ts — 守"取流相邻"的纯解析函数(无网络):
 * 设备 encoder 映射、sdk_params→流信息、房间 URL→slug。
 * 这些是 a_bogus 取流结果的下游解析;getStream 本身需真网络无法单测,但解析层可用 fixture 锁住。
 */
import { describe, it, expect } from "vitest";
import { mapEncoder, streamInfoLine } from "../../packages/ffmpeg-recorder-extra/src/index.js";
import { extractRoomSlug } from "../../packages/douyin-live/src/index.js";

describe("mapEncoder — FLV encoder 标签 → 推流设备", () => {
  it("映射已知推流端", () => {
    expect(mapEncoder("bytedmediasdkios/1.0")).toBe("iOS（iPhone/iPad）");
    expect(mapEncoder("bytedmediasdk_android")).toBe("Android");
    expect(mapEncoder("obs-studio 30.0")).toBe("OBS");
    expect(mapEncoder("FMLE/3.0")).toBe("Flash Media Encoder");
    expect(mapEncoder("XSplitBroadcaster")).toBe("XSplit");
  });
  it("iOS 优先于裸 bytedmediasdk(顺序敏感)", () => {
    expect(mapEncoder("bytedmediasdkios")).toBe("iOS（iPhone/iPad）"); // 含 'bytedmediasdk' 但应判 iOS
  });
  it("未知 → 取冒号前首段;空 → undefined", () => {
    expect(mapEncoder("WeirdEncoder:v2")).toBe("WeirdEncoder");
    expect(mapEncoder("")).toBeUndefined();
  });
});

describe("streamInfoLine — sdk_params → 流信息串", () => {
  const mk = (sdk: unknown) => ({ sources: [{ streamMap: { origin: { main: { sdk_params: JSON.stringify(sdk) } } } }] });
  it("拼分辨率/帧率/码率(k)/编码(大写)", () => {
    const r = streamInfoLine(mk({ VCodec: "h264", vbitrate: 2875000, resolution: "1088x1920", fps: 21 }), "origin");
    expect(r).toBe("1088x1920 | 21fps | 码率 2875k | H264");
  });
  it("缺字段时跳过对应段", () => {
    expect(streamInfoLine(mk({ resolution: "720x1280" }), "origin")).toBe("720x1280");
  });
  it("无 sdk_params → undefined;qualityKey 缺失回落 origin", () => {
    expect(streamInfoLine({ sources: [{ streamMap: {} }] }, "origin")).toBeUndefined();
    const r = streamInfoLine(mk({ resolution: "540x960", fps: 15 }), "hd"); // hd 不存在 → 回落 origin
    expect(r).toBe("540x960 | 15fps");
  });
});

describe("extractRoomSlug — 房间 URL → web_rid", () => {
  it("从完整 URL 取数字 id", () => {
    expect(extractRoomSlug("https://live.douyin.com/105633855291")).toBe("105633855291");
    expect(extractRoomSlug("https://live.douyin.com/105633855291?x=1")).toBe("105633855291");
  });
  it("裸房间号原样;短链原样(由 resolveShortURL 另解)", () => {
    expect(extractRoomSlug("105633855291")).toBe("105633855291");
    expect(extractRoomSlug("https://v.douyin.com/abc/")).toBe("https://v.douyin.com/abc/");
  });
});
