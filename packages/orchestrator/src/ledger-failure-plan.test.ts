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
