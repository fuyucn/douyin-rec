import { describe, it, expect, vi } from "vitest";
import { JobAbortedError, abortJob, runWithJob } from "@drec/core";
import { retry } from "./retry.js";

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

describe("retry", () => {
  it("首次成功 → 只调一次", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await retry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("前两次失败第三次成功 → 共 3 次,返回成功值", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValue("ok");
    expect(await retry(fn, { tries: 3, sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("全部失败 → 抛最后一次错误,调用次数 = tries", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockRejectedValue(new Error("last"));
    await expect(retry(fn, { tries: 3, sleep: noSleep })).rejects.toThrow("last");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("tries<=1 → 只调一次,不重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retry(fn, { tries: 1, sleep: noSleep })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("退避:每次失败后 sleep 递增(backoffMs * 2^(n-1))", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValue("ok");
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => { sleeps.push(ms); return Promise.resolve(); };
    await retry(fn, { tries: 3, backoffMs: 100, sleep });
    expect(sleeps).toEqual([100, 200]); // 两次失败 → 两次退避
  });

  it("onRetry:每次重试前回调(attempt 从 1 计,即将第 attempt+1 次)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("e1")).mockResolvedValue("ok");
    const seen: number[] = [];
    await retry(fn, { tries: 3, sleep: noSleep, onRetry: (a) => seen.push(a) });
    expect(seen).toEqual([1]); // 第 1 次失败后回调一次
  });

  it("用户停止立刻抛出,不 sleep 不重试", async () => {
    const fn = vi.fn().mockRejectedValue(new JobAbortedError());
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(retry(fn, { tries: 5, sleep })).rejects.toBeInstanceOf(JobAbortedError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    await runWithJob("k", async () => {
      abortJob("k");
      const fn2 = vi.fn().mockResolvedValue("ok");
      await expect(retry(fn2, { tries: 5, sleep })).rejects.toBeInstanceOf(JobAbortedError);
      expect(fn2).not.toHaveBeenCalled();
    });
  });
});
