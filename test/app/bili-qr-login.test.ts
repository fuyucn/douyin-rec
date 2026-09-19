import { describe, it, expect } from "vitest";
import {
  BiliQrLogin,
  biliQrState,
  harvestBiliSetCookies,
} from "../../packages/app/src/login/bili-qr-login.js";

describe("BiliQrLogin helpers", () => {
  it("maps B站二维码状态码", () => {
    expect(biliQrState(0)).toBe("confirmed");
    expect(biliQrState(86090)).toBe("scanned");
    expect(biliQrState(86101)).toBe("pending");
    expect(biliQrState(86038)).toBe("expired");
    expect(biliQrState(999)).toBeNull();
  });

  it("从 Set-Cookie 提取第一方 Cookie", () => {
    expect(harvestBiliSetCookies([
      "SESSDATA=sess; Path=/; HttpOnly",
      "bili_jct=csrf; Path=/",
      "DedeUserID=123; Path=/",
      "SESSDATA=again; Path=/",
    ])).toBe("SESSDATA=again; bili_jct=csrf; DedeUserID=123");
  });
});

describe("BiliQrLogin", () => {
  it("生成二维码并返回 B站扫码状态", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/qrcode/generate")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { url: "https://example.test/qr", qrcode_key: "key-1" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { code: 86090, message: "扫码成功" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const login = new BiliQrLogin({ fetch: fetchImpl, qrPng: async (url) => {
      expect(url).toBe("https://example.test/qr");
      return "base64-png";
    } });
    expect(await login.start()).toEqual({ qrPng: "base64-png" });
    expect(await login.poll()).toEqual({ state: "scanned" });
    expect(calls[0]).toContain("/qrcode/generate");
    expect(calls[1]).toContain("/qrcode/poll");
  });
});
