import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingSession, sessionXmlPath } from "@drec/manager";
import {
  registerPlatform, _resetPlatforms, type Platform, type Recorder, type DanmuSource,
  type RecorderEvents, type RecordOpts, type DanmuMessage,
} from "@drec/core";
import type { Notifier, NotifyEvent } from "../src/core/notify/notifier.js";

function makeOpts(outDir: string): RecordOpts {
  return { quality: "origin", outDir, segmentSec: 0 };
}

// DLR 风格 mock：不自带弹幕
class MockDlrRecorder implements Recorder {
  name = "mock-dlr"; providesDanmu = false;
  ev!: RecorderEvents;
  async start(_url: string, _opts: RecordOpts, ev: RecorderEvents) {
    this.ev = ev;
    ev.onLive({ anchorName: "主播X" });
    ev.onSegment(join(_opts.outDir, "seg_000.ts"));
  }
  async stop() {}
}
class MockDanmuSource implements DanmuSource {
  name = "mock-danmu";
  cb!: (m: DanmuMessage) => void;
  onAlert?: (msg: string) => void;
  started = false;
  startCount = 0;
  stopCount = 0;
  /** 测试可设:start 时抛错(模拟连接失败 → session 应 notify)。 */
  failWith: Error | null = null;
  async start(_url: string, _opts: RecordOpts, onMessage: (m: DanmuMessage) => void, onAlert?: (m: string) => void) {
    this.startCount++; this.cb = onMessage; this.onAlert = onAlert;
    if (this.failWith) throw this.failWith;
    this.started = true;
  }
  async stop() { this.started = false; this.stopCount++; }
}

/** 可控 mock：每次 start 都 fire onLive(模拟开播/重连成功)，isLive 按序列返回(控真下播 vs 抖动)。 */
class OfflineMock implements Recorder {
  name = "mock-offline"; providesDanmu = false;
  startCount = 0; ev!: RecorderEvents;
  /** onOffline 时 session 查 isLive 判别:false=主播下播 / true=流抖动还在播。耗尽默认 false。 */
  isLiveResults: boolean[] = [];
  async start(_u: string, o: RecordOpts, ev: RecorderEvents) {
    this.startCount++; this.ev = ev;
    ev.onLive({ anchorName: "主播R" });
    ev.onSegment(join(o.outDir, `seg_${this.startCount}.ts`));
  }
  async stop() {}
  async isLive() { return this.isLiveResults.length ? this.isLiveResults.shift()! : false; }
}

/**
 * 弹幕来源现由 `platform.connectDanmu()` 提供(不再注入 session)。测试注册一个假抖音平台,
 * connectDanmu 返回 `currentDanmu`(测试可控/可观测的 MockDanmuSource)。setCurrentDanmu(null)
 * 模拟「平台无弹幕能力」。注:test/setup.ts 已注册默认假平台,这里在 RecordingSession 用例内
 * 覆盖注册,afterEach 复位回 setup 的默认平台(避免污染其它文件——vitest 每文件独立 setup)。
 */
let currentDanmu: MockDanmuSource | null = null;
function registerDanmuPlatform(): void {
  _resetPlatforms();
  const p: Platform = {
    id: "douyin",
    matchUrl: (u) => /(?:live|v)\.douyin\.com\//.test(u),
    roomToUrl: (r) => (/^https?:\/\//.test(r) ? r : `https://live.douyin.com/${r}`),
    extractRoomSlug: (u) => { const m = u.match(/live\.douyin\.com\/(\d+)/); return m ? m[1] : u; },
    fetchAnchorName: async () => null,
    getStream: async () => ({ living: false }),
    getLiving: async () => false,
    connectDanmu: () => currentDanmu,
    defaultQuality: "origin",
    defaultEngine: "ffmpeg",
    qualities: ["origin"],
    engines: ["ffmpeg"],
  };
  registerPlatform(p, { default: true });
}

describe("RecordingSession", () => {
  beforeEach(() => {
    currentDanmu = new MockDanmuSource();
    registerDanmuPlatform();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("DLR 模式：平台 connectDanmu 起弹幕源，弹幕落盘到分段对应 xml", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const rec = new MockDlrRecorder();
    const dm = currentDanmu!;
    const sess = new RecordingSession(rec);
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "主播X" });
    expect(dm.started).toBe(true);                 // DLR 不自带弹幕 → 平台 connectDanmu 起了弹幕源
    dm.cb({ kind: "danmaku", tsMs: Date.now(), user: "u", content: "hi" });
    await sess.stop();
    const xmls = readdirSync(dir).filter((f) => f.endsWith(".xml"));
    expect(xmls.length).toBeGreaterThanOrEqual(1); // 生成了 xml
  });

  it("弹幕只在 onLive 后启动：recorder 未 fire onLive(等开播)→ 弹幕不连(防开播前陈旧 liveId)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    // 模拟 daemon 定时起、但房间还没开播:recorder 在轮询,不 fire onLive。
    class WaitingRecorder implements Recorder {
      name = "mock-waiting"; providesDanmu = false;
      async start() { /* 轮询等开播,未 onLive */ }
      async stop() {}
    }
    const dm = currentDanmu!;
    const sess = new RecordingSession(new WaitingRecorder());
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "" });
    expect(dm.started).toBe(false);   // 未开播 → 弹幕没连(修复前会立即连到陈旧 liveId → 整场 0 弹幕)
    await sess.stop();
  });

  it("biliLive 模式：不另起弹幕源", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    class MockBili implements Recorder {
      name = "mock-bili"; providesDanmu = true;
      async start(_u: string, o: RecordOpts, ev: RecorderEvents) {
        ev.onLive({ anchorName: "Y" });
        ev.onSegment(join(o.outDir, "seg_000.ts"));
        ev.onDanmu?.({ kind: "danmaku", tsMs: Date.now(), content: "z" });
      }
      async stop() {}
    }
    const dm = currentDanmu!;
    const sess = new RecordingSession(new MockBili());
    await sess.start("https://live.douyin.com/1", makeOpts(dir), { anchorName: "Y" });
    await sess.stop();
    expect(dm.started).toBe(false);                // 自带弹幕 → 不调 connectDanmu,不另起
  });

  it("biliLive 模式（providesDanmu=true）：XmlDanmuWriter 不创建文件", async () => {
    // biliLive writes its own xml natively; our XmlDanmuWriter must never open a file.
    const dir = mkdtempSync(join(tmpdir(), "sess-bili-noxml-"));
    class MockBiliWithDanmu implements Recorder {
      name = "mock-bili-danmu"; providesDanmu = true;
      async start(_u: string, o: RecordOpts, ev: RecorderEvents) {
        ev.onLive({ anchorName: "TestAnchor" });
        // Fire onSegment — should NOT cause our writer to create a .xml
        ev.onSegment(join(o.outDir, "seg_000.ts"));
        // Fire onDanmu — should be a no-op for our writer
        ev.onDanmu?.({ kind: "danmaku", tsMs: Date.now(), user: "u1", content: "hello" });
        ev.onDanmu?.({ kind: "gift", tsMs: Date.now(), user: "u2", giftName: "Rose", giftCount: 1 });
      }
      async stop() {}
    }
    const sess = new RecordingSession(new MockBiliWithDanmu());
    await sess.start("https://live.douyin.com/42", makeOpts(dir), { anchorName: "TestAnchor" });
    await sess.stop();
    // Our writer must not have created any .xml in outDir
    const xmls = readdirSync(dir).filter((f) => f.endsWith(".xml"));
    expect(xmls.length).toBe(0);
  });

  it("DLR 模式（providesDanmu=false）：弹幕源起动且写入 xml", async () => {
    // Explicit twin of the first test — ensures DLR path still works after the biliLive fix.
    const dir = mkdtempSync(join(tmpdir(), "sess-dlr-xml-"));
    const rec = new MockDlrRecorder();
    const dm = currentDanmu!;
    const sess = new RecordingSession(rec);
    await sess.start("https://live.douyin.com/456", makeOpts(dir), { anchorName: "主播DLR" });
    // DanmuSource started — confirms our writer path is active
    expect(dm.started).toBe(true);
    // Send a danmu message via the DanmuSource callback
    dm.cb({ kind: "danmaku", tsMs: Date.now(), user: "viewer", content: "nice stream" });
    await sess.stop();
    // Our XmlDanmuWriter should have created the xml
    const xmls = readdirSync(dir).filter((f) => f.endsWith(".xml"));
    expect(xmls.length).toBeGreaterThanOrEqual(1);
  });

  // ── XML 名字对齐 ─────────────────────────────────────────────────────────
  it("sessionXmlPath: 剥分段后缀 → 会话级 {base}.xml", () => {
    const b = "/o/野原旧之助_2026-06-10_00-23-33";
    expect(sessionXmlPath(`${b}-PART000.ts`)).toBe(`${b}.xml`);  // biliLive 分段
    expect(sessionXmlPath(`${b}-PART012.ts`)).toBe(`${b}.xml`);
    expect(sessionXmlPath(`${b}_000.ts`)).toBe(`${b}.xml`);      // DLR 分段
    expect(sessionXmlPath(`${b}.ts`)).toBe(`${b}.xml`);          // 不分段
    // 会话基名里的时间 HH-MM-SS 用连字符，不会被 _\d{3,} 误剥
  });

  it("DLR 多分段：同会话只产一个会话级 xml，弹幕全进同一文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-align-"));
    let ev!: RecorderEvents;
    class MultiSeg implements Recorder {
      name = "mock-multiseg"; providesDanmu = false;
      async start(_u: string, _o: RecordOpts, e: RecorderEvents) {
        ev = e; e.onLive({ anchorName: "A" });
      }
      async stop() {}
    }
    const dm = currentDanmu!;
    const sess = new RecordingSession(new MultiSeg());
    await sess.start("https://live.douyin.com/1", makeOpts(dir), { anchorName: "A" });

    const base = "A_2026-06-10_00-23-33";
    ev.onSegment(join(dir, `${base}_000.ts`));            // 第一段 → 开 {base}.xml
    dm.cb({ kind: "danmaku", tsMs: Date.now(), content: "seg0msg" });   // 实时(≥视频起点),不被丢
    ev.onSegment(join(dir, `${base}_001.ts`));            // 第二段（同会话）→ 续写，不另开
    dm.cb({ kind: "danmaku", tsMs: Date.now(), content: "seg1msg" });
    await sess.stop();

    const xmls = readdirSync(dir).filter((f) => f.endsWith(".xml"));
    expect(xmls).toEqual([`${base}.xml`]);               // 恰好一个会话级 xml（非逐段）
    const content = readFileSync(join(dir, `${base}.xml`), "utf-8");
    expect(content).toContain("seg0msg");
    expect(content).toContain("seg1msg");                // 两段弹幕都在同一 xml
  });

  it("danmuXmlMode=segment：每个视频分段一个 xml（{base}_NNN.xml）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-segmode-"));
    let ev!: RecorderEvents;
    class MultiSeg implements Recorder {
      name = "mock-segmode"; providesDanmu = false;
      async start(_u: string, _o: RecordOpts, e: RecorderEvents) {
        ev = e; e.onLive({ anchorName: "A" });
      }
      async stop() {}
    }
    const dm = currentDanmu!;
    const sess = new RecordingSession(new MultiSeg());
    await sess.start("https://live.douyin.com/1", { ...makeOpts(dir), danmuXmlMode: "segment" }, { anchorName: "A" });

    const base = "A_2026-06-10_00-23-33";
    ev.onSegment(join(dir, `${base}_000.ts`));      // 第一段 → {base}_000.xml
    dm.cb({ kind: "danmaku", tsMs: Date.now(), content: "seg0" });   // 实时(≥该段起点),不被丢
    ev.onSegment(join(dir, `${base}_001.ts`));      // 第二段（新文件名）→ 换 {base}_001.xml
    dm.cb({ kind: "danmaku", tsMs: Date.now(), content: "seg1" });
    await sess.stop();

    const xmls = readdirSync(dir).filter((f) => f.endsWith(".xml")).sort();
    expect(xmls).toEqual([`${base}_000.xml`, `${base}_001.xml`]);   // 逐段一个，与视频段配对
    expect(readFileSync(join(dir, `${base}_000.xml`), "utf-8")).toContain("seg0");
    expect(readFileSync(join(dir, `${base}_001.xml`), "utf-8")).toContain("seg1");
  });

  // ── Reconnect test ─────────────────────────────────────────────────────────
  it("recorder onOffline → session 重连：start() 被再次调用", async () => {
    vi.useFakeTimers();

    const dir = mkdtempSync(join(tmpdir(), "sess-reconnect-"));
    let startCount = 0;
    let capturedEv: RecorderEvents | null = null;

    class ReconnectMockRecorder implements Recorder {
      name = "mock-reconnect"; providesDanmu = false;
      async start(_u: string, o: RecordOpts, ev: RecorderEvents) {
        startCount++;
        capturedEv = ev;
        ev.onLive({ anchorName: "主播Z" });
        ev.onSegment(join(o.outDir, `seg_${startCount.toString().padStart(3, "0")}.ts`));
      }
      async stop() {}
    }

    // reconnectDelaySec=0.01 (10ms) so fake timers don't need a huge advance
    const sess = new RecordingSession(
      new ReconnectMockRecorder(),
      undefined,
      { reconnectDelaySec: 0.01 },
    );

    await sess.start("https://live.douyin.com/789", makeOpts(dir), { anchorName: "" });
    expect(startCount).toBe(1);

    // Fire onOffline (stream drop) — this triggers the reconnect path
    capturedEv!.onOffline();

    // Advance fake timers past the 10ms delay to let the reconnect fire
    await vi.runAllTimersAsync();

    // recorder.start() should have been called a second time
    expect(startCount).toBe(2);

    // Now user-stop: no further reconnects
    await sess.stop();
    capturedEv!.onOffline();      // spurious event after stop — should be ignored
    await vi.runAllTimersAsync();
    expect(startCount).toBe(2);   // still 2 — no extra reconnect after user stop
  });

  it("onOffline 期间已在重连：重复事件被忽略，只重连一次", async () => {
    vi.useFakeTimers();

    const dir = mkdtempSync(join(tmpdir(), "sess-dedup-"));
    let startCount = 0;
    let capturedEv: RecorderEvents | null = null;

    class DedupRecorder implements Recorder {
      name = "mock-dedup"; providesDanmu = false;
      async start(_u: string, o: RecordOpts, ev: RecorderEvents) {
        startCount++;
        capturedEv = ev;
        ev.onLive({ anchorName: "D" });
        ev.onSegment(join(o.outDir, `seg_${startCount}.ts`));
      }
      async stop() {}
    }

    const sess = new RecordingSession(
      new DedupRecorder(),
      undefined,
      { reconnectDelaySec: 0.01 },
    );
    await sess.start("https://live.douyin.com/999", makeOpts(dir), { anchorName: "" });
    expect(startCount).toBe(1);

    // Fire two offline events in quick succession — only one reconnect should happen
    capturedEv!.onOffline();
    capturedEv!.onOffline();

    await vi.runAllTimersAsync();
    expect(startCount).toBe(2);   // exactly one reconnect, not two

    await sess.stop();
  });

  it("notifier：onLive→recordStart，stop()→recordEnd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-notify-"));
    const events: NotifyEvent[] = [];
    const notifier: Notifier = { async notify(e) { events.push(e); } };
    const rec = new MockDlrRecorder();   // onLive + onSegment in start()
    const sess = new RecordingSession(rec, { notifier });
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "主播X" });
    await sess.stop();
    expect(events.some((e) => e.kind === "recordStart")).toBe(true);
    expect(events.some((e) => e.kind === "recordEnd")).toBe(true);
  });

  it("stop() 默认 → recordEnd reason=手动停止", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-stop-reason-"));
    const events: NotifyEvent[] = [];
    const notifier: Notifier = { async notify(e) { events.push(e); } };
    const sess = new RecordingSession(new MockDlrRecorder(), { notifier });
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "主播X" });
    await sess.stop();
    expect(events.some((e) => e.kind === "recordEnd" && e.reason === "手动停止")).toBe(true);
  });

  it("自然下播(getLiving=false)→ recordEnd reason=主播下播；主播回来 → 再次 recordStart", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "sess-offline-real-"));
    const events: NotifyEvent[] = [];
    const notifier: Notifier = { async notify(e) { events.push(e); } };
    const rec = new OfflineMock();
    rec.isLiveResults = [false];           // onOffline 判别 → 主播确实下播
    const sess = new RecordingSession(rec, { notifier, reconnectDelaySec: 0.01 });
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "" });
    rec.ev.onOffline();                     // 下播
    await vi.runAllTimersAsync();           // 判别 false → recordEnd 主播下播;重连 → onLive → recordStart
    expect(events.some((e) => e.kind === "recordEnd" && e.reason === "主播下播")).toBe(true);
    expect(events.filter((e) => e.kind === "recordStart").length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.kind === "recordReconnect")).toBe(false); // 下播不算抖动
    await sess.stop();
  });

  it("抖动断流(getLiving=true)→ 重连成功发 recordReconnect(warning)，不重复 recordStart/不发 recordEnd", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "sess-offline-blip-"));
    const events: NotifyEvent[] = [];
    const notifier: Notifier = { async notify(e) { events.push(e); } };
    const rec = new OfflineMock();
    rec.isLiveResults = [true];            // onOffline 判别 → 流还在播,只是抖动
    const sess = new RecordingSession(rec, { notifier, reconnectDelaySec: 0.01 });
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "" });
    rec.ev.onOffline();                     // 抖动断流
    await vi.runAllTimersAsync();           // 判别 true → 不发 recordEnd;重连 onLive → recordReconnect
    expect(events.some((e) => e.kind === "recordReconnect")).toBe(true);
    expect(events.filter((e) => e.kind === "recordStart").length).toBe(1); // 重连不重复发开播
    expect(events.some((e) => e.kind === "recordEnd")).toBe(false);        // 抖动不是结束
    await sess.stop();
  });

  it("弹幕健康告警 onAlert → notify {kind:error,stage:弹幕}(来源经 platform.connectDanmu)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-danmu-alert-"));
    const events: NotifyEvent[] = [];
    const notifier: Notifier = { async notify(e) { events.push(e); } };
    const dm = currentDanmu!;
    const sess = new RecordingSession(new MockDlrRecorder(), { notifier });
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "主播X" });
    expect(dm.started).toBe(true);
    // 弹幕源触发健康告警(模拟连上 0 条/liveId 失效)→ session 应转成 error/弹幕 notify。
    dm.onAlert?.("连上但 3 分钟 0 条");
    await sess.stop();
    expect(events.some((e) => e.kind === "error" && e.stage === "弹幕")).toBe(true);
  });

  it("弹幕 start 抛错 → session catch 后 notify {kind:error,stage:弹幕}(不影响录制)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-danmu-fail-"));
    const events: NotifyEvent[] = [];
    const notifier: Notifier = { async notify(e) { events.push(e); } };
    currentDanmu!.failWith = new Error("connect refused");
    const sess = new RecordingSession(new MockDlrRecorder(), { notifier });
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "主播X" });
    // start 抛错由 .catch 上报;等微任务队列 flush。
    await new Promise((r) => setTimeout(r, 0));
    await sess.stop();
    expect(events.some((e) => e.kind === "error" && e.stage === "弹幕")).toBe(true);
  });

  it("danmuEnabled=false → 不连弹幕(即便平台有 connectDanmu)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-danmu-off-"));
    const dm = currentDanmu!;
    const sess = new RecordingSession(new MockDlrRecorder(), { danmuEnabled: false });
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "主播X" });
    await sess.stop();
    expect(dm.started).toBe(false); // 弹幕关 → 不取源
  });

  it("平台无弹幕能力(connectDanmu 返 null)→ 不抓弹幕,不报错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-danmu-null-"));
    currentDanmu = null; // platform.connectDanmu 返回 null
    const sess = new RecordingSession(new MockDlrRecorder());
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "主播X" });
    await expect(sess.stop()).resolves.toBeUndefined();
  });

  it("断流缺口写入 {base}.gaps.json（供选优用）", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "sess-gaps-"));
    const rec = new OfflineMock();
    rec.isLiveResults = [true]; // 抖动：会重连成功 → 记一段缺口
    const sess = new RecordingSession(rec, { reconnectDelaySec: 0.01 });
    await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "" });
    rec.ev.onOffline();
    await vi.runAllTimersAsync();
    await sess.stop();
    const gapsFile = readdirSync(dir).find((f) => f.endsWith(".gaps.json"));
    expect(gapsFile).toBeTruthy();
    const g = JSON.parse(readFileSync(join(dir, gapsFile!), "utf-8"));
    expect(g.gaps.length).toBeGreaterThanOrEqual(1);
    expect(g.totalGapSec).toBeGreaterThanOrEqual(0);
  });
});

// ── 窗口结束「优雅排空」drain() ────────────────────────────────────────────────
/** 可控 mock：记录 drain/stop/isLive 调用，isLive 按 results 序列(支持抛错)返回。 */
class DrainMock implements Recorder {
  name = "mock-drain"; providesDanmu = true;
  ev!: RecorderEvents;
  startCount = 0; stopCount = 0; drainCount = 0; isLiveCount = 0;
  fireLiveOnStart = true;
  /** isLive 依次返回这些值；'throw' 模拟网络错；耗尽后默认 false。 */
  isLiveResults: (boolean | "throw")[] = [];
  async start(_u: string, _o: RecordOpts, ev: RecorderEvents): Promise<void> {
    this.startCount++; this.ev = ev;
    if (this.fireLiveOnStart) ev.onLive({ anchorName: "A" });
  }
  async stop(): Promise<void> { this.stopCount++; }
  async drain(): Promise<void> { this.drainCount++; }
  async isLive(): Promise<boolean> {
    this.isLiveCount++;
    const v = this.isLiveResults.length ? this.isLiveResults.shift()! : false;
    if (v === "throw") throw new Error("net");
    return v;
  }
}

/** 无 drain()/isLive() 的 recorder：drain 应退化为硬停。 */
class NoDrainMock implements Recorder {
  name = "mock-nodrain"; providesDanmu = true;
  stopCount = 0;
  async start(_u: string, _o: RecordOpts, ev: RecorderEvents): Promise<void> {
    ev.onLive({ anchorName: "A" });
  }
  async stop(): Promise<void> { this.stopCount++; }
}

describe("RecordingSession.drain (窗口结束排空)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("窗口结束时没有正在录制 → 立即收尾(stop)，drainDone resolve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-drain-idle-"));
    const rec = new DrainMock();
    rec.fireLiveOnStart = false;              // 没开播 → live=false
    const sess = new RecordingSession(rec, { drainPollSec: 0.01 });
    await sess.start("https://live.douyin.com/1", makeOpts(dir), { anchorName: "A" });
    await sess.drain();
    expect(rec.drainCount).toBe(1);
    expect(rec.stopCount).toBe(1);            // 立即停
    expect(rec.isLiveCount).toBe(0);          // 没起轮询
  });

  it("窗口结束排空收尾 → recordEnd reason=窗口结束收播", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-drain-reason-"));
    const events: NotifyEvent[] = [];
    const notifier: Notifier = { async notify(e) { events.push(e); } };
    const rec = new DrainMock();
    rec.fireLiveOnStart = false;              // idle → drain 立即 stop
    const sess = new RecordingSession(rec, { notifier, drainPollSec: 0.01 });
    await sess.start("https://live.douyin.com/1", makeOpts(dir), { anchorName: "A" });
    await sess.drain();
    expect(events.some((e) => e.kind === "recordEnd" && e.reason === "窗口结束收播")).toBe(true);
  });

  it("直播仍在播 → isLive 连续 2 次 false 才收尾", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "sess-drain-poll-"));
    const rec = new DrainMock();
    rec.isLiveResults = [true, true, false, false];
    const sess = new RecordingSession(rec, { drainPollSec: 0.01 });
    await sess.start("https://live.douyin.com/1", makeOpts(dir), { anchorName: "A" });
    const p = sess.drain();                   // live=true → 起轮询
    await vi.runAllTimersAsync();
    await p;
    expect(rec.stopCount).toBe(1);
    expect(rec.isLiveCount).toBe(4);          // true,true,false,false
  });

  it("isLive 抛错不计入收播判定(不会提前停)", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "sess-drain-throw-"));
    const rec = new DrainMock();
    rec.isLiveResults = ["throw", "throw"];   // 之后默认 false,false
    const sess = new RecordingSession(rec, { drainPollSec: 0.01 });
    await sess.start("https://live.douyin.com/1", makeOpts(dir), { anchorName: "A" });
    const p = sess.drain();
    await vi.runAllTimersAsync();
    await p;
    expect(rec.stopCount).toBe(1);
    expect(rec.isLiveCount).toBe(4);          // 2 抛错被忽略 + 2 个 false 才停（否则会在第 2 tick 停）
  });

  it("drain 期间 onOffline(RecordStop 自然收播) → 收尾，不重连", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-drain-offline-"));
    const rec = new DrainMock();
    rec.isLiveResults = [true, true, true];   // 轮询永远说在播，靠 onOffline 终止
    const sess = new RecordingSession(rec, { drainPollSec: 999, reconnectDelaySec: 0.01 });
    await sess.start("https://live.douyin.com/1", makeOpts(dir), { anchorName: "A" });
    const p = sess.drain();
    rec.ev.onOffline();                        // 直播自然收播
    await p;
    expect(rec.stopCount).toBe(1);
    expect(rec.startCount).toBe(1);            // 没有重连
  });

  it("recorder 不支持 drain() → 退化为硬停", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-drain-nodrain-"));
    const rec = new NoDrainMock();
    const sess = new RecordingSession(rec);
    await sess.start("https://live.douyin.com/1", makeOpts(dir), { anchorName: "A" });
    await sess.drain();
    expect(rec.stopCount).toBe(1);
  });

  it("已 userStopped → drain 直接 no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-drain-stopped-"));
    const rec = new DrainMock();
    const sess = new RecordingSession(rec);
    await sess.start("https://live.douyin.com/1", makeOpts(dir), { anchorName: "A" });
    await sess.stop();
    await sess.drain();
    expect(rec.drainCount).toBe(0);            // 已停，不再排空
  });
});
