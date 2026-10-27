import { describe, it, expect } from "vitest";
import {
  countNodeHealth,
  deriveNodeHealthProbe,
  fmtBytes,
  INITIAL_NODE_HEALTH_LOAD_STATE,
  loadNodeHealthSnapshot,
  nodeHealthState,
  roomSlugOf,
  summarizeNodes,
} from "../../packages/web/src/lib/nodes-summary.js";
import type { RollingDeliveryDTO, Task, WorkerStatus } from "../../packages/web/src/api/client.js";

const task = (...ws: Array<[string, "recording" | "not_recording" | "unavailable"]>): Pick<Task, "recordingWorkers"> => ({
  recordingWorkers: ws.map(([workerId, state]) => ({ workerId, workerName: `N-${workerId}`, state })),
}) as Pick<Task, "recordingWorkers">;
const del = (workerId: string, over: Partial<RollingDeliveryDTO> = {}): RollingDeliveryDTO => ({
  workerId, workerName: workerId, platform: "douyin", roomSlug: "1", anchorName: null, sessionBase: "s", bv: null,
  confirmed: 1, total: 2, ambiguous: 0, uploading: null, recording: true, checkedAt: 0, ...over,
});
const st = (over: Partial<WorkerStatus>): WorkerStatus => ({ id: "a", ok: true, ...over });

describe("summarizeNodes", () => {
  it("task assignments create nodes; sorts by name and counts recording/unknown rooms", () => {
    const r = summarizeNodes([task(["b", "recording"], ["a", "not_recording"]), task(["b", "unavailable"])], {}, [], "");
    expect(r.map((n) => n.id)).toEqual(["a", "b"]);
    expect(r.find((n) => n.id === "b")).toMatchObject({ recording: 1, unavailable: 1 });
    expect(r.find((n) => n.id === "a")).toMatchObject({ recording: 0, unavailable: 0 });
  });

  it("configured workers, probed nodes, and orphan deliveries all enter the fleet", () => {
    expect(summarizeNodes([], {}, [], "0.0.1")).toEqual([]);
    expect(summarizeNodes([{ recordingWorkers: undefined }], {}, [], "")).toEqual([]);
    expect(summarizeNodes([], {}, [], "", [{ id: "idle", name: "Idle node" }]).map((n) => [n.id, n.name]))
      .toEqual([["idle", "Idle node"]]);
    expect(summarizeNodes([], { a: st({}) }, [], "0.0.1").map((n) => n.id)).toEqual(["a"]);
    expect(summarizeNodes([], {}, [del("orphan", { roomSlug: "9" })], "").map((n) => [n.id, n.rollingSessions]))
      .toEqual([["orphan", 1]]);
  });

  it("磁盘:低于水位 → diskLow;水位 0(关闭)/ 缺字段 → 不标红", () => {
    const t = [task(["a", "recording"], ["b", "recording"], ["c", "recording"])];
    const r = summarizeNodes(t, {
      a: st({ id: "a", diskFreeGB: 5, diskMinGB: 10 }),
      b: st({ id: "b", diskFreeGB: 5, diskMinGB: 0 }),
      c: st({ id: "c" }),
    }, [], "");
    expect(r.map((n) => n.diskLow)).toEqual([true, false, false]);
    expect(r[2]!.diskFreeGB).toBeUndefined();
  });

  it("版本漂移:比较基础版本(忽略 -commit 后缀);旧 bundle 无版本/无基准 → 不判", () => {
    const t = [task(["a", "recording"], ["b", "recording"], ["c", "recording"])];
    const r = summarizeNodes(t, {
      a: st({ id: "a", appVersion: "0.0.112-abc123" }),
      b: st({ id: "b", appVersion: "0.0.110-abc123" }),
      c: st({ id: "c" }),
    }, [], "0.0.112");
    expect(r.map((n) => n.drift)).toEqual([false, true, false]);
    expect(summarizeNodes(t, { b: st({ id: "b", appVersion: "0.0.110" }) }, [], "")[1]!.drift).toBe(false);
  });

  it("探测失败的节点:ok=false 且不判漂移/磁盘", () => {
    const r = summarizeNodes([task(["a", "recording"])], { a: { id: "a", ok: false, error: "timeout", appVersion: "0.0.1" } }, [], "0.0.9");
    expect(r[0]).toMatchObject({ ok: false, error: "timeout", drift: false });
  });

  it("边录边传:按节点累加会话数/未确认占盘/未知段数;缺 lockedBytes 按 0;孤立会话也保留节点", () => {
    const r = summarizeNodes([task(["a", "recording"])], {}, [
      del("a", { lockedBytes: 1000, ambiguous: 1 }), del("a", { lockedBytes: 500 }), del("a"), del("zzz", { lockedBytes: 9 }),
    ], "");
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ rollingSessions: 3, lockedBytes: 1500, ambiguous: 1 });
    expect(r[1]).toMatchObject({ id: "zzz", rollingSessions: 1, lockedBytes: 9 });
  });
});

describe("fmtBytes", () => {
  it("MB / GB 1 位小数,极小值不显示 0.0", () => {
    expect(fmtBytes(49_350_000)).toBe("49.4 MB");
    expect(fmtBytes(3_400_000_000)).toBe("3.4 GB");
    expect(fmtBytes(10)).toBe("0.1 MB");
  });
});

describe("node health states", () => {
  it("distinguishes checking from no status after the probe settles", () => {
    expect(nodeHealthState({ ok: undefined }, "loading")).toBe("checking");
    expect(nodeHealthState({ ok: undefined }, "failed")).toBe("probe-failed");
    expect(nodeHealthState({ ok: undefined }, "ready")).toBe("unknown");
    expect(nodeHealthState({ ok: true }, "ready")).toBe("online");
    expect(nodeHealthState({ ok: false }, "ready")).toBe("offline");
  });

  it("waits for both first loads, then treats a settled empty result as probe failure", () => {
    expect(deriveNodeHealthProbe({ statusSettled: false, statusHasSnapshot: false, workersLoaded: true })).toBe("loading");
    expect(deriveNodeHealthProbe({ statusSettled: true, statusHasSnapshot: false, workersLoaded: false })).toBe("loading");
    expect(deriveNodeHealthProbe({ statusSettled: true, statusHasSnapshot: false, workersLoaded: true })).toBe("failed");
  });

  it("keeps the last good snapshot when a later refresh fails", () => {
    expect(deriveNodeHealthProbe({ statusSettled: true, statusHasSnapshot: true, workersLoaded: true })).toBe("ready");
  });

  it("turns empty 200 and thrown requests into settled failures, while preserving a prior snapshot", async () => {
    const ok = await loadNodeHealthSnapshot(async () => [st({ id: "a" })], INITIAL_NODE_HEALTH_LOAD_STATE);
    expect(ok.statuses).toHaveLength(1);
    expect(ok.state).toMatchObject({ statusSettled: true, statusHasSnapshot: true, statusStale: false });
    expect(deriveNodeHealthProbe({ ...ok.state, workersLoaded: true })).toBe("ready");

    const empty = await loadNodeHealthSnapshot(async () => [], INITIAL_NODE_HEALTH_LOAD_STATE);
    expect(empty.statuses).toEqual([]);
    expect(empty.state).toMatchObject({ statusSettled: true, statusHasSnapshot: false, statusStale: true });
    expect(deriveNodeHealthProbe({ ...empty.state, workersLoaded: true })).toBe("failed");

    const thrown = await loadNodeHealthSnapshot(async () => { throw new Error("probe unavailable"); }, INITIAL_NODE_HEALTH_LOAD_STATE);
    expect(thrown.statuses).toBeUndefined();
    expect(thrown.state).toMatchObject({ statusSettled: true, statusHasSnapshot: false, statusStale: true });
    expect(deriveNodeHealthProbe({ ...thrown.state, workersLoaded: true })).toBe("failed");

    const laterFailure = await loadNodeHealthSnapshot(
      async () => { throw new Error("probe unavailable"); },
      { statusSettled: true, statusHasSnapshot: true, statusStale: false },
    );
    expect(laterFailure.state).toMatchObject({ statusSettled: true, statusHasSnapshot: true, statusStale: true });
    expect(deriveNodeHealthProbe({ ...laterFailure.state, workersLoaded: true })).toBe("ready");
  });

  it("counts all states without treating unknown as online", () => {
    const nodes = [{ ok: true }, { ok: false }, { ok: undefined }, { ok: undefined }];
    expect(countNodeHealth(nodes, "loading")).toMatchObject({
      total: 4, checking: 4, probeFailed: 0, unknown: 0, online: 0, offline: 0,
    });
    expect(countNodeHealth(nodes, "failed")).toMatchObject({
      total: 4, checking: 0, probeFailed: 4, unknown: 0, online: 0, offline: 0,
    });
    expect(countNodeHealth(nodes, "ready")).toMatchObject({
      total: 4, checking: 0, probeFailed: 0, unknown: 2, online: 1, offline: 1,
    });
  });
});

describe("节点卡片的房间行", () => {
  const rt = (room: string, anchorName: string | null, enabled: boolean, ...ws: Array<[string, "recording" | "not_recording" | "unavailable"]>) => ({
    platform: "douyin", room, anchorName, name: null, enabled,
    recordingWorkers: ws.map(([workerId, state]) => ({ workerId, workerName: `N-${workerId}`, state })),
  }) as unknown as Parameters<typeof summarizeNodes>[0][number];

  it("roomSlugOf:抖音 URL / 纯数字 / 带查询串", () => {
    expect(roomSlugOf("https://live.douyin.com/123456")).toBe("123456");
    expect(roomSlugOf("123456")).toBe("123456");
    expect(roomSlugOf("https://live.bilibili.com/77?x=1")).toBe("77");
    expect(roomSlugOf(undefined)).toBe("");
  });

  it("每个节点列出分配的房间:在录优先、停用靠后;状态按 recordingWorkers + enabled 判定", () => {
    const r = summarizeNodes([
      rt("https://live.douyin.com/1", "甲", true, ["a", "not_recording"]),
      rt("https://live.douyin.com/2", "乙", true, ["a", "recording"]),
      rt("https://live.douyin.com/3", "丙", false, ["a", "not_recording"]),
      rt("https://live.douyin.com/4", "丁", true, ["a", "unavailable"]),
    ], {}, [], "");
    expect(r[0]!.rooms.map((x) => [x.label, x.state])).toEqual([["乙", "recording"], ["丁", "unavailable"], ["甲", "waiting"], ["丙", "disabled"]]);
  });

  it("边录边传会话挂到同节点同房间;别的节点的同房间不串", () => {
    const r = summarizeNodes([rt("https://live.douyin.com/1", "甲", true, ["a", "recording"], ["b", "not_recording"])], {}, [
      del("a", { roomSlug: "1", sessionBase: "s1", bv: "BV1" }), del("b", { roomSlug: "1", sessionBase: "s2" }),
    ], "");
    expect(r.find((n) => n.id === "a")!.rooms[0]!.sessions.map((s) => s.sessionBase)).toEqual(["s1"]);
    expect(r.find((n) => n.id === "b")!.rooms[0]!.sessions.map((s) => s.sessionBase)).toEqual(["s2"]);
  });

  it("同 slug 的不同平台不合并房间行,会话按平台挂靠", () => {
    const dy = { ...rt("https://live.douyin.com/7", "抖音", true, ["a", "recording"]), platform: "douyin" };
    const bl = { ...rt("https://live.bilibili.com/7", "B站", true, ["a", "recording"]), platform: "bilibili" };
    const r = summarizeNodes([dy, bl], {}, [
      del("a", { platform: "douyin", roomSlug: "7", sessionBase: "dy" }),
      del("a", { platform: "bilibili", roomSlug: "7", sessionBase: "bl" }),
    ], "");
    expect(r[0]!.rooms.map((x) => [x.platform, x.roomSlug, x.sessions.map((s) => s.sessionBase)])).toEqual([
      ["bilibili", "7", ["bl"]],
      ["douyin", "7", ["dy"]],
    ]);
  });

  it("任务清单里没有的遗留会话也列出(未确认分段不能消失)", () => {
    const r = summarizeNodes([rt("https://live.douyin.com/1", "甲", true, ["a", "recording"])], {}, [del("a", { roomSlug: "999", anchorName: "遗留" })], "");
    expect(r[0]!.rooms.map((x) => x.label)).toContain("遗留");
  });

  it("配置同步:期望≠已应用 → syncLag;相等/缺字段 → 不告警", () => {
    const t = [rt("https://live.douyin.com/1", "甲", true, ["a", "recording"], ["b", "recording"], ["c", "recording"])];
    const r = summarizeNodes(t, {
      a: st({ id: "a", appliedVersion: 5, expectedVersion: 7 }),
      b: st({ id: "b", appliedVersion: 7, expectedVersion: 7 }),
      c: st({ id: "c" }),
    }, [], "");
    expect(r.map((n) => n.syncLag)).toEqual([true, false, false]);
  });
});

describe("room label priority (#53): task name before the cached anchor name", () => {
  it("task name wins; no task name → anchor; neither → room id", () => {
    const mk = (room: string, name: string | null, anchorName: string | null) =>
      ({ room, name, anchorName, enabled: true, recordingWorkers: [{ workerId: "a", workerName: "A", state: "recording" }] }) as unknown as Task;
    const r = summarizeNodes([
      mk("https://live.douyin.com/1", "任务名", "主播名"),
      mk("https://live.douyin.com/2", null, "主播名2"),
      mk("https://live.douyin.com/3", null, null),
    ], {}, [], "");
    expect(r[0]!.rooms.map((x) => x.label).sort()).toEqual(["3", "主播名2", "任务名"].sort());
  });
});
