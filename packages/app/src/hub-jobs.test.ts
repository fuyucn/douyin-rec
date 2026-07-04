import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHubJobs, readHubJobLog, jobLogPath } from "./hub-jobs.js";

/** 手工建台账 fixture(表结构与 orchestrator SyncLedger 对齐——结构即契约,不 import 它保分层)。 */
function makeSyncDb(): { dbPath: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "hubjobs-"));
  const dbPath = join(dir, "x-sync.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
    winnerTenant TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_job_events(streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_candidates(streamKey TEXT NOT NULL, tenantId TEXT NOT NULL,
    coverage REAL NOT NULL, durationSec REAL NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL,
    totalGapSec REAL NOT NULL, isWinner INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    PRIMARY KEY(streamKey, tenantId))`);
  return { dbPath, db };
}

const T0 = 1_700_000_000_000;

function seedJob(db: DatabaseSync, key: string, states: Array<[string, number]>, durationSec: number, opts: { bv?: string } = {}): void {
  const [lastState, lastAt] = states[states.length - 1];
  db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerTenant,bv,fails,updatedAt) VALUES(?,?,?,?,0,?)")
    .run(key, lastState, "local", opts.bv ?? null, lastAt);
  for (const [s, at] of states) db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run(key, s, at);
  db.prepare(`INSERT INTO sync_candidates(streamKey,tenantId,coverage,durationSec,startMs,endMs,totalGapSec,isWinner,updatedAt)
    VALUES(?,?,1,?,0,0,0,1,?)`).run(key, "local", durationSec, lastAt);
}

describe("listHubJobs", () => {
  it("sync db 不存在(hub 未开过)→ 空数组不炸", () => {
    expect(listHubJobs("/nonexistent/x-sync.db")).toEqual([]);
  });

  it("时间线/当前步时长/ETA:历史 done job 的步骤速率喂给进行中 job", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "hubstage-"));
    // 历史完成 job:视频 1000s;merging 用了 300s(rate=0.3)、uploading 用了 500s(rate=0.5)。
    seedJob(db, "douyin:1:2026-07-01", [
      ["pending", T0], ["syncing", T0 + 10_000], ["merging", T0 + 20_000],
      ["uploading", T0 + 320_000], ["done", T0 + 820_000],
    ], 1000, { bv: "BVdone" });
    // 进行中 job:视频 2000s,uploading 开始于 now-100s。
    const now = T0 + 2_000_000;
    seedJob(db, "douyin:2:2026-07-02", [
      ["pending", now - 400_000], ["syncing", now - 300_000], ["merging", now - 250_000],
      ["uploading", now - 100_000],
    ], 2000);
    db.close();

    const jobs = listHubJobs(dbPath, 10, now, stage);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].streamKey).toBe("douyin:2:2026-07-02"); // updatedAt 倒序
    const cur = jobs[0];
    expect(cur.state).toBe("uploading");
    expect(cur.currentStepSec).toBe(100);
    // ETA = rate(0.5) × 2000s − 已跑 100s = 900s
    expect(cur.etaSec).toBe(900);
    expect(cur.events.map((e) => e.state)).toEqual(["pending", "syncing", "merging", "uploading"]);
    expect(cur.startedAt).toBe(now - 400_000);
    // 终态 job:currentStepSec/etaSec 均 null
    const fin = jobs[1];
    expect(fin.state).toBe("done");
    expect(fin.bv).toBe("BVdone");
    expect(fin.currentStepSec).toBeNull();
    expect(fin.etaSec).toBeNull();
  });

  it("无历史速率 → 回落保守常数;hasLog 反映 job.log 是否存在", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "hubstage2-"));
    const now = T0 + 1_000_000;
    seedJob(db, "douyin:3:2026-07-03", [["pending", now - 60_000], ["merging", now - 50_000]], 1000);
    db.close();
    // 造一个 job.log
    const logP = jobLogPath("douyin:3:2026-07-03", stage);
    mkdirSync(join(stage, "douyin_3_2026-07-03"), { recursive: true });
    writeFileSync(logP, "[t] hello\n");

    const jobs = listHubJobs(dbPath, 10, now, stage);
    expect(jobs[0].currentStepSec).toBe(50);
    // fallback merging rate 0.3 × 1000 − 50 = 250
    expect(jobs[0].etaSec).toBe(250);
    expect(jobs[0].hasLog).toBe(true);
    expect(readHubJobLog("douyin:3:2026-07-03", 65536, stage)).toContain("hello");
    expect(readHubJobLog("douyin:no-such", 65536, stage)).toBeNull();
  });
});
