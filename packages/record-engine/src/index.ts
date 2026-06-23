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
export const FAIL_ALERT = 3;          // 连续「取流+判活均失败」首次告警阈值(≈1.5 分钟)
export const ALERT_REPEAT = 20;       // 持续失败每隔此次数再提醒(≈10 分钟)
export const STALL_CHECK_MS = 15_000; // 卡死看门狗检查间隔
export const STALL_TIMEOUT_MS = 60_000; // 输出停滞 ≥ 此时长 → 判定卡死

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
  /** 最近 stderr 尾(断链诊断;引擎按需 push)。 */
  protected stderrTail: string[] = [];

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
    this.pollTimer = setTimeout(() => void this.poll(), POLL_MS);
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

  /** 卡死看门狗:lastAdvanceAt 停滞 ≥ STALL_TIMEOUT_MS 且进程仍在 → 告警 + 杀(→ onOffline → 重连)。 */
  private startStallWatch(proc: ChildProcess): void {
    this.clearStallWatch();
    this.stallTimer = setInterval(() => {
      if (this.stopped || this.proc !== proc) return;
      if (Date.now() - this.lastAdvanceAt <= STALL_TIMEOUT_MS) return;
      const secs = Math.round((Date.now() - this.lastAdvanceAt) / 1000);
      log.warn(`⚠️ 录制卡死:${secs}s 无新输出,杀进程触发重连`);
      this.ev?.onProbeError?.(`录制卡死:≥${secs}s 未写入新数据(流连着但无内容),已杀进程重连。room=${this.channelId}`);
      this.clearStallWatch();
      try { proc.kill("SIGKILL"); } catch { /* close 事件会 onOffline */ }
    }, STALL_CHECK_MS);
    this.stallTimer.unref?.();
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
    let living = false;
    try {
      living = await this.platform.getLiving(this.channelId);
    } catch {
      /* API 不可达 → 按断流处理 */
    }
    if (this.stopped) return;
    if (!living) {
      log.info(`主播已下播,本场录制结束,等待下次开播。room=${this.channelId}`);
    } else {
      const tail = this.stderrTail
        .filter((l) => /error|fail|403|404|reset|refused|invalid|eof|timeout|http/i.test(l))
        .slice(-6);
      log.info(`录制进程退出 code=${code}(房间仍在播 → 疑似断流,将重连)`);
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
