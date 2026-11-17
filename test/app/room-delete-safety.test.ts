import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HUB_TABLE_NAMES, jobLogPathCandidates } from "@drec/core";
import { TaskStore } from "../../packages/app/src/store.js";
import * as hubStore from "../../packages/app/src/hub-store.js";
import { makeApi, type ManagerLike } from "../../packages/app/src/web/api.js";
import { deleteHubHistory } from "../../packages/orchestrator/src/ledger-history.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function apiWithRoom(
  syncDbPath?: string,
  deleteHistory?: (dbPath: string, roomKey: string) => { deleted: number; streamKeys: string[] },
) {
  const root = mkdtempSync(join(tmpdir(), "room-delete-guard-"));
  roots.push(root);
  const hubDir = join(root, "hub");
  mkdirSync(hubDir);
  const hubConfigPath = join(root, "hub.config.json");
  writeFileSync(hubConfigPath, JSON.stringify({ workers: [{ id: "local", kind: "local", dataRoot: root }] }));
  const store = new TaskStore(":memory:");
  const manager = { isRunning: () => false, getAnchorName: () => null } as unknown as ManagerLike;
  const task = store.addTask({ room: "123456" });
  hubStore.upsertHubRule(hubDir, {
    platform: "douyin", roomSlug: "123456", room: task.room, recording: { sourceTaskId: task.id },
  });
  const api = makeApi({
    store, manager, hubDir, hubConfigPath, hubEnabled: true,
    ...(syncDbPath ? { syncDbPath } : {}),
    ...(deleteHistory ? { deleteHubHistory: deleteHistory } : {}),
  });
  return { api, store, task, hubDir };
}

function malformedLedger(): string {
  const root = mkdtempSync(join(tmpdir(), "room-delete-malformed-"));
  roots.push(root);
  const dbPath = join(root, "sync.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE sync_jobs (wrongKey TEXT, state TEXT)");
  db.close();
  return dbPath;
}

function emptyLedger(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "room-delete-active-"));
  roots.push(root);
  const dbPath = join(root, "sync.db");
  const db = new DatabaseSync(dbPath);
  for (const table of HUB_TABLE_NAMES) {
    db.exec(`CREATE TABLE ${table} (streamKey TEXT PRIMARY KEY, state TEXT, updatedAt INTEGER)`);
  }
  db.close();
  return { root, dbPath };
}

function addLateActiveRun(dbPath: string, root: string, streamKey: string): string {
  const db = new DatabaseSync(dbPath);
  for (const table of HUB_TABLE_NAMES) {
    db.prepare("INSERT INTO " + table + "(streamKey, state, updatedAt) VALUES(?, ?, 1)")
      .run(streamKey, "merging");
  }
  db.close();
  const logPath = jobLogPathCandidates(root, streamKey, root)[0]!;
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, "late active run log");
  return logPath;
}

function expectHistoryRetained(dbPath: string, streamKey: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const table of HUB_TABLE_NAMES) {
      expect(db.prepare("SELECT * FROM " + table + " WHERE streamKey = ?").all(streamKey))
        .toEqual([{ streamKey, state: "merging", updatedAt: 1 }]);
    }
  } finally {
    db.close();
  }
}

describe("room deletion safety", () => {
  it.each([
    ["room", "task", "false"],
    ["room", "task", "exception"],
    ["room", "rule", "false"],
    ["room", "rule", "exception"],
    ["rule", "rule", "false"],
    ["rule", "rule", "exception"],
  ])("%s deletion reports a %s %s and supports retry", (route, target, failure) => {
    const { root, dbPath } = emptyLedger();
    const streamKey = "douyin:123456:finished-run";
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO sync_jobs VALUES (?, 'done', 1)").run(streamKey);
    db.close();
    const logPath = jobLogPathCandidates(root, streamKey, root)[0]!;
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "completed run log");
    const deleteHistory = (path: string, roomKey: string) =>
      deleteHubHistory({ syncDbPath: path, roomKey, stageDir: root, logsDir: root });
    const { api, store, task, hubDir } = apiWithRoom(dbPath, deleteHistory);
    const remove = target === "task"
      ? vi.spyOn(store, "removeTask")
      : vi.spyOn(hubStore, "removeHubRule");
    remove.mockImplementationOnce(() => {
      if (failure === "exception") throw new Error(target === "task" ? "SQLITE_BUSY" : "EACCES");
      return false;
    });
    const deleteTarget = () => route === "room" ? api.deleteRoom("douyin.123456") : api.deleteHubRule("douyin.123456");
    const taskRemoved = route === "room" && target === "rule";
    try {
      const result = deleteTarget();
      expect(result.status).toBe(500);
      expect((result.body as { error: string }).error).toContain("Processing history has already been cleared");
      expect((result.body as { error: string }).error).toContain("Retry " + route + " deletion");
      expect((result.body as { error: string }).error.includes("Recording task has also been removed")).toBe(taskRemoved);
      expect(store.getTask(task.id) === null).toBe(taskRemoved);
      expect(hubStore.getHubRule(hubDir, "douyin.123456")).not.toBeNull();
      expect(existsSync(logPath)).toBe(false);
      expect(deleteHistory(dbPath, "douyin.123456").deleted).toBe(0);
      expect(deleteTarget().status).toBe(200);
      expect(store.getTask(task.id) === null).toBe(route === "room");
      expect(hubStore.getHubRule(hubDir, "douyin.123456")).toBeNull();
    } finally { store.close(); }
  });

  it("preserves configuration when the ledger dependency is not configured", () => {
    const { api, store, task, hubDir } = apiWithRoom();
    const result = api.deleteRoom("douyin.123456");
    expect(result.status).toBe(503);
    expect(store.getTask(task.id)).not.toBeNull();
    expect(hubStore.getHubRule(hubDir, "douyin.123456")).not.toBeNull();
    expect(api.deleteHubRule("douyin.123456").status).toBe(503);
    expect(hubStore.getHubRule(hubDir, "douyin.123456")).not.toBeNull();
    store.close();
  });

  it("preserves task and rule when the read guard cannot query", () => {
    const dbPath = malformedLedger();
    const deleteHistory = vi.fn(() => ({ deleted: 0, streamKeys: [] }));
    const { api, store, task, hubDir } = apiWithRoom(dbPath, deleteHistory);
    const result = api.deleteRoom("douyin.123456");
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(store.getTask(task.id)).not.toBeNull();
    expect(hubStore.getHubRule(hubDir, "douyin.123456")).not.toBeNull();
    expect(deleteHistory).not.toHaveBeenCalled();
    expect(api.deleteHubRule("douyin.123456").status).toBeGreaterThanOrEqual(400);
    expect(hubStore.getHubRule(hubDir, "douyin.123456")).not.toBeNull();
    expect(store.getTask(task.id)).not.toBeNull();
    expect(deleteHistory).not.toHaveBeenCalled();
    store.close();
  });

  it("preserves room configuration when a run becomes active before the writer recheck", () => {
    const { root, dbPath } = emptyLedger();
    let logPath = "";
    const deleteHistory = vi.fn((path: string, roomKey: string) => {
      logPath = addLateActiveRun(path, root, "douyin:123456:late-run");
      return deleteHubHistory({ syncDbPath: path, roomKey, stageDir: root, logsDir: root });
    });
    const { api, store, task, hubDir } = apiWithRoom(dbPath, deleteHistory);
    const result = api.deleteRoom("douyin.123456");
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(store.getTask(task.id)).not.toBeNull();
    expect(hubStore.getHubRule(hubDir, "douyin.123456")).not.toBeNull();
    expect(deleteHistory).toHaveBeenCalledOnce();
    expectHistoryRetained(dbPath, "douyin:123456:late-run");
    expect(existsSync(logPath)).toBe(true);
    store.close();
  });

  it("preserves the rule, ledger row, and log when a run starts after the rule preflight", () => {
    const { root, dbPath } = emptyLedger();
    let logPath = "";
    const deleteHistory = vi.fn((path: string, roomKey: string) => {
      logPath = addLateActiveRun(path, root, "douyin:123456:late-rule-run");
      return deleteHubHistory({ syncDbPath: path, roomKey, stageDir: root, logsDir: root });
    });
    const { api, store, hubDir } = apiWithRoom(dbPath, deleteHistory);
    const ruleBefore = hubStore.getHubRule(hubDir, "douyin.123456");
    const result = api.deleteHubRule("douyin.123456");
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(hubStore.getHubRule(hubDir, "douyin.123456")).toEqual(ruleBefore);
    expect(deleteHistory).toHaveBeenCalledOnce();
    expectHistoryRetained(dbPath, "douyin:123456:late-rule-run");
    expect(existsSync(logPath)).toBe(true);
    store.close();
  });
});
