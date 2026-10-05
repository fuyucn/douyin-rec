/**
 * @drec/record-engine — 通用直播录制器 + 下载引擎策略(ffmpeg / mesio)。
 *
 * `PollingRecorder` 是**平台无关 + 引擎无关**的录制器:开播轮询(30s)→ 取流成功且 living 则
 * 让选中的 `DownloadEngine` spawn 下载子进程 → 进程退出后判别「下播 vs 断流」交 RecordingSession;
 * 取流持续失败(签名失效/风控)告警;drain(停开播轮询不腰斩当前)/ isLive(权威判活);
 * 卡死看门狗(引擎喂 markProgress(),停滞超阈值 → 杀进程触发重连)。
 *
 * **取流不写死任何平台**:start() 时 `platformForRoom(roomUrl)` 拿到 Platform,之后一律走
 * `this.platform.getStream/getLiving/extractRoomSlug/resolveShortUrl`。
 * **下载不写死引擎**:构造时注入一个 `DownloadEngine`(ffmpeg/mesio);spawnRecording 把流 URL +
 * 来路 header + 输出目录/命名/分段交给 engine.spawn,引擎负责具体下载进程 + 进度/分段上报。
 *
 * 取代了原「每平台 × ffmpeg/mesio = 4 个近乎相同的录制器包」:现在录制器只此一个,可换引擎。
 */
import { resolve, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { createLogger, platformForRoom, type DownloadEngine, type Platform, type PlatformStream, type Recorder, type RecordOpts, type RecorderEvents } from "@drec/core";
import { logStreamMeta, type StreamMetaSource } from "@drec/ffmpeg-recorder-extra";

const log = createLogger("stream_recorder");

export const POLL_MS = 30_000;        // 开播探测间隔
export const THROTTLE_POLL_MS = 5 * 60_000; // 风控降频探测间隔(冷却期少打扰平台,代价是开播检测延迟)
export const FAIL_ALERT = 3;          // 连续「取流+判活均失败」首次告警阈值(≈1.5 分钟)
export const ALERT_REPEAT = 20;       // 持续失败每隔此次数再提醒(≈10 分钟)
export const STALL_CHECK_MS = 15_000; // 卡死看门狗检查间隔
export const STALL_TIMEOUT_MS = 60_000; // 输出停滞 ≥ 此时长 → 判定卡死
export const STALL_GRACEFUL_EXIT_MS = 5_000; // 主播已下播但进程吊着 → SIGINT 后等它收尾的宽限

export type { PlatformStream };
export { ffmpegEngine, buildFfmpegArgs } from "./engines/ffmpeg.js";
export { mesioEngine, buildMesioArgs, resolveMesioBin } from "./engines/mesio.js";

/** {name}_{YYYY-MM-DD_HH-MM-SS} 会话起始时间戳(分段文件名用)。 */
export function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * 子目录/文件名清洗:删非法字符(/ \ : * ? " < > |)+ 控制符,折叠空白,trim(不截断)。
 * **必须与合并 UI(api.ts recordingsDir → sanitizeSeg)一致**——否则落盘目录名与读取算出的对不上。
 */
export function sanitizePathSegment(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class PollingRecorder implements Recorder {
  readonly name: string;
  /** 自研录制器仅录视频;弹幕(含礼物)由独立 DanmuSource 插件负责。 */
  readonly providesDanmu = false;

  private readonly engine: DownloadEngine;

  protected platform!: Platform;
  protected channelId = "";
  protected quality: RecordOpts["quality"] = "origin";
  protected outDir = "";
  protected outName?: string;
  /** 任务 cookie:原样透传给 platform.getStream,平台自决用不用(抖音忽略保持匿名,bilibili 可用)。 */
  protected cookies?: string;
  protected segSec = 0;
  protected ev: RecorderEvents | null = null;

  protected stopped = false;
  /** drain:停开播轮询、不再录下一场,但不腰斩当前进程。 */
  protected noNewSession = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  protected proc: ChildProcess | null = null;
  /** 引擎本场的清理(如 mesio 文件增长看门狗 interval);进程退出时调用。 */
  private engineCleanup: (() => void) | null = null;
  /** 连续「取流+判活均失败」计数(区分签名坏 vs 没开播;成功清零)。 */
  private probeFails = 0;
  /** 卡死看门狗:上次「输出有前进」的墙钟。引擎调 markProgress() 刷新。 */
  protected lastAdvanceAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** 卡死判定中的异步 living 查询;防止 interval 重入并发处理。 */
  private stallInFlight = false;
  /** 「疑似本场结束」提示的复核进行中标志(防重入;与 stallInFlight 分开,语义不同)。 */
  private hintInFlight = false;
  /** 最近 stderr 尾(断链诊断;引擎按需 push)。 */
  protected stderrTail: string[] = [];
  /** 平台建议的基础探测间隔(缺省 30s;快手页面限流紧 → 5 分钟)。 */
  private basePollMs = POLL_MS;
  /** 当前开播探测间隔(风控时升 THROTTLE_POLL_MS,解除回 basePollMs)。 */
  private pollDelayMs = POLL_MS;
  /** 最近一次风控提示(去重:同一文案只在进入时打一次,解除时再打恢复日志)。 */
  private lastThrottledReason: string | null = null;

  /** 注入下载引擎(ffmpeg / mesio)。name 取引擎 id,便于日志/识别。 */
  constructor(engine: DownloadEngine) {
    this.engine = engine;
    this.name = engine.id;
  }

  /**
   * 用取到的流 URL 让引擎 spawn 下载进程并接线:
   *   组装输出目录/命名/分段 → engine.spawn({url, headers, dir, nameBase, segSec, on*}) →
   *   beginRecording(proc, owner, title, sessionFirstPath) → 记录 cleanup(进程退出时调)。
   * probe.raw 携带平台专属原始取流结果(如抖音 logStreamMeta);probe.headers = 拉流来路头。
   */
  protected spawnRecording(url: string, probe: PlatformStream, owner: string, title: string): void {
    const ev = this.ev;
    if (!ev) return;
    // 附加插件(抖音):若平台取流给了 raw,打印「流信息」+「直播设备」(异步 ffprobe,不阻塞)。
    // bilibili 等无 raw 的平台 → streamInfoLine 返 undefined(只 ffprobe 设备,也无伤)。
    if (probe.raw) logStreamMeta(url, probe.raw as StreamMetaSource, this.quality);

    const safe = sanitizePathSegment(this.outName || owner) || this.channelId;
    const dir = join(this.outDir, safe);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      log.warn(`预建子目录失败(${safe}):`, (e as Error)?.message ?? e);
    }
    const nameBase = `${safe}_${stamp(new Date())}`;

    log.info(`录制中`);
    this.stderrTail = [];
    const { proc, sessionFirstPath, cleanup } = this.engine.spawn({
      url,
      headers: probe.headers,
      dir,
      nameBase,
      segSec: this.segSec,
      onSegment: (p) => ev.onSegment(p),
      markProgress: () => this.markProgress(),
      pushStderr: (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      },
    });
    this.engineCleanup = cleanup ?? null;
    // 登记 proc + onLive + onSegment(会话首段)+ 卡死看门狗 + close/error 接线。
    this.beginRecording(proc, owner, title, sessionFirstPath);
  }

  async start(roomUrl: string, opts: RecordOpts, ev: RecorderEvents): Promise<void> {
    this.stopped = false;
    this.noNewSession = false;
    this.ev = ev;
    this.platform = platformForRoom(roomUrl);
    // 平台可指定更保守的基础轮询间隔(快手页面限流紧 → 5 分钟);缺省仍是 30s。
    this.basePollMs = this.platform.pollIntervalMs ?? POLL_MS;
    this.pollDelayMs = this.basePollMs;
    this.quality = opts.quality;
    this.cookies = opts.cookies;
    this.outDir = resolve(opts.outDir);
    this.outName = opts.name?.trim() || undefined;
    this.segSec = opts.segmentSec > 0 ? opts.segmentSec : 0;

    let slug = this.platform.extractRoomSlug(roomUrl);
    // extractRoomSlug 没把 URL 解析成房间号(仍是 URL)→ 多半是短链,试平台短链解析。
    if (/^https?:\/\//.test(slug) && this.platform.resolveShortUrl) {
      try {
        const r = await this.platform.resolveShortUrl(roomUrl);
        if (r) slug = r;
      } catch (e) {
        log.error(`短链解析失败 (${roomUrl}):`, (e as Error)?.message ?? e);
      }
    }
    this.channelId = slug;

    log.info(`等待开播`);
    void this.poll(); // 立即探一次,不阻塞 start
  }

  /** 开播探测:living 则 spawnRecording,否则 30s 后重试;取流持续失败告警。 */
  private async poll(): Promise<void> {
    if (this.stopped || this.noNewSession || this.proc) return;
    try {
      // 取流:把任务 cookie 透传给平台,平台自决用不用(抖音忽略=匿名避免踢手机,bilibili 可用于高画质)。
      const probe = await this.platform.getStream(this.channelId, this.quality, this.cookies);
      this.probeFails = 0; // 取流成功 → 清零
      if (this.stopped) return;
      if (probe.throttledReason) {
        // 风控(平台页可达但被限流)→ 显式日志 + 降频轮询,避免把风控伪装成「主播没开播」掩盖漏录。
        this.pollDelayMs = Math.max(this.basePollMs, THROTTLE_POLL_MS);
        if (probe.throttledReason !== this.lastThrottledReason) {
          this.lastThrottledReason = probe.throttledReason;
          log.warn(`平台风控:${probe.throttledReason} —— ${Math.round(this.pollDelayMs / 60000)} 分钟一探(冷却期少打扰平台;解除前若在播会漏录)`);
        }
      } else if (this.lastThrottledReason) {
        log.info(`风控解除,恢复正常轮询`);
        this.lastThrottledReason = null;
        this.pollDelayMs = this.basePollMs;
      }
      if (probe.living && probe.url) {
        this.spawnRecording(probe.url, probe, String(probe.owner ?? ""), String(probe.title ?? ""));
        return;
      }
      // 干净返回但未开播 → 正常,继续轮询。
    } catch {
      if (this.stopped) return;
      // getStream 抛错:可能真没开播,也可能签名失效/被风控。getLiving 能返回=API/签名正常。
      if (await this.apiReachable()) {
        this.probeFails = 0;
      } else {
        this.probeFails++;
        if (this.probeFails === FAIL_ALERT || (this.probeFails > FAIL_ALERT && this.probeFails % ALERT_REPEAT === 0)) {
          const mins = Math.round((this.probeFails * POLL_MS) / 60000);
          this.ev?.onProbeError?.(
            `连续 ${this.probeFails} 次取流+判活均失败(约 ${mins} 分钟),疑似签名失效或被风控 —— 若此时主播在播即为漏录,请检查。room=${this.channelId}`,
          );
        }
      }
    }
    this.scheduleNextPoll();
  }

  /** 探活:getLiving 能返回=API/签名正常(也许只是没开播);抛错=API 真不可达。 */
  private async apiReachable(): Promise<boolean> {
    try {
      await this.platform.getLiving(this.channelId);
      return true;
    } catch {
      return false;
    }
  }

  private scheduleNextPoll(): void {
    if (this.stopped || this.noNewSession) return;
    this.pollTimer = setTimeout(() => void this.poll(), this.pollDelayMs);
  }

  /**
   * 引擎 spawn 后调用:登记 proc + onLive + onSegment(首段)+ 起卡死看门狗 + wire close/error。
   * 进程退出后由 reportExitThenOffline 判别下播/断流 → onOffline(由 RecordingSession 决定重连)。
   */
  protected beginRecording(proc: ChildProcess, owner: string, title: string, firstSegment?: string): void {
    const ev = this.ev;
    if (!ev) return;
    this.proc = proc;
    this.lastAdvanceAt = Date.now(); // 起始宽限
    this.startStallWatch(proc);
    ev.onLive({ anchorName: owner, title: title || undefined });
    if (firstSegment) ev.onSegment(firstSegment);
    proc.on("close", (code) => {
      this.proc = null;
      this.clearStallWatch();
      this.runEngineCleanup();
      if (this.stopped) return; // 用户/排空已停,不再上报
      void this.reportExitThenOffline(code);
    });
    // exit 先于 close(close 还要等 stdio 关):立即摘看门狗,避免「进程已退出但 close 晚到」
    // 的窗口里把正常下播误判成卡死。上报/收尾仍由 close 负责。
    proc.on("exit", () => {
      this.clearStallWatch();
    });
    proc.on("error", (e) => {
      this.proc = null;
      this.clearStallWatch();
      this.runEngineCleanup();
      if (this.stopped) return;
      ev.onError(e);
    });
  }

  private runEngineCleanup(): void {
    if (this.engineCleanup) {
      try { this.engineCleanup(); } catch { /* ignore */ }
      this.engineCleanup = null;
    }
  }

  /** 录制有前进时调用(刷新看门狗健康时刻)。ffmpeg=time= 推进;mesio=输出文件增长。 */
  protected markProgress(): void {
    this.lastAdvanceAt = Date.now();
  }

  /**
   * 「疑似本场结束」旁路提示(弹幕 ControlMessage / 上层信号)→ **立刻用权威 getLiving 复核**。
   * 目的是把「等看门狗 60s 才判定收尾」缩短到秒级。**只有确认 living=false 才收尾**;
   * true/未知一律忽略(网络抖动、风控断流都不能当收播,否则会把一场切成多段)。
   */
  hintStreamEnded(tips?: string): void {
    const proc = this.proc;
    if (this.stopped || !proc || this.hintInFlight) return;
    if (proc.exitCode !== null || proc.signalCode !== null) return; // 已退出 → 走正常 close 收尾
    this.hintInFlight = true;
    void (async () => {
      try {
        let living: boolean | null = null;
        try { living = await this.platform.getLiving(this.channelId); } catch { living = null; }
        if (this.stopped || this.proc !== proc || proc.exitCode !== null || proc.signalCode !== null) return;
        if (living === false) {
          // 与看门狗「已下播但进程吊着」同路径:先 SIGINT 让下载器正常收尾,宽限后再 SIGKILL。
          const secs = Math.round((Date.now() - this.lastAdvanceAt) / 1000);
          log.info(
            `收到本场结束提示${tips ? `(${tips})` : ""}且权威判活=下播 → 立即收尾(SIGINT,${STALL_GRACEFUL_EXIT_MS / 1000}s 未退再强杀)`,
          );
          this.clearStallWatch();
          const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* 已退出 */ } }, STALL_GRACEFUL_EXIT_MS);
          killTimer.unref?.();
          const cancelKill = (): void => clearTimeout(killTimer);
          proc.once("exit", cancelKill);
          proc.once("close", cancelKill);
          try { proc.kill("SIGINT"); } catch { /* close 事件会收尾 */ }
        } else {
          log.info(
            `收到本场结束提示${tips ? `(${tips})` : ""}但权威判活=${living === true ? "仍在播" : "未知"} → 忽略(疑似断流/风控,不误判收播)`,
          );
        }
      } finally {
        this.hintInFlight = false;
      }
    })();
  }

  /** 卡死看门狗:lastAdvanceAt 停滞 ≥ STALL_TIMEOUT_MS 且进程仍在 → 告警 + 杀(→ onOffline → 重连)。 */
  private startStallWatch(proc: ChildProcess): void {
    this.clearStallWatch();
    this.stallTimer = setInterval(() => {
      if (this.stopped || this.proc !== proc || this.stallInFlight) return;
      // 进程已 exit 但 close 还没收 stdio → 不判卡死,等 close 收尾。
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      if (Date.now() - this.lastAdvanceAt <= STALL_TIMEOUT_MS) return;
      const secs = Math.round((Date.now() - this.lastAdvanceAt) / 1000);
      this.stallInFlight = true;
      void this.handleStall(proc, secs);
    }, STALL_CHECK_MS);
    this.stallTimer.unref?.();
  }

  /**
   * 停滞超阈值后的处置:先查权威 living,再决定「真卡死(告警+杀)」还是「主播已下播但下载进程
   * 还吊着(静默收尾)」——避免正常下播被误报成录制卡死。
   */
  private async handleStall(proc: ChildProcess, secs: number): Promise<void> {
    let living: boolean | null = null;
    try {
      living = await this.platform.getLiving(this.channelId);
    } catch {
      /* API 不可达:无法确认主播是否下播 → 按卡死保守重连,但告警要说明真实原因 */
    }
    this.stallInFlight = false;
    if (this.stopped || this.proc !== proc || proc.exitCode !== null || proc.signalCode !== null) return;

    if (living === false) {
      // 先 SIGINT 让 ffmpeg 正常收尾(写完 PAT/PMT、flush 最后一帧),避免 SIGKILL 留下未收尾的 .ts
      // (那种尾部会在体检里报时间戳/残帧问题,重封装后才消失)。宽限内没退再 SIGKILL。
      log.info(`主播已下播但下载进程 ${secs}s 无输出未退出,先 SIGINT 收尾(${STALL_GRACEFUL_EXIT_MS / 1000}s 未退再强杀)`);
      this.clearStallWatch();
      const killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
      }, STALL_GRACEFUL_EXIT_MS);
      killTimer.unref?.();
      const cancelKill = (): void => clearTimeout(killTimer);
      proc.once("exit", cancelKill);
      proc.once("close", cancelKill);
      try { proc.kill("SIGINT"); } catch { /* close 事件会收尾 */ }
      return;
    }

    const apiUnreachable = living === null;
    const label = apiUnreachable ? "无法确认主播状态" : "录制卡死";
    log.warn(`⚠️ ${label}:${secs}s 无新输出,杀进程触发重连`);
    this.ev?.onProbeError?.(
      apiUnreachable
        ? `无法确认主播状态(判活 API 不可达),≥${secs}s 未写入新数据,按卡死重连。room=${this.channelId}`
        : `录制卡死:≥${secs}s 未写入新数据(流连着但无内容),已杀进程重连。room=${this.channelId}`,
    );
    this.clearStallWatch();
    try { proc.kill("SIGKILL"); } catch { /* close 事件会 onOffline */ }
  }

  private clearStallWatch(): void {
    if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = null; }
  }

  /**
   * 进程退出后:查一次权威 living 再 onOffline,区分日志:
   *   不在播 → 主播正常下播(下播=流 URL 失效,进程会喷错,那是正常收场)→ 干净打「已下播」。
   *   仍在播 → 真断流 → 打 code + 断链 stderr 供诊断。两种都照常 onOffline(session 决定等/重连)。
   */
  private async reportExitThenOffline(code: number | null): Promise<void> {
    const ev = this.ev;
    if (!ev || this.stopped) return;
    // 三态:false=确认下播 / true=仍在播 / null=无法确认(API 不可达或被风控)。
    // 后两者都按「断流」处理并继续重连 —— 只有确认下播才收尾。
    let living: boolean | null = null;
    try {
      living = await this.platform.getLiving(this.channelId);
    } catch {
      living = null;
    }
    if (this.stopped) return;
    if (living === false) {
      log.info(`主播已下播,本场录制结束,等待下次开播。room=${this.channelId}`);
    } else {
      const tail = this.stderrTail
        .filter((l) => /error|fail|403|404|reset|refused|invalid|eof|timeout|http/i.test(l))
        .slice(-6);
      log.info(
        living === true
          ? `录制进程退出 code=${code}(房间仍在播 → 疑似断流,将重连)`
          : `录制进程退出 code=${code}(主播状态未知/被风控 → 按断流处理,将重连)`,
      );
      if (tail.length) log.info(`断链前 stderr:\n  ${tail.join("\n  ")}`);
    }
    ev.onOffline();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearStallWatch();
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    const p = this.proc;
    if (p) {
      // SIGINT 让进程冲完当前分段再退,避免尾段损坏;8s 兜底 SIGKILL。
      try { p.kill("SIGINT"); } catch { /* ignore */ }
      await new Promise<void>((r) => {
        const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* ignore */ } r(); }, 8000);
        p.on("close", () => { clearTimeout(t); r(); });
      });
      this.proc = null;
    }
  }

  /** 排空:停开播轮询(不录下一场),当前进程不动,录到自然收播。 */
  async drain(): Promise<void> {
    this.noNewSession = true;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  /** 权威开播状态(drain 期间判定自然收播)。查询失败按「仍在播」避免误判收播。 */
  async isLive(): Promise<boolean> {
    if (!this.channelId) return true;
    try {
      return await this.platform.getLiving(this.channelId);
    } catch {
      return true;
    }
  }
}
