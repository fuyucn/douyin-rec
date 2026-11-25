/** issue #752:台账的失败处置字段(classifyUploadOutcome 的落库侧)。 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SyncLedger } from "./ledger.js";

const path = (): string => join(mkdtempSync(join(tmpdir(), "ledger-plan-")), "control.db");

describe("SyncLedger 失败处置计划(failureClass / nextAttemptAt)", () => {
  it("旧库首次打开自动补列,且新列可为空", () => {
    const p = path();
    const old = new DatabaseSync(p);
    // 旧库的真实最小形态:有历史列但**没有**新的 failureClass/nextAttemptAt。
    old.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL, winnerWorker TEXT,
      bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, startMs INTEGER, updatedAt INTEGER NOT NULL)`);
    old.prepare("INSERT INTO sync_jobs(streamKey,state,updatedAt) VALUES ('k','failed',1)").run();
    old.close();
    const ledger = new SyncLedger(p);
    const row = ledger.get("k");
    expect(row?.failureClass ?? null).toBeNull();
    expect(row?.nextAttemptAt ?? null).toBeNull();
    ledger.close();
  });

  it("setFailurePlan 落库并可被 dueForRetry 取到;clearFailurePlan 之后不再排队", () => {
    const p = path();
    const ledger = new SyncLedger(p);
    ledger.upsertPending("k");
    ledger.setState("k", "failed", { error: "boom" });
    expect(ledger.setFailurePlan("k", { failureClass: "safe-retry", nextAttemptAt: 1000 })).toBe(true);
    const due = ledger.dueForRetry(1500);
    expect(due.map((r) => r.streamKey)).toEqual(["k"]);
    expect(due[0]?.failureClass).toBe("safe-retry");
    // 未到期不取
    expect(ledger.dueForRetry(999)).toEqual([]);
    ledger.clearFailurePlan("k");
    expect(ledger.dueForRetry(9999)).toEqual([]);
    ledger.close();
  });

  it("人工分类带时间戳会被归一化成 NULL(直接断言落库值)", () => {
    const p = path();
    const ledger = new SyncLedger(p);
    ledger.upsertPending("k1");
    ledger.setFailurePlan("k1", { failureClass: "verify-manual", nextAttemptAt: 10 });
    expect(ledger.get("k1")?.nextAttemptAt ?? null).toBeNull();
    // 未分类(NULL)同样不许留时间戳
    ledger.setFailurePlan("k1", { failureClass: null, nextAttemptAt: 10 });
    expect(ledger.get("k1")?.nextAttemptAt ?? null).toBeNull();
    ledger.close();
  });

  it("即使手工写入了更早到期的人工/未分类行,limit 也不会被它们占住", () => {
    const p = path();
    const ledger = new SyncLedger(p);
    ledger.upsertPending("legal");
    ledger.upsertPending("manual");
    ledger.upsertPending("unclassified");
    ledger.upsertPending("finished");
    // 绕过 setFailurePlan 的归一化,直接写库模拟历史脏数据(更早到期)
    ledger.setState("legal", "failed", { error: "boom" });
    ledger.setFailurePlan("legal", { failureClass: "safe-retry", nextAttemptAt: 500 });
    ledger.setFailurePlan("manual", { failureClass: "verify-manual" });
    ledger.setFailurePlan("unclassified", { failureClass: null });
    ledger.setFailurePlan("finished", { failureClass: "safe-retry" });
    const db = new DatabaseSync(p);
    db.prepare("UPDATE sync_jobs SET failureClass='verify-manual', nextAttemptAt=1, state='failed' WHERE streamKey='manual'").run();
    db.prepare("UPDATE sync_jobs SET failureClass=NULL, nextAttemptAt=1, state='failed' WHERE streamKey='unclassified'").run();
    db.prepare("UPDATE sync_jobs SET failureClass='safe-retry', nextAttemptAt=1, state='done' WHERE streamKey='finished'").run();
    db.close();
    // 更早到期的三条都不合格 → limit=1 仍能取到合法那条
    expect(ledger.dueForRetry(1000, 1).map((r) => r.streamKey)).toEqual(["legal"]);
    ledger.close();
  });

  it("resume-append + retrying 是可调度组合;收口与失败的状态对计划的影响各不相同", () => {
    const p = path();
    const ledger = new SyncLedger(p);
    ledger.upsertPending("r1");
    ledger.setState("r1", "retrying", {});
    ledger.setFailurePlan("r1", { failureClass: "resume-append", nextAttemptAt: 5 });
    expect(ledger.dueForRetry(10).map((r) => r.streamKey)).toEqual(["r1"]);

    // needs_manual / done 收口 → 两列都清掉
    ledger.setState("r1", "needs_manual", { error: "x" });
    expect(ledger.get("r1")?.failureClass ?? null).toBeNull();
    expect(ledger.get("r1")?.nextAttemptAt ?? null).toBeNull();

    // failed 是「可重试」的中间态:换 markFailed 之后计划应保留(等调度决定)
    ledger.upsertPending("r2");
    ledger.setFailurePlan("r2", { failureClass: "safe-retry", nextAttemptAt: 7 });
    ledger.setFailurePlan("r2", { failureClass: "safe-retry", nextAttemptAt: 7 });
    expect(ledger.get("r2")?.nextAttemptAt).toBe(7);
    ledger.close();
  });

  it("dueForRetry 只取到期且可自动重试的行,并按 nextAttemptAt 升序截断", () => {
    const p = path();
    const ledger = new SyncLedger(p);
    for (const [k, at] of [["a", 30], ["b", 10], ["c", 20]] as Array<[string, number]>) {
      ledger.upsertPending(k);
      ledger.setState(k, "failed", { error: "boom" });
      ledger.setFailurePlan(k, { failureClass: "safe-retry", nextAttemptAt: at });
    }
    expect(ledger.dueForRetry(20, 2).map((r) => r.streamKey)).toEqual(["b", "c"]);
    expect(ledger.dueForRetry(20, 1).map((r) => r.streamKey)).toEqual(["b"]);
    ledger.close();
  });

  it("verify-manual 不写 nextAttemptAt → 永不进自动队列", () => {
    const p = path();
    const ledger = new SyncLedger(p);
    ledger.upsertPending("k");
    ledger.setFailurePlan("k", { failureClass: "verify-manual" });
    expect(ledger.dueForRetry(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(ledger.get("k")?.failureClass).toBe("verify-manual");
    ledger.close();
  });
});
