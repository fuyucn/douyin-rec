import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { registerPlatform, type DownloadEngine, type Platform, type RecorderEvents } from "@drec/core";
import {
  PollingRecorder, POLL_MS, STALL_CHECK_MS, STALL_GRACEFUL_EXIT_MS, STALL_TIMEOUT_MS, THROTTLE_POLL_MS,
  THROTTLE_MAX_POLL_MS,
} from "./index.js";

/** 可控退出状态的假下载子进程(不真 spawn)。 */
class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  killCalls: (string | number)[] = [];
  kill(signal: string | number = "SIGTERM"): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    return true;
  }
}

function makePlatform(living: boolean | "error"): Platform {
  return {
    id: "test-stall",
    matchUrl: (url) => /test\.local/.test(url),
    urlPattern: "test.local",
    roomToUrl: (room) => room,
    extractRoomSlug: (url) => url.replace(/^https?:\/\//, ""),
    resolveShortUrl: async () => null,
    fetchAnchorName: async () => null,
    getStream: async () => ({ living: true, url: "http://test.local/live.flv", owner: "测试主播" }),
    getLiving: async () => {
      if (living === "error") throw new Error("network down");
      return living;
    },
    defaultQuality: "origin",
    defaultEngine: "ffmpeg",
    qualities: ["origin"],
    engines: ["ffmpeg"],
  };
}

async function startRecorder(proc: FakeProc) {
  const engine: DownloadEngine = {
    id: "fake",
    spawn: () => ({ proc: proc as unknown as ChildProcess, sessionFirstPath: "/out/a.ts" }),
  };
  const rec = new PollingRecorder(engine);
  const ev: RecorderEvents = {
    onLive: vi.fn(),
    onSegment: vi.fn(),
    onOffline: vi.fn(),
    onError: vi.fn(),
    onProbeError: vi.fn(),
  };
  const outDir = mkdtempSync(join(tmpdir(), "rec-stall-"));
  await rec.start("https://test.local/live/123", { quality: "origin", outDir, segmentSec: 0 }, ev);
  await vi.advanceTimersByTimeAsync(1); // 让 poll() 的微任务完成 spawn
  return { rec, ev, outDir };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("卡死看门狗(正常下播不误报)", () => {
  it("进程已 exit 但 close 晚到 → 不误报录制卡死", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(false));
    const proc = new FakeProc();
    const { rec, ev, outDir } = await startRecorder(proc);
    (rec as unknown as { lastAdvanceAt: number }).lastAdvanceAt = Date.now() - 120_000;

    proc.exitCode = 0;
    proc.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + STALL_CHECK_MS * 2);

    expect(ev.onProbeError).not.toHaveBeenCalled();
    expect(proc.killCalls).toHaveLength(0);

    proc.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(1);
    expect(ev.onOffline).toHaveBeenCalledTimes(1);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("主播已下播但进程仍吊着 → 先 SIGINT 优雅收尾(不报卡死);宽限内没退再 SIGKILL", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(false));
    const proc = new FakeProc();
    const { rec, ev, outDir } = await startRecorder(proc);
    (rec as unknown as { lastAdvanceAt: number }).lastAdvanceAt = Date.now() - 120_000;

    await vi.advanceTimersByTimeAsync(STALL_CHECK_MS);
    await vi.advanceTimersByTimeAsync(0); // 冲掉 handleStall 里的 living 查询微任务

    expect(ev.onProbeError).not.toHaveBeenCalled();
    expect(proc.killCalls).toEqual(["SIGINT"]); // 不再直接强杀:给 ffmpeg 收尾机会

    await vi.advanceTimersByTimeAsync(STALL_GRACEFUL_EXIT_MS + 1); // 进程仍未退出 → 兜底强杀
    expect(proc.killCalls).toEqual(["SIGINT", "SIGKILL"]);

    proc.emit("close", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    expect(ev.onOffline).toHaveBeenCalledTimes(1);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("仍在播但无输出 → 保留卡死告警并杀进程重连", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(true));
    const proc = new FakeProc();
    const { rec, ev, outDir } = await startRecorder(proc);
    (rec as unknown as { lastAdvanceAt: number }).lastAdvanceAt = Date.now() - 120_000;

    await vi.advanceTimersByTimeAsync(STALL_CHECK_MS * 2);
    await vi.advanceTimersByTimeAsync(0);

    const onProbeError = vi.mocked(ev.onProbeError!);
    expect(onProbeError).toHaveBeenCalledTimes(1);
    expect(String(onProbeError.mock.calls[0]?.[0])).toContain("录制卡死");
    expect(proc.killCalls).toEqual(["SIGKILL"]);

    proc.emit("close", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    expect(ev.onOffline).toHaveBeenCalledTimes(1);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("判活 API 不可达 → 告警说明无法确认状态,不误称录制卡死", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform("error"));
    const proc = new FakeProc();
    const { rec, ev, outDir } = await startRecorder(proc);
    (rec as unknown as { lastAdvanceAt: number }).lastAdvanceAt = Date.now() - 120_000;

    await vi.advanceTimersByTimeAsync(STALL_CHECK_MS * 2);
    await vi.advanceTimersByTimeAsync(0);

    const onProbeError = vi.mocked(ev.onProbeError!);
    expect(onProbeError).toHaveBeenCalledTimes(1);
    expect(String(onProbeError.mock.calls[0]?.[0])).toContain("无法确认主播状态");
    expect(String(onProbeError.mock.calls[0]?.[0])).not.toContain("录制卡死");
    expect(proc.killCalls).toEqual(["SIGKILL"]);
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("停滞提前探活(不依赖弹幕:弹幕关闭/无弹幕平台同样生效)", () => {
  it("停滞达提前阈值且已下播 → 提前 SIGINT 收尾(不必等满 60s)", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(false)); // getLiving=false
    const proc = new FakeProc();
    const { rec, ev, outDir } = await startRecorder(proc);
    // 停滞 20s:未达 STALL_TIMEOUT_MS(60s),但已达提前阈值(15s)
    (rec as unknown as { lastAdvanceAt: number }).lastAdvanceAt = Date.now() - 20_000;

    await vi.advanceTimersByTimeAsync(STALL_CHECK_MS); // 看门狗 tick
    await vi.advanceTimersByTimeAsync(0);              // 冲掉 getLiving 微任务

    expect(proc.killCalls).toEqual(["SIGINT"]);        // 提前收尾
    expect(ev.onProbeError).not.toHaveBeenCalled();    // 不是卡死,不告警
    rmSync(outDir, { recursive: true, force: true });
  });

  it("停滞达提前阈值但仍在播 → 不干预(等看门狗原逻辑,不杀进程)", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(true)); // getLiving=true(流抖动)
    const proc = new FakeProc();
    const { rec, outDir } = await startRecorder(proc);
    (rec as unknown as { lastAdvanceAt: number }).lastAdvanceAt = Date.now() - 20_000;

    await vi.advanceTimersByTimeAsync(STALL_CHECK_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(proc.killCalls).toHaveLength(0); // 仍在播 → 什么都不做
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("hintStreamEnded(弹幕旁路提示 → 权威复核)", () => {
  it("权威判活=下播 → 立刻 SIGINT 收尾(不等看门狗 60s)", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(false)); // getLiving = false
    const proc = new FakeProc();
    const { rec, ev, outDir } = await startRecorder(proc);
    (rec as unknown as { lastAdvanceAt: number }).lastAdvanceAt = Date.now() - 1_000; // 刚还在推进,看门狗远未触发

    rec.hintStreamEnded?.("直播已结束");
    await vi.advanceTimersByTimeAsync(0); // 冲掉 getLiving 微任务

    expect(proc.killCalls).toEqual(["SIGINT"]); // 秒级收尾
    expect(ev.onProbeError).not.toHaveBeenCalled(); // 不是卡死,不告警
    rmSync(outDir, { recursive: true, force: true });
  });

  it("权威判活=仍在播 → 忽略(网络抖动不误判收播,不杀进程)", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(true)); // getLiving = true(只是断流)
    const proc = new FakeProc();
    const { rec, ev, outDir } = await startRecorder(proc);

    rec.hintStreamEnded?.("疑似断流");
    await vi.advanceTimersByTimeAsync(0);

    expect(proc.killCalls).toHaveLength(0); // 绝不动进程
    expect(ev.onOffline).not.toHaveBeenCalled();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("判活 API 不可达 → 忽略(未知不当收播)", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform("error")); // getLiving 抛错
    const proc = new FakeProc();
    const { rec, outDir } = await startRecorder(proc);

    rec.hintStreamEnded?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(proc.killCalls).toHaveLength(0);
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("风控降频轮询(platform.getStream 返回 throttledReason)", () => {
  it("探到风控 → 降频 + 不算取流失败告警;解除后恢复正常间隔", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const state = { throttled: true };
    const p = makePlatform(false);
    p.getStream = async () => {
      calls++;
      return state.throttled ? { living: false, throttledReason: "请求过快，请稍后重试" } : { living: false };
    };
    registerPlatform(p);
    const { ev, outDir } = await startRecorder(new FakeProc());
    await vi.advanceTimersByTimeAsync(1); // 首次 poll
    expect(calls).toBe(1);
    expect(ev.onProbeError).not.toHaveBeenCalled(); // 风控不是「取流失败」,不告警

    await vi.advanceTimersByTimeAsync(POLL_MS);            // 30s 内不再探测(降频生效)
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(THROTTLE_POLL_MS - POLL_MS); // 满 5 分钟才探第二次
    expect(calls).toBe(2);

    state.throttled = false;                               // 风控解除
    // 第 2 次探测时已退避到 10 分钟(递进退避),故要等 10 分钟才到下一次探测点。
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(POLL_MS);            // 之后恢复 30s 间隔
    expect(calls).toBe(4);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("平台指定 pollIntervalMs(快手 5 分钟)→ 常态就按该间隔探测,不再 30s 一次", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = makePlatform(false);
    p.pollIntervalMs = 5 * 60_000;
    p.getStream = async () => { calls++; return { living: false }; };
    registerPlatform(p);
    const { outDir } = await startRecorder(new FakeProc());
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);            // 30s 内不探
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - POLL_MS); // 满 5 分钟才探第二次
    expect(calls).toBe(2);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("持续风控 → 探测间隔递进退避(5→10→20 分钟翻倍,封顶 30 分钟)", async () => {
    vi.useFakeTimers();
    const at: number[] = []; // 每次探测的 (虚拟) 时刻
    const p = makePlatform(false);
    // 用 30s 基础间隔,便于观察退避(快手常态 5 分钟会让第一次退避不显形)。
    p.getStream = async () => { at.push(Date.now()); return { living: false, throttledReason: "请求过快，请稍后重试" }; };
    registerPlatform(p);
    const { outDir } = await startRecorder(new FakeProc());
    // 每次都推进「够久」(> 最大间隔),到点自然探测;用探测时刻的**间隔**验证退避曲线。
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(THROTTLE_MAX_POLL_MS + 1);
    // 相邻间隔:第 1→2 次 = 5 分钟(首次风控),之后逐次翻倍 10→20→30(封顶),不再增长。
    const gaps = at.slice(1).map((t, i) => Math.round((t - at[i]) / 60_000));
    expect(gaps.slice(0, 4)).toEqual([5, 10, 20, 30]);     // 递进退避曲线
    expect(Math.max(...gaps)).toBe(30);                    // 封顶 30 分钟,不无限翻倍
    expect(gaps.slice(4).every((g) => g === 30)).toBe(true);
    expect(THROTTLE_MAX_POLL_MS).toBe(30 * 60_000);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("递进退避后风控解除 → 计数清零,间隔回落到基础值", async () => {
    vi.useFakeTimers();
    const state = { throttled: true };
    const p = makePlatform(false);
    p.getStream = async () => (state.throttled ? { living: false, throttledReason: "请求过快" } : { living: false });
    registerPlatform(p);
    const { outDir } = await startRecorder(new FakeProc());
    await vi.advanceTimersByTimeAsync(1);                  // 进风控(1)
    await vi.advanceTimersByTimeAsync(THROTTLE_POLL_MS);   // 风控(2)→ 退避到 10 分钟
    state.throttled = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);        // 解除 → 复位到 basePollMs
    // 解除后再等一个基础间隔即应再探(说明已回落到 30s,而非仍按 10 分钟)
    let calls = 0;
    p.getStream = async () => { calls++; return { living: false }; };
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls).toBe(1);
    rmSync(outDir, { recursive: true, force: true });
  });
});

/**
 * T14:`lastProgressAgeMs()` 契约 —— **复用**卡死看门狗的 lastAdvanceAt(不引入第二套时钟)。
 * 关键语义:无活跃进程 / 从未 markProgress → `null`(绝不能返回 ~epoch 的巨大年龄,
 * 否则上层会把「没在录」误判成「卡死」)。
 */
describe("lastProgressAgeMs(T14 进度信号)", () => {
  it("无活跃进程(未 start / 已 stop)→ null", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(false));
    const engine: DownloadEngine = { id: "fake", spawn: () => ({ proc: new FakeProc() as unknown as ChildProcess, sessionFirstPath: "/out/a.ts" }) };
    const rec = new PollingRecorder(engine);
    expect(rec.lastProgressAgeMs()).toBeNull();   // 还没 start
    const ev: RecorderEvents = { onLive: vi.fn(), onSegment: vi.fn(), onOffline: vi.fn(), onError: vi.fn() };
    const outDir = mkdtempSync(join(tmpdir(), "rec-age-"));
    await rec.start("https://test.local/live/9", { quality: "origin", outDir, segmentSec: 0 }, ev);
    void rec.stop();              // stop 有 SIGINT→8s SIGKILL 宽限(真等会超时);fake timer 下摘 proc 即生效
    await vi.advanceTimersByTimeAsync(8_001); // 走完 SIGINT→SIGKILL 宽限 → proc 摘掉
    expect(rec.lastProgressAgeMs()).toBeNull();   // 已停 → 无活跃录制
    rmSync(outDir, { recursive: true, force: true });
  });

  it("录制中且从未 markProgress(lastAdvanceAt=0)→ null,不是 ~epoch 巨龄", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(false));
    const proc = new FakeProc();
    const { rec, outDir } = await startRecorder(proc);
    (rec as unknown as { lastAdvanceAt: number }).lastAdvanceAt = 0; // 极端态:从未有进度
    expect(rec.lastProgressAgeMs()).toBeNull();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("录制中:进程已 exit(close 未到)也算无活跃进程 → null", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(false));
    const proc = new FakeProc();
    const { rec, outDir } = await startRecorder(proc);
    proc.exitCode = 0;
    proc.emit("exit", 0, null);
    expect(rec.lastProgressAgeMs()).toBeNull();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("录制中:随 markProgress 刷新,龄随时间增长", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(false));
    const proc = new FakeProc();
    const { rec, outDir } = await startRecorder(proc);
    // startRecorder 里已 advance(1) 让 poll 完成 spawn;从此刻起算龄。
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rec.lastProgressAgeMs()).toBeGreaterThanOrEqual(Date.now() - t0); // lastAdvanceAt 可能早 t0 ≤1ms
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rec.lastProgressAgeMs()).toBeGreaterThanOrEqual(Date.now() - t0);
    expect(rec.lastProgressAgeMs()).toBeLessThanOrEqual(8_001);
    (rec as unknown as { markProgress: () => void }).markProgress(); // 引擎报前进 → 龄归零
    expect(rec.lastProgressAgeMs()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rec.lastProgressAgeMs()).toBe(1_000);
    rmSync(outDir, { recursive: true, force: true });
  });
});
