/**
 * Issue #477: a session sidecar ({base}.session.json) write failure used to be swallowed with an
 * empty catch. Hub clusters/selects nodes by that file, so the operator needs a signal — one alert
 * per session, while recording must keep going.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingSession } from "@drec/manager";
import type { Notifier, NotifyEvent, Recorder, RecorderEvents, RecordOpts } from "@drec/core";

class MockRecorder implements Recorder {
  name = "sidecar-mock";
  providesDanmu = false;
  ev!: RecorderEvents;
  stopped = false;
  /** onOffline 时 session 查权威判活:true = 流抖动(同场重连),false = 主播下播。 */
  isLiveResults: boolean[] = [];
  async start(_url: string, _o: RecordOpts, ev: RecorderEvents) { this.stopped = false; this.ev = ev; }
  async stop() { this.stopped = true; }
  async isLive() { return this.isLiveResults.length ? this.isLiveResults.shift()! : false; }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("会话边车写入失败 (issue #477)", () => {
  it("每次失败都 warn;同一场只告警一次(同场重连不重复);下一场重新武装;录制不受影响", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "sidecar-alert-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: NotifyEvent[] = [];
    const notifier: Notifier = { async notify(e) { events.push(e); } };
    const rec = new MockRecorder();
    const sess = new RecordingSession(rec, { notifier, danmuEnabled: false, reconnectDelaySec: 0.01 });
    await sess.start("https://live.douyin.com/123", { quality: "origin", outDir: dir, segmentSec: 0 }, { anchorName: "" });

    // Make the sidecar write fail deterministically: occupy its path with a directory (rename onto a
    // directory → EISDIR).
    mkdirSync(join(dir, "s1.session.json"), { recursive: true });
    mkdirSync(join(dir, "s2.session.json"), { recursive: true });

    const warns = (): number => warn.mock.calls.filter((c) => c.some((a) => String(a).includes("会话边车写入失败"))).length;
    const alerts = (): NotifyEvent[] => events.filter((e) => e.kind === "error" && (e as { stage?: string }).stage === "边车");

    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s1_000.ts"));
    expect(warns()).toBe(1);
    expect(alerts()).toHaveLength(1);
    expect(String((alerts()[0] as { message: string }).message)).toContain("s1.session.json");
    const firstWarn = warn.mock.calls.find((c) => c.some((a) => String(a).includes("会话边车写入失败")))!;
    expect(String(firstWarn[2] ?? "").length).toBeGreaterThan(0); // the warn carries the real reason
    expect(rec.stopped).toBe(false); // recording is not interrupted by a sidecar failure

    // Same-broadcast reconnect: writing the same sidecar fails again → one more warn, no second alert.
    rec.isLiveResults = [true];
    rec.ev.onOffline();
    await vi.runAllTimersAsync();
    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s1_000.ts"));
    expect(warns()).toBe(2);
    expect(alerts()).toHaveLength(1);
    expect(rec.stopped).toBe(false);

    // Next broadcast (new base) fails → the alert is re-armed.
    rec.ev.onSegment(join(dir, "s2_000.ts"));
    expect(warns()).toBe(3);
    expect(alerts()).toHaveLength(2);

    // The final (gaps) write fails too → warned, still no duplicate alert.
    await sess.stop();
    expect(warns()).toBe(4);
    expect(alerts()).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("边车写入正常时不告警", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-ok-"));
    const events: NotifyEvent[] = [];
    const notifier: Notifier = { async notify(e) { events.push(e); } };
    const rec = new MockRecorder();
    const sess = new RecordingSession(rec, { notifier, danmuEnabled: false, reconnectDelaySec: 0.01 });
    await sess.start("https://live.douyin.com/123", { quality: "origin", outDir: dir, segmentSec: 0 }, { anchorName: "" });
    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s1_000.ts"));
    expect(events.filter((e) => e.kind === "error")).toHaveLength(0);
    await sess.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
