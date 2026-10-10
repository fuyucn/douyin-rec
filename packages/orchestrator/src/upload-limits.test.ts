import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUploadLimitStore, sanitizeUploadLimitState } from "./upload-limits.js";
import { ResourcePool } from "./workflow.js";

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "upload-limits-")), "test-sync.db");
}
const silence = (): void => {};

describe("upload-limits store", () => {
  it("首次运行无文件 → 空窗口(不是不可用)", () => {
    const store = openUploadLimitStore(dbPath(), { log: silence });
    expect(store.load()).toEqual({ blockedUntil: 0, times: [] });
    store.close();
  });

  it("save → 另一个 store 实例读回同一状态", () => {
    const p = dbPath();
    const a = openUploadLimitStore(p, { log: silence });
    a.save({ blockedUntil: 123, times: [1, 2, 3] });
    a.close();
    const b = openUploadLimitStore(p, { log: silence });
    expect(b.load()).toEqual({ blockedUntil: 123, times: [1, 2, 3] });
    b.close();
  });

  it("库文件损坏/非 sqlite → load 返回 null(不可用),不抛", () => {
    const p = dbPath();
    writeFileSync(p, "this is not sqlite at all");
    const store = openUploadLimitStore(p, { log: silence });
    expect(store.load()).toBeNull();
    store.close();
  });

  it("times 是坏 JSON → 保住 blockedUntil,窗口归零", () => {
    const p = dbPath();
    const store = openUploadLimitStore(p, { log: silence });
    store.save({ blockedUntil: 999, times: [1] });
    // 直接改坏 times 列(模拟半截写入/外部损坏)。
    const db = (store as unknown as { close(): void });
    db.close();
    const raw = new DatabaseSync(p);
    raw.exec("UPDATE upload_limits SET times='{oops' WHERE id=1");
    raw.close();
    const reopened = openUploadLimitStore(p, { log: silence });
    expect(reopened.load()).toEqual({ blockedUntil: 999, times: [] });
    reopened.close();
  });

  it("load 裁掉窗口外的历史 times;乱序/非法值被清洗", () => {
    const now = 1_000_000;
    const state = sanitizeUploadLimitState(
      { blockedUntil: 5, times: [999_999, -3, Number.NaN, 500_000, "x", 900_000] },
      now,
      600_000,
    );
    expect(state.blockedUntil).toBe(5);
    expect(state.times).toEqual([500_000, 900_000, 999_999]); // 升序,窗口外(<400000)已丢
  });

  it("时钟回拨:窗口外的旧时刻不会被当成已占额", () => {
    const now = 2_000_000;
    const state = sanitizeUploadLimitState({ blockedUntil: 0, times: [100, 1_999_999] }, now, 600_000);
    expect(state.times).toEqual([1_999_999]);
  });

  it("并发写(多进程同库)后仍是合法单行,不产生半截 JSON", () => {
    const p = dbPath();
    const stores = Array.from({ length: 5 }, () => openUploadLimitStore(p, { log: silence }));
    for (let i = 0; i < 50; i++) {
      for (const s of stores) s.save({ blockedUntil: i, times: [i, i + 1] });
    }
    for (const s of stores) s.close();
    const final = openUploadLimitStore(p, { log: silence });
    const state = final.load();
    expect(state).not.toBeNull();
    expect(state!.times).toEqual([49, 50]);
    final.close();
  });
});

describe("ResourcePool + 持久化限流", () => {
  const CFG = { uploadRateLimit: 2, uploadRateWindowMs: 1_000, uploadCooldownMs: 5_000 };

  function makePool(p: string, now: () => number, sleep: (ms: number) => Promise<void>, warns: string[] = []) {
    return new ResourcePool(CFG, { now, sleep, limitStore: openUploadLimitStore(p, { log: (m) => warns.push(m) }), warn: (m) => warns.push(m) });
  }

  it("命中 601 后新建 pool(同 store)仍在冷却期,提交被等到冷却结束", async () => {
    const p = dbPath();
    let now = 1_000_000;
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); now += ms; };
    const pool = makePool(p, () => now, sleep);
    await expect(pool.withUpload(async () => { throw new Error("code: 601"); })).rejects.toThrow();
    const blocked = pool.snapshot().upload.cooldownUntil;
    expect(blocked).toBe(now + 5_000);

    // 模拟重启:新进程、同一库、时间继续推进。
    const sleeps2: number[] = [];
    const pool2 = makePool(p, () => now, async (ms) => { sleeps2.push(ms); now += ms; });
    expect(pool2.snapshot().upload.cooldownUntil).toBe(now + 5_000);
    await pool2.withUpload(async () => "ok");
    expect(sleeps2.length).toBeGreaterThan(0); // 确实等了冷却,而不是直接放行
  });

  it("滑动窗口计数跨重启保留(重启即打爆会被挡住)", async () => {
    const p = dbPath();
    let now = 1_000_000;
    const pool = makePool(p, () => now, async (ms) => { now += ms; });
    await pool.withUpload(async () => 1);
    await pool.withUpload(async () => 2);
    expect(pool.snapshot().upload.windowUsed).toBe(2);

    const pool2 = makePool(p, () => now, async (ms) => { now += ms; });
    expect(pool2.snapshot().upload.windowUsed).toBe(2); // 窗口不归零
    // 第三次必须等窗口滑出,而不是立刻通过。
    const before = now;
    await pool2.withUpload(async () => 3);
    expect(now).toBeGreaterThan(before);
  });

  it("无 store 时行为不变(纯内存,旧语义)", async () => {
    let now = 1_000_000;
    const pool = new ResourcePool(CFG, { now: () => now, sleep: async (ms) => { now += ms; } });
    await expect(pool.withUpload(async () => { throw new Error("code: 601"); })).rejects.toThrow();
    expect(pool.snapshot().upload.cooldownUntil).toBe(now + 5_000);
  });

  it("存储不可用 → fail-closed:启动即冷却一个 cooldown,不是无限速", () => {
    const p = dbPath();
    writeFileSync(p, "not a db");
    let now = 1_000_000;
    const warns: string[] = [];
    const pool = makePool(p, () => now, async (ms) => { now += ms; }, warns);
    expect(pool.snapshot().upload.cooldownUntil).toBe(now + 5_000);
    expect(warns.join()).toContain("保守");
  });

  it("fail-closed 不因配置 cooldown=0 而退化成无限速", () => {
    const p = dbPath();
    writeFileSync(p, "not a db");
    let now = 1_000_000;
    const pool = new ResourcePool({ ...CFG, uploadCooldownMs: 0 }, {
      now: () => now, sleep: async () => {},
      limitStore: openUploadLimitStore(p, { log: silence }), warn: silence,
    });
    expect(pool.snapshot().upload.cooldownUntil).toBeGreaterThan(now);
  });

  it("save 抛错 → 只 warn,上传不中断(不静默)", async () => {
    let now = 1_000_000;
    const warns: string[] = [];
    const pool = new ResourcePool(CFG, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
      limitStore: { load: () => ({ blockedUntil: 0, times: [] }), save: () => { throw new Error("disk full"); }, close: () => {} },
      warn: (m) => warns.push(m),
    });
    await expect(pool.withUpload(async () => "ok")).resolves.toBe("ok");
    expect(warns.join()).toContain("disk full");
  });
});
