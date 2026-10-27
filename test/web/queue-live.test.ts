import { describe, expect, it } from "vitest";
import {
  attentionKindOf,
  groupAttention,
  queueSummary,
  sortLive,
  splitQueue,
} from "../../packages/web/src/lib/queue-live.js";
import type { HubBlockedBroadcastDTO, QueueItemDTO, RollingDeliveryDTO } from "../../packages/core/src/api-types.js";

function row(patch: Partial<QueueItemDTO> & Pick<QueueItemDTO, "streamKey" | "phase">): QueueItemDTO {
  return {
    platform: "douyin",
    roomSlug: "1",
    anchorName: "Alice",
    state: "pending",
    resource: null,
    queuePosition: null,
    currentNode: null,
    doneSteps: [],
    nextSteps: [],
    currentStepSec: null,
    etaSec: null,
    winnerWorker: null,
    fails: 0,
    updatedAt: 100,
    error: null,
    bv: null,
    videoDurationSec: null,
    finishedAt: null,
    enqueuedAt: 100,
    nodeUpload: null,
    ...patch,
  };
}

function delivery(patch: Partial<RollingDeliveryDTO>): RollingDeliveryDTO {
  return {
    workerId: "a",
    workerName: "node-a",
    platform: "douyin",
    roomSlug: "1",
    anchorName: "Alice",
    sessionBase: "s1",
    bv: null,
    confirmed: 0,
    total: 1,
    ambiguous: 0,
    uploading: null,
    recording: true,
    checkedAt: 100,
    ...patch,
  };
}

describe("queue live sections", () => {
  it("keeps only real live phases in NOW and orders running before queued before settle", () => {
    const rows = [
      row({ streamKey: "c", phase: "waiting_settle" }),
      row({ streamKey: "a", phase: "queued", queuePosition: 2 }),
      row({ streamKey: "b", phase: "running" }),
      row({ streamKey: "d", phase: "done" }),
      row({ streamKey: "e", phase: "waiting_upload" }),
      row({ streamKey: "f", phase: "waiting_manual", error: "节点已开始上传但结果未知" }),
    ];
    const s = splitQueue(rows, [], []);
    expect(s.live.map((r) => r.streamKey)).toEqual(["b", "a", "c"]);
    expect(s.stageReady.map((r) => r.streamKey)).toEqual(["e"]);
    expect(s.history.map((r) => r.streamKey)).toEqual(["d"]);
    expect(s.attention[0]?.kind).toBe("upload_unknown");
  });

  it("groups attention by cause and counts distinct rooms", () => {
    const rows = [
      row({ streamKey: "1", phase: "waiting_manual", error: "节点已开始上传但结果未知" }),
      row({ streamKey: "2", phase: "waiting_manual", error: "节点已开始上传但结果未知" }),
      row({ streamKey: "3", phase: "waiting_manual", roomSlug: "2", error: "边录边传:BV=x 有不确定段 2" }),
      row({ streamKey: "4", phase: "stopped", error: "用户停止" }),
      row({ streamKey: "5", phase: "waiting_upload", error: "已存档待人工上传(stage 模式正常收口)" }),
    ];
    const groups = groupAttention(rows, []);
    expect(groups.map((g) => [g.kind, g.rows.length, g.rooms])).toEqual([
      ["upload_unknown", 2, 1],
      ["part_unknown", 1, 1],
      ["stopped", 1, 1],
    ]);
    expect(attentionKindOf(rows[0]!)).toBe("upload_unknown");
    expect(attentionKindOf(rows[2]!)).toBe("part_unknown");
  });

  it("keeps failed runs in ATTENTION and out of history", () => {
    const rows = [
      row({ streamKey: "f", phase: "failed", error: "节点侧上传失败:ssh rc=255" }),
      row({ streamKey: "d", phase: "done" }),
    ];
    const s = splitQueue(rows, [], []);
    expect(s.attention.map((g) => [g.kind, g.rows.map((r) => r.streamKey)])).toEqual([
      ["node_failure", ["f"]],
    ]);
    expect(s.history.map((r) => r.streamKey)).toEqual(["d"]);
  });

  it("classifies a node upload failure before part-review wording", () => {
    const failed = row({
      streamKey: "n",
      phase: "waiting_manual",
      error: "节点侧上传失败:append 分 P 2 时 ssh rc=255",
    });
    expect(attentionKindOf(failed)).toBe("node_failure");
  });

  it("does not label a master-side ffmpeg failure as a node upload failure", () => {
    expect(attentionKindOf(row({ streamKey: "f", phase: "failed", error: "ffmpeg 失败:exit 1" }))).toBe("other");
  });

  it("does not label a generic master-side upload failure as a node failure", () => {
    expect(attentionKindOf(row({ streamKey: "u", phase: "failed", error: "上传失败:biliup exited 1" }))).toBe("other");
  });

  it("does not label a generic mention of parts as a part-review incident", () => {
    expect(attentionKindOf(row({ streamKey: "p", phase: "failed", error: "编辑分 P 标题失败" }))).toBe("other");
  });

  it("promotes blocked broadcasts into attention without inventing ledger rows", () => {
    const blocked: HubBlockedBroadcastDTO = {
      streamKey: "douyin:9:2026-10-26", platform: "douyin", roomSlug: "9", workers: ["a"],
      sinceMs: 1, rounds: 2, threshold: 6,
    };
    const s = splitQueue([], [], [blocked]);
    expect(s.attention[0]?.kind).toBe("blocked");
    expect(s.attention[0]?.rooms).toBe(1);
  });

  it("summary counts are derived from the snapshot, not hard-coded", () => {
    const rows = [
      row({ streamKey: "a", phase: "running" }),
      row({ streamKey: "b", phase: "waiting_upload" }),
      row({ streamKey: "c", phase: "waiting_manual", error: "node failed" }),
      row({ streamKey: "e", phase: "stopped", error: "用户停止" }),
      row({ streamKey: "d", phase: "done" }),
    ];
    const s = splitQueue(rows, [delivery({})], []);
    expect(queueSummary(s, { cpu: { active: 1, queued: 0, max: 1 }, upload: { active: 0, queued: 0, max: 1, cooldownUntil: 0, windowUsed: 0, windowLimit: 5, windowResetAt: 0 }, net: { active: 0, queued: 0, max: 1 }, waiting: [] }))
      .toMatchObject({ live: 1, attention: 2, stageReady: 1, history: 1, delivering: 1, activeSlots: 1, maxSlots: 6 });
  });

  it("sortLive is deterministic when queue positions and ages tie", () => {
    const a = row({ streamKey: "a", phase: "queued", queuePosition: 1 });
    const b = row({ streamKey: "b", phase: "queued", queuePosition: 1 });
    expect(sortLive([b, a]).map((r) => r.streamKey)).toEqual(["a", "b"]);
  });
});
