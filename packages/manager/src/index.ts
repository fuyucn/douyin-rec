import { basename, join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type {
  Recorder, DanmuSource, RecorderEvents, RecordOpts, DanmuMessage, StreamInfo,
} from "@drec/core";
import { XmlDanmuWriter } from "./danmu-xml/index.js";
import { createLogger, platformForRoom } from "@drec/core";
import type { Notifier, NotifyEvent } from "@drec/core";

const log = createLogger("session");

export interface SessionOpts {
  /** Seconds to wait before reconnecting after an unexpected stream drop. Default: 5. */
  reconnectDelaySec?: number;
  /** Optional Discord (or other) notifier. Fire-and-forget; failures are swallowed. */
  notifier?: Notifier;
  /** Seconds between live-status polls while draining (window-end). Default: 30. */
  drainPollSec?: number;
  /**
   * 是否抓弹幕(任务 danmu 开关)。true → onLive 时经 `platform.connectDanmu()` 取一个弹幕源;
   * false → 不抓。弹幕来源不再由外部注入,而是运行时按 roomUrl 命中的平台提供。默认 true。
   */
  danmuEnabled?: boolean;
}

export class RecordingSession {
  private writer = new XmlDanmuWriter();
  private writerOpen = false;
  /** Session-level danmu xml path currently open (DLR mode). Null = none open. */
  private currentXmlPath: string | null = null;
  private anchor = "";
  /** Set to true once stop() is called by the user — suppresses reconnect. */
  private userStopped = false;
  /** Guards against overlapping reconnect attempts. */
  private reconnecting = false;
  /** True once drain() is called (window-end) — onOffline finalizes instead of reconnecting. */
  private draining = false;
  /** True while a recording is actively in progress (onLive → onOffline). */
  private live = false;
  /**
   * 本次「断流 gap」开始的 epoch ms（onOffline 进入重连时置；重连成功 onLive 时清）。
   * null = 当前不在断流缺口里（首次开播 / 已恢复）。用于:区分「重连」vs「首次开播」,并算中断时长。
   */
  private offlineSince: number | null = null;
  /**
   * 本次断流缺口是否已判定为「主播下播」并发过 recordEnd（getLiving=false）。
   * true → 不再在 onLive 时补发「抖动重连」warning（那次 onLive 是下播后重新开播 → 正常 recordStart）。
   */
  private offlineNotified = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** 断流缺口列表（startMs/endMs epoch ms）；会话结束时写 {base}.gaps.json sidecar。 */
  private gaps: { startMs: number; endMs: number }[] = [];
  /** 最后一次打开的 xml 路径（stop 时 currentXmlPath 已清空，用此回溯会话基名）。 */
  private lastXmlPath: string | null = null;
  private drainDone: Promise<void> | null = null;
  private resolveDrainDone: (() => void) | null = null;

  private readonly reconnectDelaySec: number;
  private readonly drainPollSec: number;
  private readonly notifier: Notifier | undefined;
  private readonly danmuEnabled: boolean;
  /**
   * 当前这场的弹幕源(onLive 时经 platform.connectDanmu 取得、start;onOffline/stop 时 stop)。
   * 每场重新取一个(重连/下一场要重新解析 liveId)。null = 本场未抓弹幕。
   */
  private danmu: DanmuSource | null = null;
  /** 连续「重连(_startInner)抛错」次数;成功恢复(onLive)清零。用于指数退避 + 告警。 */
  private reconnectFails = 0;

  // Store these so reconnect can call recorder.start() again with the same args.
  private roomUrl = "";
  private opts: RecordOpts = { quality: "origin", outDir: ".", segmentSec: 0 };
  private streamInfo: StreamInfo = { anchorName: "" };

  constructor(
    private recorder: Recorder,
    sessionOpts?: SessionOpts,
  ) {
    this.reconnectDelaySec = sessionOpts?.reconnectDelaySec ?? 5;
    this.drainPollSec = sessionOpts?.drainPollSec ?? 30;
    this.notifier = sessionOpts?.notifier;
    this.danmuEnabled = sessionOpts?.danmuEnabled ?? true;
  }

  /** Fire-and-forget notifier call — swallows errors so notifications never affect recording. */
  private notify(e: NotifyEvent): void {
    void this.notifier?.notify(e).catch(() => {});
  }

  /**
   * **可等待**的通知:用于 stop() 的终止事件——cli 在 `session.stop().then(()=>process.exit())`
   * 里停止,若 recordEnd 仍 fire-and-forget,POST 会被 process.exit 腰斩、Discord 收不到。
   * 这里 await 推送、但用 timeout 兜底(挂死的 webhook 不能拖垮停止)。
   */
  private async notifyAwait(e: NotifyEvent, timeoutMs = 3000): Promise<void> {
    if (!this.notifier) return;
    try {
      await Promise.race([
        this.notifier.notify(e),
        new Promise<void>((r) => setTimeout(r, timeoutMs)),
      ]);
    } catch { /* 通知失败绝不影响停止 */ }
  }

  async start(roomUrl: string, opts: RecordOpts, info: StreamInfo): Promise<void> {
    this.roomUrl = roomUrl;
    this.opts = opts;
    this.streamInfo = info;
    this.anchor = info.anchorName;
    this.userStopped = false;

    mkdirSync(opts.outDir, { recursive: true });
    await this._startInner();
  }

  private async _startInner(): Promise<void> {
    // When the recorder owns danmu (providesDanmu=true, e.g. biliLive), it writes its
    // OWN complete native danmu .xml next to the .ts.  Our XmlDanmuWriter must NOT open
    // a file in that case — both writers would resolve to the same path and race/clobber.
    // When providesDanmu=false (DLR), we drive our XmlDanmuWriter as before.
    const ownWriter = !this.recorder.providesDanmu;
    // 弹幕只在「确认开播(onLive)」后才连(见下),不在 recorder.start() 后立即连——否则开播前
    // (轮询等待期)解析到的是陈旧/上一场 liveId,WS 连上却整场 0 弹幕(本地空弹幕根因 2026-06-19)。
    let danmuStarted = false;

    // 进程已起、录制器在轮询开播但尚未拿到流 → 「等待开播」。父进程 TaskManager 解析
    // `[状态] X` → UI 区分「等待开播中」vs「录制中」（避免未开播也显示录制中）。
    console.log(`[状态] 等待开播`);

    const ev: RecorderEvents = {
      onLive: (i) => {
        this.live = true;
        this.reconnectFails = 0; // 录制成功恢复 → 清零重连失败计数(退避复位)
        console.log(`[状态] 录制中`); // 真正拿到流、开始录视频
        const resolved = i.anchorName || this.anchor;
        // 抓到主播名后打一行可解析日志（父进程 TaskManager 解析 → UI 显示主播名）。
        // 只在首次拿到非空主播名、且与上次不同时打，避免重连刷屏。
        if (resolved && resolved !== this.anchor) console.log(`[主播] ${resolved}`);
        this.anchor = resolved;
        // 通知:首次开播 / 下播后重新开播 → recordStart;**抖动断流后重连成功** → 一条 recordReconnect
        // warning(报中断时长),不重复发「开播」。offlineNotified=true(已发过「主播下播」)的那次 onLive
        // 是下播后重新开播 → 走正常 recordStart。
        if (this.offlineSince != null && !this.offlineNotified) {
          const downSec = Math.max(1, Math.round((Date.now() - this.offlineSince) / 1000));
          this.gaps.push({ startMs: this.offlineSince!, endMs: Date.now() });
          this.notify({ kind: "recordReconnect", anchor: this.anchor, room: this.roomUrl, downSec });
        } else {
          this.notify({ kind: "recordStart", anchor: this.anchor, room: this.roomUrl, quality: this.opts.quality });
        }
        this.offlineSince = null;
        this.offlineNotified = false;
        // 开播确认后才连弹幕:此时 liveId 才是当场的(开播前连会拿陈旧 id → 整场 0 弹幕)。
        // 弹幕来源由 roomUrl 命中的平台提供(platform.connectDanmu),不再外部注入;返回未 start 的
        // 源,由本处 start。fire-and-forget,不阻塞录制;每个 _startInner 只连一次(重连由
        // _handleOffline 先 stop 再新起,届时重新 connectDanmu 拿当场 liveId)。
        if (ownWriter && this.danmuEnabled && !danmuStarted) {
          const platform = platformForRoom(this.roomUrl);
          const dm = platform.connectDanmu?.({
            roomUrl: this.roomUrl,
            channelId: platform.extractRoomSlug(this.roomUrl),
            opts: this.opts,
          }) ?? null;
          this.danmu = dm;
          if (dm) {
          danmuStarted = true;
          void dm
            .start(
              this.roomUrl,
              this.opts,
              (m) => this.write(m),
              // 弹幕健康告警 → 与取流探测同路(notify → webhook + 父进程 @@DREC_ALERT@@ → UI)。
              (msg) => {
                log.error("弹幕告警:", msg);
                this.notify({ kind: "error", stage: "弹幕", message: msg });
              },
            )
            .catch((e) => {
              // 硬失败(connect 拒绝 / 模块加载失败等)同样上报,不只埋日志 → 避免静默无弹幕。
              const message = (e as Error)?.message ?? String(e);
              log.error("弹幕启动失败:", message);
              this.notify({ kind: "error", stage: "弹幕", message: `弹幕启动失败: ${message}` });
            });
          }
        }
      },
      // Only open our writer for a new segment when we are responsible for the xml.
      onSegment: (tsPath) => {
        if (ownWriter) this.openWriterForSegment(tsPath);
        else log.info(`新分段 (biliLive 自管 xml): ${tsPath}`);
      },
      // biliLive fires onDanmu but writes its own xml — we do NOT intercept here.
      // DLR does not fire onDanmu (providesDanmu=false); danmu comes via DanmuSource below.
      onDanmu: (m) => { if (ownWriter) this.write(m); },
      onOffline: () => { void this._handleOffline(); },
      onError: (e) => {
        log.error("recorder error:", e.message);
        this.notify({ kind: "error", stage: "record", message: e.message });
        void this._handleOffline();
      },
      // 探测连续失败:只告警(走 webhook),不触发收尾/重连(此刻并没有在录)。
      onProbeError: (msg) => {
        log.error("取流探测失败:", msg);
        this.notify({ kind: "error", stage: "取流", message: msg });
      },
    };

    // 注意:弹幕**不在此处**启动(那会在开播前连到陈旧 liveId)。改在 ev.onLive 里、确认开播后才连。
    await this.recorder.start(this.roomUrl, this.opts, ev);
  }

  /**
   * Called when the recorder fires onOffline or onError.
   * If the user has NOT called stop(), waits reconnectDelaySec then restarts.
   * Guards against re-entry while a reconnect is already in progress.
   */
  private async _handleOffline(): Promise<void> {
    this.live = false;
    if (this.userStopped) return;        // user-initiated stop — don't reconnect
    // Window-end drain: the current broadcast just ended naturally → finalize and
    // exit instead of reconnecting (RecordStop arrives before the isLive poll).
    if (this.draining) { await this._finishDrain(); return; }
    if (this.reconnecting) return;       // already reconnecting — ignore duplicate event
    this.reconnecting = true;

    // 标记断流缺口起点(重连成功 onLive 时用于算中断时长 + 区分「重连」vs「首次开播」)。
    this.offlineSince = Date.now();
    this.offlineNotified = false;
    // 区分「真下播」vs「网络抖动断流」:查权威 getLiving。
    //   false(主播确实下播)→ 立刻发 recordEnd(reason:主播下播),并标记 offlineNotified
    //                        (重连循环仍继续,主播重新开播时正常发 recordStart);
    //   true / 无 isLive(只是流抖动,主播还在播)→ 不发,留待 onLive 重连成功时发「抖动重连」warning。
    let stillLive = true;
    if (this.recorder.isLive) stillLive = await this.recorder.isLive().catch(() => true);
    if (!stillLive) {
      this.notify({ kind: "recordEnd", anchor: this.anchor, room: this.roomUrl, outDir: this.opts.outDir, reason: "主播下播" });
      this.offlineNotified = true;
    }

    // Tear down the current recorder/danmu before restarting (下一场会重新 connectDanmu 拿当场 liveId)。
    if (!this.recorder.providesDanmu && this.danmu) {
      await this.danmu.stop().catch(() => {});
      this.danmu = null;
    }
    await this.recorder.stop().catch(() => {});
    if (this.writerOpen) { this.writer.close(); this.writerOpen = false; this.currentXmlPath = null; }

    // Check again after async teardown — user may have called stop() during teardown
    if (this.userStopped) { this.reconnecting = false; return; }

    // 指数退避 + 封顶:_startInner 持续抛错(如短链解析/取流初始化失败)时不再每隔
    // reconnectDelaySec 死循环刷屏/打 API。delay = reconnectDelaySec * 2^fails,封顶 300s。
    const delaySec = Math.min(this.reconnectDelaySec * 2 ** this.reconnectFails, 300);
    log.info(
      `流断开,${delaySec}s 后重连… (${this.roomUrl})${this.reconnectFails ? ` [连续失败 ${this.reconnectFails}]` : ""}`
    );
    await delay(delaySec * 1000);

    if (this.userStopped) { this.reconnecting = false; return; }

    this.reconnecting = false;
    try {
      await this._startInner();
    } catch (err) {
      this.reconnectFails++;
      log.error(`重连失败(连续 ${this.reconnectFails}):`, err);
      // 跨阈值告警一次,之后每 10 次再提醒(避免刷屏);成功恢复由 onLive 清零。
      if (this.reconnectFails === 3 || (this.reconnectFails > 3 && this.reconnectFails % 10 === 0)) {
        this.notify({ kind: "error", stage: "重连", message: `连续 ${this.reconnectFails} 次重连失败,房间可能持续不可达:${this.roomUrl}` });
      }
      void this._handleOffline();
    }
  }

  private openWriterForSegment(tsPath: string): void {
    // xml 粒度由 opts.danmuXmlMode 决定：
    //   "segment" — 每个视频分段一个 xml：{tsPath 去 .ts}.xml（= {base}_NNN.xml，与该段配对）。
    //   "session"（默认）— 整场一个会话级 xml：剥掉分段后缀 → {base}.xml，同会话续写、
    //                      合并时按 ffprobe 时长切 ASS（避开断流位移，最稳）。
    const xmlPath =
      this.opts.danmuXmlMode === "segment"
        ? tsPath.replace(/\.(ts|flv)$/i, ".xml")
        : sessionXmlPath(tsPath);
    if (this.writerOpen && this.currentXmlPath === xmlPath) return;  // 同 xml 续写
    if (this.writerOpen) this.writer.close();
    // 弹幕时间轴锚到「本 xml 录制起点」(= 此刻新开分段 ≈ 视频该段第一帧)。这样:
    //   - 实时弹幕 rel = 真实发送时间 − 视频起点 → 落在正确视频秒;
    //   - WS 连上回灌的「开播前历史弹幕」(发送时间早于此)被 writer 丢弃,不污染片头。
    // 对 session/segment 两种粒度都正确(各自首次开 xml 的时刻即该段视频起点)。
    this.writer.open(xmlPath, { anchorName: this.anchor, videoStartMs: Date.now() });
    this.writerOpen = true;
    this.currentXmlPath = xmlPath;
    this.lastXmlPath = xmlPath;
    // 会话**开始**即写身份 sidecar:roomSlug(web_rid)= 唯一 ID。多节点 scan 优先读它当 slug,
    // 从第一秒就有、跨节点一致、不依赖主播名解析,也无"停录后 gaps 才有 slug"的时序竞态。
    try {
      const base = xmlPath.replace(/\.xml$/i, "");
      const roomSlug = platformForRoom(this.roomUrl).extractRoomSlug(this.roomUrl);
      writeFileSync(`${base}.meta.json`, JSON.stringify({ sessionBase: basename(base), roomSlug }), "utf-8");
    } catch { /* meta 写失败不影响录制 */ }
  }

  private write(m: DanmuMessage): void {
    if (!this.writerOpen) return;   // 还没有分段就丢弃（极少见）
    this.writer.add(m);
  }

  /** @param reason 录制结束原因(进 recordEnd 通知)。缺省「手动停止」——SIGTERM/手动停止走这条;
   *  窗口结束排空由 drain 传「窗口结束收播」。 */
  async stop(reason = "手动停止"): Promise<void> {
    if (this.userStopped) return;
    this.userStopped = true;
    if (!this.recorder.providesDanmu && this.danmu) {
      await this.danmu.stop().catch(() => {});
      this.danmu = null;
    }
    await this.recorder.stop().catch(() => {});
    if (this.writerOpen) { this.writer.close(); this.writerOpen = false; this.currentXmlPath = null; }
    // 写缺口 sidecar（供多节点选优用）
    try {
      if (this.currentXmlPath || this.lastXmlPath) {
        const base = (this.currentXmlPath ?? this.lastXmlPath!).replace(/\.xml$/i, "");
        const totalGapSec = Math.round(this.gaps.reduce((s, g) => s + (g.endMs - g.startMs), 0) / 1000);
        // 写入权威 roomSlug:多节点选优的 scan 优先用它,跨节点一致(不依赖各节点 anchorName 是否解析)。
        const roomSlug = platformForRoom(this.roomUrl).extractRoomSlug(this.roomUrl);
        writeFileSync(`${base}.gaps.json`, JSON.stringify({ sessionBase: basename(base), gaps: this.gaps, totalGapSec, roomSlug }), "utf-8");
      }
    } catch { /* sidecar 失败不影响停止 */ }
    // await(带 timeout):stop() 后调用方常立刻 process.exit,fire-and-forget 会丢这条 recordEnd。
    await this.notifyAwait({ kind: "recordEnd", anchor: this.anchor, room: this.roomUrl, outDir: this.opts.outDir, reason });
  }

  /**
   * Window-end DRAIN: stop the open-detection loop so no NEW broadcast is
   * recorded, but let the CURRENT recording finish naturally. The returned
   * promise resolves once the broadcast has ended and everything is torn down,
   * so the caller (cli record SIGUSR2 handler) can then exit the process.
   *
   * Natural-end is detected by whichever fires first:
   *   - the recorder's RecordStop event (→ onOffline, handled while draining), or
   *   - the authoritative isLive() poll returning false twice in a row.
   *
   * If nothing is being recorded at window-end, this finalizes immediately. If
   * the recorder can't drain (no drain()), it degrades to a hard stop().
   */
  async drain(): Promise<void> {
    if (this.userStopped) return;
    if (this.draining) return this.drainDone ?? Promise.resolve();
    this.draining = true;
    this.drainDone = new Promise<void>((r) => { this.resolveDrainDone = r; });

    if (!this.recorder.drain) {        // recorder can't drain → degrade to hard stop
      await this.stop("窗口结束收播");
      this._resolveDrain();
      return this.drainDone;
    }

    await this.recorder.drain().catch(() => {});
    log.info("窗口结束：停止开播轮询，等待当前直播自然收播…");

    if (!this.live) {                  // nothing recording → finalize now
      await this._finishDrain();
      return this.drainDone;
    }

    // Poll the authoritative live API; 2 consecutive offline reads = ended.
    if (this.recorder.isLive) {
      let offlineHits = 0;
      const tick = async (): Promise<void> => {
        if (!this.draining || this.userStopped) return;
        try {
          const living = await this.recorder.isLive!();
          offlineHits = living ? 0 : offlineHits + 1;
          if (offlineHits >= 2) { await this._finishDrain(); return; }
        } catch { /* API error → unknown, assume still live; retry next tick */ }
        if (this.draining) this.drainTimer = setTimeout(() => void tick(), this.drainPollSec * 1000);
      };
      this.drainTimer = setTimeout(() => void tick(), this.drainPollSec * 1000);
    }
    return this.drainDone;
  }

  /** Tear down after a drained broadcast ends; resolves drainDone exactly once. */
  private async _finishDrain(): Promise<void> {
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    if (!this.userStopped) await this.stop("窗口结束收播");
    this._resolveDrain();
  }

  private _resolveDrain(): void {
    const r = this.resolveDrainDone;
    this.resolveDrainDone = null;
    r?.();
  }
}

/**
 * 从一个视频分段路径推出会话级弹幕 xml 路径（同目录、会话基名 + .xml）。
 * 剥掉分段后缀，使一次录制会话的所有分段对应同一个 xml：
 *   biliLive: {base}-PART000.ts / -PART001.ts … → {base}.xml
 *   DLR:      {base}_000.ts / _001.ts …         → {base}.xml   ({主播}_{date}_{HH-MM-SS}[_%03d].ts)
 *   不分段:   {base}.ts                          → {base}.xml
 * 段后缀仅匹配 `-PART<n>` 或 `_<3+位数字>`；会话基名里的时间 `HH-MM-SS` 用连字符，不会误剥。
 */
export function sessionXmlPath(tsPath: string): string {
  const stem = basename(tsPath).replace(/\.(ts|flv)$/i, "");
  const base = stem.replace(/(?:-PART\d+|_\d{3,})$/, "");
  return join(dirname(tsPath), `${base}.xml`);
}

/** Promisified setTimeout — can be injected in tests via the reconnectDelaySec=0 trick. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
