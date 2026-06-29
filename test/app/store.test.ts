import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../../packages/app/src/store.js";
import { openDb, migrate } from "../../packages/app/src/db.js";

describe("TaskStore", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "douyin-rec-test-"));
    dbPath = join(dir, "tasks.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("add → get → list → setStatus → remove", () => {
    const store = new TaskStore(dbPath);

    const t = store.addTask({
      room: "767116735823",
      name: "一勺小苏打",
      quality: "origin",
      danmu: 1,
      segmentSec: 1800,
    });
    expect(t.id).toBeGreaterThan(0);
    expect(t.room).toBe("https://live.douyin.com/767116735823"); // 裸号入库归一化为规范 URL
    expect(t.name).toBe("一勺小苏打");
    expect(t.status).toBe("stopped");
    expect(t.engine).toBe("ffmpeg");
    expect(typeof t.createdAt).toBe("string");

    const got = store.getTask(t.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(t.id);
    expect(got!.danmu).toBe(1);

    const list = store.listTasks();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(t.id);

    expect(store.setStatus(t.id, "running")).toBe(true);
    expect(store.getTask(t.id)!.status).toBe("running");

    expect(store.removeTask(t.id)).toBe(true);
    expect(store.getTask(t.id)).toBeNull();
    expect(store.listTasks()).toHaveLength(0);
    store.close();
  });

  it("addTask 归一化房间地址:任何格式 → https://live.douyin.com/{id}", () => {
    const store = new TaskStore(dbPath);
    // 带 query 的 URL → 剥 query
    const a = store.addTask({
      room: "https://live.douyin.com/411477943168?activity_name=&anchor_id=758019140624780&banner_type=recommend",
    });
    expect(a.room).toBe("https://live.douyin.com/411477943168");
    // 裸房间号 → 拼成规范 URL
    const b = store.addTask({ room: "767116735823" });
    expect(b.room).toBe("https://live.douyin.com/767116735823");
    // 编辑同理
    const c = store.updateTask(a.id, { room: "https://live.douyin.com/603532021677?x=1" });
    expect(c!.room).toBe("https://live.douyin.com/603532021677");
    // 非数字串(如短链占位/未知)不硬拼 URL
    const d = store.addTask({ room: "v.douyin.com/abcXYZ" });
    expect(d.room).toBe("v.douyin.com/abcXYZ");
    store.close();
  });

  it("addTask 按 platform.engines 校验 engine:非法→平台默认,合法保留", () => {
    const store = new TaskStore(dbPath);
    expect(store.addTask({ room: "111", engine: "mesio" }).engine).toBe("mesio");
    expect(store.addTask({ room: "111", engine: "bogus-engine" }).engine).toBe("ffmpeg");
    store.close();
  });

  it("addTask 按 platform 校验 quality(danmu 已退化为开关,无 provider 校验)", () => {
    const store = new TaskStore(dbPath);
    expect(store.addTask({ room: "111", quality: "hd" }).quality).toBe("hd"); // 合法保留
    expect(store.addTask({ room: "111", quality: "8k-bogus" }).quality).toBe("origin"); // 非法→默认
    // 弹幕只剩 danmu(0/1)开关,来源由命中平台的 connectDanmu 提供,store 不再有 danmuProvider 校验。
    expect(store.addTask({ room: "111", danmu: 1 }).danmu).toBe(1);
    expect(store.addTask({ room: "111", danmu: 0 }).danmu).toBe(0);
    store.close();
  });

  it("updateTask 跳过空白 room(不写 \"\" 进 NOT NULL 列)", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({ room: "111" });
    const before = t.room;
    const updated = store.updateTask(t.id, { room: "   ", name: "x" });
    expect(updated!.name).toBe("x");
    expect(updated!.room).toBe(before); // room 未被清空
    store.close();
  });

  it("updateTask 改 room 跨平台 → platform 列 + recorder/quality/danmu 切到新平台默认", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({ room: "https://live.douyin.com/123" });
    expect(t.platform).toBe("douyin");
    expect(t.engine).toBe("ffmpeg");
    expect(t.quality).toBe("origin");
    // 只改 room 到 bilibili → 平台重判,quality 对 bilibili 非法 → 重置为新平台默认;engine 同档
    // (ffmpeg 两平台都合法,保留)。
    const u = store.updateTask(t.id, { room: "https://live.bilibili.com/6" })!;
    expect(u.platform).toBe("bilibili");
    expect(u.engine).toBe("ffmpeg");
    expect(u.quality).toBe("10000");
    store.close();
  });

  it("applies defaults for omitted fields", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({ room: "abc" });
    expect(t.quality).toBe("origin");
    expect(t.engine).toBe("ffmpeg");
    expect(t.danmu).toBe(1);
    expect(t.segmentSec).toBe(1800);
    expect(t.cookies).toBeNull();
    expect(t.outDir).toBeNull();
    expect(t.scheduleStart).toBeNull();
    expect(t.useCookie).toBe(true);
    store.close();
  });

  it("persists useCookie true/false and round-trips as a boolean", () => {
    const store = new TaskStore(dbPath);

    const on = store.addTask({ room: "with", useCookie: true });
    const off = store.addTask({ room: "without", useCookie: false });
    expect(on.useCookie).toBe(true);
    expect(off.useCookie).toBe(false);
    // Read back through getTask + listTasks — stays boolean (not 0/1).
    expect(store.getTask(on.id)!.useCookie).toBe(true);
    expect(store.getTask(off.id)!.useCookie).toBe(false);
    const list = store.listTasks();
    expect(typeof list[0].useCookie).toBe("boolean");
    expect(list.find((t) => t.id === off.id)!.useCookie).toBe(false);
    store.close();
  });

  it("defaults useCookie to true when omitted", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({ room: "default-on" });
    expect(t.useCookie).toBe(true);
    store.close();
  });

  it("migrates an OLD db (no useCookie column) → adds it with default 1 for existing rows", () => {
    // Hand-build a pre-feature db: tasks table WITHOUT the useCookie column,
    // plus an existing row. Then run migrate() and confirm the column is
    // backfilled and existing rows read back as useCookie=true.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        room         TEXT NOT NULL,
        name         TEXT,
        quality      TEXT DEFAULT 'origin',
        recorder     TEXT DEFAULT 'bililive',
        danmu        INTEGER DEFAULT 1,
        segmentSec   INTEGER DEFAULT 1800,
        cookies      TEXT,
        outDir       TEXT,
        scheduleStart TEXT,
        scheduleEnd  TEXT,
        status       TEXT DEFAULT 'stopped',
        createdAt    TEXT
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    raw.prepare(`INSERT INTO tasks (room, createdAt) VALUES (?, ?)`).run(
      "legacy",
      "2026-06-12T00:00:00.000Z",
    );
    // Column absent before migration.
    const before = raw.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    expect(before.some((c) => c.name === "useCookie")).toBe(false);

    migrate(raw);

    // Column present + idempotent (second migrate is a no-op, no throw).
    migrate(raw);
    raw.close();

    const store = new TaskStore(dbPath);
    const list = store.listTasks();
    expect(list).toHaveLength(1);
    expect(list[0].room).toBe("legacy");
    expect(list[0].useCookie).toBe(true);
    // New rows still default to true after migration.
    const fresh = store.addTask({ room: "post-migrate" });
    expect(fresh.useCookie).toBe(true);
    store.close();
  });

  it("updateTask updates only the provided fields, leaving others untouched", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({
      room: "111",
      name: "old",
      quality: "origin",
      danmu: 1,
      segmentSec: 1800,
      useCookie: true,
    });

    const updated = store.updateTask(t.id, { name: "new", quality: "hd" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("new");
    expect(updated!.quality).toBe("hd");
    // untouched fields stay the same
    expect(updated!.room).toBe("https://live.douyin.com/111");
    expect(updated!.danmu).toBe(1);
    expect(updated!.segmentSec).toBe(1800);
    expect(updated!.useCookie).toBe(true);
    store.close();
  });

  it("updateTask round-trips booleans (useCookie) as 0/1 ↔ boolean", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({ room: "111", useCookie: true });

    const off = store.updateTask(t.id, { useCookie: false });
    expect(off!.useCookie).toBe(false);
    expect(typeof store.getTask(t.id)!.useCookie).toBe("boolean");

    const on = store.updateTask(t.id, { useCookie: true });
    expect(on!.useCookie).toBe(true);
    store.close();
  });

  it("updateTask returns null for a missing id", () => {
    const store = new TaskStore(dbPath);
    expect(store.updateTask(9999, { name: "x" })).toBeNull();
    store.close();
  });

  it("updateTask never changes id / createdAt / status", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({ room: "111", name: "orig" });
    store.setStatus(t.id, "running");

    const updated = store.updateTask(t.id, { name: "renamed", room: "222" });
    expect(updated!.id).toBe(t.id);
    expect(updated!.createdAt).toBe(t.createdAt);
    expect(updated!.status).toBe("running");
    store.close();
  });

  it("updateTask with an empty patch is a no-op (returns task unchanged)", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({ room: "111", name: "keep" });
    const updated = store.updateTask(t.id, {});
    expect(updated!.name).toBe("keep");
    expect(updated!.room).toBe("https://live.douyin.com/111");
    store.close();
  });

  it("updateTask can clear nullable fields (name → null)", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({ room: "111", name: "had-name" });
    const updated = store.updateTask(t.id, { name: null });
    expect(updated!.name).toBeNull();
    store.close();
  });

  it("stores schedule fields without acting on them", () => {
    const store = new TaskStore(dbPath);
    const t = store.addTask({
      room: "abc",
      scheduleStart: "06:00",
      scheduleEnd: "09:00",
    });
    expect(t.scheduleStart).toBe("06:00");
    expect(t.scheduleEnd).toBe("09:00");
    store.close();
  });

  it("getTask / removeTask on missing id behave cleanly", () => {
    const store = new TaskStore(dbPath);
    expect(store.getTask(9999)).toBeNull();
    expect(store.removeTask(9999)).toBe(false);
    expect(store.setStatus(9999, "running")).toBe(false);
    store.close();
  });

  it("settings get/set with upsert", () => {
    const store = new TaskStore(dbPath);
    expect(store.getSetting("discordWebhook")).toBeNull();
    store.setSetting("discordWebhook", "https://example/hook");
    expect(store.getSetting("discordWebhook")).toBe("https://example/hook");
    // upsert overwrites
    store.setSetting("discordWebhook", "https://example/hook2");
    expect(store.getSetting("discordWebhook")).toBe("https://example/hook2");
    store.close();
  });

  it("migration is idempotent — open twice, data persists", () => {
    const store1 = new TaskStore(dbPath);
    const t = store1.addTask({ room: "persist-me" });
    store1.close();

    // Reopen same file — migrate() runs again (CREATE TABLE IF NOT EXISTS).
    const store2 = new TaskStore(dbPath);
    const got = store2.getTask(t.id);
    expect(got).not.toBeNull();
    expect(got!.room).toBe("persist-me");
    store2.close();

    // openDb directly twice on same path must not throw.
    const d1 = openDb(dbPath);
    d1.close();
    const d2 = openDb(dbPath);
    d2.close();
  });

  it("accepts an externally provided DatabaseSync", () => {
    const db = openDb(dbPath);
    const store = new TaskStore(db);
    const t = store.addTask({ room: "external-db" });
    expect(store.getTask(t.id)!.room).toBe("external-db");
    db.close();
  });

  it("pipeline 配置:addTask 存 + getTask 取(JSON 往返),updateTask 改,默认 null", () => {
    const store = new TaskStore(dbPath);
    // 默认无 pipeline
    const a = store.addTask({ room: "no-pipe" });
    expect(store.getTask(a.id)!.pipeline).toBeNull();
    // 带 pipeline 配置
    const cfg = { sync: true, steps: { burnDanmu: false }, cleanup: { sourceAfterDone: true }, upload: { mode: "stage-only" as const, tag: "t", tid: 21 } };
    const b = store.addTask({ room: "with-pipe", pipeline: cfg });
    expect(store.getTask(b.id)!.pipeline).toEqual(cfg);
    // updateTask 改 pipeline
    store.updateTask(b.id, { pipeline: { sync: false } });
    expect(store.getTask(b.id)!.pipeline).toEqual({ sync: false });
    // 清空
    store.updateTask(b.id, { pipeline: null });
    expect(store.getTask(b.id)!.pipeline).toBeNull();
    store.close();
  });
});
