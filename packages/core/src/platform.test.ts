import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetPlatforms,
  defaultPlatform,
  getPlatform,
  listPlatforms,
  matchPlatform,
  platformForRoom,
  registerPlatform,
  type Platform,
} from "./platform.js";

const fakePlatform = (id: string, matchUrl: Platform["matchUrl"] = () => false): Platform => ({
  id,
  matchUrl,
  roomToUrl: (room) => room,
  extractRoomSlug: (room) => room,
  fetchAnchorName: async () => null,
  getStream: async () => ({ living: false }),
  getLiving: async () => false,
  defaultQuality: "default",
  defaultEngine: "fake",
  qualities: ["default"],
  engines: ["fake"],
});

describe("直播平台注册表", () => {
  beforeEach(() => _resetPlatforms());

  it("拒绝空 id 与重复 id，且不覆盖已有实现", () => {
    expect(() => registerPlatform(fakePlatform(""))).toThrow("id 不能为空");
    expect(() => registerPlatform(fakePlatform("  "))).toThrow("id 不能为空");

    const original = fakePlatform("alpha");
    registerPlatform(original);
    expect(() => registerPlatform(fakePlatform("alpha"))).toThrow("重复注册: alpha");
    expect(getPlatform("alpha")).toBe(original);
    expect(listPlatforms()).toEqual([original]);
  });

  it("默认平台唯一，并将被选中的默认平台列在列表首位", () => {
    const first = fakePlatform("first");
    const chosen = fakePlatform("chosen");
    registerPlatform(first);
    registerPlatform(chosen, { default: true });

    expect(defaultPlatform()).toBe(chosen);
    expect(listPlatforms()).toEqual([chosen, first]);
    expect(() => registerPlatform(fakePlatform("another"), { default: true })).toThrow("默认平台重复指定: another");
    expect(getPlatform("another")).toBeUndefined();
  });

  it("多重 URL 命中时报出所有平台；无命中仍回落默认平台", () => {
    const matchesUrl = (url: string) => /shared\.example/i.test(url);
    const primary = fakePlatform("primary", matchesUrl);
    const second = fakePlatform("second", matchesUrl);
    registerPlatform(primary, { default: true });
    registerPlatform(second);

    expect(() => matchPlatform("https://shared.example/room")).toThrow(
      "URL 同时匹配多个平台: primary, second",
    );
    expect(() => platformForRoom("https://shared.example/room")).toThrow(
      "URL 同时匹配多个平台: primary, second",
    );
    expect(matchPlatform("https://unknown.example/room")).toBeUndefined();
    expect(platformForRoom("https://unknown.example/room")).toBe(primary);
    expect(platformForRoom("12345")).toBe(primary);
  });
});
