/**
 * issue #96:会话层区分「新一场开播」与「同场断流重连」,只有新一场才问磁盘闸门;
 * 同场重连一律放行(I2:不为腾空间打断录制;重连的硬下限另见 plans/033 D6)。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingSession, SAME_BROADCAST_WINDOW_MS } from "@drec/manager";
import type { AdmitDecision, Notifier, NotifyEvent, Recorder, RecorderEvents, RecordOpts } from "@drec/core";

/** 记录每次 start 收到的 opts(含 admit),由测试驱动「开播 / 断流」。 */
class GateMock implements Recorder {
  name = "gate-mock"; providesDanmu = false;
  ev!: RecorderEvents;
  opts!: RecordOpts;
  startCount = 0;
  /** onOffline 时 session 查 isLive:false = 主播下播(下一次是新一场);true = 流抖动(同场重连)。 */
  isLiveResults: boolean[] = [];
  async start(_u: string, o: RecordOpts, ev: RecorderEvents) { this.startCount++; this.ev = ev; this.opts = o; }
  async stop() {}
  async isLive() { return this.isLiveResults.length ? this.isLiveResults.shift()! : false; }
  /** 模拟录制器「确认开播 → 起录」。 */
  goLive() { this.ev.onLive({ anchorName: "主播G" }); }
}

const makeOpts = (): RecordOpts => ({ quality: "origin", outDir: mkdtempSync(join(tmpdir(), "gate-sess-")), segmentSec: 0 });
const DENY: AdmitDecision = { ok: false, reason: "磁盘剩余 1.0GB,低于水位 10.0GB" };

function setup(gate?: () => AdmitDecision) {
  const events: NotifyEvent[] = [];
  const notifier: Notifier = { async notify(e) { events.push(e); } };
  const rec = new GateMock();
  const sess = new RecordingSession(rec, { notifier, reconnectDelaySec: 0.01, danmuEnabled: false, admitNewBroadcast: gate });
  return { rec, sess, events };
}
const diskAlerts = (events: NotifyEvent[]): NotifyEvent[] => events.filter((e) => e.kind === "error" && e.stage === "磁盘");

afterEach(() => { vi.useRealTimers(); });

describe("新一场开播准入(会话层)", () => {
  it("首次开播是新一场:闸门拒绝 → admit 返回拒绝,并发一条磁盘 error 告警", async () => {
    const { rec, sess, events } = setup(() => DENY);
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    const d = rec.opts.admit!();
    expect(d.ok).toBe(false);
    expect(diskAlerts(events)).toHaveLength(1);
    expect(String((diskAlerts(events)[0] as { message: string }).message)).toContain("低于水位");
    await sess.stop();
  });

  it("同一原因反复被拒只告警一次;放行后再被拒才再次告警(不刷屏)", async () => {
    let d: AdmitDecision = DENY;
    const { rec, sess, events } = setup(() => d);
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    for (let i = 0; i < 5; i++) rec.opts.admit!();
    expect(diskAlerts(events)).toHaveLength(1);
    d = { ok: true };
    expect(rec.opts.admit!().ok).toBe(true);
    d = DENY;
    rec.opts.admit!();
    expect(diskAlerts(events)).toHaveLength(2);
    await sess.stop();
  });

  it("同场断流重连(isLive=true,流抖动)→ 即使闸门会拒绝也放行,且不询问闸门", async () => {
    vi.useFakeTimers();
    const gate = vi.fn(() => DENY);
    const { rec, sess } = setup(gate);
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    rec.goLive();                       // 本场已起录
    rec.isLiveResults = [true];         // 断流后权威判活:仍在播
    rec.ev.onOffline();
    await vi.runAllTimersAsync();       // 重连 → recorder.start 再次被调用
    expect(rec.startCount).toBe(2);
    gate.mockClear();
    expect(rec.opts.admit!().ok).toBe(true);
    expect(gate).not.toHaveBeenCalled();
    await sess.stop();
  });

  it("真下播(isLive=false)后的下一次开播是新一场 → 重新受闸门约束", async () => {
    vi.useFakeTimers();
    const gate = vi.fn((): AdmitDecision => DENY);
    const { rec, sess } = setup(gate);
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    rec.goLive();
    rec.isLiveResults = [false];        // 主播确实下播
    rec.ev.onOffline();
    await vi.runAllTimersAsync();
    expect(rec.startCount).toBe(2);
    gate.mockClear();
    expect(rec.opts.admit!().ok).toBe(false);
    expect(gate).toHaveBeenCalledTimes(1);
    await sess.stop();
  });

  it("同场重连起录成功(onLive)后标志复位:之后再真下播,下一场重新受约束", async () => {
    vi.useFakeTimers();
    const gate = vi.fn((): AdmitDecision => DENY);
    const { rec, sess } = setup(gate);
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    rec.goLive();
    rec.isLiveResults = [true, false];  // 先抖动重连,再真下播
    rec.ev.onOffline();
    await vi.runAllTimersAsync();
    rec.goLive();                       // 重连成功
    rec.ev.onOffline();                 // 这次是真下播
    await vi.runAllTimersAsync();
    gate.mockClear();
    expect(rec.opts.admit!().ok).toBe(false);
    expect(gate).toHaveBeenCalledTimes(1);
    await sess.stop();
  });

  it("闸门抛错 → 视为放行(探测失败绝不误拦录制)", async () => {
    const { rec, sess, events } = setup(() => { throw new Error("statfs boom"); });
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    expect(rec.opts.admit!().ok).toBe(true);
    expect(diskAlerts(events)).toHaveLength(0);
    await sess.stop();
  });

  it("不注入闸门 → 恒放行、无告警(默认行为不变)", async () => {
    const { rec, sess, events } = setup(undefined);
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    expect(rec.opts.admit!().ok).toBe(true);
    expect(diskAlerts(events)).toHaveLength(0);
    await sess.stop();
  });
});

describe("同场重连标志的有效窗口 / 去重键(审计返工)", () => {
  it("窗口内仍按同场放行;超过窗口(例如收播判活滞后,几小时后的下一场)重新问闸门", async () => {
    vi.useFakeTimers();
    const gate = vi.fn((): AdmitDecision => DENY);
    const { rec, sess } = setup(gate);
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    rec.goLive();
    rec.isLiveResults = [true];          // 收播那刻判活滞后/抛错 → 被记成「仍在播」
    rec.ev.onOffline();
    await vi.runAllTimersAsync();
    gate.mockClear();
    expect(rec.opts.admit!().ok).toBe(true);           // 窗口内:同场,放行且不问闸门
    expect(gate).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + SAME_BROADCAST_WINDOW_MS + 1_000);
    expect(rec.opts.admit!().ok).toBe(false);          // 超窗:按新一场处理
    expect(gate).toHaveBeenCalledTimes(1);
    await sess.stop();
  });

  it("isLive 抛错(落成「仍在播」)后,几小时后的新一场不能绕过闸门", async () => {
    vi.useFakeTimers();
    const gate = vi.fn((): AdmitDecision => DENY);
    const { rec, sess } = setup(gate);
    rec.isLive = async () => { throw new Error("api down"); };
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    rec.goLive();
    rec.ev.onOffline();
    await vi.runAllTimersAsync();
    vi.setSystemTime(Date.now() + 3 * 3600_000);
    expect(rec.opts.admit!().ok).toBe(false);
    await sess.stop();
  });

  it("去重键:reason 里的实时剩余空间变化不重复告警;key 变了才再告警", async () => {
    let free = 9.9;
    let key = "disk-below-watermark:10.0";
    const { rec, sess, events } = setup(() => ({ ok: false, reason: `剩余 ${free.toFixed(1)}GB`, key }));
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    for (let i = 0; i < 4; i++) { rec.opts.admit!(); free -= 0.1; }
    expect(diskAlerts(events)).toHaveLength(1);
    key = "disk-below-watermark:15.0";
    rec.opts.admit!();
    expect(diskAlerts(events)).toHaveLength(2);
    await sess.stop();
  });

  it("无 key 时回落按 reason 去重(旧闸门实现向后兼容)", async () => {
    let n = 1;
    const { rec, sess, events } = setup(() => ({ ok: false, reason: `r${n}` }));
    await sess.start("https://live.douyin.com/1", makeOpts(), { anchorName: "" });
    rec.opts.admit!(); rec.opts.admit!();
    expect(diskAlerts(events)).toHaveLength(1);
    n = 2;
    rec.opts.admit!();
    expect(diskAlerts(events)).toHaveLength(2);
    await sess.stop();
  });
});
