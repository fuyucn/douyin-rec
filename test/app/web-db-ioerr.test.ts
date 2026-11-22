/**
 * web-db-ioerr.test.ts — issue #742 回归：SQLite I/O 故障要回 503 + 明确文案，别再是笼统 500。
 *
 * 两条真实故障注入路径（都不 mock SQLite 本身）：
 *   ① TaskStore.listTasks() 抛 Node 24 `node:sqlite` 的真实形状错误（errcode=10 disk I/O error）；
 *   ② 把 hub 台账库路径指向一个**目录** → `new DatabaseSync(dir)` 真抛 errcode=14（unable to open）。
 * 另外钉住「非 IO 错误仍是 500、文案不变」，防止这次改动把别的错误也染成 503。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
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
function sqliteIoError(): Error {
  const e = new Error("disk I/O error") as Error & { code: string; errcode: number; errstr: string };
  e.code = "ERR_SQLITE_ERROR";
  e.errcode = 10;
  e.errstr = "disk I/O error";
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

  it("任务库抛 SQLITE_IOERR → GET /api/tasks 回 503 且文案点明挂载/重启", async () => {
    const base = await start(join(hubDir, "sync.db"));
    vi.spyOn(store, "listTasks").mockImplementation(() => { throw sqliteIoError(); });
    const res = await fetch(`${base}/api/tasks`);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/数据库暂时不可用/);
    expect(body.error).toMatch(/挂载/);
    // 不再是笼统 500 —— 值班据此判断「不是数据坏了」。
    expect(body.error).not.toBe("服务器内部错误");
  });

  it("非 IO 错误仍走 500 + 原文案（不误判成 503）", async () => {
    const base = await start(join(hubDir, "sync.db"));
    vi.spyOn(store, "listTasks").mockImplementation(() => { throw new TypeError("boom"); });
    const res = await fetch(`${base}/api/tasks`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "服务器内部错误" });
  });

  it("hub 台账库打不开（CANTOPEN）→ GET /api/hub/jobs 回 503，不是 500", async () => {
    // 把库路径指向一个目录：真实触发 SQLITE_CANTOPEN(14) —— 归 IO 类。
    const base = await start(hubDir);
    const res = await fetch(`${base}/api/hub/jobs`);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/读 hub 台账失败/);
    expect(body.error).toContain("数据库 I/O 错误");
    expect(body.error).toMatch(/挂载/);
  });

  it("hub 队列在台账 I/O 故障时同样 503（队列统计不静默报 done=0）", async () => {
    const base = await start(hubDir);
    const res = await fetch(`${base}/api/hub/queue`);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/读 hub 队列失败|数据库暂时不可用/);
  });

  it("正常的台账库路径不受影响（回归）", async () => {
    const syncDbPath = join(hubDir, "sync.db");
    // 真建表（空库只有表结构、没有行）→ 读路径应当正常返回空列表。
    const ledger = new SyncLedger(syncDbPath);
    ledger.close();
    const base = await start(syncDbPath);
    const res = await fetch(`${base}/api/hub/jobs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [], total: 0 });
  });
});
