/**
 * issue #96:PollingRecorder 起录前过准入闸门(拒绝 → 不起录、继续轮询;放行 → 起录),
 * 告警按稳定 key 去重(剩余空间数值变化不算新原因)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPlatform, type AdmitDecision, type Platform, type PlatformStream, type RecorderEvents } from "@drec/core";
import { PollingRecorder } from "@drec/record-engine";

const gatePlatform: Platform = {
  id: "gatetest",
  matchUrl: (u) => /gate\.test\//.test(u),
  roomToUrl: (r) => `https://gate.test/${r}`,
  extractRoomSlug: (u) => u.replace(/^https?:\/\/gate\.test\//, ""),
  resolveShortUrl: async () => null,
  fetchAnchorName: async () => null,
  getStream: async (): Promise<PlatformStream> => ({ living: true, url: "https://stream.invalid/x.flv" }),
  getLiving: async () => true,
  defaultQuality: "origin",
  defaultEngine: "ffmpeg",
  qualities: ["origin"],
  engines: ["ffmpeg"],
};
registerPlatform(gatePlatform);

/** 只数「起录」次数,不真的 spawn 引擎。 */
class CountingRecorder extends PollingRecorder {
  spawned = 0;
  protected override spawnRecording(): void { this.spawned++; }
}
const ev = { onLive() {}, onSegment() {}, onOffline() {} } as unknown as RecorderEvents;
const opts = (admit?: () => AdmitDecision) => ({ quality: "origin", outDir: "/tmp/gate-rec-test", segmentSec: 0, admit }) as never;
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("PollingRecorder 准入闸门", () => {
  it("拒绝 → 不起录,保持轮询;放行后下一轮自动起录", async () => {
    let d: AdmitDecision = { ok: false, reason: "低水位", key: "k1" };
    const r = new CountingRecorder({ id: "fake" } as never);
    await r.start("https://gate.test/1", opts(() => d), ev);
    await flush();
    expect(r.spawned).toBe(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(r.spawned).toBe(0);          // 仍被拒
    d = { ok: true };
    await vi.advanceTimersByTimeAsync(31_000);
    expect(r.spawned).toBe(1);          // 空间恢复 → 自动开始
    await r.stop();
  });

  it("闸门抛错 → 放行起录(探测失败绝不误拦)", async () => {
    const r = new CountingRecorder({ id: "fake" } as never);
    await r.start("https://gate.test/2", opts(() => { throw new Error("boom"); }), ev);
    await flush();
    expect(r.spawned).toBe(1);
    await r.stop();
  });

  it("不注入 admit → 照常起录(默认行为不变)", async () => {
    const r = new CountingRecorder({ id: "fake" } as never);
    await r.start("https://gate.test/3", opts(undefined), ev);
    await flush();
    expect(r.spawned).toBe(1);
    await r.stop();
  });

  it("按 key 去重:reason 里的实时数值变化不重复告警;key 变了才再告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let free = 9.9;
    let key = "disk-below-watermark:10.0";
    const r = new CountingRecorder({ id: "fake" } as never);
    await r.start("https://gate.test/4", opts(() => ({ ok: false, reason: `剩余 ${free.toFixed(1)}GB`, key })), ev);
    await flush();
    const countDenied = () => [...warn.mock.calls, ...logSpy.mock.calls].filter((c) => String(c.join(" ")).includes("准入闸门拒绝")).length;
    const first = countDenied();
    expect(first).toBe(1);
    for (let i = 0; i < 3; i++) { free -= 0.1; await vi.advanceTimersByTimeAsync(31_000); }
    expect(countDenied()).toBe(first);   // 数值变了,key 没变 → 不再告警
    key = "disk-below-watermark:15.0";
    await vi.advanceTimersByTimeAsync(31_000);
    expect(countDenied()).toBe(first + 1); // key 变了 → 再告警一次
    await r.stop();
    warn.mockRestore(); logSpy.mockRestore();
  });
});
