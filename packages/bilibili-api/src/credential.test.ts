import { describe, it, expect } from "vitest";
import { biliAccountKey, biliAccountKeyFromCookiesJson, biliupCookieHeader, biliupCsrf } from "./credential.js";

describe("账号键(唯一真理)", () => {
  it("DedeUserID → bilibili:<mid>", () => {
    expect(biliAccountKey("12345")).toBe("bilibili:12345");
    expect(biliAccountKey(12345)).toBe("bilibili:12345");
    expect(biliAccountKey(" 12345 ")).toBe("bilibili:12345");
  });
  it("缺 mid → bilibili:unknown(保守并桶)", () => {
    expect(biliAccountKey(null)).toBe("bilibili:unknown");
    expect(biliAccountKey("  ")).toBe("bilibili:unknown");
    expect(biliAccountKey()).toBe("bilibili:unknown");
  });
  it("从 cookies.json 解析(两种结构)", () => {
    const a = JSON.stringify({ cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "DedeUserID", value: "999" }] } });
    const b = JSON.stringify({ cookies: [{ name: "dedeuserid", value: "888" }] });
    expect(biliAccountKeyFromCookiesJson(a)).toBe("bilibili:999");
    expect(biliAccountKeyFromCookiesJson(b)).toBe("bilibili:888");
  });
  it("坏 JSON / 无该 cookie / 空 → unknown,不抛", () => {
    expect(biliAccountKeyFromCookiesJson("{oops")).toBe("bilibili:unknown");
    expect(biliAccountKeyFromCookiesJson(null)).toBe("bilibili:unknown");
    expect(biliAccountKeyFromCookiesJson(JSON.stringify({ cookies: [{ name: "SESSDATA", value: "x" }] }))).toBe("bilibili:unknown");
  });
});

describe("Cookie 头 / CSRF(登录态解析)", () => {
  it("解析 cookie_info.cookies → 请求头", () => {
    expect(biliupCookieHeader({ cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }] } })).toBe("SESSDATA=x");
    expect(biliupCookieHeader({})).toBeNull();
  });
  it("取 bili_jct 作为 CSRF;缺省 null", () => {
    expect(biliupCsrf({ cookies: [{ name: "bili_jct", value: " abc " }] })).toBe("abc");
    expect(biliupCsrf({ cookies: [{ name: "SESSDATA", value: "x" }] })).toBeNull();
  });
});
