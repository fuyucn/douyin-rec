/**
 * rolling-upload.ts — 「边录边传」录制端执行体(T-33,见 plans/031)。
 *
 * 现状:整场录完才做 merge/upload,多房间同时在录时节点盘被源 + 中间产物写满,
 * 后处理写盘失败、源也删不掉(实测某 worker 49G 盘写满)。本模块让**录制进程**在每产生一个
 * **已封口**分段时就单独上传一个分 P,该分 P 确认(BV / append ack)后**只删那一段**的源视频。
 *
 * 硬边界(与 core/rolling.ts 的纯判定对齐):
 *   - 只碰**已封口**分段(封口判定 = core.sealedSegmentIndices;正在写的文件永不动)。
 *   - 源视频只在该段**自己**得到确认后才删;失败/不确定 → **保留源、转人工**,绝不自动重传。
 *   - `.xml` / `.ass` 绝不随分段删(弹幕源不可再生)。
 *   - 磁盘低于水位 → 拒绝**新开录**;不靠删未确认源腾空间(判定在 core.shouldRefuseNewRecording,由调用方用)。
 *
 * 幂等/重入:已确认段号持久化在 `{sessionBase}.rolling.json`(节点本地 sidecar),进程重启后
 * 不会重复建稿/重复 append。首个封口段 = P1 建稿(拿 BV),后续段 = append(单文件一次提交,
 * 失败可安全重试;不确定失败 → 记 ambiguous、保留源、转人工)。
 *
 * ⚠️ 为什么按**会话**隔离:断流重连会产生新会话(新文件名 base)+ 新 xml;不同会话的段各自独立
 * 建稿/append,绝不跨会话混在一起(与 orchestrator 的「分 P 只能属于一个会话」同口径)。
 */
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import {
  canDeleteRollingSource,
  DEFAULT_SEAL_GRACE_MS,
  formatBiliTitle,
  planRollingUploads,
  resolveOutputStem,
  rollingUploadSingleNode,
  segmentSessionBase,
  UploadGate,
  type RollingSegment,
} from "@drec/core";
import { appendGroup, uploadPlain } from "./upload/biliup.js";
import { rootBiliupCookies } from "./paths.js";
import { openNodeUploadGate, resolveUploadAccountKey } from "./node-pipeline.js";
import { getHubRule, hubKey } from "./hub-store.js";
import { rootHubConfig, rootHubDir } from "./paths.js";
import type { RollingUploadHook } from "@drec/manager";

/** 一个会话的持久化确认状态(防重启后重复投稿)。 */
interface RollingState {
  streamKey: string;
  sessionBase: string;
  /**
   * 段号 → 段文件路径(段号按 onSegment 触发顺序)。**必须持久化**:进程重启后新段要从
   * `max(已知段号)+1` 续号,否则新段会被分到「已确认」的段号 → 被跳过 = **漏传**(丢分 P)。
   */
  segments: Array<{ index: number; path: string }>;
  /** 已确认上传(拿到 BV/ack)的**段号**集合。 */
  confirmed: number[];
  /** 已建稿的 BV(首个封口段建稿成功后落库;空 = 尚未建稿)。 */
  bv?: string;
  /** 结果不确定的段号(append 失败但可能已提交)—— 转人工,绝不自动重传。 */
  ambiguous?: number[];
  updatedAt: number;
}

function statePathFor(dir: string, sessionBase: string): string {
  // sidecar 必须与分段文件同目录(下一个会话/重启能读到);base 不含目录,需拼上 dirname。
  return join(dir, `${sessionBase}.rolling.json`);
}

function readState(dir: string, sessionBase: string): RollingState | null {
  try {
    return JSON.parse(readFileSync(statePathFor(dir, sessionBase), "utf-8")) as RollingState;
  } catch {
    return null;
  }
}

function writeState(dir: string, s: RollingState): void {
  try {
    writeFileSync(statePathFor(dir, s.sessionBase), JSON.stringify(s), "utf-8");
  } catch {
    /* sidecar 写失败不影响上传(仅影响重启幂等,不静默改上传行为) */
  }
}

export interface RollingUploaderOpts {
  /** 房间身份(删源证据用)。 */
  room: { platform: string; roomSlug: string };
  /**
   * 由会话 base 推 streamKey(默认 `{platform}:{roomSlug}:{YYYY-MM-DD}`,日期取会话 base 里的
   * 时间戳 —— 与 master 的 streamKey 口径一致)。仅用于 sidecar 记录,不参与删源判定。
   */
  streamKeyOf?: (sessionBase: string) => string;
  /** 建稿/上传用的标题与 metadata(来自 hub 规则 upload / hub.config uploadDefaults)。 */
  uploadMeta: {
    tag: string;
    tid: number;
    desc?: string;
    titleTemplate?: string;
    submissionTitleTemplate?: string;
  };
  timeZone?: string;
  /** 缺省 true(仅自己可见);false = 公开。 */
  uploadPrivate?: boolean;
  /** biliup cookies 路径;缺省 env/数据根默认。 */
  cookies?: string;
  /** 收尾后最后一段的封口宽限(ms)。缺省 {@link DEFAULT_SEAL_GRACE_MS}。 */
  sealGraceMs?: number;
  /** 限流闸门;缺省按节点本地库装配(与节点侧上传同一账号键)。 */
  gate?: UploadGate;
  log?: (msg: string) => void;
  /** 上传接缝(测试注入)。 */
  uploadPlainRaw?: typeof uploadPlain;
  appendGroupRaw?: typeof appendGroup;
  /** 删源接缝(测试注入);缺省 fs.rm。返回是否删除成功。 */
  removeFile?: (p: string) => boolean;
  /** 时间源(测试注入)。 */
  now?: () => number;
}

/**
 * 边录边传执行器(一个会话一个实例)。调用方:
 *   - `onSegment(path)` → {@link noteSegment} 记录段序 + 触发一次 {@link flush}(fire-and-forget);
 *   - 会话收尾 → `await flush({ recordingActive:false })` 处理最后一段并等上传完成;
 *   - 建稿 BV 经 {@link bv} 暴露,供调用方回传 master(可选)。
 */
export class RollingUploader {
  private readonly o: RollingUploaderOpts;
  private readonly log: (m: string) => void;
  private readonly gate: UploadGate;
  private readonly accountKey: string;
  private readonly now: () => number;
  /** 段文件所在目录(首个段确定;sidecar 写在这里)。 */
  private segDir = "";
  private state: RollingState;
  /** 段路径 → 段号(按首次上报顺序)。 */
  private readonly indexByPath = new Map<string, number>();
  /** 串行链:同一会话的上传/删除严格串行(防并发 append 撞稿 + 防重入)。 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 会话第一段写入时刻(epoch ms)—— 标题 `{HH}-{mm}-{ss}` 用它,避免用上传时刻漂移。 */
  private firstSegMtimeMs = 0;

  constructor(o: RollingUploaderOpts) {
    this.o = o;
    this.log = o.log ?? ((m: string): void => console.error(m));
    this.now = o.now ?? Date.now;
    const cookiesPath = o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
    this.gate = o.gate ?? openNodeUploadGate({ warn: this.log });
    this.accountKey = resolveUploadAccountKey(cookiesPath);
    this.segDir = "";
    // 初始 state 占位;真正的 sessionBase 由首个段确定(见 noteSegment)。
    this.state = { streamKey: "", sessionBase: "", segments: [], confirmed: [], updatedAt: this.now() };
  }

  /**
   * 记录一个分段(按 `onSegment` 触发顺序分配段号)。**首个段确定会话 base**,
   * 并从磁盘回读该会话的 sidecar(进程重启幂等)。
   */
  noteSegment(filePath: string): number {
    // 会话 base + sidecar 必须先加载(重建 indexByPath),再查「本路径是否已分过号」——
    // 顺序颠倒会让重启后同一路径被当新段,分到已确认段号之外的号 → 重复上传该段(丢幂等)。
    if (!this.state.sessionBase) {
      const dir = path.dirname(filePath);
      const base = segmentSessionBase(path.basename(filePath)) ?? path.basename(filePath).replace(/\.(ts|flv)$/i, "");
      const loaded = readState(dir, base);
      this.state = loaded ?? {
        streamKey: this.o.streamKeyOf?.(base) ?? `${this.o.room.platform}:${this.o.room.roomSlug}:${base}`,
        sessionBase: base,
        segments: [],
        confirmed: [],
        updatedAt: this.now(),
      };
      // 从持久化状态重建「路径 → 段号」映射(重启后段号续号,不漏传、不重复建稿)。
      for (const s of this.state.segments ?? []) {
        if (s && typeof s.path === "string" && typeof s.index === "number") this.indexByPath.set(s.path, s.index);
      }
      this.segDir = dir;
    }
    const existing = this.indexByPath.get(filePath);
    if (existing != null) return existing;
    if (this.firstSegMtimeMs === 0) {
      try { this.firstSegMtimeMs = statSync(filePath).mtimeMs; } catch { this.firstSegMtimeMs = this.now(); }
    }
    // 段号单调递增(不能复用已确认段号):取当前最大值 +1。
    const idx = this.indexByPath.size === 0 ? 0 : Math.max(...this.indexByPath.values()) + 1;
    this.indexByPath.set(filePath, idx);
    this.state = {
      ...this.state,
      segments: [...(this.state.segments ?? []), { index: idx, path: filePath }],
      updatedAt: this.now(),
    };
    writeState(this.segDir, this.state);
    return idx;
  }

  /** 当前 BV(建稿后;诊断/回传用)。 */
  get bv(): string | undefined { return this.state.bv; }
  /** 已确认段号(诊断/测试)。 */
  get confirmedIndices(): number[] { return [...this.state.confirmed]; }
  /** 结果不确定段号(转人工;诊断/测试)。 */
  get ambiguousIndices(): number[] { return [...(this.state.ambiguous ?? [])]; }

  /**
   * 处理当前已知分段:算封口段 → 上传未确认者 → 确认后删该段源视频。
   * 同一会话的调用严格串行(chain),可并发安全触发(如 onSegment 与收尾同时)。
   */
  flush(input: { recordingActive: boolean }): Promise<{ uploaded: number[]; deleted: string[]; ambiguous: number[] }> {
    const run = this.chain.then(
      () => this._flush(input.recordingActive),
      () => this._flush(input.recordingActive),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async _flush(recordingActive: boolean): Promise<{ uploaded: number[]; deleted: string[]; ambiguous: number[] }> {
    const nowMs = this.now();
    const rolling: RollingSegment[] = [...this.indexByPath.entries()].map(([p, index]) => {
      let mtimeMs = 0;
      try { mtimeMs = statSync(p).mtimeMs; } catch { mtimeMs = 0; }
      return { path: p, index, mtimeMs };
    });
    const confirmed = new Set(this.state.confirmed);
    const ambiguous = new Set(this.state.ambiguous ?? []);
    const pending = planRollingUploads(rolling, {
      recordingActive, nowMs, sealGraceMs: this.o.sealGraceMs ?? DEFAULT_SEAL_GRACE_MS,
    }, confirmed).filter((s) => !ambiguous.has(s.index));

    const uploaded: number[] = [];
    const deleted: string[] = [];
    for (const seg of pending) {
      // 不确定段绝不重传(可能已提交分 P)。
      if (ambiguous.has(seg.index) || confirmed.has(seg.index)) continue;
      try {
        await this.uploadSegment(seg);
        confirmed.add(seg.index);
        this.state = { ...this.state, confirmed: [...confirmed], updatedAt: this.now() };
        writeState(this.segDir, this.state);
        uploaded.push(seg.index);
        if (this.deleteConfirmedSource(seg, confirmed)) deleted.push(seg.path);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // 结果不确定(限流重试耗尽 / 网络) → 转人工:保留源,记 ambiguous,不自动重传。
        ambiguous.add(seg.index);
        this.state = { ...this.state, ambiguous: [...ambiguous], updatedAt: this.now() };
        writeState(this.segDir, this.state);
        this.log(`[rolling] 段 ${seg.index} 上传失败/不确定,保留源并转人工(不自动重传): ${msg.slice(0, 200)}`);
      }
    }
    return { uploaded, deleted, ambiguous: [...ambiguous] };
  }

  /** 上传一个封口段:P1(无 bv)建稿 → 落 BV;其余 append。 */
  private async uploadSegment(seg: RollingSegment): Promise<void> {
    const cookies = this.o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
    const meta = {
      cookies,
      tag: this.o.uploadMeta.tag,
      tid: this.o.uploadMeta.tid,
      desc: this.o.uploadMeta.desc,
      public: this.o.uploadPrivate === false,
    };
    if (!this.state.bv) {
      const base = segmentSessionBase(path.basename(seg.path)) ?? this.state.sessionBase;
      // startMs 用**会话第一段写入时刻**(不是上传时刻):`{HH}-{mm}-{ss}` 渲染才与文件名一致。
      const startMs = this.firstSegMtimeMs || this.now();
      const stem = resolveOutputStem({
        template: this.o.uploadMeta.titleTemplate,
        sessionBase: base,
        startMs,
        timeZone: this.o.timeZone,
      });
      const subTpl = (this.o.uploadMeta.submissionTitleTemplate ?? "").trim();
      const title = subTpl ? formatBiliTitle(subTpl, { sessionBase: base, startMs, timeZone: this.o.timeZone }) : stem;
      const up = this.o.uploadPlainRaw ?? uploadPlain;
      const bv = await this.gate.run(this.accountKey, () => up({ plain: { ...meta, video: seg.path, title } }));
      this.state = { ...this.state, bv, updatedAt: this.now() };
      writeState(this.segDir, this.state);
      this.log(`[rolling] 段 ${seg.index} 建稿 BV=${bv}`);
      return;
    }
    const ap = this.o.appendGroupRaw ?? appendGroup;
    await this.gate.run(this.accountKey, () => ap({ ...meta, bv: this.state.bv!, files: [seg.path] }));
    this.log(`[rolling] 段 ${seg.index} append 到 ${this.state.bv}`);
  }

  /**
   * 删除该段**源视频**(仅当 core 的删源三重证据齐备:封口 + 已确认 + 房间身份一致)。
   * `.xml`/`.ass` 不在此路径(绝不删弹幕源)。
   */
  private deleteConfirmedSource(seg: RollingSegment, confirmed: ReadonlySet<number>): boolean {
    const evidence = {
      sealed: true, // 仅由 _flush 对「已封口」段调用
      ack: confirmed.has(seg.index),
      segmentRoom: this.o.room,
      targetRoom: this.o.room,
    };
    if (!canDeleteRollingSource(evidence)) {
      this.log(`[rolling] 段 ${seg.index} 删源证据不足,保留源`);
      return false;
    }
    const remove = this.o.removeFile ?? ((p: string): boolean => { rmSync(p, { force: true }); return true; });
    try {
      if (remove(seg.path)) {
        this.log(`[rolling] 已删封口且确认的源段: ${path.basename(seg.path)}`);
        return true;
      }
      return false;
    } catch (e) {
      this.log(`[rolling] 删源失败(保留): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return false;
    }
  }
}

/** 从 hub 全局配置解析上传 metadata(与 cli 的 resolveCfg 同口径:规则 upload > hub.config uploadDefaults)。 */
function resolveRollingUploadMeta(
  platform: string,
  roomSlug: string,
): { meta: RollingUploaderOpts["uploadMeta"]; private: boolean } {
  // hub 规则(现读不缓存;无规则/坏 JSON → null):只有规则**显式** upload 时才走边录边传的 metadata。
  const rule = getHubRule(rootHubDir(), hubKey(platform, roomSlug));
  let uploadDefaults: {
    tag?: string; tid?: number; desc?: string; titleTemplate?: string; submissionTitleTemplate?: string;
  } = {};
  try {
    const raw = JSON.parse(readFileSync(rootHubConfig(), "utf-8")) as {
      uploadDefaults?: typeof uploadDefaults;
    };
    uploadDefaults = raw.uploadDefaults ?? {};
  } catch {
    /* 无 hub.config → 用规则/内置默认 */
  }
  const up = rule?.pipeline?.upload;
  return {
    meta: {
      tag: up?.tag || uploadDefaults.tag || "直播,录像",
      tid: up?.tid ?? uploadDefaults.tid ?? 21,
      desc: up?.desc ?? uploadDefaults.desc,
      titleTemplate: (up?.titleTemplate ?? "").trim() || uploadDefaults.titleTemplate,
      submissionTitleTemplate: (up?.submissionTitleTemplate ?? "").trim() || uploadDefaults.submissionTitleTemplate,
    },
    // 可见性:规则 upload.private 缺省 true(= 仅自己可见)。**保守默认 true**(公开是不可逆的曝光)。
    private: up?.private !== false,
  };
}

/**
 * **装配边录边传钩子工厂**(供 `record` 子命令 / serve 注入 session)。
 *
 * 语义:任务 `rollingUpload=true` 时返回一个工厂,每次 `_startInner` 造一个**本会话专属**的
 * {@link RollingUploader} 钩子;否则返回 undefined(**完全不启用**,行为不变)。
 *
 * 为什么在 app 而非 cli:metadata 来自 hub 规则 + hub.config(文件),app 已有 hub-store/paths,
 * 且 manager(录制端)只认 `makeRolling` 接口 —— 上传/删源实现全在 app,manager 零依赖。
 *
 * ⚠️ **多节点重复投稿**:边录边传是**录制节点自己**建稿,多节点同录一个房间会各建一个稿
 * (B 站不可逆)。闸门**必须在 master 下发时**判定(worker 节点上没有 hub 规则文件,判不了):
 * 见 cli 的 `desiredFor` —— 仅当该房间选中**恰好 1 个** worker 时才把 `rollingUpload: true`
 * 下发。本工厂只信 `o.enabled`(已由 master 收窄),不在此重复判定。
 */
export function makeRollingUploadHookFactory(o: {
  enabled: boolean;
  platform: string;
  roomSlug: string;
  timeZone?: string;
  uploadPrivate?: boolean;
  cookies?: string;
  sealGraceMs?: number;
  log?: (msg: string) => void;
  uploadPlainRaw?: typeof uploadPlain;
  appendGroupRaw?: typeof appendGroup;
  removeFile?: (p: string) => boolean;
  now?: () => number;
  gate?: UploadGate;
}): (() => RollingUploadHook) | undefined {
  if (!o.enabled) return undefined;
  // 跨节点重复投稿闸门(本机/master 侧现读 hub 规则;见 core.rollingUploadSingleNode 注释):
  //   - 本机 local 录制:能读到 hub 规则 → 规则勾选恰好 1 个节点(或无规则=单机)才允许;
  //   - 远端 worker:节点上**没有** hub 规则文件 → `getHubRule` 返回 null → 视为「无规则」放行,
  //     但那是安全的 —— master 下发时已按同一闸门收窄过 `enabled`(远端拿到 true 才可能到这里)。
  const rule = getHubRule(rootHubDir(), hubKey(o.platform, o.roomSlug));
  if (!rollingUploadSingleNode(rule != null, rule?.workers)) {
    (o.log ?? ((m: string) => console.error(m)))(
      `[rolling] 边录边传未启用:hub 规则选了 ${rule?.workers?.length ?? 0} 个节点(= 全部或多节点),多节点各建稿会重复投稿 → 回落整场管线`,
    );
    return undefined;
  }
  return () => {
    const { meta, private: isPrivate } = resolveRollingUploadMeta(o.platform, o.roomSlug);
    const uploader = new RollingUploader({
      room: { platform: o.platform, roomSlug: o.roomSlug },
      uploadMeta: meta,
      timeZone: o.timeZone,
      uploadPrivate: o.uploadPrivate ?? isPrivate,
      cookies: o.cookies,
      sealGraceMs: o.sealGraceMs,
      log: o.log,
      uploadPlainRaw: o.uploadPlainRaw,
      appendGroupRaw: o.appendGroupRaw,
      removeFile: o.removeFile,
      now: o.now,
      gate: o.gate,
    });
    return {
      onSegment: (p: string): void => {
        uploader.noteSegment(p);
        // 每产生新段 → 尝试处理:新段存在即意味着**旧段已封口**(滚动即封口)。fire-and-forget,
        // 不阻塞录制;串行链保证同一会话不并发上传。失败/不确定在 uploader 内部转人工(保留源)。
        void uploader.flush({ recordingActive: true }).catch(() => undefined);
      },
      onSessionEnd: (): Promise<void> => uploader.flush({ recordingActive: false }).then(() => undefined),
    };
  };
}
