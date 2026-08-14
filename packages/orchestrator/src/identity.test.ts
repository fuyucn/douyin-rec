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
      { workerId: "local", recordings: [rec({ startMs: 1_700_000_000_000, endMs: 1_700_009_000_000 })] },
      { workerId: "vps",   recordings: [rec({ startMs: 1_700_000_015_000, endMs: 1_700_009_010_000 })] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].members).toHaveLength(2);
    expect(out[0].roomSlug).toBe("411");
    expect(out[0].platform).toBe("douyin");
    expect(out[0].streamKey).toMatch(/^douyin:411:/);
  });
  it("同 worker 断流后快速重连(间隔 < 容差)→ 同一场两成员,不拆成两场", () => {
    const startMs = new Date("2026-08-14T08:00:00Z").getTime();
    const out = clusterBroadcasts(
      [
        { workerId: "local", recordings: [
          rec({ startMs, endMs: startMs + 30 * 60_000 }),
          rec({ startMs: startMs + 35 * 60_000, endMs: startMs + 65 * 60_000 }),
        ] },
      ],
      10 * 60_000,
    );
    expect(out).toHaveLength(1);
    expect(out[0].members).toHaveLength(2);
    expect(out[0].streamKey).toBe("douyin:411:2026-08-14");
  });
  it("同房间、相隔数小时不重叠 → 两簇(两 streamKey)", () => {
    const out = clusterBroadcasts([
      { workerId: "local", recordings: [
        rec({ startMs: 1_700_000_000_000, endMs: 1_700_003_000_000 }),
        rec({ startMs: 1_700_050_000_000, endMs: 1_700_053_000_000 }),
      ] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].streamKey).not.toBe(out[1].streamKey);
  });
  it("不同 roomSlug 永不同簇", () => {
    const out = clusterBroadcasts([
      { workerId: "a", recordings: [rec({ roomSlug: "1" }), rec({ roomSlug: "2" })] },
    ]);
    expect(out).toHaveLength(2);
  });
  it("同房间号不同平台不撞(douyin:123 vs bilibili:123)", () => {
    const out = clusterBroadcasts([
      { workerId: "a", recordings: [
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
  it("已知 base job 与当前簇同一场(开录时间在容差内)→ 继续用 base,不追加 _HHMM(幂等)", () => {
    const startMs = new Date("2026-08-14T08:00:00Z").getTime();
    const out = clusterBroadcasts(
      [
        { workerId: "local", recordings: [
          rec({ startMs, endMs: startMs + 3_600_000 }),
        ] },
      ],
      5 * 60_000,
      "douyin",
      [{ streamKey: "douyin:411:2026-08-14", startMs, updatedAt: startMs + 3_600_000 }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].streamKey).toBe("douyin:411:2026-08-14");
  });
  it("已知 base job 是同日更早的一场 → 新簇追加 _HHMM,不复用 done 的 base key", () => {
    const early = new Date("2026-08-14T08:00:00Z").getTime();
    const late = new Date("2026-08-14T12:00:00Z").getTime();
    const out = clusterBroadcasts(
      [
        { workerId: "local", recordings: [
          rec({ startMs: late, endMs: late + 3_600_000 }),
        ] },
      ],
      5 * 60_000,
      "douyin",
      [{ streamKey: "douyin:411:2026-08-14", startMs: early, updatedAt: early + 3_600_000 }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].streamKey).toMatch(/^douyin:411:2026-08-14_\d{4}$/);
  });
  it("同一天两簇且无已知 job → 各追加 _HHMM 区分", () => {
    const a = new Date("2026-08-14T08:00:00Z").getTime();
    const b = new Date("2026-08-14T12:00:00Z").getTime();
    const out = clusterBroadcasts([
      { workerId: "local", recordings: [
        rec({ startMs: a, endMs: a + 3_600_000 }),
        rec({ startMs: b, endMs: b + 3_600_000 }),
      ] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].streamKey).toMatch(/^douyin:411:2026-08-14_\d{4}$/);
    expect(out[1].streamKey).toMatch(/^douyin:411:2026-08-14_\d{4}$/);
    expect(out[0].streamKey).not.toBe(out[1].streamKey);
  });
  it("旧库已知 job 无 startMs 且开录不晚于 job 更新+容差 → 视为同一场,继续用 base", () => {
    const startMs = new Date("2026-08-14T08:00:00Z").getTime();
    const out = clusterBroadcasts(
      [{ workerId: "local", recordings: [rec({ startMs, endMs: startMs + 3_600_000 })] }],
      5 * 60_000,
      "douyin",
      [{ streamKey: "douyin:411:2026-08-14", startMs: null, updatedAt: startMs + 3_700_000 }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].streamKey).toBe("douyin:411:2026-08-14");
  });
});
