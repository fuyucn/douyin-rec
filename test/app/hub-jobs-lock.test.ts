/**
 * issue #428 复审:deleteHubJobHistory 写连接等锁用例。
 *
 * 原本长在 packages/app/src/hub-jobs.test.ts,但并发测试要 import 根 test/sqlite-lock-holder
 * (worker 线程持写事务,见该文件头注释)—— 包内测试引用包外的根 test/ 不合分层;挪到
 * test/app/ 与其它集成测试同层。fixture(makeSyncDb/seedJob)复制自 hub-jobs.test.ts:
 * 表结构与 orchestrator SyncLedger 对齐——结构即契约,不 import 它保分层。
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdWriteLock } from "../sqlite-lock-holder.js";
import { activeHubJobKeys, deleteHubJobHistory } from "../../packages/app/src/hub-jobs.js";

function makeSyncDb(): { dbPath: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "hubjobs-lock-"));
  const dbPath = join(dir, "x-sync.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
    winnerWorker TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_job_events(streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_job_steps(streamKey TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT)`);
  db.exec(`CREATE TABLE sync_candidates(streamKey TEXT NOT NULL, workerId TEXT NOT NULL,
    coverage REAL NOT NULL, durationSec REAL NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL,
    totalGapSec REAL NOT NULL, danmuCount INTEGER, isWinner INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    PRIMARY KEY(streamKey, workerId))`);
  db.exec(`CREATE TABLE sync_node_states(streamKey TEXT NOT NULL, node TEXT NOT NULL, state TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL,
    PRIMARY KEY(streamKey, node))`);
  return { dbPath, db };
}

const T0 = 1_700_000_000_000;

function seedJob(db: DatabaseSync, key: string, states: Array<[string, number]>, durationSec: number, opts: { bv?: string; error?: string } = {}): void {
  const [lastState, lastAt] = states[states.length - 1];
  db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerWorker,bv,error,fails,updatedAt) VALUES(?,?,?,?,?,0,?)")
    .run(key, lastState, "local", opts.bv ?? null, opts.error ?? null, lastAt);
  for (const [s, at] of states) db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run(key, s, at);
  db.prepare(`INSERT INTO sync_candidates(streamKey,workerId,coverage,durationSec,startMs,endMs,totalGapSec,isWinner,updatedAt)
    VALUES(?,?,1,?,0,0,0,1,?)`).run(key, "local", durationSec, lastAt);
}

describe("deleteHubJobHistory 写连接等锁(issue #428)", () => {
  it("写连接设 busy_timeout:他人持写事务时等锁,不立刻 BUSY(issue #428)", async () => {
    const { dbPath, db } = makeSyncDb();
    seedJob(db, "douyin:100:2026-07-01", [["done", T0]], 100, { bv: "A1" });
    db.close();
    const { locked, released } = holdWriteLock(dbPath, 200);
    await locked; // 另一线程 BEGIN IMMEDIATE 持有写锁
    const t0 = Date.now();
    const r = deleteHubJobHistory(dbPath, "douyin.100"); // 修复前:BEGIN IMMEDIATE 立刻 SQLITE_BUSY 抛错
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120); // 真的等过锁
    await released;
    expect(r.deleted).toBe(1);
    expect(activeHubJobKeys(dbPath, "douyin.100")).toEqual([]);
  });
});
