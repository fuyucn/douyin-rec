/** issue #137:outputFormat 的 DB 迁移 / store / 任务与房间 API 校验 / 远端同步 / 节点 stage 清理识别。 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteTaskSpec } from "@drec/core";
import { TaskStore } from "../../packages/app/src/store.js";
import { listNodeTasks, applyRemoteTasks } from "../../packages/app/src/task-sync.js";
import { makeApi, type ManagerLike } from "../../packages/app/src/web/api.js";
import { nodeStageCleanupTargets, listNodeProducts } from "../../packages/app/src/node-pipeline.js";

describe("DB 迁移:老库兼容", () => {
  it("没有 outputFormat 列的老库:打开后补列,老任务读出来是 original", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-db-"));
    const p = join(dir, "old.db");
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, name TEXT, quality TEXT NOT NULL DEFAULT 'origin',
      engine TEXT NOT NULL DEFAULT 'ffmpeg', danmu INTEGER DEFAULT 1, segmentSec INTEGER DEFAULT 1800, cookies TEXT, outDir TEXT,
      scheduleStart TEXT, scheduleEnd TEXT, status TEXT DEFAULT 'stopped', createdAt TEXT)`);
    raw.exec(`INSERT INTO tasks (room, name, createdAt) VALUES ('https://live.douyin.com/111', '老任务', '2026-01-01T00:00:00Z')`);
    raw.close();
    const s = new TaskStore(p);
    expect(s.getTask(1)!.outputFormat).toBe("original");
    expect(s.updateTask(1, { outputFormat: "mkv" })!.outputFormat).toBe("mkv");
    s.close();
    // 重开(迁移幂等)后值仍在
    const s2 = new TaskStore(p);
    expect(s2.getTask(1)!.outputFormat).toBe("mkv");
    s2.close();
  });
  it("库里被手改成非白名单值 → 读取回落 original(不抛)", () => {
    const s = new TaskStore(":memory:");
    const t = s.addTask({ room: "123" });
    s.db.prepare(`UPDATE tasks SET outputFormat='avi' WHERE id=?`).run(t.id);
    expect(s.getTask(t.id)!.outputFormat).toBe("original");
  });
});

describe("store", () => {
  it("缺省 original;显式值往返;update 不带该字段时不动它", () => {
    const s = new TaskStore(":memory:");
    expect(s.addTask({ room: "1" }).outputFormat).toBe("original");
    const t = s.addTask({ room: "2", outputFormat: "mkv" });
    expect(t.outputFormat).toBe("mkv");
    expect(s.updateTask(t.id, { quality: "origin" })!.outputFormat).toBe("mkv");
    expect(s.updateTask(t.id, { outputFormat: undefined })!.outputFormat).toBe("mkv");
    expect(s.updateTask(t.id, { outputFormat: "original" })!.outputFormat).toBe("original");
  });
  it("白名单外的值被拒绝(addTask / updateTask 抛错,库不变)", () => {
    const s = new TaskStore(":memory:");
    expect(() => s.addTask({ room: "1", outputFormat: "avi" as never })).toThrow(/outputFormat/);
    const t = s.addTask({ room: "2", outputFormat: "mkv" });
    expect(() => s.updateTask(t.id, { outputFormat: "webm" as never })).toThrow(/outputFormat/);
    expect(s.getTask(t.id)!.outputFormat).toBe("mkv");
  });
});

const mgr = (): ManagerLike => ({
  runningIds: () => [], isRunning: () => false, start: () => true, stop: async () => {}, stopWithin: async () => true,
  isStopping: () => false, stopGraceful: async () => {}, getRuntime: () => ({ running: false, startedAt: null, elapsedMs: null, anchorName: null }),
  getAnchorName: () => null, isRecording: () => false, getLogs: () => [],
} as unknown as ManagerLike);

describe("任务 API 校验", () => {
  it("创建:缺省 original;合法值落库;非法值 400 且不建任务", () => {
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: mgr() });
    expect((a.createTask({ room: "1" }).body as { outputFormat: string }).outputFormat).toBe("original");
    expect((a.createTask({ room: "2", outputFormat: "mkv" }).body as { outputFormat: string }).outputFormat).toBe("mkv");
    const before = s.listTasks().length;
    const bad = a.createTask({ room: "3", outputFormat: "avi" });
    expect(bad.status).toBe(400);
    expect(s.listTasks().length).toBe(before);
  });
  it("更新:合法改值;非法 400 且原值不变;不带字段不动", () => {
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: mgr() });
    const id = (a.createTask({ room: "1", outputFormat: "mkv" }).body as { id: number }).id;
    expect(a.updateTask(id, { name: "x" }).status).toBe(200);
    expect(s.getTask(id)!.outputFormat).toBe("mkv");
    expect(a.updateTask(id, { outputFormat: "bad" }).status).toBe(400);
    expect(s.getTask(id)!.outputFormat).toBe("mkv");
    expect(a.updateTask(id, { outputFormat: "mp4" }).status).toBe(200);
    expect(s.getTask(id)!.outputFormat).toBe("mp4");
  });
});

describe("远端同步 RemoteTaskSpec", () => {
  const spec = (over: Partial<RemoteTaskSpec> = {}): RemoteTaskSpec => ({
    platform: "douyin", roomSlug: "123456", room: "https://live.douyin.com/123456", name: "A", quality: "origin",
    engine: "ffmpeg", danmu: 1, segmentSec: 1800, scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true,
    cookies: null, outDir: null, webhook: null, anchorName: null, rollingUpload: false, rollingEffective: false, ...over,
  });
  it("新节点:下发 mkv 即生效;旧 master 不下发 → original;非法值 → original(不拒绝整批)", () => {
    const s = new TaskStore(":memory:");
    applyRemoteTasks(s, [spec({ outputFormat: "mkv" })]);
    expect(s.listTasks()[0]!.outputFormat).toBe("mkv");
    applyRemoteTasks(s, [spec()]);
    expect(s.listTasks()[0]!.outputFormat).toBe("original");
    applyRemoteTasks(s, [spec({ outputFormat: "avi" as never })]);
    expect(s.listTasks()[0]!.outputFormat).toBe("original");
  });
  it("节点清单(_tasks)带回 outputFormat", () => {
    const s = new TaskStore(":memory:");
    s.addTask({ room: "https://live.douyin.com/9", outputFormat: "mkv" });
    expect(listNodeTasks(s)[0]!.outputFormat).toBe("mkv");
  });
});

describe("节点 stage 清理识别 mkv", () => {
  it("nodeStageCleanupTargets / listNodeProducts:mkv 产物与 mp4/ts 同类;xml 不动", () => {
    const d = mkdtempSync(join(tmpdir(), "of-node-"));
    for (const f of ["a.mp4", "b.mkv", "c.ts", "a.xml", "job.log"]) writeFileSync(join(d, f), "x");
    mkdirSync(join(d, ".work"));
    const t = nodeStageCleanupTargets(d).map((p) => p.replace(d + "/", "")).sort();
    expect(t).toEqual([".work", "a.mp4", "b.mkv", "c.ts"]);
    expect(listNodeProducts(d).map((p) => p.replace(d + "/", "")).sort()).toEqual(["a.mp4", "b.mkv", "c.ts"]);
  });
});

describe("房间 API(录制半边)往返与校验", () => {
  function setup() {
    const hubDir = mkdtempSync(join(tmpdir(), "of-rooms-"));
    const hubConfigPath = join(hubDir, "hub.config.json");
    writeFileSync(hubConfigPath, JSON.stringify({ workers: [{ id: "local", name: "本机", kind: "local", dataRoot: "/data" }] }));
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: mgr(), hubDir, hubConfigPath });
    const t = a.createTask({ room: "123456", name: "主播" }).body as { id: number };
    expect(a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] }).status).toBe(201);
    return { s, a, id: t.id };
  }
  it("GET 录制半边带 outputFormat(缺省 original);PUT 写入后再 GET 一致,源任务同步变化", () => {
    const { s, a, id } = setup();
    const get = (): string => (a.getRoom("douyin.123456").body as { recording: { outputFormat: string } }).recording.outputFormat;
    expect(get()).toBe("original");
    expect(a.updateRoom("douyin.123456", { recording: { outputFormat: "mkv" } }).status).toBe(200);
    expect(get()).toBe("mkv");
    expect(s.getTask(id)!.outputFormat).toBe("mkv");
  });
  it("PUT 非法值 → 400,原值不变", () => {
    const { s, a, id } = setup();
    a.updateRoom("douyin.123456", { recording: { outputFormat: "mp4" } });
    const bad = a.updateRoom("douyin.123456", { recording: { outputFormat: "avi" as never } });
    expect(bad.status).toBe(400);
    expect(s.getTask(id)!.outputFormat).toBe("mp4");
  });
  it("PUT 不带该字段(旧客户端)→ 不动", () => {
    const { s, a, id } = setup();
    a.updateRoom("douyin.123456", { recording: { outputFormat: "mkv" } });
    a.updateRoom("douyin.123456", { recording: { quality: "origin" } });
    expect(s.getTask(id)!.outputFormat).toBe("mkv");
  });
});
