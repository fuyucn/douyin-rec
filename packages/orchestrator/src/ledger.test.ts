import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SyncLedger } from "./ledger.js";

function fresh(): SyncLedger { return new SyncLedger(join(mkdtempSync(join(tmpdir(), "led-")), "j.db")); }

describe("SyncLedger", () => {
  it("upsertPending 首次 isNew=true，再次 false（幂等去重）", () => {
    const l = fresh();
    expect(l.upsertPending("k1").isNew).toBe(true);
    expect(l.upsertPending("k1").isNew).toBe(false);
    l.close();
  });
  it("已 done 的作业不被 upsertPending 重置", () => {
    const l = fresh();
    l.upsertPending("k1"); l.markDone("k1", "BVxxx");
    l.upsertPending("k1");
    expect(l.get("k1")?.state).toBe("done");
    expect(l.get("k1")?.bv).toBe("BVxxx");
    l.close();
  });
  it("setState 写状态 + 错误", () => {
    const l = fresh();
    l.upsertPending("k1"); l.setState("k1", "failed", { error: "boom" });
    expect(l.get("k1")?.state).toBe("failed");
    expect(l.get("k1")?.error).toBe("boom");
    l.close();
  });
  it("状态转换自动记入 sync_job_events(时间线可复盘:每步起点=事件时刻)", () => {
    const l = fresh();
    l.upsertPending("k1");                       // → pending 事件
    l.setState("k1", "syncing");
    l.setState("k1", "merging");
    l.markDone("k1", "BVyyy");                   // → done 事件
    const ev = l.getEvents("k1");
    expect(ev.map((e) => e.state)).toEqual(["pending", "syncing", "merging", "done"]);
    for (const e of ev) expect(e.at).toBeGreaterThan(0);
    // markFailed 也记录
    l.upsertPending("k2");
    l.markFailed("k2", "boom");
    expect(l.getEvents("k2").map((e) => e.state)).toEqual(["pending", "failed"]);
    l.close();
  });
  it("listRecent 按 updatedAt 倒序返回最近 N 个 job", () => {
    const l = fresh();
    l.upsertPending("a"); l.upsertPending("b"); l.upsertPending("c");
    l.setState("b", "merging");                  // b 最新
    const rows = l.listRecent(2);
    expect(rows).toHaveLength(2);
    expect(rows[0].streamKey).toBe("b");
    l.close();
  });
  it("recordCandidates 落库 + 标记 winner + 幂等覆盖（选优可复盘）", () => {
    const l = fresh();
    const cands = [
      { workerId: "local", coverage: 1, durationSec: 20525, startMs: 100, endMs: 20625100, totalGapSec: 0 },
      { workerId: "vps2", coverage: 1, durationSec: 20503, startMs: 20100, endMs: 20623100, totalGapSec: 0 },
    ];
    l.recordCandidates("douyin:767:2026-06-28", cands, "local");
    const rows = l.getCandidates("douyin:767:2026-06-28");
    expect(rows).toHaveLength(2);
    expect(rows[0].isWinner).toBe(1);          // winner 排最前
    expect(rows[0].workerId).toBe("local");
    expect(rows[0].durationSec).toBe(20525);
    expect(rows[1].isWinner).toBe(0);
    // 再次写 → 覆盖不重复（PRIMARY KEY streamKey+workerId）
    l.recordCandidates("douyin:767:2026-06-28", cands, "vps2");
    const again = l.getCandidates("douyin:767:2026-06-28");
    expect(again).toHaveLength(2);
    expect(again.find((r) => r.workerId === "vps2")?.isWinner).toBe(1);
    l.close();
  });
});

describe("logStep detail", () => {
  it("stores and reads back a step detail", () => {
    const l = fresh();
    l.upsertPending("k1");
    l.logStep("k1", "pull", "start");
    l.logStep("k1", "pull", "done", "2 文件 · 1.9GB ← vps");
    const steps = l.getSteps("k1");
    const done = steps.find((s) => s.step === "pull" && s.phase === "done");
    expect(done?.detail).toBe("2 文件 · 1.9GB ← vps");
    const start = steps.find((s) => s.step === "pull" && s.phase === "start");
    expect(start?.detail ?? null).toBeNull();
    l.close();
  });
});

describe("ledger 列迁移 tenant→worker(幂等 RENAME COLUMN)", () => {
  it("打开旧 schema(winnerTenant/tenantId)库 → 自动改名列 + 旧值保留", () => {
    const dir = mkdtempSync(join(tmpdir(), "led-mig-"));
    const p = join(dir, "old.db");
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
      winnerTenant TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
    raw.exec(`CREATE TABLE sync_candidates(streamKey TEXT NOT NULL, tenantId TEXT NOT NULL,
      coverage REAL NOT NULL, durationSec REAL NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL,
      totalGapSec REAL NOT NULL, isWinner INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(streamKey, tenantId))`);
    raw.exec(`CREATE TABLE sync_job_events(streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
    raw.exec(`CREATE TABLE sync_job_steps(streamKey TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL)`);
    raw.prepare("INSERT INTO sync_jobs(streamKey,state,winnerTenant,updatedAt) VALUES(?,?,?,?)")
      .run("douyin:1:2026-06-28", "done", "local", 1);
    raw.prepare(`INSERT INTO sync_candidates(streamKey,tenantId,coverage,durationSec,startMs,endMs,totalGapSec,isWinner,updatedAt)
      VALUES(?,?,1,10,0,10,0,1,1)`).run("douyin:1:2026-06-28", "vps2");
    raw.close();

    const l = new SyncLedger(p); // 构造函数应就地迁移
    expect(l.get("douyin:1:2026-06-28")?.winnerWorker).toBe("local");   // 旧值保留 + 新列名
    expect(l.getCandidates("douyin:1:2026-06-28")[0].workerId).toBe("vps2");
    l.close();

    // 幂等:同一(已迁移)库再次打开不抛。
    const l2 = new SyncLedger(p);
    expect(l2.get("douyin:1:2026-06-28")?.winnerWorker).toBe("local");
    l2.close();
  });

  it("setBv 只落 bv 列,不改 state、不产生新事件", () => {
    const l = fresh();
    l.upsertPending("k1");                 // pending
    l.setState("k1", "uploading");         // uploading
    const before = l.getEvents("k1").length;
    l.setBv("k1", "BVabc");
    expect(l.get("k1")?.bv).toBe("BVabc");
    expect(l.get("k1")?.state).toBe("uploading"); // state 不变
    expect(l.getEvents("k1").length).toBe(before); // 不新增事件
    l.close();
  });

  it("isStepDone:最新事件为 done → true;只有 start → false;无该 step → false", () => {
    const l = fresh();
    l.upsertPending("k1");
    l.logStep("k1", "append_danmu", "start");
    expect(l.isStepDone("k1", "append_danmu")).toBe(false); // 只 start
    l.logStep("k1", "append_danmu", "done");
    expect(l.isStepDone("k1", "append_danmu")).toBe(true);  // 最新 done
    expect(l.isStepDone("k1", "append_livechat")).toBe(false); // 无该 step
    l.close();
  });

  it("isStepDone:同 step 再次 start(续跑重入)→ 最新为 start → false", () => {
    const l = fresh();
    l.upsertPending("k1");
    l.logStep("k1", "append_danmu", "start");
    l.logStep("k1", "append_danmu", "done");
    l.logStep("k1", "append_danmu", "start"); // 重入又开始
    expect(l.isStepDone("k1", "append_danmu")).toBe(false);
    l.close();
  });
});
