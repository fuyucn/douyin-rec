import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { registerPlatform, type DownloadEngine, type Platform, type RecorderEvents } from "@drec/core";
import { PollingRecorder, STALL_CHECK_MS, STALL_TIMEOUT_MS } from "./index.js";

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

  it("主播已下播但进程仍吊着 → 静默收尾,不报卡死", async () => {
    vi.useFakeTimers();
    registerPlatform(makePlatform(false));
    const proc = new FakeProc();
    const { rec, ev, outDir } = await startRecorder(proc);
    (rec as unknown as { lastAdvanceAt: number }).lastAdvanceAt = Date.now() - 120_000;

    await vi.advanceTimersByTimeAsync(STALL_CHECK_MS * 2);
    await vi.advanceTimersByTimeAsync(0); // 冲掉 handleStall 里的 living 查询微任务

    expect(ev.onProbeError).not.toHaveBeenCalled();
    expect(proc.killCalls).toEqual(["SIGKILL"]);

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
