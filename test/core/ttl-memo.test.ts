import { describe, it, expect } from "vitest";
import { ttlMemoAsync } from "../../packages/core/src/ttl-memo.js";

describe("ttlMemoAsync", () => {
  it("ttl 内复用结果,过期后重算", async () => {
    let t = 0, calls = 0;
    const f = ttlMemoAsync(async () => ++calls, 1000, () => t);
    expect(await f()).toBe(1);
    t = 999; expect(await f()).toBe(1);
    t = 1000; expect(await f()).toBe(2);
    expect(calls).toBe(2);
  });

  it("并发调用合并成一次在途请求", async () => {
    let calls = 0, release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = ttlMemoAsync(async () => { calls++; await gate; return "v"; }, 1000, () => 0);
    const ps = [f(), f(), f()];
    release();
    expect(await Promise.all(ps)).toEqual(["v", "v", "v"]);
    expect(calls).toBe(1);
  });

  it("失败不缓存:下次调用重试,且在途标记被清除", async () => {
    let calls = 0;
    const f = ttlMemoAsync(async () => { if (++calls === 1) throw new Error("boom"); return "ok"; }, 1000, () => 0);
    await expect(f()).rejects.toThrow("boom");
    await expect(f()).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});
