import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { NodeTasksDTO, RoomDTO, WorkerDTO } from "../../packages/core/src/api-types.js";
import {
  ROOM_LOG_MAX_LINES, createRoomLogReader, matchRoomLogTask, mergeRoomLogs, roomLogSources, roomLogTimestamp,
  type RoomLogClient, type RoomLogResult, type RoomLogSource,
} from "../../packages/web/src/lib/room-logs.js";

const identity = { platform: "douyin", roomSlug: "123" };
const room = (processing: RoomDTO["processing"] = null): RoomDTO => ({
  key: "douyin.123", ...identity, room: "https://live.douyin.com/123",
  recording: { taskId: 7 } as RoomDTO["recording"], processing,
});
const rule = (patch = {}): NonNullable<RoomDTO["processing"]> => ({ enabled: true, pipeline: {}, ...patch });
const workers: WorkerDTO[] = [
  { id: "local", name: "Local", kind: "local" },
  { id: "a", name: "Worker A", kind: "ssh", capabilities: ["danmu:douyin"] },
  { id: "b", name: "Worker B", kind: "ssh" },
];
const local: RoomLogSource = { id: "local", name: "", kind: "local", taskId: 7 };
const remote = (id: string): RoomLogSource => ({ id: `worker:${id}`, name: `Worker ${id}`, kind: "worker", workerId: id });
const tasks = (id = 81): NodeTasksDTO["tasks"] => [{ id, ...identity } as NodeTasksDTO["tasks"][number]];
const result = (source: RoomLogSource, lines: string[]): RoomLogResult => ({ source, lines, status: lines.length ? "ready" : "empty" });
function client(): RoomLogClient {
  return {
    getTaskLogs: vi.fn(async () => ({ lines: ["hub line"] })),
    getNodeTasks: vi.fn(async (workerId) => ({ workerId, tasks: tasks() })),
    getNodeTaskLogs: vi.fn(async (workerId, taskId) => ({ workerId, taskId, lines: [`${workerId} line`] })),
  };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => { resolve = r; }), resolve: (value) => resolve(value) };
}
async function read(sources: RoomLogSource[], api = client()): Promise<RoomLogResult[]> {
  const results: RoomLogResult[] = [];
  await createRoomLogReader(sources, identity, api, (r) => results.push(r)).refresh();
  return results;
}

describe("room log sources and node-owned task identity (#399)", () => {
  it("includes hub once and only explicitly assigned workers", () => {
    expect(roomLogSources(room(rule({ workers: ["local", "a"] })), workers, true).map((s) => s.id)).toEqual(["local", "worker:a"]);
  });
  it("preserves legacy all-worker selection, deduplicates and applies shared capability gates", () => {
    expect(roomLogSources(room(rule({ workers: [] })), [...workers, workers[1]], true).map((s) => s.id)).toEqual(["local", "worker:a", "worker:b"]);
    expect(roomLogSources(room(rule({ requires: ["danmu:douyin"] })), workers, true).map((s) => s.id)).toEqual(["local", "worker:a"]);
  });
  it("does not query remote endpoints on a worker, without a rule, or with a disabled rule", () => {
    for (const sources of [roomLogSources(room(rule()), workers, false), roomLogSources(room(), workers, true), roomLogSources(room(rule({ enabled: false })), workers, true)]) {
      expect(sources).toEqual([local]);
    }
  });
  it("represents no nodes, missing local tasks and dangling assignments explicitly", async () => {
    expect(roomLogSources(room(rule()), [], true)).toEqual([local]);
    const missing = roomLogSources({ ...room(rule({ workers: ["gone", "gone"] })), recording: null }, workers, true);
    const api = client();
    expect((await read(missing, api)).map((r) => r.status)).toEqual(["noTask", "missing"]);
    expect(api.getTaskLogs).not.toHaveBeenCalled();
    expect(api.getNodeTasks).not.toHaveBeenCalled();
  });
  it("matches both platform and room slug, never a master task ID or a friendly name", () => {
    const unrelated = [
      { id: 7, platform: "bilibili", roomSlug: "123" },
      { id: 8, platform: "douyin", roomSlug: "other", name: "123" },
    ] as NodeTasksDTO["tasks"];
    expect(matchRoomLogTask([...unrelated, ...tasks(81)], identity)).toEqual({ status: "matched", taskId: 81 });
    expect(matchRoomLogTask(unrelated, identity)).toEqual({ status: "noTask" });
    expect(matchRoomLogTask([...tasks(81), ...tasks(82)], identity)).toEqual({ status: "ambiguous" });
  });
  it("skips ambiguous / absent node tasks rather than picking the first", async () => {
    const api = client();
    api.getNodeTasks = vi.fn(async (workerId) => ({ workerId, tasks: workerId === "a" ? [...tasks(81), ...tasks(82)] : [] }));
    expect((await read([remote("a"), remote("b")], api)).map((r) => r.status)).toEqual(["ambiguous", "noTask"]);
    expect(api.getNodeTaskLogs).not.toHaveBeenCalled();
  });
  it("reads logs by each node's own matched ID with a bounded tail", async () => {
    const api = client();
    await read([local, remote("a")], api);
    expect(api.getTaskLogs).toHaveBeenCalledWith(7);
    expect(api.getNodeTaskLogs).toHaveBeenCalledWith("a", 81, ROOM_LOG_MAX_LINES);
  });
});

describe("independent allSettled room log reader", () => {
  it("reads multiple sources concurrently, publishing healthy results before a slow one", async () => {
    const slow = deferred<NodeTasksDTO>();
    const api = client();
    api.getNodeTasks = vi.fn((workerId) => workerId === "a" ? slow.promise : Promise.resolve({ workerId, tasks: tasks() }));
    const published: RoomLogResult[] = [];
    const reader = createRoomLogReader([local, remote("a"), remote("b")], identity, api, (r) => published.push(r));
    const pending = reader.refresh();
    await vi.waitFor(() => expect(published.map((r) => r.source.id)).toEqual(["local", "worker:b"]));
    slow.resolve({ workerId: "a", tasks: tasks() });
    await pending;
    expect(published.map((r) => r.source.id)).toEqual(["local", "worker:b", "worker:a"]);
  });
  it("keeps local and other workers when one task-list request rejects", async () => {
    const api = client();
    api.getNodeTasks = vi.fn(async (workerId) => {
      if (workerId === "a") throw new Error("SSH connection refused");
      return { workerId, tasks: tasks() };
    });
    const rows = await read([local, remote("a"), remote("b")], api);
    expect(rows.find((r) => r.source.id === "worker:a")).toMatchObject({ status: "unavailable", error: "SSH connection refused" });
    expect(rows.filter((r) => r.status === "ready")).toHaveLength(2);
  });
  it("keeps worker logs when the local reader fails", async () => {
    const api = client();
    api.getTaskLogs = vi.fn(async () => { throw new Error("HTTP 503"); });
    const rows = await read([local, remote("a")], api);
    expect(rows.find((r) => r.source.id === "local")?.status).toBe("unavailable");
    expect(rows.find((r) => r.source.id === "worker:a")?.lines).toEqual(["a line"]);
  });
  it.each(["unknown command '_tasks'", "节点 bundle 过旧,不支持日志代查(需升级节点)", "未知命令", "unsupported node type"])("distinguishes an old/unsupported node: %s", async (error) => {
    const api = client();
    api.getNodeTasks = vi.fn(async (workerId) => ({ workerId, tasks: [], error }));
    expect((await read([remote("a")], api))[0]).toMatchObject({ status: "unsupported", error, lines: [] });
    expect(api.getNodeTaskLogs).not.toHaveBeenCalled();
  });
  it("distinguishes logs endpoint old-node errors, explicit unreachability and successful empty logs", async () => {
    const api = client();
    api.getNodeTaskLogs = vi.fn(async (workerId, taskId) => ({ workerId, taskId, lines: [],
      ...(workerId === "a" ? { error: "unknown command '_task-logs'" } : workerId === "b" ? { error: "Connection timed out" } : {}),
    }));
    const rows = await read([remote("a"), remote("b"), remote("c")], api);
    expect(rows.map((r) => r.status)).toEqual(["unsupported", "unavailable", "empty"]);
  });
  it("settles rejected log requests and clears previous successful lines on a later failure", async () => {
    const api = client();
    const published: RoomLogResult[] = [];
    const reader = createRoomLogReader([remote("a")], identity, api, (r) => published.push(r));
    await reader.refresh();
    api.getNodeTaskLogs = vi.fn(async () => { throw new Error("unreachable"); });
    await expect(reader.refresh()).resolves.toBeDefined();
    expect(published.map((r) => r.status)).toEqual(["ready", "unavailable"]);
    expect(published[1].lines).toEqual([]);
  });
  it("does not overlap a slow source, but allows healthy sources to refresh", async () => {
    const api = client();
    const slow = deferred<NodeTasksDTO>();
    api.getNodeTasks = vi.fn(() => slow.promise);
    const published = vi.fn();
    const reader = createRoomLogReader([local, remote("a")], identity, api, published);
    const first = reader.refresh();
    await vi.waitFor(() => expect(published).toHaveBeenCalledTimes(1));
    await reader.refresh();
    expect(api.getTaskLogs).toHaveBeenCalledTimes(2);
    expect(api.getNodeTasks).toHaveBeenCalledTimes(1);
    slow.resolve({ workerId: "a", tasks: [] });
    await first;
  });
  it("discards old replies across A -> B -> A room switching and prevents refresh after cleanup", async () => {
    const api = client();
    const slow = deferred<{ lines: string[] }>();
    api.getTaskLogs = vi.fn(() => slow.promise);
    const published: string[] = [];
    const oldA = createRoomLogReader([local], identity, api, () => published.push("old A"));
    const pendingA = oldA.refresh();
    oldA.cancel();
    const b = createRoomLogReader([local], { ...identity, roomSlug: "456" }, client(), () => published.push("B"));
    await b.refresh();
    b.cancel();
    const newA = createRoomLogReader([local], identity, client(), () => published.push("new A"));
    await newA.refresh();
    slow.resolve({ lines: ["stale"] });
    await pendingA;
    await oldA.refresh();
    expect(api.getTaskLogs).toHaveBeenCalledTimes(1);
    expect(published).toEqual(["B", "new A"]);
  });
  it("bounds even unexpectedly large responses", async () => {
    const api = client();
    api.getTaskLogs = vi.fn(async () => ({ lines: Array.from({ length: 800 }, (_, i) => String(i)) }));
    expect((await read([local], api))[0].lines).toEqual(Array.from({ length: 500 }, (_, i) => String(i + 300)));
  });
});

describe("room log merge, filter and caps", () => {
  it("merges explicit timezone timestamps across sources, keeping deterministic tie order", () => {
    const rows = [result(local, ["2026-11-21T01:00:02Z second", "[2026-11-21T01:00:03Z] third"]),
      result(remote("a"), ["2026-11-21T09:00:01+08:00 first", "2026-11-21T01:00:03Z tied"])];
    const merged = mergeRoomLogs(rows, null, 200);
    expect(merged.mode).toBe("time");
    expect(merged.entries.map((e) => e.text.split(" ").at(-1))).toEqual(["first", "second", "third", "tied"]);
    expect(mergeRoomLogs(rows, null, 2).entries.map((e) => e.text.split(" ").at(-1))).toEqual(["third", "tied"]);
  });
  it.each(["plain text", "[12:34:56] time only", "2026-11-21 12:34:56 naive", "2026-11-21T12:34:56 naive", "2026-99-21T12:34:56Z invalid", "prefix 2026-11-21T12:34:56Z embedded"])("does not invent a timestamp for %s", (text) => {
    expect(roomLogTimestamp(text)).toBeNull();
  });
  it("groups the whole mixed tail, preserving source order rather than concatenating a fake chronology", () => {
    const rows = [result(local, ["2026-11-21T01:00:03Z last", "stack trace"]), result(remote("a"), ["2026-11-21T01:00:01Z first"])];
    const merged = mergeRoomLogs(rows, null, 200);
    expect(merged.mode).toBe("grouped");
    expect(merged.entries.map((e) => e.text)).toEqual(rows.flatMap((r) => r.lines));
    expect(merged.entries.map((e) => e.source.id)).toEqual(["local", "local", "worker:a"]);
  });
  it("shares a strict global grouped limit fairly and keeps the newest lines of each source", () => {
    const rows = [result(local, ["h1", "h2", "h3"]), result(remote("a"), ["a1", "a2", "a3"]), result(remote("b"), ["b1", "b2", "b3"])];
    expect(mergeRoomLogs(rows, null, 5)).toMatchObject({ total: 9, mode: "grouped", entries: [
      { text: "h2" }, { text: "h3" }, { text: "a2" }, { text: "a3" }, { text: "b3" },
    ] });
    expect(mergeRoomLogs(rows, null, 0).entries).toEqual([]);
    expect(mergeRoomLogs(rows, null, -2).entries).toEqual([]);
  });
  it("filters before ordering and capping; a missing source produces no lines", () => {
    const rows = [result(local, ["no clock"]), result(remote("a"), ["2026-11-21T01:00:01Z first", "2026-11-21T01:00:02Z second"])];
    expect(mergeRoomLogs(rows, "worker:a", 1)).toMatchObject({ total: 2, mode: "time", entries: [{ text: "2026-11-21T01:00:02Z second" }] });
    expect(mergeRoomLogs(rows, "absent", 200)).toMatchObject({ total: 0, entries: [] });
    expect(mergeRoomLogs([], null, 200).entries).toEqual([]);
  });
  it("never exceeds the hard cap and handles non-finite limits", () => {
    const rows = [result(local, Array.from({ length: 900 }, (_, i) => `line ${i}`))];
    expect(mergeRoomLogs(rows, null, Infinity).entries).toHaveLength(200);
    expect(mergeRoomLogs(rows, null, NaN).entries).toHaveLength(200);
    expect(mergeRoomLogs(rows, null, 900).entries).toHaveLength(500);
    expect(mergeRoomLogs(rows, null, 1.9).entries).toHaveLength(1);
  });
});

describe("room-only component integration (static; no live API)", () => {
  const source = (file: string): string => readFileSync(new URL(`../../packages/web/src/${file}`, import.meta.url), "utf8");
  it("only replaces the room reader and also mounts for rooms without a local task", () => {
    const page = source("pages/RoomPage.tsx");
    expect(page).toContain('<RoomLogPanel room={room} workers={data.workers} nodes={vis.nodes}');
    expect(page).not.toContain("TaskLogPanel");
    expect(page).not.toMatch(/taskId !== null && \([\s\S]{0,100}<RoomLogPanel/);
    expect(source("components/LogTerminal.tsx")).toContain("export function TaskLogPanel");
    expect(source("components/LogTerminal.tsx")).toContain("api.getTaskLogs(taskId)");
  });
  it("keys session identity, invalidates pending reads on cleanup, and exposes responsive labelled controls", () => {
    const panel = source("components/RoomLogPanel.tsx");
    expect(panel).toContain("key={JSON.stringify([room.key, room.platform, room.roomSlug, sources])}");
    expect(panel).toContain("reader.cancel(); clearInterval(timer)");
    expect(panel).toContain('if (!open) return');
    expect(panel).toContain('t("room.logs.source")');
    expect(panel).toContain('t("room.logs.limit")');
    expect(panel.match(/<label/g)).toHaveLength(2);
    expect(panel).toContain("min-w-0 max-w-full");
    expect(panel).toContain("flex flex-wrap");
    expect(panel).toContain("break-all");
    expect(panel).toContain("`[${label(entry.source)}] ${entry.text}`");
    expect(panel).toContain("<LogTerminal");
  });
});
