import { describe, it, expect } from "vitest";
import { clusterBroadcasts } from "./identity.js";
import type { NodeRecording } from "./transport.js";

const rec = (over: Partial<NodeRecording>): NodeRecording => ({
  roomSlug: "411", platform: "douyin", sessionBase: "s", tsFiles: [], durationSec: 100,
  startMs: 0, endMs: 100_000, totalGapSec: 0, ...over,
});

describe("clusterBroadcasts", () => {
  it("同房间、开录差15s → 同一簇(同 streamKey)", () => {
    const out = clusterBroadcasts([
      { tenantId: "local", recordings: [rec({ startMs: 1_700_000_000_000, endMs: 1_700_009_000_000 })] },
      { tenantId: "vps",   recordings: [rec({ startMs: 1_700_000_015_000, endMs: 1_700_009_010_000 })] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].members).toHaveLength(2);
    expect(out[0].roomSlug).toBe("411");
    expect(out[0].platform).toBe("douyin");
    expect(out[0].streamKey).toMatch(/^douyin:411:/);
  });
  it("同房间、相隔数小时不重叠 → 两簇(两 streamKey)", () => {
    const out = clusterBroadcasts([
      { tenantId: "local", recordings: [
        rec({ startMs: 1_700_000_000_000, endMs: 1_700_003_000_000 }),
        rec({ startMs: 1_700_050_000_000, endMs: 1_700_053_000_000 }),
      ] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].streamKey).not.toBe(out[1].streamKey);
  });
  it("不同 roomSlug 永不同簇", () => {
    const out = clusterBroadcasts([
      { tenantId: "a", recordings: [rec({ roomSlug: "1" }), rec({ roomSlug: "2" })] },
    ]);
    expect(out).toHaveLength(2);
  });
  it("同房间号不同平台不撞(douyin:123 vs bilibili:123)", () => {
    const out = clusterBroadcasts([
      { tenantId: "a", recordings: [
        rec({ roomSlug: "123", platform: "douyin" }),
        rec({ roomSlug: "123", platform: "bilibili" }),
      ] },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.streamKey).sort()).toEqual([
      expect.stringMatching(/^bilibili:123:/),
      expect.stringMatching(/^douyin:123:/),
    ]);
  });
});
