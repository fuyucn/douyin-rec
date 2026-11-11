import { describe, it, expect } from "vitest";
import { createUploadTargetRegistry, type UploadTarget } from "@drec/core";
import type { UploadCheckpoint, UploadPartRecord, UploadStateStore } from "./state-store.js";

/**
 * 验收口径(plans/049 §8 阶段 0):新增一个假上传目标 = 一个包 + 一行注册,
 * app / web / orchestrator 零改动。这里把「一行注册」跑成真实断言。
 */
const fakeTarget: UploadTarget = {
  id: "fake-upload",
  platformIds: ["fake-platform"],
  resolveCredential: ({ dataRoot, explicitPath }) => ({
    targetId: "fake-upload",
    locator: explicitPath ?? `${dataRoot}/fake-upload.credential`,
  }),
  accountKey: (cred) => `${cred.targetId}:${cred.locator}`,
  hardPolicy: () => ({ visibility: "private", watermark: false, copyright: "self" }),
  defaults: () => ({ tid: 1, tags: ["fake"], titleMaxLength: 80, maxParts: null }),
  create: async () => ({ proof: "created", ref: { targetId: "fake-upload", id: "archive-1" } }),
  append: async () => ({ proof: "observed" }),
  inspect: async () => null,
  findRecent: async () => "none",
  classifyError: () => ({ kind: "transient", reason: "fake" }),
  capabilities: { appendGranularity: "group", seasons: false },
};

describe("upload-target 契约", () => {
  it("假目标一行注册即可被平台查到", () => {
    const registry = createUploadTargetRegistry();
    registry.register(fakeTarget);
    expect(registry.forPlatform("fake-platform")).toBe(fakeTarget);
  });

  it("硬策略由目标自己给出:水印关闭、投稿类型自制", () => {
    expect(fakeTarget.hardPolicy()).toEqual({ visibility: "private", watermark: false, copyright: "self" });
  });

  it("建稿与 append 都必须带 proof", async () => {
    const created = await fakeTarget.create({
      cred: fakeTarget.resolveCredential({ dataRoot: "/tmp" }),
      title: "t",
      files: [{ path: "/tmp/a.mp4" }],
      policy: fakeTarget.hardPolicy(),
    });
    expect(created.proof).toBe("created");
    expect(created.ref?.targetId).toBe("fake-upload");
    const appended = await fakeTarget.append({
      cred: fakeTarget.resolveCredential({ dataRoot: "/tmp" }),
      ref: { targetId: "fake-upload", id: "archive-1" },
      files: [{ path: "/tmp/a.mp4" }],
      policy: fakeTarget.hardPolicy(),
    });
    expect(appended.proof).toBe("observed");
  });

  it("状态存储可按接口注入(驱动不直接开库)", () => {
    const mem = new Map<string, UploadCheckpoint>();
    const store: UploadStateStore = {
      load: (key) => mem.get(key) ?? null,
      save: (key, checkpoint) => void mem.set(key, checkpoint),
      confirmPart: (key, part: UploadPartRecord) => {
        const current = mem.get(key);
        if (!current) return;
        current.parts.push(part);
      },
    };
    store.save("k", { targetId: "fake-upload", archiveId: "archive-1", parts: [] });
    store.confirmPart("k", { index: 1, size: 10, mtimeMs: 20 });
    expect(store.load("k")?.parts).toEqual([{ index: 1, size: 10, mtimeMs: 20 }]);
    expect(store.load("missing")).toBeNull();
  });
});
