import { LivePumpObserver } from "./live-pump-observer.js";
import { LivePumpSource, type StreamAcquirer } from "./live-pump-source.js";
import { LivePumpStartup } from "./live-pump-startup.js";
import { LivePumpDelivery } from "./live-pump-delivery.js";
import { LivePumpCapture } from "./live-pump-capture.js";
import type { RunLivePumpOptions, RunLivePumpResult } from "./live-pump-run-options.js";
class LivePumpRunner {
  private readonly capture: LivePumpCapture;
  private recoveryTimedOut = false;
  private danmuStarted = false;
  private danmuAttempted = false;
  constructor(private readonly o: RunLivePumpOptions, private readonly events: LivePumpObserver, private readonly source: LivePumpSource, private readonly delivery: LivePumpDelivery) {
    this.capture = new LivePumpCapture(o, delivery, events);
  }
  async startDanmuOnce(): Promise<void> {
    if (!this.o.danmu || this.danmuAttempted)
      return;
    this.danmuAttempted = true;
    try {
      await this.o.danmu.start(m => {
      });
      this.danmuStarted = true;
      this.events.log(`[直播直传] 弹幕已连接 → ${this.o.danmu.xmlPath}`);
    }
    catch (e) {
      this.events.log(`[直播直传] ⚠️ 弹幕连接失败(不影响视频上传): ${(e as Error).message}`);
    }
  }
  async stopDanmu(): Promise<void> {
    if (!this.danmuStarted || !this.o.danmu)
      return;
    this.danmuStarted = false;
    await this.o.danmu.stop().catch((e: unknown) => this.events.log(`[直播直传] ⚠️ 弹幕停止失败: ${(e as Error).message}`));
  }
  private async startLive(s: StreamAcquirer): Promise<void> {
    this.events.emit({ at: Date.now(), kind: "live" });
    await this.startDanmuOnce();
    if (s.title?.trim())
      this.delivery.liveTitle = s.title.trim();
    if (this.o.titleForLive && s.title) {
      const nextTitle = this.o.titleForLive(s.title);
      if (this.delivery.session.setTitleIfFresh(nextTitle))
        this.events.log(`[直播直传] 稿件标题已按直播标题渲染: ${nextTitle}`);
    }
    else if (this.o.titleForLive) {
      const nextTitle = this.o.titleForLive("");
      if (this.delivery.session.setTitleIfFresh(nextTitle))
        this.events.log(`[直播直传] 稿件标题已按取流信息重渲染: ${nextTitle}`);
    }
    this.events.phase("recording");
    this.events.log("[状态] 录制中");
  }
  private timedOut(): void {
    this.recoveryTimedOut = true;
    this.events.log("[直播直传] 停滞恢复窗口结束,停止本次录制;下次运行会重新等待开播");
  }
  private async shouldFinish(): Promise<boolean> {
    if (await this.o.shouldStop?.())
      return true;
    const maxSegments = Math.max(0, this.o.maxSegments ?? 0);
    if (maxSegments > 0 && this.capture.partsOpened >= maxSegments)
      return true;
    if (this.o.signal?.aborted)
      return true;
    if (this.delivery.recoveryDeadline !== undefined && Date.now() >= this.delivery.recoveryDeadline) {
      this.timedOut();
      return true;
    }
    if (this.o.drainSignal?.aborted) {
      this.events.log("[直播直传] 窗口结束已排空:不再开录下一场,当前分 P 传完后收尾");
      return true;
    }
    return !!this.capture.spoolDiskStopReason;
  }
  private async acquire(): Promise<StreamAcquirer | null> {
    if (this.capture.partsOpened > 0)
      this.events.emit({ at: Date.now(), kind: "waiting" });
    this.events.phase(this.delivery.session.hasUnconfirmed ? "finalizing" : "polling");
    if (this.delivery.recoveryDeadline === undefined)
      return this.source.acquire(this.capture.partSeq);
    const stream = await this.source.waitForBroadcast(this.delivery.recoveryDeadline);
    if (!stream && !(await this.source.stopRequested()))
      this.timedOut();
    return stream;
  }
  async run(): Promise<RunLivePumpResult> {
    try {
      while (!(await this.shouldFinish())) {
        const stream = await this.acquire();
        if (!stream?.living || !stream.url)
          break;
        await this.startLive(stream);
        const result = await this.capture.connect(stream);
        if ("ok" in result)
          return result;
        if (result.ended)
          break;
      }
      return this.delivery.finish(this.recoveryTimedOut);
    }
    finally {
      this.delivery.close();
      await this.delivery.session.drainSeason();
      await this.stopDanmu();
    }
  }
}
export async function runLivePump(o: RunLivePumpOptions): Promise<RunLivePumpResult> {
  if (o.submitMode === "spool" && (o.spoolMode ?? "full") === "none")
    throw new Error("submitMode 'spool' 需要 spoolMode 'full':零落盘没有可托管的本地字节");
  const events = new LivePumpObserver(o);
  const source = new LivePumpSource(o, events.log);
  events.emit({ at: Date.now(), kind: "waiting" });
  events.phase("polling");
  events.log("[状态] 等待开播");
  const startup = new LivePumpStartup(o, events, source);
  const beforeWait = await startup.prepare();
  if (beforeWait)
    return beforeWait;
  const opened = await startup.open();
  if ("pending" in opened)
    return opened.pending;
  if ("fail" in opened)
    return opened.fail;
  return new LivePumpRunner(o, events, source, new LivePumpDelivery(o, opened.session, events, opened.spoolOnlyRun)).run();
}
