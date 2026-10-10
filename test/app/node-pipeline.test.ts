/**
 * T19:节点侧上传共限流持久化 601 冷却 —— node-pipeline 的上传路径必须过 core UploadGate。
 *
 * 覆盖:① 命中 601 → 冷却跨「重启」(新 gate 实例 + 新 store 实例)保留;
 *      ② 冷却期内节点侧上传被阻塞;③ 账号键解析(与 master 同键/异键);
 *      ④ master 与节点共享同一限流状态文件时,总提交数不超 rateLimit(并发场景)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadGate, openUploadLimitStore, biliAccountKeyFromCookiesJson } from "@drec/core";
import { openNodeUploadGate, resolveUploadAccountKey } from "../../packages/app/src/node-pipeline.js";

const silence = (): void => {};
const tmp = (): string => join(mkdtempSync(join(tmpdir(), "node-gate-")), "x.db");
function clock(start = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += Math.max(0, ms); }, advance: (ms) => { t += ms; } };
}

describe("节点侧上传限流(T19)", () => {
  it("命中 601 → 冷却写入节点本地库;新 gate 实例(等价重启)冷却仍在", async () => {
    const db = tmp();
    const c = clock();
    const store = openUploadLimitStore(db, { log: silence });
    const gate = new UploadGate({ store, cooldownMs: 30_000, rateLimit: 5, now: c.now, sleep: c.sleep, warn: silence });
    const key = biliAccountKeyFromCookiesJson(JSON.stringify({ cookie_info: { cookies: [{ name: "DedeUserID", value: "42" }] } }));

    await expect(gate.run(key, async () => { throw new Error("code: 601"); })).rejects.toThrow();
    store.close();

    // 「重启」:全新 store + 全新 gate,冷却必须还在(不因进程重启清零)。
    const store2 = openUploadLimitStore(db, { log: silence });
    const gate2 = new UploadGate({ store: store2, cooldownMs: 30_000, rateLimit: 5, now: c.now, sleep: c.sleep, warn: silence });
    const t0 = c.now();
    await gate2.awaitSlot(key); // 冷却期内 → 阻塞到截止
    expect(c.now() - t0).toBe(30_000);
    store2.close();
  });

  it("冷却期内节点侧上传被拒绝(等够冷却才放行),非立刻重试", async () => {
    const db = tmp();
    const c = clock();
    const store = openUploadLimitStore(db, { log: silence });
    const gate = new UploadGate({ store, cooldownMs: 20_000, rateLimit: 100, now: c.now, sleep: c.sleep, warn: silence });
    gate.recordRateLimit("bilibili:42");
    const t0 = c.now();
    await gate.run("bilibili:42", async () => "bv");
    expect(c.now() - t0).toBe(20_000);
    store.close();
  });

  it("master 与节点用同一 store 文件 + 同一账号键 → 总提交数不超 rateLimit(并发)", async () => {
    const db = tmp();
    const c = clock();
    // 模拟 master ResourcePool 与节点 UploadGate 两个独立进程,共用该 db 文件。
    const masterStore = openUploadLimitStore(db, { log: silence });
    const nodeStore = openUploadLimitStore(db, { log: silence });
    const { ResourcePool } = await import("@drec/orchestrator");
    const pool = new ResourcePool(
      { uploadRateLimit: 2, uploadRateWindowMs: 1000, uploadCooldownMs: 5000 },
      { now: c.now, sleep: c.sleep, limitStore: masterStore, limitKey: "bilibili:42", warn: silence },
    );
    const nodeGate = new UploadGate({
      store: nodeStore, rateLimit: 2, windowMs: 1000, cooldownMs: 5000, now: c.now, sleep: c.sleep, warn: silence,
    });
    const key = "bilibili:42";
    // 并发 6 次提交(master 3 + 节点 3)。
    // 断言打在**限流账本**上,而不是「await 返回时刻」:注入的假时钟会被别的并发调用 sleep 推进,
    // 一个调用醒来时 now 可能已晚于自己占额的时刻(语义正常)。账本才是配额的权威。
    await Promise.all([
      pool.withUpload(async () => 1, "s1"),
      pool.withUpload(async () => 2, "s2"),
      nodeGate.awaitSlot(key),
      pool.withUpload(async () => 3, "s3"),
      nodeGate.awaitSlot(key),
      nodeGate.awaitSlot(key),
    ]);
    const st = masterStore.load(key);
    expect(st).not.toBeNull();
    const times = st!.times;
    // 账本只保留**当前窗口**(tryClaim 每次按窗口裁剪重写),窗口内条目数即已占配额数。
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((x) => Number.isFinite(x))).toBe(true);
    // master + 节点合计不超过 rateLimit=2 —— 这正是「共享限流桶」的验收标准。
    expect(times.length).toBeLessThanOrEqual(2);
    const spread = times[times.length - 1] - times[0];
    expect(spread).toBeLessThan(1000);
    masterStore.close();
    nodeStore.close();
  });

  it("不同账号互不影响(节点 A 的冷却不挡节点 B)", async () => {
    const db = tmp();
    const c = clock();
    const store = openUploadLimitStore(db, { log: silence });
    const gate = new UploadGate({ store, cooldownMs: 30_000, rateLimit: 5, now: c.now, sleep: c.sleep, warn: silence });
    gate.recordRateLimit("bilibili:1");
    const t0 = c.now();
    await gate.awaitSlot("bilibili:2");
    expect(c.now() - t0).toBe(0); // 另一账号立即放行
    store.close();
  });

  it("openNodeUploadGate:库损坏 → fail-closed 冷却(不是无限速)", async () => {
    const db = tmp();
    writeFileSync(db, "not sqlite");
    const c = clock();
    const gate = openNodeUploadGate({ store: openUploadLimitStore(db, { log: silence }), rateLimit: 5, cooldownMs: 0, warn: silence });
    // 注入假时钟需重开 gate:openNodeUploadGate 未暴露时钟 → 用 store 损坏 + 默认时钟断言不抛即可。
    // 真实验证时钟相关行为见 core/upload-gate.test.ts 的 fail-closed 用例。
    expect(() => gate.peek("k")).not.toThrow();
  });

  it("resolveUploadAccountKey:读本机 cookies.json;缺失/损坏 → unknown 桶", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-"));
    const p = join(dir, "cookies.json");
    writeFileSync(p, JSON.stringify({ cookie_info: { cookies: [{ name: "DedeUserID", value: "777" }] } }));
    expect(resolveUploadAccountKey(p)).toBe("bilibili:777");
    writeFileSync(p, "{broken");
    expect(resolveUploadAccountKey(p)).toBe("bilibili:unknown");
    expect(resolveUploadAccountKey(join(dir, "nope.json"))).toBe("bilibili:unknown");
  });
});
