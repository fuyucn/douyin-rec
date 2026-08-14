import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeHubJobKeys, deleteHubJobHistory, listHubJobs, readHubJobLog, jobLogPath } from "./hub-jobs.js";

/** 手工建台账 fixture(表结构与 orchestrator SyncLedger 对齐——结构即契约,不 import 它保分层)。 */
function makeSyncDb(): { dbPath: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "hubjobs-"));
  const dbPath = join(dir, "x-sync.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
    winnerWorker TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_job_events(streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_job_steps(streamKey TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT)`);
  db.exec(`CREATE TABLE sync_candidates(streamKey TEXT NOT NULL, workerId TEXT NOT NULL,
    coverage REAL NOT NULL, durationSec REAL NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL,
    totalGapSec REAL NOT NULL, isWinner INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    PRIMARY KEY(streamKey, workerId))`);
  db.exec(`CREATE TABLE sync_node_states(streamKey TEXT NOT NULL, node TEXT NOT NULL, state TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL,
    PRIMARY KEY(streamKey, node))`);
  return { dbPath, db };
}

const T0 = 1_700_000_000_000;

function seedJob(db: DatabaseSync, key: string, states: Array<[string, number]>, durationSec: number, opts: { bv?: string } = {}): void {
  const [lastState, lastAt] = states[states.length - 1];
  db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerWorker,bv,fails,updatedAt) VALUES(?,?,?,?,0,?)")
    .run(key, lastState, "local", opts.bv ?? null, lastAt);
  for (const [s, at] of states) db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run(key, s, at);
  db.prepare(`INSERT INTO sync_candidates(streamKey,workerId,coverage,durationSec,startMs,endMs,totalGapSec,isWinner,updatedAt)
    VALUES(?,?,1,?,0,0,0,1,?)`).run(key, "local", durationSec, lastAt);
}

describe("listHubJobs", () => {
  it("sync db 不存在(hub 未开过)→ 空结果不炸", () => {
    expect(listHubJobs("/nonexistent/x-sync.db")).toEqual({ jobs: [], total: 0 });
  });

  it("steps 子步骤事件透出(供 fork/join 流程图);无 steps 时为空数组", () => {
    const { dbPath, db } = makeSyncDb();
    seedJob(db, "douyin:9:2026-07-05", [["merging", T0 + 5000]], 100);
    for (const [step, phase, at] of [["merge", "start", T0 + 1000], ["merge", "done", T0 + 2000], ["burn_danmu", "start", T0 + 2000]] as const) {
      db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at) VALUES(?,?,?,?)").run("douyin:9:2026-07-05", step, phase, at);
    }
    db.close();
    const { jobs } = listHubJobs(dbPath, { now: T0 + 6000 });
    expect(jobs[0].steps.map((s) => `${s.step}:${s.phase}`)).toEqual(["merge:start", "merge:done", "burn_danmu:start"]);
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

    const { jobs, total } = listHubJobs(dbPath, { now, stageDir: stage });
    expect(total).toBe(2);
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

  it("已超预估 → etaSec 为 null(不显示误导的「约 0s」)", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "hubstage-eta0-"));
    const now = T0 + 1_000_000;
    // 短视频 200s + fallback uploading rate 0.6 → 预估总耗时 120s;但已跑 300s 远超 → 剩余负 → null。
    seedJob(db, "douyin:9:2026-07-09", [["merging", now - 320_000], ["uploading", now - 300_000]], 200);
    db.close();
    const { jobs } = listHubJobs(dbPath, { now, stageDir: stage });
    expect(jobs[0].currentStepSec).toBe(300);
    expect(jobs[0].etaSec).toBeNull();
  });

  it("按房间过滤 + 分页:room 只返回该房间的 run,total 是过滤后总数,limit/offset 翻页", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "hubstage-pg-"));
    // 房间 A(douyin.100)3 场 + 房间 B(douyin.200)1 场。
    seedJob(db, "douyin:100:2026-07-01", [["done", T0 + 1000]], 100, { bv: "A1" });
    seedJob(db, "douyin:100:2026-07-02", [["done", T0 + 2000]], 100, { bv: "A2" });
    seedJob(db, "douyin:100:2026-07-03", [["done", T0 + 3000]], 100, { bv: "A3" });
    seedJob(db, "douyin:200:2026-07-01", [["done", T0 + 4000]], 100, { bv: "B1" });
    db.close();

    // room=douyin.100 → 只 3 场,total=3,新→旧
    const p1 = listHubJobs(dbPath, { room: "douyin.100", limit: 2, offset: 0, now: T0 + 5000, stageDir: stage });
    expect(p1.total).toBe(3);
    expect(p1.jobs.map((j) => j.streamKey)).toEqual(["douyin:100:2026-07-03", "douyin:100:2026-07-02"]);
    // 第二页
    const p2 = listHubJobs(dbPath, { room: "douyin.100", limit: 2, offset: 2, now: T0 + 5000, stageDir: stage });
    expect(p2.total).toBe(3);
    expect(p2.jobs.map((j) => j.streamKey)).toEqual(["douyin:100:2026-07-01"]);
    // 不跨房间:room=douyin.200 只 1 场
    expect(listHubJobs(dbPath, { room: "douyin.200", stageDir: stage }).total).toBe(1);
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

    const { jobs } = listHubJobs(dbPath, { now, stageDir: stage });
    expect(jobs[0].currentStepSec).toBe(50);
    // fallback merging rate 0.3 × 1000 − 50 = 250
    expect(jobs[0].etaSec).toBe(250);
    expect(jobs[0].hasLog).toBe(true);
    expect(readHubJobLog("douyin:3:2026-07-03", 65536, stage)).toContain("hello");
    expect(readHubJobLog("douyin:no-such", 65536, stage)).toBeNull();
  });

  it("includes step detail in the DTO", () => {
    const { dbPath, db } = makeSyncDb();
    seedJob(db, "douyin:room:2026-07-10", [["done", T0 + 5000]], 100, { bv: "BVdetail" });
    db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at,detail) VALUES(?,?,?,?,?)")
      .run("douyin:room:2026-07-10", "merge", "done", T0 + 2000, "4 段 → 90MB");
    db.close();
    const { jobs } = listHubJobs(dbPath, { room: "douyin.room" });
    const merge = jobs[0].steps.find((s) => s.step === "merge" && s.phase === "done");
    expect(merge?.detail).toBe("4 段 → 90MB");
  });
});

describe("deleteHubJobHistory / activeHubJobKeys", () => {
  it("删除该房间全部历史(五表 + job.log),不动其他房间", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "hubdelete-"));
    seedJob(db, "douyin:100:2026-07-01", [["done", T0]], 100, { bv: "A1" });
    seedJob(db, "douyin:100:2026-07-02", [["done", T0 + 1000]], 100, { bv: "A2" });
    seedJob(db, "douyin:200:2026-07-01", [["done", T0 + 2000]], 100, { bv: "B1" });
    for (const key of ["douyin:100:2026-07-01", "douyin:100:2026-07-02", "douyin:200:2026-07-01"]) {
      db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at,detail) VALUES(?,?,?,?,?)")
        .run(key, "merge", "start", T0, "4 段");
      db.prepare("INSERT INTO sync_node_states(streamKey,node,state,error,attempts,updatedAt) VALUES(?,?,?,?,?,?)")
        .run(key, "merge", "done", null, 1, T0);
      const logP = jobLogPath(key, stage);
      mkdirSync(join(stage, key.replace(/[:/]/g, "_")), { recursive: true });
      writeFileSync(logP, "log\n");
    }
    db.close();

    const r = deleteHubJobHistory(dbPath, "douyin.100", stage);
    expect(r.deleted).toBe(2);
    expect(new Set(r.streamKeys)).toEqual(new Set(["douyin:100:2026-07-01", "douyin:100:2026-07-02"]));

    const { jobs } = listHubJobs(dbPath, { stageDir: stage });
    expect(jobs.map((j) => j.streamKey)).toEqual(["douyin:200:2026-07-01"]);
    expect(existsSync(jobLogPath("douyin:100:2026-07-01", stage))).toBe(false);
    expect(existsSync(jobLogPath("douyin:200:2026-07-01", stage))).toBe(true);
  });

  it("activeHubJobKeys 只报非终态 run;done/failed/needs_manual 不拦", () => {
    const { dbPath, db } = makeSyncDb();
    seedJob(db, "douyin:100:2026-07-01", [["merging", T0]], 100);
    seedJob(db, "douyin:100:2026-07-02", [["done", T0 + 1000]], 100);
    seedJob(db, "douyin:200:2026-07-01", [["uploading", T0 + 2000]], 100);
    db.close();
    expect(activeHubJobKeys(dbPath, "douyin.100")).toEqual(["douyin:100:2026-07-01"]);
    expect(activeHubJobKeys(dbPath, "douyin.200")).toEqual(["douyin:200:2026-07-01"]);
    expect(activeHubJobKeys(dbPath, "douyin.300")).toEqual([]);
  });

  it("旧库缺表 / sync db 不存在 → 不炸,只删能删的", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubdelete-old-"));
    const dbPath = join(dir, "old-sync.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL, updatedAt INTEGER NOT NULL)");
    db.prepare("INSERT INTO sync_jobs(streamKey,state,updatedAt) VALUES(?,?,?)").run("douyin:100:2026-08-01", "done", T0);
    db.close();

    const r = deleteHubJobHistory(dbPath, "douyin.100");
    expect(r).toEqual({ deleted: 1, streamKeys: ["douyin:100:2026-08-01"] });
    expect(activeHubJobKeys(dbPath, "douyin.100")).toEqual([]);
    expect(deleteHubJobHistory("/nonexistent/x-sync.db", "douyin.100")).toEqual({ deleted: 0, streamKeys: [] });
  });
});
