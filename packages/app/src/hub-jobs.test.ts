import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE_READY } from "@drec/core";
import { needsManualPhaseOf } from "./hub-jobs.js";
import { activeHubJobKeys, buildQueueView, deleteHubJobHistory, latestRunPerRoom, listHubJobs, readHubJobLog, jobLogPath } from "./hub-jobs.js";

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

  it("states 过滤:只返回指定状态,total 是过滤后总数(不受 limit 截断)", () => {
    // 回归:Hub 页 Active 指标曾用「最近 20 条里数非终态」→ 数据一多恒为 0。
    // 现在用 states 精确过滤 + 读 total,故必须验证「非终态被更新的终态挤出 limit 窗口」时 total 仍正确。
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "hubjobs-states-"));
    const base = T0 + 10_000_000;
    // 25 条更新的 done(会占满任何 limit≤25 的窗口)+ 3 条更旧的非终态
    for (let i = 0; i < 25; i++) {
      seedJob(db, `douyin:D${i}:2026-10-01`, [["done", base + i]], 100, { bv: `BV${i}` });
    }
    seedJob(db, "douyin:ACT1:2026-10-01", [["merging", base - 9000]], 100);
    seedJob(db, "douyin:ACT2:2026-10-01", [["uploading", base - 8000]], 100);
    seedJob(db, "douyin:ACT3:2026-10-01", [["pending", base - 7000]], 100);
    db.close();

    const active = ["pending", "settling", "syncing", "merging", "uploading", "retrying"];
    // limit=1:返回 1 条,但 total 必须是权威的 3
    const r = listHubJobs(dbPath, { states: active, limit: 1, now: base + 1000, stageDir: stage });
    expect(r.total).toBe(3);
    expect(r.jobs).toHaveLength(1);
    // 对照:不带 states 的默认查询(最近 20 条)一条非终态都看不到
    const dflt = listHubJobs(dbPath, { now: base + 1000, stageDir: stage });
    expect(dflt.jobs.filter((j) => active.includes(j.state))).toHaveLength(0);
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

describe("latestRunPerRoom", () => {
  it("每房间返回最新一条 run;roomKey 无尾冒号;不受「最近 N 条」影响", () => {
    // 回归:Hub 房间列表曾用「最近 20 条 run 再按房间过滤」→ 有历史 run 的房间显示「No runs yet」。
    const { dbPath, db } = makeSyncDb();
    const base = T0 + 10_000_000;
    // 房间 A:2 条(旧的 + 新的);房间 B:1 条。
    seedJob(db, "douyin:100:2026-10-01", [["done", base - 5000]], 100, { bv: "A-old" });
    seedJob(db, "douyin:100:2026-10-02", [["done", base + 1000]], 100, { bv: "A-new" });
    seedJob(db, "douyin:200:2026-10-01", [["merging", base]], 100);
    db.close();

    const rooms = latestRunPerRoom(dbPath);
    const byKey = Object.fromEntries(rooms.map((r) => [r.roomKey, r]));
    // roomKey 无尾冒号(与前端 `${platform}:${roomSlug}` 对齐)
    expect(Object.keys(byKey).sort()).toEqual(["douyin:100", "douyin:200"]);
    // A 取最新那条
    expect(byKey["douyin:100"].bv).toBe("A-new");
    expect(byKey["douyin:100"].streamKey).toBe("douyin:100:2026-10-02");
    expect(byKey["douyin:200"].state).toBe("merging");
  });

  it("无 sync db / 空表 → 空数组,不炸", () => {
    expect(latestRunPerRoom("/nonexistent/x-sync.db")).toEqual([]);
  });
});

describe("buildQueueView", () => {
  const POOL_EMPTY = {
    cpu: { active: 0, queued: 0, max: 0 }, net: { active: 0, queued: 0, max: 0 },
    upload: { active: 0, queued: 0, cooldownUntil: 0, windowUsed: 0, windowLimit: 0, windowResetAt: 0 },
    waiting: [],
  };

  it("无 sync db → active/rows/recent 空,pool 原样透出", () => {
    const v = buildQueueView("/nonexistent/x-sync.db", { pool: POOL_EMPTY });
    expect(v).toEqual({ active: [], rows: [], recent: [], pool: POOL_EMPTY });
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

  /**
   * 回归(issue #12):节点侧上传(本地 remux + 上传,无回传)的**当前节点**必须显示 `node_upload`,
   * 不能回落到 stateToNode("syncing")="pull"(否则队列页误报「还在 rsync 回传」)。
   * 常规 pull 回 master 的场仍显示 `pull`(向后兼容)。
   */
  it("节点侧上传场:currentNode=node_upload(非 pull);常规 pull 场仍为 pull", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage-nodeupload-"));
    const now = T0 + 100_000;
    // ① 节点侧上传场:state=syncing、steps 记 select + node_upload、节点表 node_upload=running。
    seedJob(db, "douyin:300:2026-07-10", [["syncing", now - 20_000]], 1000);
    for (const [step, phase, at] of [
      ["select", "start", now - 20_000], ["select", "done", now - 18_000],
      ["node_upload", "start", now - 18_000],
    ] as const) {
      db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at) VALUES(?,?,?,?)").run("douyin:300:2026-07-10", step, phase, at);
    }
    db.prepare("INSERT INTO sync_node_states(streamKey,node,state,error,attempts,updatedAt) VALUES(?,?,?,?,?,?)")
      .run("douyin:300:2026-07-10", "node_upload", "running", null, 1, now - 18_000);
    // ② 常规 pull 回 master 场:state=syncing、steps 记 pull,无 running 节点 → 回落 pull。
    seedJob(db, "douyin:400:2026-07-10", [["syncing", now - 15_000]], 1000);
    db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at) VALUES(?,?,?,?)").run("douyin:400:2026-07-10", "pull", "start", now - 15_000);
    db.close();

    const { active } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    const nodeSide = active.find((a) => a.roomSlug === "300")!;
    const regular = active.find((a) => a.roomSlug === "400")!;
    expect(nodeSide.currentNode).toBe("node_upload");
    expect(nodeSide.currentNode).not.toBe("pull");
    expect(nodeSide.resource).toBeNull(); // 节点本地跑,不占 master 资源闸门
    expect(nodeSide.doneSteps.map((s) => s.step)).toContain("select");
    // 常规路径语义不变。
    expect(regular.currentNode).toBe("pull");
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
    // seedJob 不写 error → 数据异常(漏写原因)→ 按真故障渲染,且仍留在 active 里等人看
    const m = active.find((a) => a.streamKey === "douyin:200:2026-07-10")!;
    expect(m.phase).toBe("waiting_manual");
    // 默认 newest:200 入队(now-10s)比 100(now-30s)晚 → 200 排最前
    expect(active[0].streamKey).toBe("douyin:200:2026-07-10");
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

  it("needs_manual cap:长期堆积时只列最近 manualLimit 条真事故(stage 正常收口不进 active)", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage5-"));
    const now = T0 + 10_000_000;
    for (let i = 0; i < 40; i++) {
      seedJob(db, `douyin:m${i}:2026-10-01`, [["needs_manual", now - 40_000 + i]], 100, { error: `失败 ${i}` });
    }
    db.close();
    const { active, recent } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY, manualLimit: 20 });
    const manual = active.filter((a) => a.phase === "waiting_manual");
    expect(manual).toHaveLength(20);
    expect(manual.map((a) => a.streamKey)).toContain("douyin:m39:2026-10-01");
    expect(manual.map((a) => a.streamKey)).not.toContain("douyin:m0:2026-10-01");
    expect(recent).toHaveLength(0);
  });

  it("needs_manual 细分:stage 正常收口(显式 STAGE_READY)/ 用户停止 / 真故障 / 空 error 视为异常", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-manual3-"));
    const now = T0 + 10_000_000;
    const put = (k: string, error: string | null, at: number): void => {
      db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerWorker,bv,error,fails,updatedAt) VALUES(?,?,?,?,?,0,?)")
        .run(k, "needs_manual", "local", null, error, at);
      db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run(k, "pending", at - 1000);
      db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run(k, "needs_manual", at);
    };
    put("douyin:UPLOAD:2026-10-06", STAGE_READY, now - 3_000);       // stage 正常收口
    put("douyin:STOPPED:2026-10-06", "用户停止", now - 2_000);        // 用户停止
    put("douyin:BROKEN:2026-10-06", "进程重启中断", now - 1_000);     // 真故障
    put("douyin:NOERR:2026-10-06", null, now - 500);                 // 漏写原因 = 异常
    db.close();
    const { rows, active } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    const by = (k: string): string => rows.find((r) => r.streamKey === k)!.phase;
    expect(by("douyin:UPLOAD:2026-10-06")).toBe("waiting_upload");
    expect(by("douyin:STOPPED:2026-10-06")).toBe("stopped");
    expect(by("douyin:BROKEN:2026-10-06")).toBe("waiting_manual");
    expect(by("douyin:NOERR:2026-10-06")).toBe("waiting_manual");
    // 空 error 的行必须带一句可读的兜底原因(红色「待人工」旁不能是空白)。
    expect(rows.find((r) => r.streamKey === "douyin:NOERR:2026-10-06")!.error).toContain("缺少失败原因");
    // error 透出到行
    expect(rows.find((r) => r.streamKey === "douyin:BROKEN:2026-10-06")!.error).toBe("进程重启中断");
    expect(rows.find((r) => r.streamKey === "douyin:UPLOAD:2026-10-06")!.error).toBe(STAGE_READY);
    // **人工收件箱只装真事故**:stage 正常收口留在 rows 时间轴,但不进 active。
    expect(active.map((a) => a.streamKey)).toContain("douyin:BROKEN:2026-10-06");
    expect(active.map((a) => a.streamKey)).toContain("douyin:NOERR:2026-10-06");
    expect(active.map((a) => a.streamKey)).toContain("douyin:STOPPED:2026-10-06");
    expect(active.map((a) => a.streamKey)).not.toContain("douyin:UPLOAD:2026-10-06");
  });

  it("manualLimit 只约束真事故:一堆 stage 正常收口不占人工收件箱名额", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage7-"));
    const now = T0 + 10_000_000;
    // 30 条 stage 正常收口(updatedAt 更新,会占满任何先取后分的窗口)
    for (let i = 0; i < 30; i++) {
      seedJob(db, `douyin:s${i}:2026-10-01`, [["needs_manual", now - 40_000 + i]], 100, { error: STAGE_READY });
    }
    // 3 条真事故,updatedAt 更旧
    for (let i = 0; i < 3; i++) {
      seedJob(db, `douyin:x${i}:2026-10-01`, [["needs_manual", now - 100_000 + i]], 100, { error: `上传失败 ${i}` });
    }
    db.close();
    const { active } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY, manualLimit: 20 });
    const manual = active.filter((a) => a.phase === "waiting_manual");
    expect(manual).toHaveLength(3);
    expect(manual.map((a) => a.streamKey)).toContain("douyin:x0:2026-10-01");
    expect(manual.map((a) => a.streamKey)).toContain("douyin:x2:2026-10-01");
  });

  it("stage 正常收口无限堆积也不会挤掉真事故(只增不减的终态,窗口不能被它占满)", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage8-"));
    const now = T0 + 10_000_000;
    // 120 条 stage 正常收口,updatedAt 全部比真事故新(它只增不减,几天就会到这个量级)
    for (let i = 0; i < 120; i++) {
      seedJob(db, `douyin:s${i}:2026-10-01`, [["needs_manual", now - 10_000 + i]], 100, { error: STAGE_READY });
    }
    // 唯一一条真事故,updatedAt 最旧
    seedJob(db, "douyin:FIRE:2026-10-01", [["needs_manual", now - 900_000]], 100, { error: "节点侧上传 SSH 失败" });
    db.close();
    const { active, rows } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY, manualLimit: 20 });
    expect(active.map((a) => a.streamKey)).toContain("douyin:FIRE:2026-10-01");
    expect(rows.find((r) => r.streamKey === "douyin:FIRE:2026-10-01")?.phase).toBe("waiting_manual");
  });

  it("stage 标记按精确相等判定:两侧都不得 trim(否则同一行两边结论相反)", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage10-"));
    const now = T0 + 10_000_000;
    seedJob(db, "douyin:WRAP:2026-10-01", [["needs_manual", now]], 100, { error: ` ${STAGE_READY} ` });
    seedJob(db, "douyin:FIRE:2026-10-01", [["needs_manual", now - 1000]], 100, { error: "上传失败" });
    db.close();
    const { active, rows } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    // 带空白的不是标记值(closeStageReady 原样写入,不会产生这种行)→ 当真事故处理。
    expect(active.map((a) => a.streamKey)).toContain("douyin:WRAP:2026-10-01");
    expect(rows.find((r) => r.streamKey === "douyin:WRAP:2026-10-01")?.phase).toBe("waiting_manual");
    expect(rows.find((r) => r.streamKey === "douyin:FIRE:2026-10-01")?.phase).toBe("waiting_manual");
  });

  it("兜底文案只作用于 needs_manual 行(failed / done 的空 error 必须原样为 null)", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage11-"));
    const now = T0 + 10_000_000;
    // failed / done 的 error 为空是合法的(例如从未失败过),不能被塞进兜底文案。
    seedJob(db, "douyin:FAILED:2026-10-01", [["failed", now]], 100);
    seedJob(db, "douyin:DONE:2026-10-01", [["done", now - 1000]], 100, { bv: "BV1" });
    seedJob(db, "douyin:MANUAL:2026-10-01", [["needs_manual", now - 2000]], 100);
    db.close();
    const { rows } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    const err = (k: string): string | null => rows.find((r) => r.streamKey === k)?.error ?? null;
    expect(err("douyin:FAILED:2026-10-01")).toBeNull();
    expect(err("douyin:DONE:2026-10-01")).toBeNull();
    expect(err("douyin:MANUAL:2026-10-01")).toContain("缺少失败原因");
  });

  it("rows 里同一场不重复出现(onlyError / excludeError 过滤不能交叠)", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-stage9-"));
    const now = T0 + 10_000_000;
    seedJob(db, "douyin:MIX:2026-10-01", [["needs_manual", now]], 100, { error: STAGE_READY });
    seedJob(db, "douyin:FIRE:2026-10-01", [["needs_manual", now - 1000]], 100, { error: "上传失败" });
    seedJob(db, "douyin:DONE:2026-10-01", [["done", now - 2000]], 100, { bv: "BV1" });
    db.close();
    const { rows } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    const keys = rows.map((r) => r.streamKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("douyin:MIX:2026-10-01");
    expect(keys).toContain("douyin:FIRE:2026-10-01");
    expect(keys).toContain("douyin:DONE:2026-10-01");
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

  it("排序:默认 newest —— 入队时间倒序(最新在前),与 updatedAt 无关", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-sort-"));
    const base = T0 + 10_000_000;
    // C 最早入队但 updatedAt 最新;A 最后入队但 updatedAt 最旧 —— updatedAt 排序会把顺序反过来。
    seedJob(db, "douyin:C:2026-10-06", [["merging", base + 1_000]], 100);
    seedJob(db, "douyin:B:2026-10-06", [["pending", base + 5_000]], 100);
    seedJob(db, "douyin:A:2026-10-06", [["pending", base + 9_000]], 100);
    db.prepare("UPDATE sync_jobs SET updatedAt=? WHERE streamKey=?").run(base + 99_000, "douyin:C:2026-10-06");
    db.prepare("UPDATE sync_jobs SET updatedAt=? WHERE streamKey=?").run(base + 1, "douyin:A:2026-10-06");
    db.close();

    // 缺省 = newest:最后入队的 A 排最前
    const dflt = buildQueueView(dbPath, { now: base + 200_000, stageDir: stage, pool: POOL_EMPTY });
    expect(dflt.active.map((a) => a.streamKey)).toEqual([
      "douyin:A:2026-10-06", "douyin:B:2026-10-06", "douyin:C:2026-10-06",
    ]);
    expect(dflt.active[0].enqueuedAt).toBe(base + 9_000);
  });

  it("排序:sort=oldest 切到 FIFO(等最久的最前)", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-sort2-"));
    const base = T0 + 10_000_000;
    seedJob(db, "douyin:C:2026-10-06", [["merging", base + 1_000]], 100);
    seedJob(db, "douyin:B:2026-10-06", [["pending", base + 5_000]], 100);
    seedJob(db, "douyin:A:2026-10-06", [["pending", base + 9_000]], 100);
    db.close();

    const { active } = buildQueueView(dbPath, { now: base + 200_000, stageDir: stage, pool: POOL_EMPTY, sort: "oldest" });
    expect(active.map((a) => a.streamKey)).toEqual([
      "douyin:C:2026-10-06", "douyin:B:2026-10-06", "douyin:A:2026-10-06",
    ]);
  });

  it("排序:入队时间缺失(极老 run)回落 updatedAt,不排到最前", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-sort3-"));
    const now = T0 + 10_000_000;
    // 无 events 行 → startedAt/enqueuedAt = null(旧库缺表或没事件)。
    db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerWorker,bv,fails,updatedAt) VALUES(?,?,?,?,0,?)")
      .run("douyin:OLD:2026-10-06", "pending", "local", null, now - 50_000);
    db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerWorker,bv,fails,updatedAt) VALUES(?,?,?,?,0,?)")
      .run("douyin:NEW:2026-10-06", "pending", "local", null, now - 1_000);
    db.close();
    const { active } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    expect(active[0].enqueuedAt).toBeNull();
    // NEW(updatedAt 更新)应排前 —— 缺失回落 updatedAt 后倒序
    expect(active[0].streamKey).toBe("douyin:NEW:2026-10-06");
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

    // 默认 newest:入队越晚越靠前(400 最后入队 → 第 1)
    expect(view({ phase: ["running"] })).toEqual(["douyin:300:2026-10-06", "douyin:100:2026-10-06"]);
    expect(view({ phase: ["waiting_settle"] })).toEqual(["bilibili:400:2026-10-06", "douyin:200:2026-10-06"]);
    expect(view({ states: ["syncing"] })).toEqual(["douyin:300:2026-10-06"]);
    expect(view({ platform: ["bilibili"] })).toEqual(["bilibili:400:2026-10-06"]);
    expect(view({ q: "300" })).toEqual(["douyin:300:2026-10-06"]);
    expect(view({ phase: ["running"], platform: ["douyin"] })).toEqual([
      "douyin:300:2026-10-06", "douyin:100:2026-10-06",
    ]);
    expect(view({ phase: ["queued"], platform: ["bilibili"] })).toEqual([]);
  });

  it("rows:进行中与已完成同表,完成行带 bv/finishedAt 且 nextSteps 为空", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-rows-"));
    const now = T0 + 10_000_000;
    // 进行中(入队 20s 前)
    seedJob(db, "douyin:LIVE:2026-10-06", [["merging", now - 20_000]], 1000);
    // 已完成(入队早,但刚刚才收尾 —— finishedAt 应让它排在最前)
    seedJob(db, "douyin:DONE:2026-10-06", [["pending", now - 900_000], ["done", now - 5_000]], 1000, { bv: "BVdone1" });
    db.close();

    const { rows, active, recent } = buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY });
    // 一张表:进行中 + 已完成都在
    expect(rows.map((r) => r.streamKey).sort()).toEqual(["douyin:DONE:2026-10-06", "douyin:LIVE:2026-10-06"]);
    // 完成行字段
    const done = rows.find((r) => r.streamKey === "douyin:DONE:2026-10-06")!;
    expect(done.phase).toBe("done");
    expect(done.bv).toBe("BVdone1");
    expect(done.finishedAt).toBe(now - 5_000);
    expect(done.nextSteps).toEqual([]);
    expect(done.currentStepSec).toBeNull(); // 终态无「已运行」
    // 进行中行字段
    const live = rows.find((r) => r.streamKey === "douyin:LIVE:2026-10-06")!;
    expect(live.phase).toBe("running");
    expect(live.finishedAt).toBeNull();
    // active 只含进行中(不含 done),recent 只含完成
    expect(active.map((a) => a.streamKey)).toEqual(["douyin:LIVE:2026-10-06"]);
    expect(recent.map((j) => j.streamKey)).toEqual(["douyin:DONE:2026-10-06"]);
    // 排序:完成的按 finishedAt(刚刚=最前),newest 缺省 → DONE 在 LIVE 前
    expect(rows[0].streamKey).toBe("douyin:DONE:2026-10-06");
  });

  it("筛选 phase=done 只留完成行;与 platform/q 叠加", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "queue-rows2-"));
    const now = T0 + 10_000_000;
    seedJob(db, "douyin:LIVE:2026-10-06", [["merging", now - 20_000]], 1000);
    seedJob(db, "douyin:DONE:2026-10-06", [["pending", now - 900_000], ["done", now - 5_000]], 1000, { bv: "B1" });
    db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerWorker,bv,fails,updatedAt) VALUES(?,?,?,?,?,?)")
      .run("bilibili:FAIL:2026-10-06", "failed", "vps2", null, 2, now - 1_000);
    db.close();
    const view = (o: Parameters<typeof buildQueueView>[1]): string[] =>
      buildQueueView(dbPath, { now, stageDir: stage, pool: POOL_EMPTY, ...o }).rows.map((r) => r.streamKey);
    expect(view({ phase: ["done"] })).toEqual(["douyin:DONE:2026-10-06"]);
    expect(view({ phase: ["failed"] })).toEqual(["bilibili:FAIL:2026-10-06"]);
    expect(view({ phase: ["done", "failed"] }).sort()).toEqual(["bilibili:FAIL:2026-10-06", "douyin:DONE:2026-10-06"]);
    expect(view({ platform: ["bilibili"] })).toEqual(["bilibili:FAIL:2026-10-06"]);
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

/**
 * T5:批量读取 + 只读连接 busy_timeout。
 *
 * 两条口径:
 *  - **等价性**:同一份数据下,批量化输出必须与逐条查询逐字段深相等(含 events/steps/candidates/
 *    nodeStates 的**组内排序** —— 排序错了前端时间线就乱)。
 *  - **查询条数与 job 数解耦**:200 个 job 的附加表查询次数不随 job 数增长。
 */
describe("T5 批量读取", () => {
  /** 逐条参照实现(批量化前的语义),用于等价性对照。 */
  function referencePerJob(dbPath: string, keys: readonly string[]) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const per = keys.map((k) => ({
        events: db.prepare("SELECT state, at FROM sync_job_events WHERE streamKey=? ORDER BY at ASC, rowid ASC").all(k),
        steps: (() => {
          try {
            return db.prepare("SELECT step, phase, at, detail FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC").all(k);
          } catch {
            return db.prepare("SELECT step, phase, at FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC").all(k);
          }
        })(),
        candidates: db.prepare(
          "SELECT workerId, coverage, durationSec, totalGapSec, danmuCount, isWinner FROM sync_candidates WHERE streamKey=? ORDER BY isWinner DESC, coverage DESC",
        ).all(k),
        nodeStates: db.prepare(
          "SELECT node, state, error, attempts, updatedAt FROM sync_node_states WHERE streamKey=? ORDER BY node ASC",
        ).all(k),
      }));
      return per;
    } finally {
      db.close();
    }
  }

  it("批量结果与逐条实现深相等(含各表组内排序)", () => {
    const { dbPath, db } = makeSyncDb();
    const stage = mkdtempSync(join(tmpdir(), "hubjobs-eq-"));
    // 刻意让插入顺序 ≠ 排序顺序:candidates 的 isWinner/coverage、nodeStates 的 node 名乱序插入。
    seedJob(db, "douyin:1:2026-10-01", [["pending", T0], ["merging", T0 + 1000]], 100);
    seedJob(db, "douyin:2:2026-10-02", [["pending", T0 + 500], ["uploading", T0 + 2500]], 200, { bv: "BV9" });
    for (const at of [T0 + 300, T0 + 100, T0 + 200]) {
      db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run("douyin:1:2026-10-01", "syncing", at);
    }
    for (const [step, phase, at] of [["merge", "start", T0 + 900], ["merge", "done", T0 + 1900], ["burn_danmu", "start", T0 + 1900]] as const) {
      db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at) VALUES(?,?,?,?)").run("douyin:1:2026-10-01", step, phase, at);
    }
    // 三个候选:winner coverage 最低、另一个 coverage 最高 —— 必须 winner 排最前。
    for (const [w, cov, win] of [["vps1", 0.9, 0], ["vps2", 0.5, 1], ["local", 0.7, 0]] as const) {
      if (w === "local") {
        // seedJob 已插了一个 local winner;改它的 coverage 并取消 winner,保留多候选排序场景。
        db.prepare("UPDATE sync_candidates SET coverage=?, isWinner=0 WHERE streamKey=? AND workerId='local'")
          .run(cov, "douyin:1:2026-10-01");
        continue;
      }
      db.prepare(`INSERT INTO sync_candidates(streamKey,workerId,coverage,durationSec,startMs,endMs,totalGapSec,danmuCount,isWinner,updatedAt)
        VALUES(?,?,?,?,0,0,0,?,?,?)`).run("douyin:1:2026-10-01", w, cov, 100, 42, win, T0);
    }
    for (const node of ["upload_plain", "merge"] as const) {
      db.prepare("INSERT INTO sync_node_states(streamKey,node,state,attempts,updatedAt) VALUES(?,?,?,1,?)")
        .run("douyin:1:2026-10-01", node, "done", T0);
    }
    const keys = ["douyin:1:2026-10-01", "douyin:2:2026-10-02"];
    const ref = referencePerJob(dbPath, keys);
    db.close();

    const { jobs } = listHubJobs(dbPath, { limit: 10, stageDir: stage, now: T0 + 5000 });
    const byKey = new Map(jobs.map((j) => [j.streamKey, j]));
    keys.forEach((k, i) => {
      const got = byKey.get(k)!;
      // events:按 at 升序
      expect(got.events).toEqual(ref[i].events.map((e: Record<string, unknown>) => ({ state: e.state, at: Number(e.at) })));
      // steps:按 at 升序
      expect(got.steps).toEqual(ref[i].steps.map((s: Record<string, unknown>) => ({ step: s.step, phase: s.phase, at: Number(s.at), detail: (s.detail as string | undefined) ?? undefined })));
      // candidates:winner 优先、其次 coverage 降序
      expect(got.candidates).toEqual(ref[i].candidates.map((c: Record<string, unknown>) => ({
        worker: c.workerId,
        coverage: Number(c.coverage),
        durationSec: Number(c.durationSec),
        danmuCount: c.danmuCount == null ? null : Number(c.danmuCount),
        complete: Number(c.totalGapSec) <= 0,
        isWinner: Number(c.isWinner) === 1,
      })));
      expect(got.candidates[0].isWinner).toBe(true);
      // nodeStates:按 node 名升序
      expect(got.nodeStates).toEqual(ref[i].nodeStates.map((n: Record<string, unknown>) => ({
        node: n.node, state: n.state, error: n.error, attempts: Number(n.attempts), updatedAt: Number(n.updatedAt),
      })));
      // 只有第一个 job 播了 node_states;第二个应为空数组(不能串桶)。
      expect(got.nodeStates.map((n) => n.node)).toEqual(i === 0 ? ["merge", "upload_plain"] : []);
    });
  });

  it("附加表查询次数与 job 数**无关**(N+1 已消除)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubjobs-nplus1-"));
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
      error TEXT, attempts INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL, PRIMARY KEY(streamKey, node))`);
    for (let i = 0; i < 200; i++) {
      seedJob(db, `douyin:${i}:2026-10-01`, [["merging", T0 + i]], 100);
      db.prepare("INSERT INTO sync_node_states(streamKey,node,state,attempts,updatedAt) VALUES(?,?,?,1,?)")
        .run(`douyin:${i}:2026-10-01`, "merge", "running", T0);
    }
    db.close();

    // 通过 DatabaseSync.prototype 计数 prepare 调用:SQLITE 语句实际执行次数的可靠代理。
    const orig = DatabaseSync.prototype.prepare;
    let n = 0;
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      n++;
      return orig.call(this, sql);
    } as typeof DatabaseSync.prototype.prepare;
    let countFor200 = 0;
    try {
      listHubJobs(dbPath, { limit: 200, now: T0 });
      countFor200 = n;
      n = 0;
      listHubJobs(dbPath, { limit: 10, now: T0 });
    } finally {
      DatabaseSync.prototype.prepare = orig;
    }
    const countFor10 = n;
    // 200 个 job 的附加表查询**不是** 200×4(旧实现 ≈800 条)。余量给 historicalRates(按 done job
    // 数线性,fixture 里 done 为 0)与 jobs 的 count/select 两条。
    expect(countFor200).toBeLessThanOrEqual(10);
    // 关键性质:200 与 10 个 job 的语句数**基本相同** → 确实与 job 数解耦。
    expect(countFor200).toBeLessThanOrEqual(countFor10 + 1);
  });

  it("空 job 集合(keys 为空)跳过全部 IN 查询,不炸", () => {
    const { dbPath, db } = makeSyncDb();
    db.close();
    expect(listHubJobs(dbPath, { states: ["nonexistent-state"] })).toEqual({ jobs: [], total: 0 });
  });

  it("旧库缺 steps 表(含 detail 列)→ 空步骤,不抛;其余表照常", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubjobs-nosteps-"));
    const dbPath = join(dir, "old-sync.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
      winnerWorker TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
    db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)").run("douyin:1:2026-10-01", "merging", T0);
    db.prepare("CREATE TABLE sync_job_events(streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)").run();
    db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run("douyin:1:2026-10-01", "pending", T0);
    db.close();
    const { jobs, total } = listHubJobs(dbPath, { now: T0 });
    expect(total).toBe(1);
    expect(jobs[0].steps).toEqual([]);           // 缺表降级
    expect(jobs[0].events).toHaveLength(1);       // 有表的照常
    expect(jobs[0].startedAt).toBe(T0);
  });

  it("limit/offset/states 过滤仍正确(批量化没动分页语义)", () => {
    const { dbPath, db } = makeSyncDb();
    for (let i = 0; i < 5; i++) {
      seedJob(db, `douyin:${i}:2026-10-01`, [["merging", T0 + i * 1000]], 100);
    }
    seedJob(db, "douyin:x:2026-10-01", [["pending", T0]], 100);
    db.close();
    const page1 = listHubJobs(dbPath, { limit: 2, offset: 0 });
    const page2 = listHubJobs(dbPath, { limit: 2, offset: 2 });
    expect(page1.total).toBe(6);
    expect(page1.jobs.map((j) => j.streamKey)).toEqual(["douyin:4:2026-10-01", "douyin:3:2026-10-01"]);
    expect(page2.jobs.map((j) => j.streamKey)).toEqual(["douyin:2:2026-10-01", "douyin:1:2026-10-01"]);
    // 分页后附加表仍正确映射回各自的 job(不能串桶)
    expect(page1.jobs[0].events[0].state).toBe("merging");
    const onlyPending = listHubJobs(dbPath, { states: ["pending"] });
    expect(onlyPending.jobs.map((j) => j.streamKey)).toEqual(["douyin:x:2026-10-01"]);
    const noTerminal = listHubJobs(dbPath, { excludeStates: ["merging"] });
    expect(noTerminal.jobs.map((j) => j.streamKey)).toEqual(["douyin:x:2026-10-01"]);
  });

  it("同毫秒(at 并列)的事件/步骤仍按插入序(rowid)稳定排序", () => {
    // 回归:批量版若只按 `at` 排,并列时会退化成 IN 查询的返回顺序(sqlite 不保证),
    // 表现为「事件时间线在两次刷新间跳动」。逐条版的 ORDER BY at, rowid 是确定的。
    const { dbPath, db } = makeSyncDb();
    seedJob(db, "douyin:1:2026-10-01", [["pending", T0]], 100);
    const SAME = T0 + 1000;
    for (const s of ["a", "b", "c", "d"]) {
      db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run("douyin:1:2026-10-01", s, SAME);
    }
    for (const st of ["s1", "s2", "s3"]) {
      db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at) VALUES(?,?,?,?)").run("douyin:1:2026-10-01", st, "start", SAME);
    }
    db.close();
    for (const _round of [1, 2]) {
      const { jobs } = listHubJobs(dbPath, { now: T0 + 5000 });
      expect(jobs[0].events.slice(-4).map((e) => e.state)).toEqual(["a", "b", "c", "d"]);
      expect(jobs[0].steps.map((s) => s.step)).toEqual(["s1", "s2", "s3"]);
    }
  });

  it("只读连接带 busy_timeout:写端持锁时读不立刻抛 BUSY(不再静默空结果)", () => {
    const { dbPath, db } = makeSyncDb();
    seedJob(db, "douyin:1:2026-10-01", [["merging", T0]], 100);
    // BEGIN IMMEDIATE 拿写锁并保持事务打开 = 另一个连接此刻无共享锁。
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
      .run("douyin:2:2026-10-01", "uploading", T0 + 1);
    try {
      // 有 busy_timeout → 读会等;写事务很快被回滚(下面),所以这里要么拿到数据、要么拿到一致快照。
      // **关键是不得**因为一次 SQLITE_BUSY 就回落成 `{jobs:[],total:0}`(静默空队列)。
      const r = listHubJobs(dbPath, { now: T0 });
      expect(r.jobs.length + r.total).toBeGreaterThan(0);
    } finally {
      try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
      db.close();
    }
  });
});

describe("latestRunPerRoom.manualPhase (issue #190)", () => {
  it("needs_manual 的最新一场带与队列同源的细分;其他状态为 null;不外泄 error", () => {
    const { dbPath, db } = makeSyncDb();
    const now = T0 + 1_000;
    seedJob(db, "douyin:A:2026-10-01", [["needs_manual", now]], 100, { error: STAGE_READY });
    seedJob(db, "douyin:B:2026-10-01", [["needs_manual", now]], 100, { error: "用户停止" });
    seedJob(db, "douyin:C:2026-10-01", [["needs_manual", now]], 100, { error: "上传失败" });
    seedJob(db, "douyin:D:2026-10-01", [["needs_manual", now]], 100);
    seedJob(db, "douyin:E:2026-10-01", [["done", now]], 100, { bv: "BV1" });
    db.close();
    const by = Object.fromEntries(latestRunPerRoom(dbPath).map((r) => [r.roomKey, r]));
    expect(by["douyin:A"].manualPhase).toBe("waiting_upload");
    expect(by["douyin:B"].manualPhase).toBe("stopped");
    expect(by["douyin:C"].manualPhase).toBe("waiting_manual");
    expect(by["douyin:D"].manualPhase).toBe("waiting_manual"); // 空 error = 异常
    expect(by["douyin:E"].manualPhase).toBeNull();
    expect(JSON.stringify(by["douyin:C"])).not.toContain("上传失败");
  });

  it("needsManualPhaseOf 精确相等:带空白的 STAGE_READY 不算正常收口", () => {
    expect(needsManualPhaseOf(STAGE_READY)).toBe("waiting_upload");
    expect(needsManualPhaseOf(` ${STAGE_READY} `)).toBe("waiting_manual");
    expect(needsManualPhaseOf(" 用户停止 ")).toBe("stopped");
    expect(needsManualPhaseOf(null)).toBe("waiting_manual");
  });
});

describe("queued node upload status (plan 038 PR5)", () => {
  const KEY = "douyin:7:2026-10-17";
  const status = (over: Record<string, unknown> = {}) => ({
    nodeId: "n1", phase: "biliup", state: "running", step: "transfer", attempts: 1, notBefore: null,
    heartbeatAt: T0, leaseAlive: true, bv: null, error: null, polledAt: T0 + 9_000,
    progress: { doneBytes: 400, totalBytes: 1_000, bps: 100, at: T0 }, ...over,
  });
  function seed(raw: string | null, state = "syncing") {
    const { dbPath, db } = makeSyncDb();
    db.exec("ALTER TABLE sync_jobs ADD COLUMN uploadStatus TEXT");
    seedJob(db, KEY, [["pending", T0], [state, T0 + 1_000]], 3_600);
    db.prepare("UPDATE sync_jobs SET uploadStatus=? WHERE streamKey=?").run(raw, KEY);
    db.close();
    return dbPath;
  }

  it("exposes the snapshot and replaces the ETA with the measured rate", () => {
    const dbPath = seed(JSON.stringify(status()));
    const job = listHubJobs(dbPath, { now: T0 + 10_000 }).jobs[0]!;
    expect(job.nodeUpload).toMatchObject({ nodeId: "n1", step: "transfer", progress: { doneBytes: 400 } });
    expect(job.etaSec).toBe(6); // (1000 - 400) / 100
    const row = buildQueueView(dbPath, { now: T0 + 10_000 }).active.find((r) => r.streamKey === KEY)!;
    expect(row.nodeUpload?.nodeId).toBe("n1");
    expect(row.etaSec).toBe(6);
  });

  it("a stale snapshot, no rate or a non-running job keeps the historical ETA", () => {
    const cases = [
      status({ polledAt: T0 - 10 * 60_000 }),
      status({ progress: { doneBytes: 400, totalBytes: 1_000, bps: null, at: T0 } }),
      status({ state: "pending" }),
    ];
    for (const s of cases) {
      const eta = listHubJobs(seed(JSON.stringify(s)), { now: T0 + 10_000 }).jobs[0]!.etaSec;
      expect(eta).not.toBe(6);
    }
  });

  it("missing column, malformed JSON and terminal jobs read as null", () => {
    const { dbPath, db } = makeSyncDb();
    seedJob(db, KEY, [["syncing", T0]], 100);
    db.close();
    expect(listHubJobs(dbPath).jobs[0]!.nodeUpload).toBeNull();
    expect(listHubJobs(seed("{bad")).jobs[0]!.nodeUpload).toBeNull();
    expect(listHubJobs(seed(JSON.stringify(status()), "done")).jobs[0]!.nodeUpload).toBeNull();
  });
});
