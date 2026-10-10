import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  UploadGate,
  biliAccountKey,
  biliAccountKeyFromCookiesJson,
  openUploadLimitStore,
  type UploadGateStore,
  type UploadLimitState,
} from "./upload-gate.js";

const silence = (): void => {};

/** 可注入时钟:now 由测试推进,sleep 立即把时间往前拨。 */
function fakeClock(start = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += Math.max(0, ms); },
    advance: (ms: number) => { t += ms; },
  };
}

function memStore(): UploadGateStore & { data: Map<string, UploadLimitState>; failLoad: boolean; failSave: boolean } {
  const data = new Map<string, UploadLimitState>();
  const s = {
    data,
    failLoad: false,
    failSave: false,
    load(key: string): UploadLimitState | null {
      if (s.failLoad) return null;
      return data.get(key) ?? { blockedUntil: 0, times: [] };
    },
    save(key: string, state: UploadLimitState): void {
      if (s.failSave) throw new Error("disk full");
      data.set(key, { blockedUntil: state.blockedUntil, times: [...state.times] });
    },
    close(): void {},
  };
  return s;
}

describe("账号键(唯一真理)", () => {
  it("DedeUserID → bilibili:<mid>", () => {
    expect(biliAccountKey("12345")).toBe("bilibili:12345");
    expect(biliAccountKey(12345)).toBe("bilibili:12345");
    expect(biliAccountKey(" 12345 ")).toBe("bilibili:12345");
  });
  it("缺 mid → bilibili:unknown(保守并桶)", () => {
    expect(biliAccountKey(null)).toBe("bilibili:unknown");
    expect(biliAccountKey("  ")).toBe("bilibili:unknown");
    expect(biliAccountKey()).toBe("bilibili:unknown");
  });
  it("从 cookies.json 解析(两种结构)", () => {
    const a = JSON.stringify({ cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "DedeUserID", value: "999" }] } });
    const b = JSON.stringify({ cookies: [{ name: "dedeuserid", value: "888" }] });
    expect(biliAccountKeyFromCookiesJson(a)).toBe("bilibili:999");
    expect(biliAccountKeyFromCookiesJson(b)).toBe("bilibili:888");
  });
  it("坏 JSON / 无该 cookie / 空 → unknown,不抛", () => {
    expect(biliAccountKeyFromCookiesJson("{oops")).toBe("bilibili:unknown");
    expect(biliAccountKeyFromCookiesJson(null)).toBe("bilibili:unknown");
    expect(biliAccountKeyFromCookiesJson(JSON.stringify({ cookies: [{ name: "SESSDATA", value: "x" }] }))).toBe("bilibili:unknown");
  });
});

describe("UploadGate 窗口限速", () => {
  it("窗口内超 rateLimit → 睡到最早一次滑出窗口", async () => {
    const c = fakeClock();
    const store = memStore();
    const gate = new UploadGate({ store, rateLimit: 2, windowMs: 1000, now: c.now, sleep: c.sleep, warn: silence });
    const at: number[] = [];
    for (let i = 0; i < 4; i++) { await gate.awaitSlot("bilibili:1"); at.push(c.now()); }
    // 窗口边界是「严格晚于 now-windowMs」(与 ResourcePool._awaitUploadSlot 同规则):
    // 到 t=1_001_000 时 t0 的两次已滑出 → 第 3、4 次同时放行,不会各等一个窗口。
    // 边界 `>=` 归在窗口内 → 多等 1ms 到 1_001_001。
    expect(at).toEqual([1_000_000, 1_000_000, 1_001_001, 1_001_001]);
  });

  it("rateLimit<=0 → 不限次数(但冷却仍生效)", async () => {
    const c = fakeClock();
    const store = memStore();
    const gate = new UploadGate({ store, rateLimit: 0, cooldownMs: 5000, now: c.now, sleep: c.sleep, warn: silence });
    await gate.awaitSlot("k");
    gate.recordRateLimit("k");
    const t0 = c.now();
    await gate.awaitSlot("k");
    expect(c.now() - t0).toBe(5000);
  });

  it("同键并发 4 次 awaitSlot 不超 rateLimit(串行链)", async () => {
    const c = fakeClock();
    const store = memStore();
    const gate = new UploadGate({ store, rateLimit: 2, windowMs: 1000, now: c.now, sleep: c.sleep, warn: silence });
    await Promise.all([gate.awaitSlot("k"), gate.awaitSlot("k"), gate.awaitSlot("k"), gate.awaitSlot("k")]);
    // 窗口内任一时刻已占额 ≤ rateLimit(串行链保证不超卖)。
    expect(store.data.get("k")!.times.length).toBeLessThanOrEqual(2);
    expect(c.now()).toBe(1_001_001);
  });

  it("不同键互不影响", async () => {
    const c = fakeClock();
    const gate = new UploadGate({ store: memStore(), rateLimit: 1, windowMs: 1000, now: c.now, sleep: c.sleep, warn: silence });
    await gate.awaitSlot("bilibili:1");
    const t0 = c.now();
    await gate.awaitSlot("bilibili:2"); // 另一个账号 → 立即放行
    expect(c.now()).toBe(t0);
  });
});

describe("UploadGate 冷却 / fail-closed", () => {
  it("recordRateLimit → 冷却期内拒绝(awaitSlot 阻塞到截止)", async () => {
    const c = fakeClock();
    const gate = new UploadGate({ store: memStore(), cooldownMs: 30_000, now: c.now, sleep: c.sleep, warn: silence });
    gate.recordRateLimit("bilibili:1");
    const t0 = c.now();
    await gate.awaitSlot("bilibili:1");
    expect(c.now() - t0).toBe(30_000);
  });

  it("run():命中 601 自动记冷却,非 601 不记", async () => {
    const c = fakeClock();
    const store = memStore();
    const gate = new UploadGate({ store, cooldownMs: 1000, now: c.now, sleep: c.sleep, warn: silence });
    await expect(gate.run("k", async () => { throw new Error("code: 601"); })).rejects.toThrow();
    expect(store.data.get("k")!.blockedUntil).toBe(1_001_000);
    await expect(gate.run("k", async () => { throw new Error("转码失败"); })).rejects.toThrow();
    expect(store.data.get("k")!.blockedUntil).toBe(1_001_000); // 未被覆盖/延长
    await expect(gate.run("k", async () => "ok")).resolves.toBe("ok");
  });

  it("21566 也算限流(与 upload-contract 同一判定)", async () => {
    const c = fakeClock();
    const store = memStore();
    const gate = new UploadGate({ store, cooldownMs: 1000, now: c.now, sleep: c.sleep, warn: silence });
    await expect(gate.run("k", async () => { throw new Error("code: 21566"); })).rejects.toThrow();
    expect(store.data.get("k")!.blockedUntil).toBeGreaterThan(0);
  });

  it("store 不可用(load=null)→ fail-closed 冷却,不是无限速", async () => {
    const c = fakeClock();
    const warns: string[] = [];
    const gate = new UploadGate({
      store: memStore(), rateLimit: 5, cooldownMs: 0, failClosedMs: 60_000,
      now: c.now, sleep: c.sleep, warn: (m) => warns.push(m),
    });
    // 用一个恒定不可用的 store
    const broken: UploadGateStore = { load: () => null, save: () => {}, close: () => {} };
    const g2 = new UploadGate({ store: broken, rateLimit: 5, cooldownMs: 0, failClosedMs: 60_000, now: c.now, sleep: c.sleep, warn: (m) => warns.push(m) });
    const t0 = c.now();
    await g2.awaitSlot("k");
    expect(c.now() - t0).toBe(60_000);
    expect(warns.join()).toMatch(/限流状态不可用/);
    void gate;
  });

  it("显式关冷却(cooldownMs=0)时 fail-closed 仍不退化成无限速", async () => {
    const c = fakeClock();
    const broken: UploadGateStore = { load: () => null, save: () => {}, close: () => {} };
    const gate = new UploadGate({ store: broken, cooldownMs: 0, failClosedMs: 30 * 60_000, now: c.now, sleep: c.sleep, warn: silence });
    const t0 = c.now();
    await gate.awaitSlot("k");
    expect(c.now() - t0).toBe(30 * 60_000);
  });

  it("save 抛错 → 只 warn,不阻断上传(内存/后续窗口仍限流)", async () => {
    const c = fakeClock();
    const warns: string[] = [];
    const store = memStore();
    store.failSave = true;
    const gate = new UploadGate({ store, rateLimit: 1, windowMs: 1000, now: c.now, sleep: c.sleep, warn: (m) => warns.push(m) });
    await gate.run("k", async () => "ok");
    expect(warns.join()).toMatch(/持久化失败/);
  });

  it("recordRateLimit 取更晚的截止(旧记录不覆盖新冷却)", async () => {
    const c = fakeClock();
    const gate = new UploadGate({ store: memStore(), cooldownMs: 1000, now: c.now, sleep: c.sleep, warn: silence });
    gate.recordRateLimit("k");
    const first = gate.peek("k").blockedUntil;
    c.advance(500);
    gate.recordRateLimit("k");
    expect(gate.peek("k").blockedUntil).toBeGreaterThan(first);
  });

  it("peek 只读、不占额", async () => {
    const c = fakeClock();
    const store = memStore();
    const gate = new UploadGate({ store, rateLimit: 1, windowMs: 1000, now: c.now, sleep: c.sleep, warn: silence });
    gate.peek("k"); gate.peek("k");
    expect(store.data.get("k")?.times ?? []).toEqual([]);
  });

  it("throwIfBlocked 在冷却等待期间可中断", async () => {
    const c = fakeClock();
    let tripped = false;
    const gate = new UploadGate({
      store: memStore(), cooldownMs: 10_000, now: c.now, warn: silence,
      sleep: async () => { tripped = true; },
      throwIfBlocked: () => { if (tripped) throw new Error("已中止"); },
    });
    gate.recordRateLimit("k");
    await expect(gate.awaitSlot("k")).rejects.toThrow("已中止");
  });
});

describe("openUploadLimitStore(sqlite)", () => {
  const p = (): string => join(mkdtempSync(join(tmpdir(), "gate-")), "x.db");

  it("按账号键分行:同键共享、不同键隔离、跨实例(重启)保留", () => {
    const db = p();
    const a = openUploadLimitStore(db, { log: silence });
    a.save("bilibili:1", { blockedUntil: 111, times: [1] });
    a.save("bilibili:2", { blockedUntil: 222, times: [] });
    a.close();
    const b = openUploadLimitStore(db, { log: silence });
    expect(b.load("bilibili:1")).toEqual({ blockedUntil: 111, times: [1] });
    expect(b.load("bilibili:2")).toEqual({ blockedUntil: 222, times: [] });
    expect(b.load("bilibili:3")).toEqual({ blockedUntil: 0, times: [] }); // 未用过 → 空状态
    b.close();
  });

  it("首次运行(文件不存在)→ 建表 + 空状态,不是 null", () => {
    const s = openUploadLimitStore(p(), { log: silence });
    expect(s.load("k")).toEqual({ blockedUntil: 0, times: [] });
    s.close();
  });

  it("库损坏 → load null(fail-closed 由 UploadGate 兜)", () => {
    const db = p();
    writeFileSync(db, "not sqlite at all");
    const s = openUploadLimitStore(db, { log: silence });
    expect(s.load("k")).toBeNull();
    s.close();
  });

  it("times 列坏 JSON → 保住 blockedUntil", () => {
    const db = p();
    const s = openUploadLimitStore(db, { log: silence });
    s.save("k", { blockedUntil: 999, times: [1] });
    s.close();
    const raw = new DatabaseSync(db);
    raw.exec("UPDATE upload_limits SET times='{oops' WHERE key='k'");
    raw.close();
    const s2 = openUploadLimitStore(db, { log: silence });
    expect(s2.load("k")).toEqual({ blockedUntil: 999, times: [] });
    s2.close();
  });

  it("并发多实例写同一键 → 状态合法(无半截 JSON)", () => {
    const db = p();
    const stores = Array.from({ length: 5 }, () => openUploadLimitStore(db, { log: silence }));
    for (let i = 0; i < 40; i++) for (const s of stores) s.save("k", { blockedUntil: i, times: [i, i + 1] });
    for (const s of stores) s.close();
    const f = openUploadLimitStore(db, { log: silence });
    const st = f.load("k");
    expect(st).not.toBeNull();
    expect(st!.times.every((t) => Number.isFinite(t))).toBe(true);
    f.close();
  });

  it("T8 单行表结构 → 自动迁移为按键分行,冷却不丢", () => {
    const db = p();
    const raw = new DatabaseSync(db);
    raw.exec(`CREATE TABLE upload_limits(id INTEGER PRIMARY KEY CHECK(id=1), blockedUntil INTEGER NOT NULL DEFAULT 0, times TEXT NOT NULL DEFAULT '[]', updatedAt INTEGER NOT NULL DEFAULT 0)`);
    raw.exec("INSERT INTO upload_limits(id, blockedUntil, times, updatedAt) VALUES(1, 555, '[1,2]', 1)");
    raw.close();
    const s = openUploadLimitStore(db, { log: silence });
    expect(s.load("default")).toEqual({ blockedUntil: 555, times: [1, 2] });
    s.save("bilibili:7", { blockedUntil: 1, times: [] });
    expect(s.load("bilibili:7")).toEqual({ blockedUntil: 1, times: [] });
    s.close();
    // 迁移幂等:再次打开不炸
    const s2 = openUploadLimitStore(db, { log: silence });
    expect(s2.load("default")!.blockedUntil).toBe(555);
    s2.close();
  });
});
