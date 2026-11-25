/**
 * db-merge 用例(issue #750):把历史的 3 个兄弟库并进控制库。
 * 覆盖:空库不动、三库并有数据、upload_limits 逐 key 取并集、重复执行幂等、旧库原样保留。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mergeLegacyDatabases } from "./db-merge.js";
import { migrate } from "./db.js";
import { CONTROL_DB_NAME } from "./paths.js";

function scene() {
  const dir = mkdtempSync(join(tmpdir(), "db-merge-"));
  return {
    dir,
    control: join(dir, CONTROL_DB_NAME),
    legacy: {
      main: join(dir, "douyin-rec.db"),
      sync: join(dir, "douyin-rec-sync.db"),
      stats: join(dir, "room-stats.db"),
    },
  };
}

function makeLegacy(path: string, ddl: string, rows: Array<{ sql: string; args?: unknown[] }>): void {
  const db = new DatabaseSync(path);
  db.exec(ddl);
  for (const r of rows) db.prepare(r.sql).run(...((r.args ?? []) as never[]));
  db.close();
}

describe("mergeLegacyDatabases", () => {
  it("没有旧库 → 什么都不做", () => {
    const s = scene();
    const db = new DatabaseSync(s.control);
    migrate(db);
    const out = mergeLegacyDatabases({ db, controlPath: s.control, legacy: s.legacy });
    expect(out).toBeUndefined();
    db.close();
  });

  it("三库都有数据 → 全部并入控制库,旧库仍在原处,重复执行不重复写", () => {
    const s = scene();
    makeLegacy(s.legacy.main, `CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'douyin');
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE upload_limits(key TEXT PRIMARY KEY, blockedUntil INTEGER NOT NULL DEFAULT 0, times TEXT NOT NULL DEFAULT '[]', updatedAt INTEGER NOT NULL DEFAULT 0);`,
      [
        { sql: `INSERT INTO tasks(room) VALUES ('douyin:roomA')` },
        { sql: `INSERT INTO settings(key,value) VALUES ('timezone','Asia/Tokyo')` },
        { sql: `INSERT INTO upload_limits(key,blockedUntil,times,updatedAt) VALUES ('acc1',0,'[100]',100)` },
      ]);
    makeLegacy(s.legacy.sync, `CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE sync_candidates(streamKey TEXT NOT NULL, workerId TEXT NOT NULL, coverage REAL);
      CREATE TABLE upload_limits(key TEXT PRIMARY KEY, blockedUntil INTEGER NOT NULL DEFAULT 0, times TEXT NOT NULL DEFAULT '[]', updatedAt INTEGER NOT NULL DEFAULT 0);`,
      [
        { sql: `INSERT INTO sync_jobs(streamKey,state) VALUES ('k1','done')` },
        { sql: `INSERT INTO sync_candidates(streamKey,workerId,coverage) VALUES ('k1','w1',1.0)` },
        { sql: `INSERT INTO upload_limits(key,blockedUntil,times,updatedAt) VALUES ('acc1',500,'[200]',200)` },
      ]);
    makeLegacy(s.legacy.stats, `CREATE TABLE room_sessions(roomSlug TEXT NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL);`,
      [{ sql: `INSERT INTO room_sessions VALUES ('roomA',1,2)` }]);

    const db = new DatabaseSync(s.control);
    migrate(db);
    const out = mergeLegacyDatabases({ db, controlPath: s.control, legacy: s.legacy });
    expect(out).toBeDefined();
    expect(out!.mergedFiles.sort()).toEqual(["douyin-rec-sync.db", "douyin-rec.db", "room-stats.db"]);

    const count = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    expect(count("tasks")).toBe(1);
    expect(count("sync_jobs")).toBe(1);
    expect(count("sync_candidates")).toBe(1);
    expect(count("room_sessions")).toBe(1);
    // upload_limits 逐 key 取并集:times 去重合并、blockedUntil/updatedAt 取大
    const lim = db.prepare(`SELECT key, blockedUntil, times, updatedAt FROM upload_limits WHERE key='acc1'`).get() as
      { blockedUntil: number; times: string; updatedAt: number };
    expect(lim.blockedUntil).toBe(500);
    expect(JSON.parse(lim.times)).toEqual([100, 200]);
    expect(lim.updatedAt).toBe(200);
    // marker 落库 = 已迁移
    expect((db.prepare(`SELECT value FROM settings WHERE key='db_merge_v1'`).get() as { value: string } | undefined)?.value).toBeTruthy();

    // 重复执行:直接跳过(不重复写、也不重新搬)
    mergeLegacyDatabases({ db, controlPath: s.control, legacy: s.legacy });
    expect(count("tasks")).toBe(1);
    expect(count("sync_jobs")).toBe(1);

    // 旧库原样保留(未被改名/删除):仍能打开且行数不变
    const legacyDb = new DatabaseSync(s.legacy.main, { readOnly: true });
    expect(Number((legacyDb.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n)).toBe(1);
    legacyDb.close();
    db.close();
  });

it("显式 --db 自定义库:控制库自己不当 legacy 附加,但同目录 custom-sync.db 会迁入", () => {
    const dir = mkdtempSync(join(tmpdir(), "db-merge-custom-"));
    const control = join(dir, "custom.db");
    makeLegacy(control, `CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL);`,
      [{ sql: `INSERT INTO tasks(room) VALUES ('douyin:roomC')` }]);
    makeLegacy(join(dir, "custom-sync.db"), `CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending');`,
      [{ sql: `INSERT INTO sync_jobs(streamKey,state) VALUES ('k2','done')` }]);

    const db = new DatabaseSync(control);
    migrate(db);
    const out = mergeLegacyDatabases({
      db,
      controlPath: control,
      legacy: { main: control, sync: join(dir, "custom-sync.db"), stats: join(dir, "room-stats.db") },
    });
    expect(out).toBeDefined();
    expect(out!.mergedFiles).toContain("custom-sync.db");
    expect(out!.mergedFiles).not.toContain("custom.db");
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM sync_jobs`).get() as { n: number }).n)).toBe(1);
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n)).toBe(1);
    db.close();
  });

  it("老 schema upload_limits(单行 id=1 无 key)归一化成 default,且目标侧更严格的冷却不被放宽", () => {
    const s = scene();
    makeLegacy(s.legacy.main, `CREATE TABLE upload_limits(id INTEGER PRIMARY KEY CHECK (id = 1), blockedUntil INTEGER NOT NULL DEFAULT 0,
      times TEXT NOT NULL DEFAULT '[]', updatedAt INTEGER NOT NULL DEFAULT 0);`,
      [{ sql: `INSERT INTO upload_limits(id,blockedUntil,times,updatedAt) VALUES (1, 900, '[10]', 100)` }]);
    const db = new DatabaseSync(s.control);
    migrate(db);
    // 目标已有一条「更严格」的记录(冷却更晚、提交时间更新)
    db.exec(`CREATE TABLE IF NOT EXISTS upload_limits(key TEXT PRIMARY KEY, blockedUntil INTEGER NOT NULL DEFAULT 0,
      times TEXT NOT NULL DEFAULT '[]', updatedAt INTEGER NOT NULL DEFAULT 0)`);
    db.prepare(`INSERT OR REPLACE INTO upload_limits VALUES ('default', 99999, '[900]', 900)`).run();

    const out = mergeLegacyDatabases({ db, controlPath: s.control, legacy: s.legacy });
    expect(out).toBeDefined();
    const lim = db.prepare(`SELECT blockedUntil, times, updatedAt FROM upload_limits WHERE key='default'`).get() as
      { blockedUntil: number; times: string; updatedAt: number };
    expect(lim.blockedUntil).toBe(99999);          // 取大,不放宽冷却
    expect(JSON.parse(lim.times)).toEqual([10, 900]);
    expect(lim.updatedAt).toBe(900);
    db.close();
  });

  it("tasks 的 AUTOINCREMENT 高水位跟着迁(删过的高 ID 不会被重用)", () => {
    const s = scene();
    makeLegacy(s.legacy.main, `CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL);`,
      [
        { sql: `INSERT INTO tasks(id,room) VALUES (100,'douyin:roomD')` },
        { sql: `DELETE FROM tasks WHERE id=100` },
        { sql: `INSERT INTO tasks(id,room) VALUES (1,'douyin:roomE')` },
      ]);
    const db = new DatabaseSync(s.control);
    migrate(db);
    mergeLegacyDatabases({ db, controlPath: s.control, legacy: s.legacy });
    db.prepare(`INSERT INTO tasks(room) VALUES ('douyin:roomF')`).run();
    const ids = (db.prepare(`SELECT id FROM tasks ORDER BY id`).all() as Array<{ id: number }>).map((r) => r.id);
    expect(ids[ids.length - 1]).toBeGreaterThan(100);
    db.close();
  });

  it("老库只有 recorder 列 → 迁入后 engine 按 recorder 语义落值(mesio 不丢)", () => {
    const s = scene();
    makeLegacy(s.legacy.main, `CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, recorder TEXT);`,
      [
        { sql: `INSERT INTO tasks(room,recorder) VALUES ('douyin:roomG','mesio-recorder')` },
        { sql: `INSERT INTO tasks(room,recorder) VALUES ('douyin:roomH','ffmpeg-recorder')` },
      ]);
    const db = new DatabaseSync(s.control);
    migrate(db);
    mergeLegacyDatabases({ db, controlPath: s.control, legacy: s.legacy });
    const rows = db.prepare(`SELECT room, engine FROM tasks WHERE room IN ('douyin:roomG','douyin:roomH') ORDER BY room`).all() as Array<{ room: string; engine: string }>;
    expect(rows).toEqual([{ room: "douyin:roomG", engine: "mesio" }, { room: "douyin:roomH", engine: "ffmpeg" }]);
    db.close();
  });

  it("迁移中途失败 → 整体回滚(不留半迁移状态与 marker),重试能全量迁完", () => {
    const s = scene();
    makeLegacy(s.legacy.main, `CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL);`,
      [{ sql: `INSERT INTO tasks(room) VALUES ('douyin:roomI')` }]);
    // 坏文件:不是 sqlite 库 → ATTACH/读取失败 → 必须整体回滚
    writeFileSync(join(s.dir, "douyin-rec-sync.db"), "not a sqlite database");
    const db = new DatabaseSync(s.control);
    migrate(db);
    expect(() => mergeLegacyDatabases({ db, controlPath: s.control, legacy: s.legacy })).toThrow();
    // 回滚后:tasks 里没有搬进来的行,也没有 marker
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n)).toBe(0);
    expect(db.prepare(`SELECT 1 FROM settings WHERE key='db_merge_v1'`).get()).toBeUndefined();
    // 修好坏文件后重试 → 全量迁完
    rmSync(join(s.dir, "douyin-rec-sync.db"));
    const out = mergeLegacyDatabases({ db, controlPath: s.control, legacy: s.legacy });
    expect(out).toBeDefined();
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n)).toBe(1);
    db.close();
  });

  it("源表缺列也按列交集搬(老 schema 不丢行)", () => {
    const s = scene();
    makeLegacy(s.legacy.main, `CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL);`,
      [{ sql: `INSERT INTO tasks(room) VALUES ('douyin:roomB')` }]);
    const db = new DatabaseSync(s.control);
    migrate(db); // 目标 tasks 有 platform/quality/... 等列
    const out = mergeLegacyDatabases({ db, controlPath: s.control, legacy: s.legacy });
    expect(out).toBeDefined();
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n)).toBe(1);
    // 没搬到的列走默认值
    expect((db.prepare(`SELECT platform FROM tasks WHERE room='douyin:roomB'`).get() as { platform: string }).platform).toBe("douyin");
    db.close();
  });
});
