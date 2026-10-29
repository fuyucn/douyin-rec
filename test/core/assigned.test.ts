// issue #73:归属判定单一真理源 isWorkerAssigned / resolveSpecAssignment,及各消费点口径一致。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkerAssigned, isWorkerTargeted, resolveSpecAssignment } from "@drec/core";
import { recordingStatusWorkerIds } from "../../packages/orchestrator/src/transport.js";
import { localSuppressedSourceTaskIds, upsertHubRule } from "../../packages/app/src/hub-store.js";

describe("isWorkerAssigned", () => {
  it("规则启用 + 勾选 + 无能力要求 → 归属", () => {
    expect(isWorkerAssigned({ enabled: true, workers: ["a", "b"] }, "a", undefined)).toBe(true);
  });
  it("规则禁用 → 不归属", () => {
    expect(isWorkerAssigned({ enabled: false, workers: ["a"] }, "a", undefined)).toBe(false);
  });
  it("enabled 缺省视为启用(reconciler 的 cfg 没有该字段)", () => {
    expect(isWorkerAssigned({ workers: ["a"] }, "a", undefined)).toBe(true);
  });
  it("取消勾选 → 不归属", () => {
    expect(isWorkerAssigned({ enabled: true, workers: ["a"] }, "b", undefined)).toBe(false);
  });
  it("能力不满足 → 不归属;满足 → 归属", () => {
    const rule = { enabled: true, workers: ["a"], requires: ["danmu:douyin"] };
    expect(isWorkerAssigned(rule, "a", ["other"])).toBe(false);
    expect(isWorkerAssigned(rule, "a", undefined)).toBe(false);
    expect(isWorkerAssigned(rule, "a", ["danmu:douyin", "x"])).toBe(true);
  });
  it("workers 缺省/空 = 全选", () => {
    expect(isWorkerAssigned({ enabled: true }, "z", undefined)).toBe(true);
    expect(isWorkerAssigned({ enabled: true, workers: [] }, "z", undefined)).toBe(true);
    expect(isWorkerTargeted({ workers: [] }, "z")).toBe(true);
  });
});

describe("resolveSpecAssignment(desiredFor 的 assigned/enabled)", () => {
  const rule = { enabled: true, workers: ["vps1"] };
  it("远端归属:enabled 跟随源任务", () => {
    expect(resolveSpecAssignment(rule, "vps1", undefined, true)).toEqual({ assigned: true, enabled: true });
    expect(resolveSpecAssignment(rule, "vps1", undefined, false)).toEqual({ assigned: true, enabled: false });
  });
  it("远端取消勾选:assigned=false 且 enabled=false(停用保留,不是删除)", () => {
    expect(resolveSpecAssignment(rule, "vps2", undefined, true)).toEqual({ assigned: false, enabled: false });
  });
  it("远端规则禁用 / 能力不满足:同样停用保留", () => {
    expect(resolveSpecAssignment({ ...rule, enabled: false }, "vps1", undefined, true)).toEqual({ assigned: false, enabled: false });
    expect(resolveSpecAssignment({ ...rule, requires: ["c"] }, "vps1", [], true)).toEqual({ assigned: false, enabled: false });
  });
  it("local 特例:没勾选本机 → assigned=false 但 enabled 保持源任务意图(不污染全局)", () => {
    expect(resolveSpecAssignment(rule, "local", undefined, true)).toEqual({ assigned: false, enabled: true });
  });
  it("local:规则禁用 → enabled=false", () => {
    expect(resolveSpecAssignment({ ...rule, enabled: false }, "local", undefined, true)).toEqual({ assigned: false, enabled: false });
  });
  it("local 被勾选 → assigned=true", () => {
    expect(resolveSpecAssignment({ enabled: true, workers: ["local"] }, "local", undefined, true)).toEqual({ assigned: true, enabled: true });
  });
});

describe("消费点共用同一勾选/能力口径", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("recordingStatusWorkerIds:workers 空 = 全部;显式 = 勾选;无 sourceTaskId 不探测", () => {
    const all = ["local", "a", "b"];
    expect([...recordingStatusWorkerIds([{ recording: { sourceTaskId: 1 } }], all)].sort()).toEqual(["a", "b", "local"]);
    expect([...recordingStatusWorkerIds([{ workers: ["a"], recording: { sourceTaskId: 1 } }], all)]).toEqual(["a"]);
    expect(recordingStatusWorkerIds([{ workers: ["a"], recording: null }], all).size).toBe(0);
  });
  it("recordingStatusWorkerIds:规则停用 / 能力不满足时仍探测已勾选节点(不叠加 enabled/能力判定)", () => {
    const all = ["local", "a", "b"];
    const disabled = [{ enabled: false, workers: ["a"], recording: { sourceTaskId: 1 } }];
    expect([...recordingStatusWorkerIds(disabled, all)]).toEqual(["a"]);
    const needCap = [{ enabled: true, requires: ["danmu:douyin"], workers: ["b"], recording: { sourceTaskId: 2 } }];
    expect([...recordingStatusWorkerIds(needCap, all)]).toEqual(["b"]);
  });

  it("localSuppressedSourceTaskIds:远端缺能力 → 不抑制本机;满足 → 抑制", () => {
    dir = mkdtempSync(join(tmpdir(), "assigned-"));
    upsertHubRule(dir, { platform: "douyin", roomSlug: "100", enabled: true, workers: ["vps1"], requires: ["danmu:douyin"], recording: { sourceTaskId: 7 } });
    const known = new Set(["vps1"]);
    expect([...localSuppressedSourceTaskIds(dir, known, () => [])]).toEqual([]);
    expect([...localSuppressedSourceTaskIds(dir, known, () => ["danmu:douyin"])]).toEqual([7]);
  });

  it("localSuppressedSourceTaskIds:规则禁用不抑制", () => {
    dir = mkdtempSync(join(tmpdir(), "assigned-"));
    upsertHubRule(dir, { platform: "douyin", roomSlug: "101", enabled: false, workers: ["vps1"], recording: { sourceTaskId: 8 } });
    expect(localSuppressedSourceTaskIds(dir, new Set(["vps1"])).size).toBe(0);
  });
});
