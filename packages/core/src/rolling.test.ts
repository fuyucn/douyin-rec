import { describe, expect, it } from "vitest";
import {
  canDeleteRollingSource,
  DEFAULT_SEAL_GRACE_MS,
  headOfLineFilter,
  isVideoSegment,
  planRollingUploads,
  rollingUploadSingleNode,
  sameRoomIdentity,
  sealedSegmentIndices,
  segmentSessionBase,
  shouldRefuseNewRecording,
  withConfirmed,
  type RollingSegment,
} from "./rolling.js";

const seg = (index: number, mtimeMs: number, path = `/rec/${index}.ts`): RollingSegment => ({ index, mtimeMs, path });

describe("sealedSegmentIndices — 只认已封口分段(绝不碰正在写的文件)", () => {
  it("空数组 → 空集(首次运行/老数据安全)", () => {
    expect(sealedSegmentIndices([], { recordingActive: true, nowMs: 1000 }).size).toBe(0);
  });

  it("录制中:有后继段的旧段都封口,最新段未封口", () => {
    const segs = [seg(0, 0), seg(1, 0), seg(2, 0)];
    const sealed = sealedSegmentIndices(segs, { recordingActive: true, nowMs: 10_000 });
    expect([...sealed].sort()).toEqual([0, 1]);
  });

  it("录制中:只有一段 → 空集(正在写,绝不上传/删除)", () => {
    const sealed = sealedSegmentIndices([seg(0, 0)], { recordingActive: true, nowMs: 999_999 });
    expect(sealed.size).toBe(0);
  });

  it("录制已收尾:最新段需过 grace 才算封口(防 flush 未完)", () => {
    const segs = [seg(0, 0), seg(1, 5_000)];
    // now - mtime(5000) < grace → 最新段仍未封口,只有段 0。
    const early = sealedSegmentIndices(segs, { recordingActive: false, nowMs: 5_000 + DEFAULT_SEAL_GRACE_MS - 1 });
    expect([...early].sort()).toEqual([0]);
    // 过了 grace → 段 1 也封口。
    const late = sealedSegmentIndices(segs, { recordingActive: false, nowMs: 5_000 + DEFAULT_SEAL_GRACE_MS });
    expect([...late].sort()).toEqual([0, 1]);
  });

  it("单段 + 已收尾 + 过 grace → 封口(整场只有一段也能传)", () => {
    const sealed = sealedSegmentIndices([seg(0, 1_000)], { recordingActive: false, nowMs: 1_000 + DEFAULT_SEAL_GRACE_MS });
    expect([...sealed]).toEqual([0]);
  });

  it("段号乱序/不连续(重连重开)→ 按最大段号定最新,更早段全封口", () => {
    const segs = [seg(0, 0), seg(5, 0), seg(2, 0)];
    const sealed = sealedSegmentIndices(segs, { recordingActive: true, nowMs: 1 });
    expect([...sealed].sort()).toEqual([0, 2]);
  });

  it("grace=0 且已收尾 → 最新段立即封口(显式关宽限)", () => {
    const sealed = sealedSegmentIndices([seg(0, 1_000)], { recordingActive: false, nowMs: 1_000, sealGraceMs: 0 });
    expect([...sealed]).toEqual([0]);
  });
});

describe("planRollingUploads — 只列未确认的封口段,按段序", () => {
  it("跳过已确认段,保留顺序", () => {
    const segs = [seg(0, 0), seg(1, 0), seg(2, 0), seg(3, 0)];
    const plan = planRollingUploads(segs, { recordingActive: true, nowMs: 1 }, new Set([0, 2]));
    expect(plan.map((s) => s.index)).toEqual([1]);
  });

  it("未封口的最新段永不进上传名单", () => {
    const segs = [seg(0, 0), seg(1, 0)];
    const plan = planRollingUploads(segs, { recordingActive: true, nowMs: 1 }, new Set());
    expect(plan.map((s) => s.index)).toEqual([0]);
  });

  it("乱序输入也按段号升序输出(分 P 顺序稳定)", () => {
    const segs = [seg(2, 0), seg(0, 0), seg(1, 0)];
    const plan = planRollingUploads(segs, { recordingActive: true, nowMs: 1 }, new Set());
    expect(plan.map((s) => s.index)).toEqual([0, 1]);
  });
});

describe("headOfLineFilter — 头阻塞:阻塞段及其后的段避免形成不可逆空洞", () => {
  const mk = (indices: number[]): RollingSegment[] => indices.map((i) => seg(i, 0));
  it("无阻塞 → 全量放行(按段号升序)", () => {
    expect(headOfLineFilter(mk([2, 0, 1])).map((s) => s.index)).toEqual([0, 1, 2]);
    expect(headOfLineFilter(mk([0, 1, 2]), new Set()).map((s) => s.index)).toEqual([0, 1, 2]);
  });
  it("阻塞段存在 → 其及之后全部截断(乱序输入也升序后从阻塞处断)", () => {
    // 段 1 卡住(ambiguous)→ 段 2/3 不得上传(否则分 P 出现洞)。
    const out = headOfLineFilter(mk([0, 1, 2, 3]), new Set([1]));
    expect(out.map((s) => s.index)).toEqual([0]);
  });
  it("阻塞段是最新一段 → 仅截断它自己", () => {
    expect(headOfLineFilter(mk([0, 1, 2]), new Set([2])).map((s) => s.index)).toEqual([0, 1]);
  });
  it("阻塞段号不在本轮 pending → 不误伤已列出的段", () => {
    const out = headOfLineFilter(mk([1, 2]), new Set([0])); // 段 0 不在 pending(未列出)
    expect(out.map((s) => s.index)).toEqual([1, 2]);
  });
  it("空 pending → 空", () => {
    expect(headOfLineFilter([], new Set([0])).length).toBe(0);
  });
});

describe("shouldRefuseNewRecording — 低水位拒绝新开录", () => {
  it("水位<=0 → 关闭闸门(向后兼容)", () => {
    expect(shouldRefuseNewRecording(0, 0)).toBe(false);
    expect(shouldRefuseNewRecording(0, -1)).toBe(false);
  });
  it("低于水位 → 拒绝;达到/超过 → 放行", () => {
    expect(shouldRefuseNewRecording(1_000, 2_000)).toBe(true);
    expect(shouldRefuseNewRecording(2_000, 2_000)).toBe(false);
    expect(shouldRefuseNewRecording(5_000, 2_000)).toBe(false);
  });
  it("NaN/负剩余(查询失败)→ 保守拒绝", () => {
    expect(shouldRefuseNewRecording(Number.NaN, 2_000)).toBe(true);
    expect(shouldRefuseNewRecording(-1, 2_000)).toBe(true);
  });
});

describe("sameRoomIdentity — 跨节点身份证据(绝不靠主播名)", () => {
  it("(platform, roomSlug) 全等 → true", () => {
    expect(sameRoomIdentity({ platform: "douyin", roomSlug: "123" }, { platform: "douyin", roomSlug: "123" })).toBe(true);
  });
  it("平台不同(同房间号)→ false", () => {
    expect(sameRoomIdentity({ platform: "douyin", roomSlug: "123" }, { platform: "bilibili", roomSlug: "123" })).toBe(false);
  });
  it("房间号不同 → false", () => {
    expect(sameRoomIdentity({ platform: "douyin", roomSlug: "123" }, { platform: "douyin", roomSlug: "456" })).toBe(false);
  });
  it("任一为空 → false(缺证据不删)", () => {
    expect(sameRoomIdentity({ platform: "", roomSlug: "123" }, { platform: "douyin", roomSlug: "123" })).toBe(false);
    expect(sameRoomIdentity({ platform: "douyin", roomSlug: "123" }, { platform: "douyin", roomSlug: " " })).toBe(false);
  });
});

describe("canDeleteRollingSource — 删源三重证据闸门", () => {
  const room = { platform: "douyin", roomSlug: "123" };
  it("封口 + ack + 身份一致 → 允许删", () => {
    expect(canDeleteRollingSource({ sealed: true, ack: true, segmentRoom: room, targetRoom: room })).toBe(true);
  });
  it("未封口(可能还在写)→ 绝不删", () => {
    expect(canDeleteRollingSource({ sealed: false, ack: true, segmentRoom: room, targetRoom: room })).toBe(false);
  });
  it("未确认上传(无 BV/ack)→ 绝不删", () => {
    expect(canDeleteRollingSource({ sealed: true, ack: false, segmentRoom: room, targetRoom: room })).toBe(false);
  });
  it("身份不符 → 绝不删(不误删他房间)", () => {
    expect(canDeleteRollingSource({
      sealed: true, ack: true,
      segmentRoom: room, targetRoom: { platform: "douyin", roomSlug: "999" },
    })).toBe(false);
  });
});

describe("withConfirmed — 幂等合并已确认段号", () => {
  it("重复确认不产生重复;保持既有", () => {
    const out = withConfirmed(new Set([0, 2]), 2, 3, 3);
    expect([...out].sort()).toEqual([0, 2, 3]);
  });
});

describe("segmentSessionBase — 分段文件名 → 会话 base", () => {
  it("剥 -PARTnnn / _PARTnnn / _nnn 后缀", () => {
    expect(segmentSessionBase("主播_2026-10-12_09-30-00-PART001.ts")).toBe("主播_2026-10-12_09-30-00");
    expect(segmentSessionBase("主播_2026-10-12_09-30-00_PART001.flv")).toBe("主播_2026-10-12_09-30-00");
    expect(segmentSessionBase("主播_2026-10-12_09-30-00_000.ts")).toBe("主播_2026-10-12_09-30-00");
  });
  it("不分段单文件也认(无后缀)", () => {
    expect(segmentSessionBase("主播_2026-10-12_09-30-00.ts")).toBe("主播_2026-10-12_09-30-00");
  });
  it("非会话文件名 → undefined(不硬猜)", () => {
    expect(segmentSessionBase("random.ts")).toBeUndefined();
    expect(segmentSessionBase("主播_2026-10-12.ts")).toBeUndefined();
  });
});

describe("isVideoSegment — .xml/.ass 恒不视为可删分段", () => {
  it("ts/flv 是视频分段", () => {
    expect(isVideoSegment("a.ts")).toBe(true);
    expect(isVideoSegment("a.FLV")).toBe(true);
  });
  it("xml/ass 不是", () => {
    expect(isVideoSegment("a.xml")).toBe(false);
    expect(isVideoSegment("a.ass")).toBe(false);
  });
});

describe("rollingUploadSingleNode — 跨节点重复投稿闸门", () => {
  it("无规则(单机/未编排)→ 单节点,允许", () => {
    expect(rollingUploadSingleNode(false, undefined)).toBe(true);
    expect(rollingUploadSingleNode(false, ["a", "b"])).toBe(true); // 无规则时 workers 无意义
  });
  it("规则存在但未勾选(=全部节点)→ 拒绝", () => {
    expect(rollingUploadSingleNode(true, undefined)).toBe(false);
    expect(rollingUploadSingleNode(true, [])).toBe(false);
  });
  it("规则恰好 1 个节点 → 允许", () => {
    expect(rollingUploadSingleNode(true, ["vps2"])).toBe(true);
  });
  it("规则 ≥2 个节点 → 拒绝", () => {
    expect(rollingUploadSingleNode(true, ["vps1", "vps2"])).toBe(false);
  });
});
