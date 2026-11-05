/**
 * Issue #477: a session sidecar ({base}.session.json) write failure used to be swallowed with an
 * empty catch. Hub clusters/selects nodes by that file, so the operator needs a signal — one alert
 * per session (RecordingSession.start()), not per sidecar base, while recording keeps going.
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

const ROOM = "https://live.douyin.com/123";

function setup(dir: string, over: Partial<ConstructorParameters<typeof RecordingSession>[1]> = {}) {
  const events: NotifyEvent[] = [];
  const notifier: Notifier = { async notify(e) { events.push(e); } };
  const rec = new MockRecorder();
  const sess = new RecordingSession(rec, { notifier, danmuEnabled: false, reconnectDelaySec: 0.01, ...over });
  const alerts = (): NotifyEvent[] => events.filter((e) => e.kind === "error" && (e as { stage?: string }).stage === "边车");
  return { rec, sess, events, alerts };
}

/** Make the sidecar write for this base fail deterministically: occupy its path with a directory. */
const block = (dir: string, base: string): void => { mkdirSync(join(dir, base + ".session.json"), { recursive: true }); };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("会话边车写入失败 (issue #477)", () => {
  it("每次失败都 warn;每场只告警一次(同场重连用新时间戳基名也不重复);录制不受影响", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "sidecar-alert-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rec, sess, alerts } = setup(dir);
    await sess.start(ROOM, { quality: "origin", outDir: dir, segmentSec: 0 }, { anchorName: "" });
    block(dir, "s1");

    const warns = (): number => warn.mock.calls.filter((c) => c.some((a) => String(a).includes("会话边车写入失败"))).length;

    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s1_000.ts"));
    expect(warns()).toBe(1);
    expect(alerts()).toHaveLength(1);
    expect(String((alerts()[0] as { message: string }).message)).toContain("s1.session.json");
    const firstWarn = warn.mock.calls.find((c) => c.some((a) => String(a).includes("会话边车写入失败")))!;
    expect(String(firstWarn[2] ?? "").length).toBeGreaterThan(0); // the warn carries the real reason
    expect(rec.stopped).toBe(false); // recording is not interrupted by a sidecar failure

    // Same-broadcast reconnect: production opens a NEW stamped base (s1b), and it fails too — still one alert.
    block(dir, "s1b");
    rec.isLiveResults = [true];
    rec.ev.onOffline();
    await vi.runAllTimersAsync();
    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s1b_000.ts"));
    expect(warns()).toBe(2);
    expect(alerts()).toHaveLength(1);
    expect(rec.stopped).toBe(false);

    // Final (gaps) write fails too → warned, no duplicate alert.
    await sess.stop();
    expect(warns()).toBe(3);
    expect(alerts()).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("segment xml 粒度:同场两段各写一个边车,仍只有一条告警", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-seg-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rec, sess, alerts } = setup(dir);
    await sess.start(ROOM, { quality: "origin", outDir: dir, segmentSec: 0, danmuXmlMode: "segment" }, { anchorName: "" });
    block(dir, "s1_000");
    block(dir, "s1_001");
    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s1_000.ts"));
    rec.ev.onSegment(join(dir, "s1_001.ts"));
    const warns = warn.mock.calls.filter((c) => c.some((a) => String(a).includes("会话边车写入失败"))).length;
    expect(warns).toBe(2);
    expect(alerts()).toHaveLength(1);
    await sess.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("只有收尾那次写失败也告警(有界等待,退出前不丢),且只报一次", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-stop-"));
    const { rec, sess, alerts } = setup(dir);
    await sess.start(ROOM, { quality: "origin", outDir: dir, segmentSec: 0 }, { anchorName: "" });
    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s1_000.ts")); // 开录写成功
    expect(alerts()).toHaveLength(0);
    // 收尾前把边车路径换成目录 → 覆盖写失败
    rmSync(join(dir, "s1.session.json"));
    block(dir, "s1");
    await sess.stop();
    expect(alerts()).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("start() 重新武装:同一实例再次 start 后,首场告警会再发一次", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-rearm-"));
    const { rec, sess, alerts } = setup(dir);
    await sess.start(ROOM, { quality: "origin", outDir: dir, segmentSec: 0 }, { anchorName: "" });
    block(dir, "s1");
    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s1_000.ts"));
    expect(alerts()).toHaveLength(1);
    await sess.stop();

    // 另一次会话运行(同一实例):告警重新武装。
    await sess.start(ROOM, { quality: "origin", outDir: dir, segmentSec: 0 }, { anchorName: "" });
    block(dir, "s2");
    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s2_000.ts"));
    expect(alerts()).toHaveLength(2);
    await sess.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("边车写入正常时不告警", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-ok-"));
    const { rec, sess, events } = setup(dir);
    await sess.start(ROOM, { quality: "origin", outDir: dir, segmentSec: 0 }, { anchorName: "" });
    rec.ev.onLive({ anchorName: "A" });
    rec.ev.onSegment(join(dir, "s1_000.ts"));
    await sess.stop();
    expect(events.filter((e) => e.kind === "error")).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
