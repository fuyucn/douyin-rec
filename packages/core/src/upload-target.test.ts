import { describe, it, expect } from "vitest";
import { createUploadTargetRegistry } from "./upload-target.js";
import type { UploadTarget } from "./upload-target.js";

function fakeTarget(id: string, platformIds: string[]): UploadTarget {
  return {
    id,
    platformIds,
    resolveCredential: (input) => ({ targetId: id, locator: input.explicitPath ?? `${input.dataRoot}/${id}` }),
    accountKey: (cred) => `${cred.targetId}:${cred.locator.length}`,
    hardPolicy: () => ({ visibility: "private", watermark: false, copyright: "self" }),
    defaults: () => ({ tid: 0, tags: [], titleMaxLength: 80, maxParts: null }),
    create: async () => ({ proof: "created", ref: { targetId: id, id: "a1" } }),
    append: async () => ({ proof: "observed" }),
    inspect: async () => null,
    findRecent: async () => "none",
    classifyError: () => ({ kind: "permanent", reason: "fake" }),
    capabilities: { appendGranularity: "single", seasons: false },
  };
}

describe("createUploadTargetRegistry", () => {
  it("按 id 与平台都能查到注册的目标", () => {
    const reg = createUploadTargetRegistry();
    reg.register(fakeTarget("fake", ["platform-a"]));
    expect(reg.get("fake")?.id).toBe("fake");
    expect(reg.forPlatform("platform-a")?.id).toBe("fake");
    expect(reg.list().map((t) => t.id)).toEqual(["fake"]);
  });

  it("未注册的目标/平台返回 undefined,由调用方显式失败", () => {
    const reg = createUploadTargetRegistry();
    expect(reg.get("missing")).toBeUndefined();
    expect(reg.forPlatform("missing")).toBeUndefined();
  });

  it("重复注册同一个 id 直接抛错,不静默覆盖", () => {
    const reg = createUploadTargetRegistry();
    reg.register(fakeTarget("fake", ["platform-a"]));
    expect(() => reg.register(fakeTarget("fake", ["platform-b"]))).toThrow(/重复注册/);
  });

  it("空 id 抛错", () => {
    const reg = createUploadTargetRegistry();
    expect(() => reg.register(fakeTarget("", ["platform-a"]))).toThrow(/id 不能为空/);
  });

  it("同一平台命中多个目标 = 配置错误,抛错而不是静默选第一个", () => {
    const reg = createUploadTargetRegistry();
    reg.register(fakeTarget("a", ["same"]));
    reg.register(fakeTarget("b", ["same"]));
    expect(() => reg.forPlatform("same")).toThrow(/命中多个上传目标/);
  });

  it("list 返回副本,调用方改动不影响注册表", () => {
    const reg = createUploadTargetRegistry();
    reg.register(fakeTarget("fake", ["platform-a"]));
    const snapshot = reg.list();
    snapshot.length = 0;
    expect(reg.list().map((t) => t.id)).toEqual(["fake"]);
  });
});
