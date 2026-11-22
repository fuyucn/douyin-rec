/**
 * web-db-ioerr.test.ts — issue #742 回归：SQLite I/O 故障要回 503 + 明确文案，别再是笼统 500。
 *
 * 三条真实故障注入路径（都不 mock SQLite 本身）：
 *   ① TaskStore.listTasks() 抛 Node 24 `node:sqlite` 的真实形状错误（errcode=10 disk I/O error）；
 *   ② 把 hub 台账库路径指向一个**目录** → 真抛 errcode=14（unable to open）；
 *   ③ 把台账库换成一个**不是数据库的文本文件** → 真抛 errcode=26（file is not a database，损坏类）。
 * 再加上「非 IO 错误仍是 500、文案不变」与「健康台账 done 计数正确」，防止把别的错误染成 503、
 * 或把计数读成 0。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { createWebServer } from "../../packages/app/src/web/server.js";
import type { ManagerLike } from "../../packages/app/src/web/api.js";
import { deleteHubHistory } from "../../packages/orchestrator/src/ledger-history.js";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";

class MockManager implements ManagerLike {
  runningIds(): number[] { return []; }
  isRunning(): boolean { return false; }
  start(): boolean { return false; }
  async stop(): Promise<void> {}
  async stopWithin(): Promise<boolean> { return false; }
  async stopGraceful(): Promise<void> {}
  logs(): string[] { return []; }
  async requestStop(): Promise<void> {}
  isDraining(): boolean { return false; }
  isGated(): boolean { return false; }
}

/** Node 24 `node:sqlite` 实测形状：code + errcode + errstr。 */
function sqliteError(errcode: number, errstr: string): Error {
  const e = new Error(errstr) as Error & { code: string; errcode: number; errstr: string };
  e.code = "ERR_SQLITE_ERROR";
  e.errcode = errcode;
  e.errstr = errstr;
  return e;
}

describe("数据库 I/O 故障的 HTTP 语义（issue #742）", () => {
  let store: TaskStore;
  let hubDir: string;
  const servers: Server[] = [];

  beforeEach(() => {
    store = new TaskStore(":memory:");
    hubDir = mkdtempSync(join(tmpdir(), "web-db-ioerr-"));
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    vi.restoreAllMocks();
  });

  async function start(syncDbPath: string): Promise<string> {
    const server = createWebServer({
      store,
      manager: new MockManager(),
      log: () => {},
      resolveAnchor: async () => null,
      resolveShortUrl: async () => null,
      hubDir,
      syncDbPath,
      deleteHubHistory: (path, roomKey) => deleteHubHistory({
        syncDbPath: path, roomKey, stageDir: hubDir, logsDir: hubDir,
      }),
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function okLedgerPath(): string {
    const syncDbPath = join(hubDir, "sync.db");
    new SyncLedger(syncDbPath).close();  // 真建表（空库只有结构、没有行）
    return syncDbPath;
  }

  it("任务库抛 SQLITE_IOERR → GET /api/tasks 回 503 且文案点明挂载/重启", async () => {
    const base = await start(okLedgerPath());
    vi.spyOn(store, "listTasks").mockImplementation(() => { throw sqliteError(10, "disk I/O error"); });
    const res = await fetch(`${base}/api/tasks`);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/数据库暂时不可用/);
    expect(body.error).toMatch(/挂载/);
    expect(body.error).toContain("errcode=10");  // 错误码要跟着回/进日志
    expect(body.error).not.toBe("服务器内部错误");
  });

  it("非 IO 的 SQLite 错误仍走 500 + 原文案（不误判成 503）", async () => {
    const base = await start(okLedgerPath());
    // errcode=19（CONSTRAINT）与普通 TypeError 都不算 I/O
    for (const err of [sqliteError(19, "constraint failed"), new TypeError("boom")]) {
      vi.spyOn(store, "listTasks").mockImplementation(() => { throw err; });
      const res = await fetch(`${base}/api/tasks`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "服务器内部错误" });
    }
  });

  it("hub 台账库打不开（CANTOPEN）→ GET /api/hub/jobs 回 503，不是 500", async () => {
    // 库路径指向一个目录：真实触发 SQLITE_CANTOPEN(14) —— 归 IO 类。
    const base = await start(hubDir);
    const res = await fetch(`${base}/api/hub/jobs`);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/数据库暂时不可用/);
    expect(body.error).toMatch(/挂载/);
    expect(body.error).toMatch(/errcode=\d+/);
  });

  it("hub 队列在台账 I/O 故障时同样 503", async () => {
    const base = await start(hubDir);
    const res = await fetch(`${base}/api/hub/queue`);
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/数据库暂时不可用/);
  });

  it("台账文件不是数据库（损坏类）→ 500 + 「数据库损坏」，不是 503", async () => {
    const broken = join(hubDir, "broken.db");
    writeFileSync(broken, "this is not a sqlite file\n");
    const base = await start(broken);
    const res = await fetch(`${base}/api/hub/jobs`);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/读 hub 台账失败/);
    expect(body.error).toMatch(/数据库损坏/);
    expect(body.error).not.toMatch(/数据库暂时不可用/);
  });

  it("健康台账：job 列表 200 空、队列 done 计数是真实值而不是 0", async () => {
    const syncDbPath = okLedgerPath();
    const ledger = new SyncLedger(syncDbPath);
    ledger.upsertPending("douyin:10001:2026-01-01");
    ledger.markDone("douyin:10001:2026-01-01", "fake-draft-id");
    ledger.close();
    const base = await start(syncDbPath);

    const jobs = await fetch(`${base}/api/hub/jobs`);
    expect(jobs.status).toBe(200);
    expect(await jobs.json()).toMatchObject({ total: 1 });

    const queue = await fetch(`${base}/api/hub/queue`);
    expect(queue.status).toBe(200);
    const body = await queue.json() as { doneTotal: number };
    expect(body.doneTotal).toBe(1);
  });
});
