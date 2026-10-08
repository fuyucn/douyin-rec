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

  // T-4:worker 录制时会自抓主播名并持久化;master 侧该值常为 null(只在建/改房间时抓一次)。
  // 若下发时带 `anchorName: null`,会把 worker 抓到的正确值覆盖成空 → 界面主播名消失。
  it("T-4: 更新已有任务时不下发 anchorName(null 不覆盖 worker 自抓的值)", () => {
    const existing = store.addTask({ room: "123456", name: "旧名" });
    store.setAnchorName(existing.id, "worker 抓到的名");   // 模拟 worker 录制时自抓
    applyRemoteTasks(store, [spec({ anchorName: null })]);
    expect(store.getTask(existing.id)!.anchorName).toBe("worker 抓到的名");   // 未被 null 覆盖
  });
  it("T-4: 新建受管任务预置 master 的 anchorName(非 null)", () => {
    applyRemoteTasks(store, [spec({ anchorName: "master 侧的名字" })]);
    const t = store.listTasks().find((x) => x.room.includes("123456"))!;
    expect(t.anchorName).toBe("master 侧的名字");   // 预置,避免 Waiting 阶段显示房间号
  });
  it("T-4: 新建受管任务 anchorName 为 null 时不出错", () => {
    applyRemoteTasks(store, [spec({ anchorName: null })]);
    const t = store.listTasks().find((x) => x.room.includes("123456"))!;
    expect(t.anchorName).toBeNull();
  });

  it("远端默认:不在期望列表的受管任务被删除", () => {
    const doomed = store.addTask({ room: "555", managedBy: "hub" });
    const r = applyRemoteTasks(store, []);
    expect(r.removed).toEqual(["douyin:555"]);
    expect(store.getTask(doomed.id)).toBeNull();
  });

  it("期望任务已禁用但仍在运行:置 pending 硬停而不是等排空", () => {
    const live = store.addTask({ room: "123456", managedBy: "hub" });
    store.setStatus(live.id, "draining");
    const r = applyRemoteTasks(store, [spec({ enabled: false })]);
    expect(r.pending).toEqual(["douyin:123456"]);
    const t = store.getTask(live.id)!;
    expect(t.enabled).toBe(false);
    expect(t.status).toBe("draining"); // 硬停由 _apply-tasks / master manager 执行
  });

  it("期望任务已禁用且已停止:不再进 pending(避免每轮重复硬停)", () => {
    const done = store.addTask({ room: "123456", managedBy: "hub" });
    const r = applyRemoteTasks(store, [spec({ enabled: false })]);
    expect(r.pending).toEqual([]);
    expect(store.getTask(done.id)!.enabled).toBe(false);
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
