import { afterEach, describe, it, expect } from "vitest";
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

describe("clusterBroadcasts same-broadcast gap boundary (issue #292, default tolerance = 60 min)", () => {
  const t0 = new Date("2026-08-14T08:00:00Z").getTime();
  const two = (gapMin: number) => clusterBroadcasts([{ workerId: "w", recordings: [
    rec({ sessionBase: "a", startMs: t0, endMs: t0 + 30 * 60_000 }),
    rec({ sessionBase: "b", startMs: t0 + (30 + gapMin) * 60_000, endMs: t0 + (60 + gapMin) * 60_000 }),
  ] }]);
  it("gap 59 min and exactly 60 min → one broadcast", () => {
    expect(two(59)).toHaveLength(1);
    expect(two(60)).toHaveLength(1);
  });
  it("gap 61 min → two broadcasts with distinct keys", () => {
    const out = two(61);
    expect(out).toHaveLength(2);
    expect(out[1]!.streamKey).toMatch(/_\d{4}$/);
  });
});

describe("clusterBroadcasts streamKey 日期按设置时区(issue #155)", () => {
  const prevTZ = process.env.TZ;
  afterEach(() => {
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  });
  // 北京 2026-09-13 01:30 开播 = 洛杉矶 09-12 10:30
  const startMs = Date.parse("2026-09-12T17:30:00Z");
  const run = (tz?: string) =>
    clusterBroadcasts(
      [{ workerId: "w", recordings: [rec({ startMs, endMs: startMs + 3_600_000 })] }],
      undefined, "douyin", [], tz,
    )[0]!.streamKey;

  it("显式 timeZone 优先于进程本地时区;缺省取进程生效时区(env TZ = 设置)", () => {
    process.env.TZ = "America/Los_Angeles";
    // 缺省 = 进程生效时区(serve/独立 CLI 启动时已把设置写进 env);显式传设置时区 → 北京日期。
    expect(run()).toBe("douyin:411:2026-09-12");
    expect(run("Asia/Shanghai")).toBe("douyin:411:2026-09-13");
  });
  it("未设 TZ 且宿主机本地为美西:默认北京日期", () => {
    delete process.env.TZ;
    expect(run()).toBe("douyin:411:2026-09-13");
  });
  it("同日第二场 _HHMM 后缀也按设置时区", () => {
    const a = Date.parse("2026-09-12T17:30:00Z"); // 北京 09-13 01:30
    const b = Date.parse("2026-09-12T20:00:00Z"); // 北京 09-13 04:00(相隔 > 容差 → 两簇)
    const out = clusterBroadcasts(
      [{ workerId: "w", recordings: [rec({ startMs: a, endMs: a + 1_000_000 }), rec({ startMs: b, endMs: b + 1_000_000 })] }],
      undefined, "douyin", [], "Asia/Shanghai",
    );
    expect(out.map((x) => x.streamKey).sort()).toEqual(["douyin:411:2026-09-13_0130", "douyin:411:2026-09-13_0400"]);
  });
});

describe("clusterBroadcasts × live id (issue #320)", () => {
  const T0 = Date.UTC(2026, 9, 20, 4, 0, 0);
  const rec = (startMin: number, endMin: number, liveSessionId?: string) => ({
    roomSlug: "r1", platform: "douyin", sessionBase: `s${startMin}`, tsFiles: [], durationSec: 0, totalGapSec: 0,
    startMs: T0 + startMin * 60_000, endMs: T0 + endMin * 60_000, ...(liveSessionId ? { liveSessionId } : {}),
  });
  const cluster = (recs: ReturnType<typeof rec>[]) => clusterBroadcasts([{ workerId: "w1", recordings: recs }], undefined, "douyin", [], "UTC");

  it("26 min apart with different live ids → two broadcasts", () => {
    expect(cluster([rec(0, 22, "a"), rec(48, 200, "b")])).toHaveLength(2);
  });
  it("84 min apart with the same live id → one broadcast", () => {
    expect(cluster([rec(0, 60, "a"), rec(144, 200, "a")])).toHaveLength(1);
  });
  it("no live id → time window as before", () => {
    expect(cluster([rec(0, 22), rec(48, 200)])).toHaveLength(1);
    expect(cluster([rec(0, 60), rec(144, 200)])).toHaveLength(2);
  });
});
