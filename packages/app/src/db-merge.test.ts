/**
 * db-merge 用例(issue #750):把历史的 3 个兄弟库并进控制库。
 * 覆盖:空库不动、三库并有数据、upload_limits 逐 key 取并集、重复执行幂等、旧库原样保留。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
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
    const out = mergeLegacyDatabases({ db, legacy: s.legacy });
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
    const out = mergeLegacyDatabases({ db, legacy: s.legacy });
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
    mergeLegacyDatabases({ db, legacy: s.legacy });
    expect(count("tasks")).toBe(1);
    expect(count("sync_jobs")).toBe(1);

    // 旧库原样保留(未被改名/删除):仍能打开且行数不变
    const legacyDb = new DatabaseSync(s.legacy.main, { readOnly: true });
    expect(Number((legacyDb.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n)).toBe(1);
    legacyDb.close();
    db.close();
  });

  it("源表缺列也按列交集搬(老 schema 不丢行)", () => {
    const s = scene();
    makeLegacy(s.legacy.main, `CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL);`,
      [{ sql: `INSERT INTO tasks(room) VALUES ('douyin:roomB')` }]);
    const db = new DatabaseSync(s.control);
    migrate(db); // 目标 tasks 有 platform/quality/... 等列
    const out = mergeLegacyDatabases({ db, legacy: s.legacy });
    expect(out).toBeDefined();
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n)).toBe(1);
    // 没搬到的列走默认值
    expect((db.prepare(`SELECT platform FROM tasks WHERE room='douyin:roomB'`).get() as { platform: string }).platform).toBe("douyin");
    db.close();
  });
});
