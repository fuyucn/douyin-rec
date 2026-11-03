import { describe, it, expect, afterEach } from "vitest";
import { fetchGuestCookie } from "./danmu-cookie.js";

// fetchGuestCookie 必须带 AbortSignal.timeout(issue #431):live.douyin.com 首页偶发挂起,
// 无超时会把弹幕 start 永久卡死在 buildDanmuCookie。这里替换 AbortSignal.timeout 捕获生产传参,
// 并用 5ms 真实超时代跑,验证「挂起的 fetch 会被中止 → 返回空串而非永久挂起」。
describe("fetchGuestCookie 访客登录态拉取超时 (issue #431)", () => {
  const origFetch = globalThis.fetch;
  const origTimeout = AbortSignal.timeout;
  // 通过 cast 替换静态方法(测试沙箱内),afterEach 恢复。
  const setTimeout_ = (impl: (ms: number) => AbortSignal): void => {
    (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = impl;
  };

  afterEach(() => {
    globalThis.fetch = origFetch;
    setTimeout_(origTimeout);
  });

  it("fetch 带 10s AbortSignal.timeout;超时 → 返回空串而非挂起", async () => {
    let timeoutMs = 0;
    setTimeout_((ms: number) => {
      timeoutMs = ms;
      return origTimeout(5); // 5ms 真实超时代跑生产值
    });
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal;
      seenSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    }) as typeof fetch;

    const c = await fetchGuestCookie();
    expect(c).toBe("");
    expect(timeoutMs).toBe(10_000);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("正常响应仍解析 set-cookie(超时不影响正常路径)", async () => {
    // 无真实定时器:返回一个与本次请求无关的 signal,避免测试进程被 10s 定时器拖住。
    setTimeout_(() => new AbortController().signal);
    globalThis.fetch = (async () =>
      new Response(null, {
        headers: { "set-cookie": "ttwid=dummy; Path=/, msToken=xyz; Path=/" },
      })) as typeof fetch;
    expect(await fetchGuestCookie()).toBe("ttwid=dummy; msToken=xyz");
  });
});
