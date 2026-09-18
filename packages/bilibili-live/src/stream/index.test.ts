import { describe, expect, it } from "vitest";
import { pickStreamUrl } from "./index.js";

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
