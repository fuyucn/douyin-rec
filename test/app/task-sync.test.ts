import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { applyRemoteTasks } from "../../packages/app/src/task-sync.js";
import type { RemoteTaskSpec } from "@drec/core";

describe("applyRemoteTasks", () => {
  let dir: string;
  let store: TaskStore;

  const spec = (over: Partial<RemoteTaskSpec> = {}): RemoteTaskSpec => ({
    platform: "douyin",
    roomSlug: "123456",
    room: "https://live.douyin.com/123456",
    name: "主播A",
    quality: "origin",
    engine: "ffmpeg",
    danmu: 1,
    segmentSec: 1800,
    scheduleStart: null,
    scheduleEnd: null,
    enabled: true,
    useCookie: true,
    cookies: null,
    outDir: null,
    webhook: null,
    anchorName: null,
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-sync-"));
    store = new TaskStore(join(dir, "tasks.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("远端默认:已存在任务收编为 hub 受管并更新 master 字段", () => {
    const existing = store.addTask({ room: "123456", name: "旧名" });
    const r = applyRemoteTasks(store, [spec({ name: "新名" })]);
    expect(r.applied).toEqual(["douyin:123456"]);
    const t = store.getTask(existing.id)!;
    expect(t.managedBy).toBe("hub");
    expect(t.name).toBe("新名");
  });

  it("远端默认:不在期望列表的受管任务被删除", () => {
    const doomed = store.addTask({ room: "555", managedBy: "hub" });
    const r = applyRemoteTasks(store, []);
    expect(r.removed).toEqual(["douyin:555"]);
    expect(store.getTask(doomed.id)).toBeNull();
  });

  it("master 本地(adopt=false):已有源任务保持可编辑,历史 hub 标记被清掉", () => {
    const src = store.addTask({ room: "123456", name: "一勺小苏打", managedBy: "hub" });
    const r = applyRemoteTasks(store, [spec({ name: "一勺小苏打" })], undefined, { adopt: false });
    expect(r.applied).toEqual(["douyin:123456"]);
    const t = store.getTask(src.id)!;
    expect(t.managedBy).toBeNull();
    expect(t.name).toBe("一勺小苏打");
  });

  it("master 本地(adopt=false):不在期望列表的本机任务不会被 hub 删除", () => {
    const local = store.addTask({ room: "999" });
    applyRemoteTasks(store, [spec()], undefined, { adopt: false });
    expect(store.getTask(local.id)).not.toBeNull();
  });

  it("master 本地(adopt=false):新建任务不标 hub 受管", () => {
    const r = applyRemoteTasks(store, [spec({ roomSlug: "777", room: "https://live.douyin.com/777" })], undefined, { adopt: false });
    expect(r.applied).toEqual(["douyin:777"]);
    const tasks = store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].managedBy).toBeNull();
  });
});
