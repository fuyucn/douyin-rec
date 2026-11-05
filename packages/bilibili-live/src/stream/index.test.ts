import { afterEach, describe, expect, it, vi } from "vitest";
import { getStream, pickStreamUrl } from "./index.js";

describe("pickStreamUrl", () => {
  it("prefers the highest actual current_qn", () => {
    const info = {
      playurl: {
        stream: [
          {
            protocol_name: "http_stream",
            format: [{
              format_name: "flv",
              codec: [{
                codec_name: "avc",
                current_qn: 250,
                base_url: "/low.flv",
                url_info: [{ host: "https://low.example", extra: "?q=low" }],
              }],
            }],
          },
          {
            protocol_name: "http_hls",
            format: [{
              format_name: "ts",
              codec: [{
                codec_name: "avc",
                current_qn: 10000,
                base_url: "/high.m3u8",
                url_info: [{ host: "https://high.example", extra: "?q=high" }],
              }],
            }],
          },
        ],
      },
    };
    expect(pickStreamUrl(info)).toBe("https://high.example/high.m3u8?q=high");
  });
});

describe("getStream: live but no playable URL (issue #476)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  /** Mock every bilibili API call with the given get_info / getRoomPlayInfo payloads. */
  function mockApi(info: Record<string, unknown>, play: Record<string, unknown>): void {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      let data: Record<string, unknown> | null = null;
      if (url.includes("/room/v1/Room/get_info")) data = info;
      else if (url.includes("getRoomPlayInfo")) data = play;
      if (!data) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, json: async () => ({ code: 0, data }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("live_status=1 but the stream list is empty → living true, no url, reason set", async () => {
    mockApi(
      { room_id: 42, live_status: 1, uid: 7, title: "测试直播", live_time: "2026-11-04 10:00:00" },
      { live_status: 1, playurl_info: { playurl: { stream: [] } } },
    );
    const s = await getStream("42", "10000");
    expect(s.living).toBe(true);
    expect(s.url).toBeUndefined();
    expect(s.unplayableReason?.length).toBeGreaterThan(0);
    expect(s.unplayableReason).toContain("可播放地址");
  });

  it("live_status=0 → still reported offline without a reason", async () => {
    mockApi({ room_id: 42, live_status: 0, uid: 7, title: "", live_time: "0000-00-00 00:00:00" }, {});
    const s = await getStream("42", "10000");
    expect(s.living).toBe(false);
    expect(s.unplayableReason).toBeUndefined();
  });
});
