import { basename, join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
  Recorder, DanmuSource, RecorderEvents, RecordOpts, DanmuMessage, StreamInfo,
} from "@drec/core";
import { XmlDanmuWriter } from "./danmu-xml/index.js";
import { writeSessionSidecar } from "./session-sidecar.js";
export { writeSessionSidecar, type SidecarWriteHooks } from "./session-sidecar.js";
import { createLogger, decorateRecordEvent, platformForRoom, processTimeZone, sessionBaseOf, stripVideoExt } from "@drec/core";

// 0 落盘流式直传(plans/039)在 record 进程里自己连弹幕,不复用 RecordingSession;
// 它需要同一个 writer 保证 xml 格式一致,所以从这里公开导出(格式的唯一实现仍在 danmu-xml)。
export { XmlDanmuWriter } from "./danmu-xml/index.js";
import type { AdmitDecision, Notifier, NotifyEvent } from "@drec/core";

const log = createLogger("session");

/**
 * T14 —— 「录稳了」的最短录制时长(ms)。低于它就断开 = **短命录制**(起得来但录不成)。
 * 取 120s:既越过绝大多数「起播瞬间抖动/签名失败」的秒退,又不让真正录了 3 分钟的直播
 * 因一次断流而背上退避(不误伤)。
 */
export const STABLE_RECORD_MS = 120_000;
/** 连续短命录制达此次数 → 发一次 error 告警(仍继续按封顶退避重连,不放弃)。 */
export const SHORT_LIVED_ALARM = 10;

/**
 * 「同场断流重连」的有效窗口(ms):自断流起算,窗口内的重启才按同一场放行闸门;超窗后按新一场处理。
 * 与 hub 的断流重连合并窗(默认 10 分钟)同口径。必要性:收播那刻判活可能滞后 / 抛错(都落成「仍在播」),
 * 若标志永不过期,几小时后的**下一场**开播会被误当同场而绕过闸门(审计发现)。
 */
export const SAME_BROADCAST_WINDOW_MS = 10 * 60_000;

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
  /**
   * 边录边传(T-33)的可选钩子**工厂**:每次 `_startInner`(首次开录 / 断流重连)调一次,
   * 返回**本会话专属**的钩子。必须是工厂而非单例 —— 断流重连会产生新会话(新文件名 base),
   * 复用同一实例会把两个会话的段混在一起(重复建稿 / 分 P 串台)。
   * **不注入 = 完全不启用**(默认,行为不变)。钩子只负责「通知」,上传/删源/失败转人工都在实现里;
   * session 不阻塞录制(除会话收尾时等其结束)。
   */
  makeRolling?: () => RollingUploadHook;
  /**
   * 新一场开播的准入闸门(磁盘水位,issue #96)。会话层只在「**新一场**」开播时调用它,
   * **同场断流重连直接放行**(重连是否受限见 plans/033 D6,不在此处理)。拒绝 → 发一条 error 告警
   * (同一原因回升前只发一次),录制器保持等待开播并自动重试。不注入 = 不启用(行为不变)。
   */
  admitNewBroadcast?: () => AdmitDecision;

  /**
   * Effective timezone recorded into the session sidecar (issue #87), next to the
   * absolute startMs. Self-describing metadata only: nothing reads it yet (scan uses
   * startMs directly). Default: process effective timezone.
   */
  timeZone?: string;
}

/**
 * 边录边传钩子(manager ↔ app 的接缝)。接口本身是通用的「分段封口」钩子:无后处理任务的节点侧
 * 原地替换容器(issue #137)也从 `makeRolling` 注入,与边录边传互斥(装配方二选一,rolling 优先)。
 * manager 只做「通知」:
 *   - {@link onSegment}:一个新分段产生(尚未封口;实现自己按封口规则决定何时上传);
 *   - {@link onSessionEnd}:本会话即将收尾(停录 / 断流重连前)—— 实现应处理最后一段并**等待完成**,
 *     返回后 session 才继续。实现必须**吞掉自身异常**(不得反噬录制),但要在自己的日志里留痕。
 */
export interface RollingUploadHook {
  onSegment(filePath: string): void;
  onSessionEnd(): Promise<void>;
}

export class RecordingSession {
  private writer = new XmlDanmuWriter();
  private writerOpen = false;
  /** Session-level danmu xml path currently open (DLR mode). Null = none open. */
  private currentXmlPath: string | null = null;
  private anchor = "";
  /** 本场直播标题(主播当场设的);落进 session sidecar,供 hub 后处理渲染 `{title}`。 */
  private liveTitle = "";
  /** Set to true once stop() is called by the user — suppresses reconnect. */
  private userStopped = false;
  /** Guards against overlapping reconnect attempts. */
  private reconnecting = false;
  /** True once drain() is called (window-end) — onOffline finalizes instead of reconnecting. */
  private draining = false;
  /** True while a recording is actively in progress (onLive → onOffline). */
  private live = false;
  /**
   * 本会话是否**曾经**真正开录过(onLive 触发过一次即 true,之后不清)。
   * 用于 stop() 收尾时决定发不发 recordEnd:整窗口主播没开播 → 一秒没录 → 收尾静默,
   * 不推「录制结束(窗口结束收播)」这种误导通知(没录过就没有「录制结束」可言)。
   */
  private everLive = false;
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
  /** Effective timezone recorded into the session sidecar (issue #87). */
  private readonly timeZone: string | undefined;
  /** 边录边传钩子工厂(T-33);undefined = 未启用(默认,行为不变)。 */
  private readonly makeRolling?: () => RollingUploadHook;
  /** 新一场开播准入闸门(issue #96);undefined = 不启用。 */
  private readonly admitNewBroadcast?: () => AdmitDecision;
  /**
   * 当前是否处于「**同一场直播的断流重连**」:_handleOffline 每次重启录制器之前查权威 getLiving 并赋值
   * (仍在播=流抖动 → true;确认下播 → false)。**但标志只在 {@link SAME_BROADCAST_WINDOW_MS} 内有效**:
   * 重启后录制器若发现其实没在播,会一直轮询而不再触发 _handleOffline,标志不会被刷新,必须靠窗口过期。
   * 录制引擎分不出「新一场」与「同场重连」,只有这里知道。初值 false:进程首次开播按新一场处理。
   */
  private sameBroadcastReconnect = false;
  /** 同场重连标志的过期时刻(epoch ms);超过后 admit 按新一场处理。 */
  private sameBroadcastUntil = 0;
  /** 上一次被拒绝的原因(同一原因只告警一次;放行后复位)。 */
  private lastAdmitDenied: string | null = null;
  /** 本会话的边录边传钩子(每次 _startInner 新建)。 */
  private rolling?: RollingUploadHook;
  /**
   * 当前这场的弹幕源(onLive 时经 platform.connectDanmu 取得、start;onOffline/stop 时 stop)。
   * 每场重新取一个(重连/下一场要重新解析 liveId)。null = 本场未抓弹幕。
   */
  private danmu: DanmuSource | null = null;
  /** 连续「重连(_startInner)抛错」次数;成功恢复(onLive)清零。用于指数退避 + 告警。 */
  private reconnectFails = 0;
  /**
   * T14:本次「onLive 起录」的时刻(epoch ms);null = 还没起过。
   * 用来算本场录制时长 —— **只有时长够(≥ STABLE_RECORD_MS)才允许复位退避**,
   * 否则「起得来但几秒退出」会以固定 5s 无限重连(实测上千次)。
   */
  private onLiveAt: number | null = null;

  /**
   * Authoritative session start (epoch ms), keyed by sidecar base (issue #87). One
   * recording process spans several broadcasts (reconnect / stream-down then up); each
   * opens a new base and must freeze its OWN start, so a stale value never leaks into
   * the next broadcast's sidecar. Re-frozen whenever the base changes.
   */
  private sessionStart: { base: string; ms: number } | null = null;
  /** Live id reported by the latest onLive (null = this spawn reported none). */
  private currentLiveSessionId: string | null = null;
  /** Live id frozen per sidecar base (issue #320), same keying as {@link sessionStart}. */
  private sessionLiveId: { base: string; id: string | null } | null = null;
  /**
   * T14:连续「短命录制」次数(起播确认后 < STABLE_RECORD_MS 就断流)。
   * 达 SHORT_LIVED_ALARM 发一次 error 告警(继续按封顶退避,不放弃重连)。
   */
  private shortLivedCount = 0;
  /** 已就发过短命熔断告警的次数档位(每跨一档再报一次,不刷屏)。 */
  private shortLivedAlarmAt = 0;

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
    this.makeRolling = sessionOpts?.makeRolling;
    this.admitNewBroadcast = sessionOpts?.admitNewBroadcast;
    this.timeZone = sessionOpts?.timeZone;
  }

  /**
   * 交给录制器的准入判定:同场重连一律放行;新一场才问闸门。拒绝时发告警(同原因只一次)。
   * 闸门抛错视为放行(探测失败绝不误拦录制)。
   */
  private admit(): AdmitDecision {
    if (!this.admitNewBroadcast) return { ok: true };
    if (this.sameBroadcastReconnect && Date.now() <= this.sameBroadcastUntil) return { ok: true };
    let d: AdmitDecision = { ok: true };
    try { d = this.admitNewBroadcast(); } catch { return { ok: true }; }
    if (d.ok) { this.lastAdmitDenied = null; return d; }
    const dedupeKey = d.key ?? d.reason;
    if (dedupeKey !== this.lastAdmitDenied) {
      this.lastAdmitDenied = dedupeKey;
      this.notify({ kind: "error", stage: "磁盘", message: `新一场开播被拒绝录制:${d.reason}(保持等待开播,空间恢复后自动开始)` });
    }
    return d;
  }

  /** Fire-and-forget notifier call — swallows errors so notifications never affect recording. */
  private notify(e: NotifyEvent): void {
    void this.notifier?.notify(this.withContext(e)).catch(() => {});
  }

  /**
   * Attach the notification context (issue #53 N4): display name by the shared chain (task name before
   * the platform anchor), platform and room id. `this.anchor` itself is untouched (it also names the
   * danmu file header). Never throws: a context failure must not cost the notification.
   */
  private withContext(e: NotifyEvent): NotifyEvent {
    try {
      const platform = this.roomUrl ? platformForRoom(this.roomUrl) : null;
      return decorateRecordEvent(e, {
        taskName: this.opts.name,
        liveAnchor: this.anchor,
        platform: platform?.id,
        roomSlug: platform && this.roomUrl ? platform.extractRoomSlug(this.roomUrl) : undefined,
      });
    } catch {
      return e;
    }
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
        this.notifier.notify(this.withContext(e)),
        new Promise<void>((r) => setTimeout(r, timeoutMs)),
      ]);
    } catch { /* 通知失败绝不影响停止 */ }
  }

  async start(roomUrl: string, opts: RecordOpts, info: StreamInfo): Promise<void> {
    this.roomUrl = roomUrl;
    this.opts = opts;
    this.streamInfo = info;
    this.anchor = info.anchorName;
    // 直播标题也进 sidecar:hub 后处理在录制进程退出后才跑,内存里的值那时已失效。
    this.liveTitle = (info.title ?? "").trim();
    this.userStopped = false;
    // 全新一轮(用户 start / 进程重启):健康计数从零开始,不继承上一轮的短命/失败计数。
    this.reconnectFails = 0;
    this.shortLivedCount = 0;
    this.shortLivedAlarmAt = 0;
    this.onLiveAt = null;
    this.sessionStart = null;
    this.currentLiveSessionId = null;
    this.sessionLiveId = null;

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
    // 边录边传(T-33):本会话专属钩子(工厂每次 _startInner 新建)。undefined = 未启用。
    this.rolling = this.makeRolling?.();

    // 进程已起、录制器在轮询开播但尚未拿到流 → 「等待开播」。父进程 TaskManager 解析
    // `[状态] X` → UI 区分「等待开播中」vs「录制中」（避免未开播也显示录制中）。
    console.log(`[状态] 等待开播`);

    const ev: RecorderEvents = {
      onLive: (i) => {
        this.live = true;
        this.everLive = true;
        // T14:**不再**无条件清零 reconnectFails。开播确认 ≠ 录成了;「起得来但几秒退出」
        // 正是靠这里无条件清零导致固定 5s 无限重连(实测 1650 次)。真正的复位判据在
        // _handleOffline:本场「时长够 + 进度新鲜」才算录稳了(见 STABLE_RECORD_MS)。
        this.onLiveAt = Date.now();
        // Reset on every spawn: a spawn without an id must not inherit the previous broadcast's id.
        this.currentLiveSessionId = (i.liveSessionId ?? "").trim() || null;
        // 新一场开播(下播后重新开播):清掉上一场的标题,否则第二场会沿用第一场的 title。
        // 判据 = offlineNotified(offline 时查权威 getLiving=false → 已确认下播);
        // 抖动断流(仍在播)不清 —— 同一场重连保留首值,避免被后续空值清掉。
        if (this.offlineNotified) this.liveTitle = "";
        console.log(`[状态] 录制中`); // 真正拿到流、开始录视频
        const resolved = i.anchorName || this.anchor;
        // 抓到主播名后打一行可解析日志（父进程 TaskManager 解析 → UI 显示主播名）。
        // 只在首次拿到非空主播名、且与上次不同时打，避免重连刷屏。
        if (resolved && resolved !== this.anchor) console.log(`[主播] ${resolved}`);
        this.anchor = resolved;
        // 直播标题:开播前拿不到(平台 getStream 只在 living 时返回 title),故在 onLive 记下。
        // onLive 恒先于 onSegment(beginRecording 里先 fire onLive 再 fire onSegment),所以随后
        // openWriterForSegment → _writeSession 落 sidecar 时 liveTitle 已就位 —— 无需在此补写
        // (补写会误用 lastXmlPath 覆盖**上一场**的 sidecar,见实测。)
        // 只取首个非空值(重连时保留首值,避免被后续空值清掉)。
        const title = (i.title ?? "").trim();
        if (title && !this.liveTitle) {
          this.liveTitle = title;
        }
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
              // 旁路提示(抖音 ControlMessage action=3:疑似本场结束)→ 交 recorder 用权威 getLiving 复核。
              // 复核为「已下播」才立刻收尾(把等看门狗 60s 缩短到秒级);仍在下播则忽略,绝不误判收播。
              (info) => { this.recorder.hintStreamEnded?.(info?.tips); },
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
        // 边录边传(T-33):通知钩子有新分段(未封口;由钩子自己按封口规则决定何时上传)。
        // 钩子异常绝不反噬录制(录制优先);失败/不确定由钩子内部转人工(保留源)。
        try { this.rolling?.onSegment(tsPath); } catch (e) { log.error("边录边传钩子 onSegment 抛错(忽略):", (e as Error)?.message ?? e); }
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
    await this.recorder.start(this.roomUrl, { ...this.opts, admit: () => this.admit() }, ev);
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
    // 仍在播(流抖动)→ 接下来的重启是「同一场的重连」,准入闸门放行;真下播 → 下一次开播是新一场,受闸门约束。
    this.sameBroadcastReconnect = stillLive;
    this.sameBroadcastUntil = Date.now() + SAME_BROADCAST_WINDOW_MS;
    if (!stillLive) {
      this.notify({ kind: "recordEnd", anchor: this.anchor, room: this.roomUrl, outDir: this.opts.outDir, reason: "主播下播" });
      this.offlineNotified = true;
    }
    // T14:**异常断流这一刻**才判定「这一场到底录稳了没」—— 这是唯一同时握有
    //   「onLiveAt(起录时刻)」+「recorder 进度信号」的时刻(onLive 时进度还新鲜,判不出短命)。
    //   录稳(duration ≥ STABLE_RECORD_MS 且进度新鲜)→ 退避复位;
    //   短命 → 记一次失败让退避真递增,并在达阈值时熔断告警(仍继续重连,不放弃)。
    // ⚠️ **只对 stillLive=true(流抖动/异常断流)判** —— 主播正常下播不是「起播即断」,
    //   混进去会让一天正常结束的直播攒够 10 次后误报「疑似签名失效/风控」,告警失去意义。
    //   真下播时这里只清健康计数(状态归零,下一场从零算)。
    if (stillLive) this.judgeStability();
    else { this.reconnectFails = 0; this.shortLivedCount = 0; this.shortLivedAlarmAt = 0; this.onLiveAt = null; }

    // Tear down the current recorder/danmu before restarting (下一场会重新 connectDanmu 拿当场 liveId)。
    if (!this.recorder.providesDanmu && this.danmu) {
      await this.danmu.stop().catch(() => {});
      this.danmu = null;
    }
    await this.recorder.stop().catch(() => {});
    if (this.writerOpen) { this.writer.close(); this.writerOpen = false; this.currentXmlPath = null; }

    // 边录边传(T-33):本会话已收尾(进程已停、最后一段不再增长)→ 处理最后一段并等它上传完成,
    // 再重连。**必须在 recorder.stop() 之后**调(否则最后一段还在写,封口判定不成立)。
    // 钩子异常绝不反噬重连;失败/不确定由钩子内部转人工(保留源)。
    if (this.rolling) {
      const rolling = this.rolling;
      this.rolling = undefined; // 幂等:同一会话只收尾一次(stop 与 offline 竞态不重复处理)
      try { await rolling.onSessionEnd(); }
      catch (e) { log.error("边录边传钩子 onSessionEnd 抛错(忽略):", (e as Error)?.message ?? e); }
    }

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

  /**
   * T14.3–T14.5:断流瞬间的稳定性判定(纯同步,只改计数器/发告警)。
   *
   * 判据(有进度信号时):`时长 ≥ STABLE_RECORD_MS` **且** `lastProgressAgeMs()` 新鲜
   *   —— 「久到不像起播抖动」+ 「退出前还在落盘」才算真录成。
   * 回落(无 `lastProgressAgeMs` 的 recorder,向后兼容):只要时长 ≥ STABLE_RECORD_MS 即算成功。
   *
   * ⚠️ 时序注意:`lastProgressAgeMs()` 在进程 close 后可能已返 `null`(recorder 已摘 proc),
   * 那属于「无信号」→ 走回落分支。这不是缺陷:close 事件路径拿不到进度是必然的,
   * 而「时长够」本身已能区分秒退与真录(真正的卡死由 recorder 自己的看门狗负责杀)。
   */
  private judgeStability(): void {
    const startedAt = this.onLiveAt;
    this.onLiveAt = null;
    // 从未 onLive(取流/初始化就抛了)→ 不是「短命录制」,退避由 reconnectFails 既有逻辑管。
    if (startedAt == null) return;

    const durationMs = Date.now() - startedAt;
    const age = this.recorder.lastProgressAgeMs?.() ?? null;
    const progressFresh = age == null ? true : age < STABLE_RECORD_MS; // null=无信号 → 不因缺信号而误判
    const stable = durationMs >= STABLE_RECORD_MS && progressFresh;

    if (stable) {
      if (this.reconnectFails > 0 || this.shortLivedCount > 0) {
        log.info(
          `本场录了 ${Math.round(durationMs / 1000)}s(进度${
            age == null ? "无信号" : `${Math.round(age / 1000)}s 前`
          })→ 判定录稳,退避复位`,
        );
      }
      this.reconnectFails = 0;
      this.shortLivedCount = 0;
      this.shortLivedAlarmAt = 0;
      return;
    }

    // 短命:起得来,但没录够就断了。
    this.shortLivedCount++;
    // 让退避**真的**递增(此前 onLive 无条件清零 → 永远 5s)。
    this.reconnectFails++;
    log.warn(
      `短命录制(第 ${this.shortLivedCount} 次):开播确认后仅 ${Math.round(durationMs / 1000)}s 就断开` +
        `${age == null ? "(无进度信号)" : `(退出前 ${Math.round(age / 1000)}s 未见落盘前进)`}` +
        ` → 退避加深,不立即重试`,
    );
    if (this.shortLivedCount >= SHORT_LIVED_ALARM && this.shortLivedCount >= this.shortLivedAlarmAt + SHORT_LIVED_ALARM) {
      this.shortLivedAlarmAt = this.shortLivedCount;
      this.notify({
        kind: "error",
        stage: "录制健康",
        message:
          `连续 ${this.shortLivedCount} 次「起播即断」(${Math.round(durationMs / 1000)}s 内退出):` +
          `疑似签名失效/平台风控/取流被拒。将继续按封顶退避重试,请检查取流与风控状态。room=${this.roomUrl}`,
      });
    }
  }

  private openWriterForSegment(tsPath: string): void {
    // xml 粒度由 opts.danmuXmlMode 决定：
    //   "segment" — 每个视频分段一个 xml：{tsPath 去 .ts}.xml（= {base}_NNN.xml，与该段配对）。
    //   "session"（默认）— 整场一个会话级 xml：剥掉分段后缀 → {base}.xml，同会话续写、
    //                      合并时按 ffprobe 时长切 ASS（避开断流位移，最稳）。
    const xmlPath =
      this.opts.danmuXmlMode === "segment"
        ? `${stripVideoExt(tsPath)}.xml`
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
    // 会话**开始**即写身份 sidecar `{base}.session.json`:roomSlug(web_rid)+ platform = 唯一身份。
    // 从第一秒就有、跨节点一致、不依赖主播名解析。停录时同名覆盖、补上 gaps(见 _writeSession)。
    // 一个 sidecar 同时承载「身份(聚类)」+「缺口(选优)」,不再分 meta/gaps 两个文件。
    try {
      this._writeSession(xmlPath.replace(/\.xml$/i, ""));
    } catch { /* sidecar 写失败不影响录制 */ }
  }

  /**
   * 写会话 sidecar `{base}.session.json`(合并旧 meta+gaps)。
   * 开录调(withGaps=false,只身份);停录调(withGaps=true,身份 + 缺口)→ 同名覆盖。
   */
  private _writeSession(base: string, withGaps = false): void {
    const plat = platformForRoom(this.roomUrl);
    // Freeze the authoritative session start the first time we write THIS base (issue #87).
    // Keyed by base: one process covers several broadcasts, each opening a new base, so the
    // value must never drift to a later broadcast's stop time.
    if (this.sessionStart === null || this.sessionStart.base !== base) {
      this.sessionStart = { base, ms: this.onLiveAt ?? Date.now() };
    }
    const data: Record<string, unknown> = {
      sessionBase: basename(base),
      roomSlug: plat.extractRoomSlug(this.roomUrl),
      platform: plat.id,
      // Absolute start + effective timezone: consume as truth instead of deriving
      // from file mtime or filename parsing (which reverse-parses in the reader's
      // local timezone and can land on the wrong day across a UTC/Asia boundary).
      startMs: this.sessionStart.ms,
      timeZone: this.timeZone ?? processTimeZone(),
    };
    if (this.liveTitle) data.title = this.liveTitle;
    // Issue #320: the platform live id decides "same broadcast" downstream. Frozen per base like startMs;
    // only filled in later if the first write had none.
    if (this.sessionLiveId === null || this.sessionLiveId.base !== base) {
      this.sessionLiveId = { base, id: this.currentLiveSessionId };
    } else if (!this.sessionLiveId.id && this.currentLiveSessionId) {
      this.sessionLiveId = { base, id: this.currentLiveSessionId };
    }
    if (this.sessionLiveId.id) data.liveSessionId = this.sessionLiveId.id;
    if (withGaps) {
      data.gaps = this.gaps;
      data.totalGapSec = Math.round(this.gaps.reduce((s, g) => s + (g.endMs - g.startMs), 0) / 1000);
    }
    // Atomic write; carries the node-side `nodeFormat` marker over from the existing file.
    writeSessionSidecar(base, data);
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
    // 边录边传(T-33):停录后处理最后一段并等上传完成(在写 session sidecar 之前;失败/不确定
    // 由钩子内部转人工)。钩子异常绝不反噬停止。
    if (this.rolling) {
      const rolling = this.rolling;
      this.rolling = undefined;
      try { await rolling.onSessionEnd(); }
      catch (e) { log.error("边录边传钩子 onSessionEnd 抛错(忽略):", (e as Error)?.message ?? e); }
    }
    // 停录:同名覆盖 session.json,补上缺口(身份字段不变)。供多节点选优用。
    try {
      if (this.currentXmlPath || this.lastXmlPath) {
        this._writeSession((this.currentXmlPath ?? this.lastXmlPath!).replace(/\.xml$/i, ""), true);
      }
    } catch { /* sidecar 失败不影响停止 */ }
    // await(带 timeout):stop() 后调用方常立刻 process.exit,fire-and-forget 会丢这条 recordEnd。
    // 只有本会话**真开录过**才发 recordEnd —— 整窗口没开播的空等会话收尾静默
    // (否则每晚主播不播,窗口一关照样推「录制结束(窗口结束收播)」,纯属打扰)。
    if (this.everLive) {
      await this.notifyAwait({ kind: "recordEnd", anchor: this.anchor, room: this.roomUrl, outDir: this.opts.outDir, reason });
    } else {
      log.info(`会话收尾(${reason}):本会话未录制任何内容,跳过 recordEnd 通知`);
    }
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
 *   _PART000 变体: {base}_PART000.ts → {base}.xml
 * 规则见 core `sessionBaseOf`(issue #50:此处原先漏认 `_PART<n>`,与其余调用点不一致,已对齐)。
 */
export function sessionXmlPath(tsPath: string): string {
  return join(dirname(tsPath), `${sessionBaseOf(tsPath)}.xml`);
}

/** Promisified setTimeout — can be injected in tests via the reconnectDelaySec=0 trick. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
