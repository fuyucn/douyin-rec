/**
 * issue #428:SyncLedger 的并发口径 —— WAL + busy_timeout。
 *
 * 台账有三个写端:serve 长连接、master 本机直播直传收尾的 record 子进程(每次 `new SyncLedger`
 * / recordStreamUpload)、删除房间历史的写连接。修复前无任何 PRAGMA:任一只读/写连接持锁时,
 * 写端提交立刻 `SQLITE_BUSY`,pipeline 步骤被误记 failed(稿件已传、台账没记)。
 *
 * 竞争用 test/sqlite-lock-holder(worker 线程持写事务)制造:主线程阻塞在同步 sqlite 调用里时,
 * 只有真线程能释放锁。变异验证:撤掉 busy_timeout / initWal 重试,下面的用例分别转红。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdWriteLock } from "../sqlite-lock-holder.js";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { recordStreamUpload } from "../../packages/orchestrator/src/stream-upload-ledger.js";

function freshDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-wal-"));
  return { dir, dbPath: join(dir, "sync.db") };
}

/** 从旁路连接读库文件里**持久化**的 journal_mode(busy_timeout 是每连接设置,读不到旁路的)。 */
function journalMode(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    return String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  } finally {
    db.close();
  }
}

describe("SyncLedger WAL + busy_timeout(issue #428)", () => {
  it("fresh 库构造后即 WAL(默认还是 rollback journal 的老库打开后也会被切过去)", () => {
    const { dir, dbPath } = freshDbPath();
    try {
      expect(journalMode(dbPath)).toBe("delete"); // DatabaseSync 新建文件默认非 WAL
      const ledger = new SyncLedger(dbPath);
      try {
        expect(journalMode(dbPath)).toBe("wal");
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("老库(rollback journal + 旧 schema)打开:数据保留、补列迁移照常、切 WAL、可继续写", () => {
    const { dir, dbPath } = freshDbPath();
    try {
      // 造一个「修复前的旧版本」库:无 fails/ackedAt 等后加列,且保持 rollback journal。
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
        winnerWorker TEXT, bv TEXT, error TEXT, updatedAt INTEGER NOT NULL)`);
      db.prepare("INSERT INTO sync_jobs(streamKey,state,updatedAt) VALUES(?,?,?)")
        .run("douyin:1:2026-01-01", "done", 123);
      db.close();
      expect(journalMode(dbPath)).toBe("delete");

      const ledger = new SyncLedger(dbPath);
      try {
        expect(journalMode(dbPath)).toBe("wal");
        expect(ledger.get("douyin:1:2026-01-01")?.state).toBe("done");
        expect(ledger.upsertPending("douyin:1:2026-02-01")).toEqual({ isNew: true });
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("写端撞上他人写事务:busy_timeout 等锁,不抛 SQLITE_BUSY", async () => {
    const { dir, dbPath } = freshDbPath();
    const ledger = new SyncLedger(dbPath);
    try {
      const { locked, released } = holdWriteLock(dbPath, 200);
      await locked; // 另一线程已 BEGIN IMMEDIATE
      const t0 = Date.now();
      expect(ledger.upsertPending("k1")).toEqual({ isNew: true }); // 必须等到锁释放才写进去
      expect(Date.now() - t0).toBeGreaterThanOrEqual(120); // 真的等过锁,而不是侥幸先写
      await released;
      expect(ledger.get("k1")?.state).toBe("pending");
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("并发首开:他人持写事务时切 WAL 退避重试,构造不抛 database is locked", async () => {
    const { dir, dbPath } = freshDbPath();
    try {
      const { locked, released } = holdWriteLock(dbPath, 200);
      await locked; // 保证构造时 journal_mode=WAL 必然撞锁(busy_timeout 对切换不生效)
      const ledger = new SyncLedger(dbPath); // 修复前:直接抛 SQLITE_BUSY
      try {
        await released;
        expect(journalMode(dbPath)).toBe("wal");
        expect(ledger.upsertPending("k1")).toEqual({ isNew: true });
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("record 子进程收尾路径(recordStreamUpload)在写锁竞争下也成功,台账落到 done", async () => {
    const { dir, dbPath } = freshDbPath();
    try {
      new SyncLedger(dbPath).close(); // 先切 WAL,模拟 serve 已建库
      const { locked, released } = holdWriteLock(dbPath, 200);
      await locked;
      const r = recordStreamUpload({ syncDbPath: dbPath, streamKey: "douyin:9:2026-01-01-zd", bvid: "BV1", parts: 2 });
      await released;
      expect(r.ok).toBe(true);
      const check = new DatabaseSync(dbPath);
      try {
        expect((check.prepare("SELECT state, bv FROM sync_jobs").get() as { state: string; bv: string }))
          .toEqual({ state: "done", bv: "BV1" });
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
