/**
 * hub-watch(T4) —— 台账变更指纹 + 去抖 + 订阅 + SSE 帧。
 *
 * 口径锚在四条真实故障上:
 *   - 指纹不用 COUNT(*):大表全表扫会随台账增长线性变慢,且「有没有变」只需看最新写入位;
 *   - db 文件不存在/旧库缺表 → 指纹稳定且**不抛**(slave 节点常驻监视器不能因无台账而死掉);
 *   - 无变更不推(否则每 tick 一次前端全量刷新,比轮询还糟);
 *   - 退订后不再收到,且退订**幂等**(SSE close 可能与 watch 重建并发)。
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TaskStore } from "../../packages/app/src/store.js";
import { createWebServer, matchRoute } from "../../packages/app/src/web/server.js";
import type { ManagerLike } from "../../packages/app/src/web/api.js";
import { HubWatch, computeVersionFingerprint, fingerprintEquals, sseComment, sseFrame } from "../../packages/app/src/hub-watch.js";

/** 台账 fixture(结构即契约)。 */
function makeDb(): { dbPath: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "hubwatch-"));
  const dbPath = join(dir, "x-sync.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
    winnerWorker TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_job_events(streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_job_steps(streamKey TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT)`);
  db.exec(`CREATE TABLE sync_node_states(streamKey TEXT NOT NULL, node TEXT NOT NULL, state TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL, PRIMARY KEY(streamKey,node))`);
  return { dbPath, db };
}

/** mtime 分辨率:ms 以内写两次可能同 mtime,测试里必须保证指纹变化的**来源**是字段值。 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("computeVersionFingerprint", () => {
  it("db 文件不存在 → 纯 mtime 指纹且不抛", () => {
    const fp = computeVersionFingerprint("/nonexistent/nope-sync.db");
    expect(fp.mtimeMs).toBe(-1);
    expect(fp.jobsMaxUpdatedAt).toBeNull();
    // 两次取样必须完全相等,否则「无变更」会变成「每 tick 推一次」。
    expect(fingerprintEquals(fp, computeVersionFingerprint("/nonexistent/nope-sync.db"))).toBe(true);
  });

  it("空台账取到 null 聚合值(不是 0);写入后指纹变化", () => {
    const { dbPath, db } = makeDb();
    const empty = computeVersionFingerprint(dbPath);
    expect(empty.jobsMaxUpdatedAt).toBeNull();
    expect(empty.jobsMaxRowid).toBeNull();

    db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
      .run("douyin:1:2026-10-01", "merging", 1000);
    db.close();
    const after = computeVersionFingerprint(dbPath);
    expect(after.jobsMaxUpdatedAt).toBe(1000);
    expect(after.jobsMaxRowid).toBe(1);
    expect(fingerprintEquals(empty, after)).toBe(false);
  });

  it("steps 追加(不动 sync_jobs)也算变更 —— MAX(rowid) 抓得到", () => {
    const { dbPath, db } = makeDb();
    db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
      .run("douyin:1:2026-10-01", "merging", 1000);
    const before = computeVersionFingerprint(dbPath);
    db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at) VALUES(?,?,?,?)")
      .run("douyin:1:2026-10-01", "merge", "start", 1001);
    db.close();
    const after = computeVersionFingerprint(dbPath);
    expect(after.jobsMaxUpdatedAt).toBe(before.jobsMaxUpdatedAt); // jobs 没动
    expect(after.stepsMaxRowid).not.toBe(before.stepsMaxRowid);     // steps 抓到了
    expect(fingerprintEquals(before, after)).toBe(false);
  });

  it("node_states 原地更新(同 rowid,updatedAt 变)也算变更", () => {
    const { dbPath, db } = makeDb();
    db.prepare("INSERT INTO sync_node_states(streamKey,node,state,attempts,updatedAt) VALUES(?,?,?,1,?)")
      .run("douyin:1:2026-10-01", "merge", "running", 2000);
    const before = computeVersionFingerprint(dbPath);
    db.prepare("UPDATE sync_node_states SET state=?, updatedAt=? WHERE node=?")
      .run("done", 3000, "merge");
    db.close();
    const after = computeVersionFingerprint(dbPath);
    expect(after.nodeStatesMaxUpdatedAt).toBe(3000);
    expect(fingerprintEquals(before, after)).toBe(false);
  });

  it("旧库缺表 → 稳定降级,不抛,且两次取样相等", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubwatch-old-"));
    const dbPath = join(dir, "old-sync.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated(x INTEGER)"); // 只有一张无关表
    db.close();
    const a = computeVersionFingerprint(dbPath);
    const b = computeVersionFingerprint(dbPath);
    expect(a.stepsMaxRowid).toBeNull();
    expect(fingerprintEquals(a, b)).toBe(true);
  });
});

describe("HubWatch", () => {
  it("变更推送一次;无变更不推", async () => {
    const { dbPath, db } = makeDb();
    const watch = new HubWatch(dbPath, { debounceMs: 10 });
    const fn = vi.fn();
    watch.subscribe(fn);

    watch.check();
    expect(fn).not.toHaveBeenCalled(); // 构造时已播种基线,首次 check 无变更

    db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
      .run("douyin:2:2026-10-02", "uploading", 5000);
    watch.check();
    await sleep(40);
    expect(fn).toHaveBeenCalledTimes(1);

    watch.check(); // 无变更
    watch.check();
    await sleep(40);
    expect(fn).toHaveBeenCalledTimes(1); // 不因重复 check 而多推
    db.close();
    watch.stop();
  });

  it("去抖:窗口内连续多次变更合并成一次推送", async () => {
    const { dbPath, db } = makeDb();
    const watch = new HubWatch(dbPath, { debounceMs: 40 });
    const fn = vi.fn();
    watch.subscribe(fn);
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
        .run(`douyin:${i}:2026-10-03`, "merging", i);
      watch.check();
    }
    expect(fn).not.toHaveBeenCalled(); // 窗口内还没发
    await sleep(90);
    expect(fn).toHaveBeenCalledTimes(1); // 5 次写入 = 1 次推送
    db.close();
    watch.stop();
  });

  it("退订后不再收到;退订幂等;subscriberCount 回落(无泄漏)", async () => {
    const { dbPath, db } = makeDb();
    const watch = new HubWatch(dbPath, { debounceMs: 5 });
    const fn = vi.fn();
    const off = watch.subscribe(fn);
    expect(watch.subscriberCount).toBe(1);
    off();
    off(); // 幂等
    off();
    expect(watch.subscriberCount).toBe(0);

    db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
      .run("douyin:3:2026-10-04", "syncing", 9000);
    watch.check();
    await sleep(30);
    expect(fn).not.toHaveBeenCalled();
    db.close();
    watch.stop();
  });

  it("一个订阅者抛错不带走其他订阅者,且不被静默吞掉(有日志)", async () => {
    const { dbPath, db } = makeDb();
    const logs: string[] = [];
    const watch = new HubWatch(dbPath, { debounceMs: 5, log: (m) => logs.push(m) });
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    watch.subscribe(bad);
    watch.subscribe(good);

    db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
      .run("douyin:4:2026-10-05", "merging", 7000);
    watch.check();
    await sleep(30);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1); // 没被带倒
    expect(logs.some((l) => l.includes("抛错"))).toBe(true); // 不是静默失败
    db.close();
    watch.stop();
  });

  it("无人订阅时不推也不抛(空订阅不该产生副作用)", async () => {
    const { dbPath, db } = makeDb();
    const watch = new HubWatch(dbPath, { debounceMs: 5 });
    db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
      .run("douyin:5:2026-10-06", "merging", 6000);
    expect(() => { watch.check(); }).not.toThrow();
    await sleep(30);
    db.close();
    watch.stop();
  });

  it("start 幂等(不叠加定时器);stop 后不再检查", async () => {
    vi.useFakeTimers();
    try {
      const { dbPath, db } = makeDb();
      const watch = new HubWatch(dbPath, { intervalMs: 100, debounceMs: 0 });
      const fn = vi.fn();
      watch.subscribe(fn);
      watch.start();
      watch.start();
      db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
        .run("douyin:6:2026-10-07", "merging", 4000);
      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(1); // 若叠加了定时器会是 2+
      const callsAfterFirst = fn.mock.calls.length;
      watch.stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(fn.mock.calls.length).toBe(callsAfterFirst); // stop 后不再推
      expect(watch.subscriberCount).toBe(0); // stop 清空订阅,不留闭包引用
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SSE 帧", () => {
  it("sseFrame 输出 event:/data:/空行 结构", () => {
    const f = sseFrame("changed", { at: 123 });
    expect(f).toBe('event: changed\ndata: {"at":123}\n\n');
    expect(f.endsWith("\n\n")).toBe(true);
    expect(f.split("\n")[0].startsWith("event: ")).toBe(true);
    expect(f.split("\n")[1].startsWith("data: ")).toBe(true);
  });

  it("data 内的换行被转义,不会破坏帧结构(裸换行会让 SSE 提前截断该帧)", () => {
    const f = sseFrame("changed", { msg: "a\nb" });
    // 唯一允许的裸换行是帧尾的\n\n;data 行本身必须单行(第 3 行不是 data → 提前截断)。
    expect(f.split("\n")).toEqual(['event: changed', 'data: {"msg":"a\\nb"}', "", ""]);
    expect(f).toBe('event: changed\ndata: {"msg":"a\\nb"}\n\n');
  });

  it("心跳是注释帧(EventSource 忽略,且不是 data 帧)", () => {
    const c = sseComment();
    expect(c).toBe(": hb\n\n");
    expect(c.startsWith(":")).toBe(true);
    expect(c).not.toContain("data:");
  });
});

/**
 * `/api/hub/stream` 的**真 socket** 端到端(T4):证明它走 SSE 而不是 JSON,
 * 变更后能收到 changed 帧,断开后订阅数回落(无监听器泄漏)。
 *
 * 独立成文件尾而不是塞进 web-server.test.ts —— 那是别人的写入范围。
 */
class MockManager implements ManagerLike {
  isRunning(): boolean { return false; }
  start(): boolean { return false; }
  async stop(): Promise<void> {}
  async stopGraceful(): Promise<void> {}
  getRuntime(): { running: boolean; startedAt: number | null; elapsedMs: number | null; anchorName: string | null } {
    return { running: false, startedAt: null, elapsedMs: null, anchorName: null };
  }
  getAnchorName(): string | null { return null; }
  isRecording(): boolean { return false; }
  getLogs(): string[] { return []; }
}

describe("GET /api/hub/stream(SSE)", () => {
  it("路由命中 hubStream(不进 dispatch 的 JSON 路径)", () => {
    expect(matchRoute("GET", "/api/hub/stream")).toMatchObject({ name: "hubStream" });
    expect(matchRoute("POST", "/api/hub/stream")).toBeNull();
  });

  it("未注入 hubWatch → 503 显式不可用(不是静默 404/空流)", async () => {
    const store = new TaskStore(":memory:");
    const server = createWebServer({ store, manager: new MockManager() });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/hub/stream`);
      expect(res.status).toBe(503);
      expect((await res.json() as { error: string }).error).toContain("hubWatch");
    } finally {
      server.close();
      store.close();
    }
  });

  it("变更推 changed 帧 + 断开后退订(subscriberCount 回落)", async () => {
    const { dbPath, db } = makeDb();
    const watch = new HubWatch(dbPath, { debounceMs: 5 });
    const store = new TaskStore(":memory:");
    const server = createWebServer({ store, manager: new MockManager(), hubWatch: watch });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const ctrl = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/hub/stream`, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toContain("no-cache");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();

      // 首帧 open:EventSource 能立刻 onopen,不必等第一次真实变更。
      const first = decoder.decode((await reader.read()).value);
      expect(first).toContain("event: open");
      await sleep(20);
      expect(watch.subscriberCount).toBe(1);

      // 写台账 → check → 应收到 changed。
      db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,?)")
        .run("douyin:7:2026-10-08", "merging", 4242);
      watch.check();
      let buf = "";
      for (let i = 0; i < 20 && !buf.includes("event: changed"); i++) {
        const chunk = await Promise.race([
          reader.read().then((r) => (r.done ? "" : decoder.decode(r.value))),
          sleep(100).then(() => ""),
        ]);
        buf += chunk;
      }
      expect(buf).toContain("event: changed");

      // 断开 → 退订。close 是异步到达的,轮询等它回落。
      ctrl.abort();
      for (let i = 0; i < 50 && watch.subscriberCount > 0; i++) await sleep(20);
      expect(watch.subscriberCount).toBe(0); // 无泄漏
    } finally {
      ctrl.abort();
      watch.stop();
      server.close();
      store.close();
      db.close();
    }
  });
});
