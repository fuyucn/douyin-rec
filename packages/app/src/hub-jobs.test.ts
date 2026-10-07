import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeHubJobKeys, buildQueueView, deleteHubJobHistory, listHubJobs, readHubJobLog, jobLogPath } from "./hub-jobs.js";

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

describe("buildQueueView", () => {
  const POOL_EMPTY = {
    cpu: { active: 0, queued: 0, max: 0 }, net: { active: 0, queued: 0, max: 0 },
    upload: { active: 0, queued: 0, cooldownUntil: 0, windowUsed: 0, windowLimit: 0, windowResetAt: 0 },
    waiting: [],
  };

  it("无 sync db → active/recent 空,pool 原样透出", () => {
    const v = buildQueueView("/nonexistent/x-sync.db", { pool: POOL_EMPTY });
    expect(v).toEqual({ active: [], recent: [], pool: POOL_EMPTY });
  });

  it("进行中 job:doneSteps=已完成(做了什么),nextSteps=DAG 后继(下面做什么),phase=running", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage-"));
    const now = T0 + 100_000;
    seedJob(db, "douyin:100:2026-07-10", [["syncing", now - 90_000], ["merging", now - 60_000]], 1000);
    // merge 已 done、burn_danmu 进行中。
    for (const [step, phase, at] of [
      ["select", "start", now - 90_000], ["select", "done", now - 88_000],
      ["pull", "start", now - 88_000], ["pull", "done", now - 70_000],
      ["merge", "start", now - 70_000], ["merge", "done", now - 60_000],
      ["burn_danmu", "start", now - 60_000],
    ] as const) {
      db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at) VALUES(?,?,?,?)").run("douyin:100:2026-07-10", step, phase, at);
    }
    db.prepare("INSERT INTO sync_node_states(streamKey,node,state,error,attempts,updatedAt) VALUES(?,?,?,?,?,?)")
      .run("douyin:100:2026-07-10", "merge", "done", null, 1, now - 60_000);
    db.prepare("INSERT INTO sync_node_states(streamKey,node,state,error,attempts,updatedAt) VALUES(?,?,?,?,?,?)")
      .run("douyin:100:2026-07-10", "burn_danmu", "running", null, 1, now - 60_000);
    db.close();

    const { active, recent } = buildQueueView(dbPath, {
      now, stageDir: stage, pool: POOL_EMPTY,
      anchorOf: (p, r) => (p === "douyin" && r === "100" ? "一勺小苏打" : null),
    });
    expect(recent).toHaveLength(0);
    expect(active).toHaveLength(1);
    const it0 = active[0];
    expect(it0.anchorName).toBe("一勺小苏打");
    expect(it0.platform).toBe("douyin");
    expect(it0.roomSlug).toBe("100");
    expect(it0.phase).toBe("running");
    expect(it0.currentNode).toBe("burn_danmu");
    expect(it0.resource).toBe("cpu");
    // 做了什么:merge 已 done(select/pull 不是 pipeline 节点,仍在 doneSteps 里但 nextSteps 只算 DAG 节点)
    expect(it0.doneSteps.map((s) => s.step)).toContain("merge");
    // 下面做什么:merge 的 done → 其后继 burn_livechat / upload_plain 立即可跑(burn_danmu 在跑)
    expect(it0.nextSteps).toContain("upload_plain");
    expect(it0.nextSteps).toContain("burn_livechat");
  });

  it("资源池 waiting 命中 → phase=queued + queuePosition;needs_manual 留进行中", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage2-"));
    const now = T0 + 100_000;
    seedJob(db, "douyin:100:2026-07-10", [["merging", now - 30_000]], 1000);
    seedJob(db, "douyin:200:2026-07-10", [["needs_manual", now - 10_000]], 1000);
    db.close();
    const { active, recent } = buildQueueView(dbPath, {
      now, stageDir: stage,
      pool: { ...POOL_EMPTY, cpu: { active: 1, queued: 1, max: 1 },
        waiting: [{ streamKey: "douyin:100:2026-07-10", resource: "cpu", position: 1, since: now - 30_000 }] },
    });
    // needs_manual 不落 recent(属待人工,留进行中)
    expect(recent).toHaveLength(0);
    const q = active.find((a) => a.streamKey === "douyin:100:2026-07-10")!;
    expect(q.phase).toBe("queued");
    expect(q.queuePosition).toBe(1);
    expect(q.resource).toBe("cpu");
    const m = active.find((a) => a.streamKey === "douyin:200:2026-07-10")!;
    expect(m.phase).toBe("waiting_manual");
    // 排序:running/queued 在 waiting_manual 之前
    expect(active[0].streamKey).toBe("douyin:100:2026-07-10");
  });

  it("终态 done 落 recent;active 按 phase 排序", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage3-"));
    const now = T0 + 100_000;
    seedJob(db, "douyin:100:2026-07-01", [["done", now - 50_000]], 100, { bv: "BVx" });
    seedJob(db, "douyin:200:2026-07-01", [["pending", now - 20_000]], 100);
    db.close();
    const { active, recent } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    expect(recent.map((j) => j.streamKey)).toEqual(["douyin:100:2026-07-01"]);
    expect(active).toHaveLength(1);
    expect(active[0].phase).toBe("waiting_settle");
  });

  it("回归:台账超 500 行时,updatedAt 较旧的 active 场不能从队列页消失", () => {
    // 审核实测的 bug:旧实现用 listHubJobs(limit:500) 再客户端过滤 → ORDER BY updatedAt DESC
    // 会把「正在处理但 updatedAt 很旧」的场挤出结果,队列页整场消失(1 active + 520 done → active=[])。
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage4-"));
    const now = T0 + 10_000_000;
    // 520 个更新的 done(会占满任何「取最近 N 条」的窗口)。
    for (let i = 0; i < 520; i++) {
      seedJob(db, `douyin:r${i}:2026-10-01`, [["done", now - 1_000 + i]], 100, { bv: `BV${i}` });
    }
    // 一个更旧的 active(卡住不动 → updatedAt 最小)。
    seedJob(db, "douyin:STUCK:2026-10-06", [["merging", now - 500_000]], 1000);
    db.close();

    const { active } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    expect(active.map((a) => a.streamKey)).toContain("douyin:STUCK:2026-10-06");
  });

  it("needs_manual cap:长期 stage 收口堆积时只列最近 manualLimit 条", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage5-"));
    const now = T0 + 10_000_000;
    for (let i = 0; i < 40; i++) {
      seedJob(db, `douyin:m${i}:2026-10-01`, [["needs_manual", now - 40_000 + i]], 100);
    }
    db.close();
    const { active, recent } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY, manualLimit: 20 });
    const manual = active.filter((a) => a.phase === "waiting_manual");
    expect(manual).toHaveLength(20);
    // cap 的是最近 20(updatedAt 最大的 = m19..m0)
    expect(manual.map((a) => a.streamKey)).toContain("douyin:m39:2026-10-01");
    expect(manual.map((a) => a.streamKey)).not.toContain("douyin:m0:2026-10-01");
    // needs_manual 不进 recent
    expect(recent).toHaveLength(0);
  });

  it("waiting 多条登记取最早一条(最急)作代表", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage6-"));
    const now = T0 + 100_000;
    seedJob(db, "douyin:100:2026-07-10", [["merging", now - 30_000]], 1000);
    db.close();
    const { active } = buildQueueView(dbPath, {
      now, stageDir: stage,
      pool: { ...POOL_EMPTY, waiting: [
        { streamKey: "douyin:100:2026-07-10", resource: "upload", position: 2, since: now - 5_000 },
        { streamKey: "douyin:100:2026-07-10", resource: "cpu", position: 1, since: now - 30_000 },
      ] },
    });
    expect(active).toHaveLength(1);
    // 最早 = cpu(position 1)—— 位次更靠前才是用户关心的
    expect(active[0].phase).toBe("queued");
    expect(active[0].resource).toBe("cpu");
    expect(active[0].queuePosition).toBe(1);
  });

  it("nextSteps 口径:未在跑只列立即可跑节点;在跑则列当前之后的其余节点", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage7-"));
    const now = T0 + 100_000;
    // A:pending(currentNode=null)→ 只列 ready(merge 已 done → burn/upload 可跑),不该列 append_*。
    seedJob(db, "douyin:A:2026-07-10", [["pending", now - 10_000]], 1000);
    db.prepare("INSERT INTO sync_node_states(streamKey,node,state,error,attempts,updatedAt) VALUES(?,?,?,?,?,?)")
      .run("douyin:A:2026-07-10", "merge", "done", null, 1, now - 10_000);
    // B:merging 且 merge 在跑 → nextSteps 是「除当前节点外尚未完成」。
    seedJob(db, "douyin:B:2026-07-10", [["merging", now - 10_000]], 1000);
    db.prepare("INSERT INTO sync_node_states(streamKey,node,state,error,attempts,updatedAt) VALUES(?,?,?,?,?,?)")
      .run("douyin:B:2026-07-10", "merge", "running", null, 1, now - 10_000);
    db.close();
    const { active } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    const a = active.find((x) => x.streamKey.startsWith("douyin:A"))!;
    expect(a.nextSteps).toContain("burn_danmu");
    expect(a.nextSteps).toContain("upload_plain");
    expect(a.nextSteps).not.toContain("append_danmu"); // 前驱未完成,不该预告
    const b = active.find((x) => x.streamKey.startsWith("douyin:B"))!;
    expect(b.currentNode).toBe("merge");
    expect(b.nextSteps).not.toContain("merge");
    expect(b.nextSteps).toContain("append_livechat");
  });

  it("排序:真实 FIFO —— 按入队时刻升序(先入队的排前),与 phase/updatedAt 无关", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-fifo-"));
    const base = T0 + 10_000_000;
    // C 先入队(最早)但 updatedAt 最新;A 最后入队但 updatedAt 最旧。
    // 若仍按 updatedAt 或 phase 排序就会错;FIFO 必须 C → B → A。
    seedJob(db, "douyin:C:2026-10-06", [["merging", base + 10]], 100);
    seedJob(db, "douyin:B:2026-10-06", [["pending", base + 5_000]], 100);
    seedJob(db, "douyin:A:2026-10-06", [["pending", base + 9_000]], 100);
    db.prepare("UPDATE sync_jobs SET updatedAt=? WHERE streamKey=?").run(base + 99_000, "douyin:C:2026-10-06");
    db.prepare("UPDATE sync_jobs SET updatedAt=? WHERE streamKey=?").run(base + 1, "douyin:A:2026-10-06");
    db.close();

    const { active } = buildQueueView(dbPath, { now: base + 200_000, stageDir: stage, pool: POOL_EMPTY });
    expect(active.map((a) => a.streamKey)).toEqual([
      "douyin:C:2026-10-06", "douyin:B:2026-10-06", "douyin:A:2026-10-06",
    ]);
    // seedJob 不插 pending 事件,首个事件即入队时刻 → C 的入队时刻就是它的首个事件 base+10。
    expect(active[0].enqueuedAt).toBe(base + 10);
  });

  it("筛选:phase / states / platform / q 各自生效,可叠加", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-filter-"));
    const now = T0 + 10_000_000;
    seedJob(db, "douyin:100:2026-10-06", [["merging", now - 30_000]], 100); // phase=running
    seedJob(db, "douyin:200:2026-10-06", [["pending", now - 20_000]], 100); // phase=waiting_settle
    seedJob(db, "douyin:300:2026-10-06", [["syncing", now - 10_000]], 100); // state=syncing
    seedJob(db, "bilibili:400:2026-10-06", [["pending", now - 5_000]], 100); // platform=bilibili
    db.close();
    const view = (o: Parameters<typeof buildQueueView>[1]): string[] =>
      buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY, ...o }).active.map((a) => a.streamKey);

    expect(view({ phase: ["running"] })).toEqual(["douyin:100:2026-10-06", "douyin:300:2026-10-06"]);
    expect(view({ phase: ["waiting_settle"] })).toEqual(["douyin:200:2026-10-06", "bilibili:400:2026-10-06"]);
    expect(view({ states: ["syncing"] })).toEqual(["douyin:300:2026-10-06"]);
    expect(view({ platform: ["bilibili"] })).toEqual(["bilibili:400:2026-10-06"]);
    expect(view({ q: "300" })).toEqual(["douyin:300:2026-10-06"]);
    expect(view({ phase: ["running"], platform: ["douyin"] })).toEqual([
      "douyin:100:2026-10-06", "douyin:300:2026-10-06",
    ]);
    expect(view({ phase: ["queued"], platform: ["bilibili"] })).toEqual([]);
  });

  it("筛选 q 命中主播名(经 anchorOf),大小写不敏感", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-q-"));
    const now = T0 + 10_000_000;
    seedJob(db, "douyin:100:2026-10-06", [["pending", now]], 100);
    seedJob(db, "douyin:200:2026-10-06", [["pending", now]], 100);
    db.close();
    const { active } = buildQueueView(dbPath, {
      now, stageDir: stage, pool: POOL_EMPTY, q: "小苏打",
      anchorOf: (_p, r) => (r === "100" ? "一勺小苏打" : "Someone Else"),
    });
    expect(active).toHaveLength(1);
    expect(active[0].streamKey).toBe("douyin:100:2026-10-06");
  });
});
