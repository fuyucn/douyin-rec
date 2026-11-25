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

  it("人工分类即使带了 nextAttemptAt 也不进队列;收口后计划被清掉", () => {
    const p = path();
    const ledger = new SyncLedger(p);
    ledger.upsertPending("k1");
    ledger.setFailurePlan("k1", { failureClass: "verify-manual", nextAttemptAt: 10 });
    expect(ledger.dueForRetry(1e9)).toEqual([]);
    // 可重试行在收口(done / needs_manual)后也不许复活
    ledger.upsertPending("k2");
    ledger.setFailurePlan("k2", { failureClass: "safe-retry", nextAttemptAt: 10 });
    ledger.setState("k2", "done", {});
    expect(ledger.dueForRetry(1e9)).toEqual([]);
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
