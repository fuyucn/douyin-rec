/**
 * 0 落盘流式直传(plans/039):弹幕是这条路径上**唯一**还落盘的东西。
 * 这里只验证 pump 与弹幕接缝的生命周期契约(不依赖真实 WS):
 *   - 稿件恢复失败/有未确认分 P → 根本不该连弹幕;
 *   - 未开播 → 不连(会解析到陈旧 liveId);开播后连一次、收尾停一次(异常退出也停)。
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLivePump } from "./live-pump.js";

const base = (dir: string) => ({
  cookiesPath: join(dir, "cookies.json"),
  room: "12345",
  spoolDir: dir,
  title: "t",
  tid: 21,
  tag: "x",
  sizeCap: 10 * 1024 * 1024,
  quality: "origin",
  submit: false,
  fetch: async () => ({ living: false }),
  sleep: async () => {},
});

describe("runLivePump danmu seam", () => {
  it("未开播 → 不连弹幕(会解析到陈旧 liveId),等待中被停止也不触发 stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-danmu-"));
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const drain = new AbortController();
    let calls = 0;
    const res = await runLivePump({
      ...base(dir),
      waitForBroadcast: true,
      drainSignal: drain.signal,
      fetch: async () => { if (++calls === 3) drain.abort(); return { living: false }; },
      danmu: { start, stop, xmlPath: join(dir, "a.xml") },
    });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("idle");
    expect(res.segments).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("开播后才连一次弹幕,异常退出路径也停一次", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-danmu-"));
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    let calls = 0;
    // Live from the 3rd probe. No cookies file exists, so the part setup throws, which exercises
    // the `finally` stop path right after the danmu connected.
    await expect(runLivePump({
      ...base(dir),
      waitForBroadcast: true,
      fetch: async () => (++calls < 3 ? { living: false } : { living: true, url: "http://invalid.test/none.flv" }),
      danmu: { start, stop, xmlPath: join(dir, "a.xml") },
    })).rejects.toThrow();
    // 3 waiting probes, then one fresh fetch after the session is opened (the probe URL is dropped).
    expect(calls).toBe(4);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("弹幕连接抛错 → 视频路径不受影响,且不重复 stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-danmu-"));
    const stop = vi.fn(async () => {});
    // No cookies file: the video path throws on its own, which proves a danmu failure did not
    // stop it from being reached.
    await expect(runLivePump({
      ...base(dir),
      fetch: async () => ({ living: true, url: "http://invalid.test/none.flv" }),
      danmu: { start: async () => { throw new Error("ws down"); }, stop, xmlPath: join(dir, "a.xml") },
    })).rejects.toThrow(/cookies/);
    expect(stop).not.toHaveBeenCalled(); // start 失败 = 没连上,不应再 stop
  });
});
