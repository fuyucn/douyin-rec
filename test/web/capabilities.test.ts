import { describe, expect, it } from "vitest";
import { nodeCaps, type NodeCaps } from "../../packages/web/src/lib/capabilities.js";

/** master 期望的全表(新增字段若没同步进这个表,`toEqual` 会立刻失败)。 */
const MASTER: NodeCaps = {
  rooms: true, createRoom: true, editRecording: true,
  editPipeline: true, hubRule: true, nodes: true, queue: true, stats: true, mergePanel: true, runs: true,
};

/** worker(以及未探测完成):只保留录制半边。 */
const WORKER: NodeCaps = {
  rooms: true, createRoom: true, editRecording: true,
  editPipeline: false, hubRule: false, nodes: false, queue: false, stats: false, mergePanel: false, runs: false,
};

/** 只有 master 才成立的能力(plans/047 §3.2)。 */
const MASTER_ONLY = ["editPipeline", "hubRule", "nodes", "queue", "stats", "mergePanel", "runs"] as const;

describe("nodeCaps", () => {
  it("master(hubEnabled=true): 全部能力可用", () => {
    expect(nodeCaps(true)).toEqual(MASTER);
  });

  it("worker(hubEnabled=false): 只保留录制半边,处理半边与 master 专有页全 false", () => {
    expect(nodeCaps(false)).toEqual(WORKER);
  });

  it("未探测完成(null)按 worker 保守 —— 不显示越权按钮", () => {
    expect(nodeCaps(null)).toEqual(nodeCaps(false));
  });

  it("worker/未探测: 七个 master-only 能力一个都拿不到", () => {
    for (const enabled of [false, null] as const) {
      const caps = nodeCaps(enabled);
      for (const key of MASTER_ONLY) expect(caps[key], `${String(enabled)} → ${key}`).toBe(false);
    }
  });

  it("两端都有: 房间入口 / 建房间 / 改录制半边", () => {
    for (const enabled of [true, false, null] as const) {
      const caps = nodeCaps(enabled);
      expect(caps.rooms).toBe(true);
      expect(caps.createRoom).toBe(true);
      expect(caps.editRecording).toBe(true);
    }
  });

  it("能力表恰好是这 10 个字段(新增能力必须补用例)", () => {
    expect(Object.keys(nodeCaps(true)).sort()).toEqual(
      ["createRoom", "editPipeline", "editRecording", "hubRule", "mergePanel", "nodes", "queue", "rooms", "runs", "stats"].sort(),
    );
  });
});
