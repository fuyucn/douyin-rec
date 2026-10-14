/**
 * rolling-upload.ts — 「边录边传」录制端执行体(T-33,见 plans/031;#57 R2 清单 v3 + 启动接管)。
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
 * 进度清单 `{sessionBase}.rolling.json`(v3,判定在 core/rolling-manifest):
 *   - segs 逐段状态机(open→sealed→uploading→acked→sourceDeleted;ambiguous/needs_manual/skipped),
 *     旧字段(segments/confirmed/ambiguous/uploading)每次写由 segs 派生镜像,旧主控/旧节点包照常读;
 *   - intent:上传动作前先写意图(含 attemptId),进程被杀后凭它回读核对;
 *   - lease:pid + until + holder,心跳续期;接管只在租约过期或 pid 不存在时发生,写前复核租约防双写;
 *   - 读取区分「不存在」与「损坏」:损坏 = 不可信,转人工并通知,**绝不当新会话**(防重复建稿)。
 *
 * ⚠️ 为什么按**会话**隔离:断流重连会产生新会话(新文件名 base)+ 新 xml;不同会话的段各自独立
 * 建稿/append,绝不跨会话混在一起(与 orchestrator 的「分 P 只能属于一个会话」同口径)。
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
  blockedIndices,
  canDeleteRollingSource,
  confirmedIndices as confirmedOf,
  decideIntentSettlement,
  formatBiliTitle,
  headOfLineFilter,
  LEASE_HEARTBEAT_MS,
  LEASE_MS,
  planRollingUploads,
  READBACK_GAP_MS,
  resolveOutputStem,
  sealedSegmentIndices,
  segmentSessionBase,
  setSegStatus,
  UploadGate,
  type Readback,
  type RollingLease,
  type RollingManifest,
  type RollingSegment,
  type SegStatus,
} from "@drec/core";
import { appendGroup, countVideoParts, uploadPlain } from "./upload/biliup.js";
import { rootBiliupCookies } from "./paths.js";
import { openNodeUploadGate, resolveUploadAccountKey } from "./node-pipeline.js";
import { getHubRule, hubKey } from "./hub-store.js";
import { rootHubConfig, rootHubDir } from "./paths.js";
import { pidAlive as realPidAlive, readManifestFile, writeManifestAtomic } from "./rolling-manifest-io.js";
import type { RollingUploadHook } from "@drec/manager";

/** 碎片段阈值:预计时长低于该秒数的封口段不上传(默认 2s,源保留)。 */
const DEFAULT_MIN_SEGMENT_SEC = 2;
/** 停止路径等最后一段上传的上限;超时后进程退出,意图/租约留盘,下次启动接管。 */
const STOP_WAIT_MS = 60_000;

/**
 * 进程内存活的上传器:`dir\0base` → 持有者 holder。同进程内判定「租约是否有效」以它为准
 * (pid 相同无法区分死活;被 {@link RollingUploader.abandon} / close 的实例不在表中 = 已死)。
 */
const LIVE = new Map<string, string>();
const liveKey = (dir: string, base: string): string => `${dir}\u0000${base}`;
export function isRollingSessionLive(dir: string, base: string): boolean {
  return LIVE.has(liveKey(dir, base));
}

export interface RollingUploaderOpts {
  /** 房间身份(删源证据用)。 */
  room: { platform: string; roomSlug: string };
  /**
   * 由会话 base 推 streamKey(默认 `{platform}:{roomSlug}:{YYYY-MM-DD}`,日期取会话 base 里的
   * 时间戳 —— 与 master 的 streamKey 口径一致)。仅用于清单记录,不参与删源判定。
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
  /** 封口段「预计时长」低于该秒数 → 不上传(碎片段;源保留,不阻塞后续段)。默认 2。 */
  minSegmentSec?: number;
  /** 分 P 数查询接缝(append 幂等核对 / 崩溃恢复 / 接管回读);缺省 {@link countVideoParts}。 */
  countPartsRaw?: (bv: string, cookies: string) => Promise<number | null>;
  /** 限流闸门;缺省按节点本地库装配(与节点侧上传同一账号键)。 */
  gate?: UploadGate;
  log?: (msg: string) => void;
  /** 转人工 / 清单损坏 / 租约丢失等**必须通知**的事件(站内 + webhook);缺省只打日志。 */
  notify?: (stage: string, message: string) => void;
  /** 上传接缝(测试注入)。 */
  uploadPlainRaw?: typeof uploadPlain;
  appendGroupRaw?: typeof appendGroup;
  /** 删源接缝(测试注入);缺省 fs.rm。返回是否删除成功。 */
  removeFile?: (p: string) => boolean;
  /** 时间源(测试注入)。 */
  now?: () => number;
  /** 回读核对的最小间隔(ms,缺省 3 分钟,容忍 B 站延迟);测试注入 0。 */
  readbackGapMs?: number;
  /** 睡眠接缝(回读间隔);缺省 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** pid 存活判定接缝(测试注入);缺省 kill(pid,0)。 */
  pidAlive?: (pid: number) => boolean;
  leaseMs?: number;
  heartbeatMs?: number;
  /** 新会话加入第一段时是否扫描同目录同房间的兄弟清单并接管(缺省 true)。 */
  takeoverSiblings?: boolean;
  /** 接管模式:只续传到已有稿件号,**绝不建稿**(内部用)。 */
  takeover?: boolean;
}

/**
 * 边录边传执行器(一个会话一个实例)。调用方:
 *   - `onSegment(path)` → {@link noteSegment} 记录段序 + 触发一次 {@link flush}(fire-and-forget);
 *   - 会话收尾 → {@link endSession}(重连:封口落盘即返回、上传后台继续;停止:有限等待);
 *   - 启动接管 → {@link runTakeover}(只续传到已有稿件号)。
 */
export class RollingUploader {
  private readonly o: RollingUploaderOpts;
  private readonly log: (m: string) => void;
  private readonly gate: UploadGate;
  private readonly accountKey: string;
  private readonly now: () => number;
  private readonly minSegmentSec: number;
  private readonly holder = randomUUID();
  private readonly allowCreate: boolean;
  private readonly readbackGapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pidAliveFn: (pid: number) => boolean;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  /** 段文件所在目录(首个段确定;清单写在这里)。 */
  private segDir = "";
  private m: RollingManifest;
  /** 段路径 → 段号(按首次上报顺序)。 */
  private readonly indexByPath = new Map<string, number>();
  /** 串行链:同一会话的上传/删除严格串行(防并发 append 撞稿 + 防重入)。 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 会话第一段写入时刻(epoch ms)—— 标题 `{HH}-{mm}-{ss}` 用它,避免用上传时刻漂移。 */
  private firstSegMtimeMs = 0;
  /** 清单写失败 / 损坏 / 租约丢失 → true:停止上传/删源(保留源,状态不可信,转人工)。 */
  private stateUntrusted = false;
  /** 从磁盘读到「已确认」段 → 恢复后补删「确认了但没删成」(崩溃窗口)的源。 */
  private needsConfirmCleanup = false;
  /** 崩溃恢复只应跑一次(读盘所得状态一次性结算,避免重复 query 分 P 数)。 */
  private recoveryDone = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;
  private dirSyncWarned = false;
  private siblingScanStarted = false;
  private siblingScan: Promise<unknown> | undefined;
  /** load() 被拒的原因:清单损坏 / 租约被占(接管据此区分上报)。 */
  private blockedBy: "corrupt" | "lease" | undefined;

  constructor(o: RollingUploaderOpts) {
    this.o = o;
    this.log = o.log ?? ((m: string): void => console.error(m));
    this.now = o.now ?? Date.now;
    this.minSegmentSec = Math.max(0, o.minSegmentSec ?? DEFAULT_MIN_SEGMENT_SEC);
    this.allowCreate = !o.takeover;
    this.readbackGapMs = Math.max(0, o.readbackGapMs ?? READBACK_GAP_MS);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pidAliveFn = o.pidAlive ?? realPidAlive;
    this.leaseMs = o.leaseMs ?? LEASE_MS;
    this.heartbeatMs = o.heartbeatMs ?? LEASE_HEARTBEAT_MS;
    const cookiesPath = o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
    this.gate = o.gate ?? openNodeUploadGate({ warn: this.log });
    this.accountKey = resolveUploadAccountKey(cookiesPath);
    // 初始占位;真正的 sessionBase 由首个段确定(见 noteSegment)/ 接管(见 runTakeover)。
    this.m = { schemaVersion: 3, streamKey: "", sessionBase: "", segs: [], updatedAt: this.now() };
  }

  /** 状态不可信:停止一切自动动作并**明示 + 通知**(不静默)。 */
  private distrust(msg: string): void {
    this.stateUntrusted = true;
    this.stopHeartbeat();
    this.log(`[rolling] ⚠️ ${msg}`);
    try { this.o.notify?.("边录边传", msg); } catch { /* 通知失败不反噬 */ }
  }

  /** 需要人工介入的事件:日志 + 通知。 */
  private alert(msg: string): void {
    this.log(`[rolling] ⚠️ ${msg}`);
    try { this.o.notify?.("边录边传", msg); } catch { /* 通知失败不反噬 */ }
  }

  private freshManifest(base: string): RollingManifest {
    return {
      schemaVersion: 3,
      streamKey: this.o.streamKeyOf?.(base) ?? `${this.o.room.platform}:${this.o.room.roomSlug}:${base}`,
      sessionBase: base,
      room: this.o.room,
      segs: [],
      updatedAt: this.now(),
    };
  }

  /** 租约是否被「别的存活写者」持有。同进程以 LIVE 表为准,跨进程看 pid + 到期时间。 */
  private heldByOther(lease: RollingLease | undefined): boolean {
    if (!lease || lease.holder === this.holder || lease.until <= this.now()) return false;
    if (lease.pid === process.pid) return LIVE.get(liveKey(this.segDir, this.m.sessionBase)) === lease.holder;
    return this.pidAliveFn(lease.pid);
  }

  /**
   * 载入会话清单。返回 `blocked` = 状态不可信(损坏 / 租约被占),调用方不得上传/删源。
   * **不存在**才是全新会话;解析失败一律按损坏处理(绝不当新会话,否则会重复建稿)。
   */
  private load(dir: string, base: string): "fresh" | "loaded" | "blocked" {
    this.segDir = dir;
    const r = readManifestFile(dir, base);
    if (r.status === "corrupt") {
      this.m = this.freshManifest(base);
      this.blockedBy = "corrupt";
      this.distrust(`进度清单损坏(${r.reason}),按不可信转人工:不上传、不删源、不覆盖原文件(${base})`);
      return "blocked";
    }
    if (r.status === "missing") {
      this.m = this.freshManifest(base);
      LIVE.set(liveKey(dir, base), this.holder);
      return "fresh";
    }
    let m = r.manifest;
    this.m = m;
    if (this.heldByOther(m.lease)) {
      this.blockedBy = "lease";
      this.distrust(`进度清单租约被其它写者持有(pid=${m.lease?.pid},疑似仍在上传),本实例不写入、不上传(${base})`);
      return "blocked";
    }
    // 旧写者已死:正在写(open)的段一律视为已封口。
    for (const s of m.segs) if (s.status === "open") m = setSegStatus(m, s.index, "sealed");
    this.m = { ...m, room: m.room ?? this.o.room };
    LIVE.set(liveKey(dir, base), this.holder);
    return "loaded";
  }

  /**
   * 记录一个分段(按 `onSegment` 触发顺序分配段号)。**首个段确定会话 base**,
   * 并从磁盘回读该会话的清单(进程重启幂等),同时扫描同目录兄弟清单做接管。
   */
  noteSegment(filePath: string): number {
    // 会话 base + 清单必须先加载(重建 indexByPath),再查「本路径是否已分过号」——
    // 顺序颠倒会让重启后同一路径被当新段,分到已确认段号之外的号 → 重复上传该段(丢幂等)。
    if (!this.m.sessionBase) {
      const dir = path.dirname(filePath);
      const base = segmentSessionBase(path.basename(filePath)) ?? path.basename(filePath).replace(/\.(ts|flv)$/i, "");
      const res = this.load(dir, base);
      // 重启读回建稿时刻:标题时间锚定**会话首段**,不受「重启后先看到哪个段」影响。
      if (Number.isFinite(this.m.startMs) && (this.m.startMs ?? 0) > 0) this.firstSegMtimeMs = this.m.startMs as number;
      // 重启/换进程读到「已确认」段 → 需要补删「确认了但没删成」的源(崩溃窗口:确认后、删前被杀)。
      if (this.m.segs.some((s) => s.status === "acked")) this.needsConfirmCleanup = true;
      // 从持久化状态重建「路径 → 段号」映射(重启后段号续号,不漏传、不重复建稿)。
      for (const s of this.m.segs) if (s.path) this.indexByPath.set(s.path, s.index);
      if (res !== "blocked") this.kickSiblingScan(dir, base);
    }
    const existing = this.indexByPath.get(filePath);
    if (existing != null) return existing;
    if (this.firstSegMtimeMs === 0) {
      try { this.firstSegMtimeMs = statSync(filePath).mtimeMs; } catch { this.firstSegMtimeMs = this.now(); }
    }
    // 段号单调递增(不能复用已确认段号):取清单里最大段号 +1。
    const idx = this.m.segs.length === 0 ? 0 : Math.max(...this.m.segs.map((s) => s.index)) + 1;
    this.indexByPath.set(filePath, idx);
    this.m = {
      ...this.m,
      segs: [...this.m.segs, { index: idx, path: filePath, status: "open" }],
      // 首段时刻一旦确定就落盘(此后不覆盖):崩溃恢复的建稿标题必须用原始开播时刻。
      startMs: this.m.startMs ?? (Number.isFinite(this.firstSegMtimeMs) && this.firstSegMtimeMs > 0 ? this.firstSegMtimeMs : this.now()),
    };
    this.persist();
    return idx;
  }

  /** 新会话加入第一段:后台扫描同目录同房间的兄弟清单并接管(fire-and-forget;失败只记日志)。 */
  private kickSiblingScan(dir: string, selfBase: string): void {
    if (this.siblingScanStarted || this.o.takeover || this.o.takeoverSiblings === false) return;
    this.siblingScanStarted = true;
    this.siblingScan = import("./rolling-takeover.js")
      .then((t) => t.takeoverSessionsInDir(dir, {
        selfBase,
        room: this.o.room,
        makeOpts: (room) => ({ ...this.o, room, takeover: true, takeoverSiblings: false }),
        now: this.o.now,
        pidAlive: this.o.pidAlive,
        log: this.log,
        notify: this.o.notify,
      }))
      .catch((e) => this.log(`[rolling] 兄弟会话接管扫描失败(忽略,不影响录制): ${String((e as Error)?.message ?? e).slice(0, 200)}`));
  }

  /** 当前 BV(建稿后;诊断/回传用)。 */
  get bv(): string | undefined { return this.m.bv; }
  /** 已确认段号(诊断/测试)。 */
  get confirmedIndices(): number[] { return confirmedOf(this.m); }
  /** 结果不确定 / 转人工段号(诊断/测试)。 */
  get ambiguousIndices(): number[] { return blockedIndices(this.m); }
  /** 兄弟会话接管扫描的完成信号(测试/诊断;未触发 = undefined)。 */
  get siblingTakeover(): Promise<unknown> | undefined { return this.siblingScan; }
  /** 清单快照(诊断/测试)。 */
  get manifest(): RollingManifest { return this.m; }

  private stopHeartbeat(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat || this.closed || this.stateUntrusted) return;
    this.heartbeat = setInterval(() => {
      if (this.closed || this.stateUntrusted) { this.stopHeartbeat(); return; }
      this.persist(); // 只续租约;写前复核租约,被接管则自停
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  /**
   * 原子写清单(WAL 语义):复核租约 → 临时文件 + fsync + rename + 目录 fsync。失败**不静默**:
   * 置 `stateUntrusted`(保留源、停止自动上传/删源,转人工)并打日志 + 通知。
   */
  private persist(): boolean {
    if (this.stateUntrusted) return false;
    // 防御:还没上报过任何分段就没有 sessionBase → 没有可写的清单路径(拼出来会落到进程 cwd
    // 的 `.rolling.json`)。此时无事可持久化,直接跳过,绝不写脏文件。
    if (!this.m.sessionBase || !this.segDir) return true;
    const nowMs = this.now();
    // 写前复核:盘上租约若已被别的存活写者持有(我们被判过期而遭接管)→ 立即停手,防双写。
    const disk = readManifestFile(this.segDir, this.m.sessionBase);
    if (disk.status === "corrupt") {
      this.distrust(`写前复核发现进度清单损坏(${disk.reason}),停止上传并保留源(转人工)`);
      return false;
    }
    if (disk.status === "ok" && this.heldByOther(disk.manifest.lease)) {
      this.distrust(`进度清单租约已被其它写者接管(pid=${disk.manifest.lease?.pid}),本实例停止写入/上传并保留源`);
      return false;
    }
    this.m = {
      ...this.m,
      lease: this.closed ? undefined : { pid: process.pid, until: nowMs + this.leaseMs, holder: this.holder },
    };
    try {
      const { dirSynced } = writeManifestAtomic(this.segDir, this.m.sessionBase, this.m, nowMs);
      if (!dirSynced && !this.dirSyncWarned) {
        this.dirSyncWarned = true;
        this.log(`[rolling] 目录 fsync 失败(清单已 rename,持久性依赖文件系统): ${this.segDir}`);
      }
    } catch (e) {
      const target = path.join(this.segDir, `${this.m.sessionBase}.rolling.json`);
      this.distrust(
        `sidecar 原子写失败(${target}),会话幂等状态不可信 → 停止自动上传并保留源(转人工): ` +
        String((e as Error)?.message ?? e).slice(0, 200),
      );
      return false;
    }
    this.ensureHeartbeat();
    return true;
  }

  /** 正常收尾:停心跳并释放租约(清单留盘供主控读取)。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    if (this.m.sessionBase && LIVE.get(liveKey(this.segDir, this.m.sessionBase)) === this.holder) {
      LIVE.delete(liveKey(this.segDir, this.m.sessionBase));
    }
    if (!this.stateUntrusted) this.persist();
  }

  /** 模拟/确知进程被杀:停心跳、退出 LIVE 表,**不**释放租约、不落盘(测试与异常路径用)。 */
  abandon(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.m.sessionBase && LIVE.get(liveKey(this.segDir, this.m.sessionBase)) === this.holder) {
      LIVE.delete(liveKey(this.segDir, this.m.sessionBase));
    }
  }

  /** 查询 BV 当前分 P 数(append 幂等核对 / 崩溃恢复 / 接管回读)。 */
  private countPartsInner(bv: string, cookies: string): Promise<number | null> {
    return (this.o.countPartsRaw ?? countVideoParts)(bv, cookies);
  }

  private cookiesPath(): string {
    return this.o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
  }

  private async readbackParts(): Promise<Readback> {
    const bv = this.m.bv;
    if (!bv) return { parts: null };
    try {
      return { parts: await this.gate.run(this.accountKey, () => this.countPartsInner(bv, this.cookiesPath())) };
    } catch {
      return { parts: null };
    }
  }

  /** 段状态转换(走 core 白名单,不强制写);`sealed` 先桥接到 `uploading`。 */
  private moveSeg(index: number, to: SegStatus, patch: { reason?: string; attempts?: number } = {}): void {
    const cur = this.m.segs.find((s) => s.index === index);
    if (cur?.status === "sealed" && (to === "acked" || to === "ambiguous")) this.m = setSegStatus(this.m, index, "uploading");
    this.m = setSegStatus(this.m, index, to, patch);
  }

  private clearIntent(): void {
    const { intent: _drop, ...rest } = this.m;
    void _drop;
    this.m = rest;
  }

  /**
   * **意图结算**(崩溃恢复 / 启动接管共用,判定表在 core `decideIntentSettlement`):
   * 读到 `intent`(进程在「开始上传 → 落结果」之间被杀)时回读分 P 数核对;
   * 「=已确认数」须**两次回读(间隔 ≥ readbackGapMs)一致**才放行续传;其余一律转人工,
   * 且**绝不自动建稿**。转人工必须日志 + 通知。
   */
  private async settleIntent(): Promise<void> {
    if (this.recoveryDone) return;
    const it = this.m.intent;
    if (!it) {
      this.recoveryDone = true;
      // uploading 段却无意图 = 状态不一致 → 保守转人工。
      for (const s of this.m.segs.filter((x) => x.status === "uploading")) {
        this.moveSeg(s.index, "needs_manual", { reason: "uploading 无意图(状态不一致)" });
        this.alert(`段 ${s.index} 处于 uploading 但无意图记录,转人工核对`);
      }
      if (this.m.segs.some((s) => s.status === "needs_manual")) this.persist();
      return;
    }
    this.recoveryDone = true;
    if (confirmedOf(this.m).includes(it.index)) {
      // 已在确认后、销标记前被杀:仅清标记,源由 needsConfirmCleanup 补删。
      this.clearIntent();
      this.persist();
      return;
    }
    const reads: Readback[] = [];
    let d = decideIntentSettlement(this.m, reads);
    while (d.action === "needMore") {
      if (reads.length > 0) await this.sleep(this.readbackGapMs);
      if (this.stateUntrusted) return; // 睡眠期间租约被夺 / 清单损坏 → 不再动作
      reads.push(await this.readbackParts());
      d = decideIntentSettlement(this.m, reads);
    }
    if (this.stateUntrusted) return;
    if (d.action === "ack") {
      this.moveSeg(it.index, "acked");
      this.clearIntent();
      this.needsConfirmCleanup = true;
      this.persist();
      this.log(`[rolling] 恢复:段 ${it.index} 上次 append 已提交(回读分P数=已确认+1),补确认`);
    } else if (d.action === "resume") {
      this.moveSeg(it.index, "sealed");
      this.clearIntent();
      this.persist();
      this.log(`[rolling] 恢复:段 ${it.index} 上次 append 未提交(两次回读一致),安全续传`);
    } else if (d.action === "manual") {
      this.moveSeg(it.index, "needs_manual", { reason: d.reason });
      this.clearIntent();
      this.persist();
      this.alert(`恢复:段 ${it.index} 需人工核对(${d.reason}),保留源、不自动重传、不重建稿`);
    }
  }

  /**
   * 判断封口段是否为「碎片段」(时长小于 {@link minSegmentSec})。
   * 时长用「本段 mtime − 上一段 mtime」近似(上一段关闭 ≈ 本段开始)。段 0 无前驱 → 恒非碎片
   * (P1 必传)。碎片段不上传、不删、不阻塞后续段(内容缺口极小,交给人工)。
   */
  private isFragment(seg: RollingSegment, rolling: readonly RollingSegment[]): boolean {
    if (this.minSegmentSec <= 0 || seg.index === 0) return false;
    const prev = rolling.find((s) => s.index === seg.index - 1);
    if (!prev || prev.mtimeMs <= 0 || seg.mtimeMs <= prev.mtimeMs) return false;
    return seg.mtimeMs - prev.mtimeMs < this.minSegmentSec * 1000;
  }

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

  /**
   * 会话收尾:**同步封口并落盘**(open→sealed 写进清单),随后最后一轮上传在后台串行链里继续。
   *   - `wait=false`(断流重连):封口落盘即返回,不等上传 —— 直播不因上传耽误重连丢画面;
   *   - `wait=true`(停止):有限等待(`waitMs`),超时后进程退出,意图/租约留盘,下次启动接管。
   * 调用契约:录制进程已退出(manager 在 `await recorder.stop()` 之后才调),最后一段不再增长。
   */
  async endSession(o: { wait: boolean; waitMs?: number } = { wait: true }): Promise<void> {
    for (const s of this.m.segs) if (s.status === "open") this.m = setSegStatus(this.m, s.index, "sealed");
    this.persist();
    const run = this.flush({ recordingActive: false })
      .then(() => undefined)
      .catch((e) => this.log(`[rolling] 收尾上传抛错(已转人工/保留源): ${String((e as Error)?.message ?? e).slice(0, 200)}`))
      .finally(() => this.close());
    if (!o.wait) return;
    const limit = o.waitMs ?? STOP_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.log(`[rolling] 停止等待 ${Math.round(limit / 1000)}s 仍未传完:上传留待下次启动接管(清单已落盘意图/租约)`);
        resolve();
      }, limit);
      timer.unref?.();
    });
    await Promise.race([run, timeout]);
    if (timer) clearTimeout(timer);
  }

  /**
   * **启动接管**一个遗留会话(由 {@link takeoverSessionsInDir} 在确认租约可接管后调用):
   *   1. 读清单(损坏 → 转人工、不动文件);抢租约;
   *   2. 结算意图(回读核对,见 settleIntent);
   *   3. 有稿件号 → 按顺序续传到该稿件号(只 append,绝不建稿);
   *      无稿件号且无任何提交迹象 → 交主控常规管线(不动任何东西)。
   */
  async runTakeover(dir: string, base: string): Promise<{ outcome: "corrupt" | "blocked" | "handoff" | "resumed" | "manual" | "nothing"; uploaded: number[] }> {
    const res = this.load(dir, base);
    if (res === "blocked") return { outcome: this.blockedBy === "corrupt" ? "corrupt" : "blocked", uploaded: [] };
    if (res === "fresh") { this.abandon(); return { outcome: "nothing", uploaded: [] }; }
    for (const s of this.m.segs) if (s.path) this.indexByPath.set(s.path, s.index);
    if (this.m.startMs) this.firstSegMtimeMs = this.m.startMs;
    if (this.m.segs.some((s) => s.status === "acked")) this.needsConfirmCleanup = true;
    // 先抢租约(写前复核保证不与存活写者双写),再做任何外部动作。
    if (!this.persist()) return { outcome: "blocked", uploaded: [] };
    this.log(`[rolling] 接管遗留会话 ${base}(bv=${this.m.bv ? "有" : "无"},段=${this.m.segs.length})`);
    try {
      await this.chainRun(async () => { await this.settleIntent(); });
      if (this.stateUntrusted) return { outcome: "blocked", uploaded: [] };
      if (!this.m.bv) {
        const submitted = this.m.segs.some((s) => ["acked", "sourceDeleted", "ambiguous", "needs_manual", "uploading"].includes(s.status));
        const manual = this.m.segs.some((s) => s.status === "ambiguous" || s.status === "needs_manual");
        if (!submitted) {
          this.log(`[rolling] 接管 ${base}:无稿件号且所有段确定未提交 → 交主控常规管线(本机不建稿)`);
          return { outcome: "handoff", uploaded: [] };
        }
        return { outcome: manual ? "manual" : "nothing", uploaded: [] };
      }
      const r = await this.flush({ recordingActive: false });
      const manual = blockedIndices(this.m).length > 0;
      return { outcome: manual ? "manual" : "resumed", uploaded: r.uploaded };
    } finally {
      this.close();
    }
  }

  private chainRun<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async _flush(recordingActive: boolean): Promise<{ uploaded: number[]; deleted: string[]; ambiguous: number[] }> {
    const nowMs = this.now();
    if (this.stateUntrusted) {
      // 失败已在 distrust() 日志明示;此后不做任何上传/删源(保留源,转人工)。
      return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    }
    const rolling: RollingSegment[] = [...this.indexByPath.entries()].map(([p, index]) => {
      let mtimeMs = 0;
      try { mtimeMs = statSync(p).mtimeMs; } catch { mtimeMs = 0; }
      return { path: p, index, mtimeMs };
    });
    // 崩溃恢复:结算上次进程留下的意图(可能补确认 / 安全续传 / 转人工)。
    await this.settleIntent();
    if (this.stateUntrusted) return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    // 无稿件号且不允许建稿(接管模式):没有可续传的稿件,什么都不做。
    if (!this.allowCreate && !this.m.bv) return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    // 封口判定(唯一真理 = core.sealedSegmentIndices),grace 恒为 0:
    //   - 录制中:最新段**恒不封口**(只有「出现后继段」才封口),grace 根本不参与判定;
    //   - 收尾(recordingActive=false):调用方契约是**录制进程已退出** —— manager 在
    //     `await recorder.stop()`(SIGINT + 8s SIGKILL 兜底)之后才调收尾,最后一段不会再增长。
    //   ⚠️ 这里曾经沿用 `DEFAULT_SEAL_GRACE_MS`(3s):而「刚写完就收尾」的末段 mtime 距今 < 3s
    //   → 判不出封口 → **末段永不上传、源永残留**。收尾是一次性调用(不重试),宽限只有害处。
    const sealOpts = { recordingActive, nowMs, sealGraceMs: 0 };
    const sealed = sealedSegmentIndices(rolling, sealOpts);
    let sealChanged = false;
    for (const s of this.m.segs) {
      if (s.status === "open" && sealed.has(s.index)) { this.m = setSegStatus(this.m, s.index, "sealed"); sealChanged = true; }
    }
    if (sealChanged && !this.persist()) return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    const confirmed = new Set(confirmedOf(this.m));
    const blocked = new Set(blockedIndices(this.m));
    const statusOf = (i: number): SegStatus | undefined => this.m.segs.find((s) => s.index === i)?.status;
    const planned = planRollingUploads(rolling, sealOpts, confirmed);
    // 头阻塞:ambiguous/needs_manual 段及其后的段一律不外发(B 站 append 只能追加末尾,缺口不可逆)。
    // ⚠️ 必须在「只留 sealed」之前过滤:阻塞段自己不是 sealed,先剔除它会让头阻塞失效。
    const headBlocked = headOfLineFilter(planned, blocked).filter((s) => statusOf(s.index) === "sealed");
    const pending: RollingSegment[] = [];
    for (const s of headBlocked) {
      if (this.isFragment(s, rolling)) {
        this.m = setSegStatus(this.m, s.index, "skipped", { reason: `时长过短(< ${this.minSegmentSec}s)` });
        this.persist();
        this.log(`[rolling] 段 ${s.index} 时长过短(< ${this.minSegmentSec}s),不上传、保留源(转人工处理)`);
        continue;
      }
      pending.push(s);
    }

    const uploaded: number[] = [];
    const deleted: string[] = [];
    // 崩溃窗口补删:上次「确认后、删源前」被杀留下的源(幂等;仅重启后首轮执行)。
    if (this.needsConfirmCleanup) {
      this.needsConfirmCleanup = false;
      for (const s of rolling) {
        if (statusOf(s.index) === "acked" && confirmed.has(s.index) && sealed.has(s.index)) this.deleteConfirmedSource(s, confirmed, true);
      }
      // 重启后全部段都已封口(旧写者已死):未在本轮 rolling 里的 acked 段(路径已不在 indexByPath)无需处理。
    }
    for (const seg of pending) {
      try {
        // 成功时把「确认」并入**同一次**清单写(见 uploadSegment):
        // 避免「落 bv 后、再落 confirmed」之间崩溃 → 重启漏确认 → 重复 append。
        await this.uploadSegment(seg);
        uploaded.push(seg.index);
        confirmed.add(seg.index);
        if (this.deleteConfirmedSource(seg, confirmed, sealed.has(seg.index))) deleted.push(seg.path);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // 结果不确定(限流重试耗尽 / 网络) → 转人工:保留源,记 ambiguous,不自动重传。
        if (statusOf(seg.index) === "uploading") {
          this.m = setSegStatus(this.m, seg.index, "ambiguous", { reason: msg.slice(0, 120) });
          this.clearIntent();
          this.persist();
        }
        this.log(`[rolling] 段 ${seg.index} 上传失败/不确定,保留源并转人工(不自动重传): ${msg.slice(0, 200)}`);
        // **头阻塞**:段号升序处理,一旦第 k 段失败,之后所有段(>k)若继续上传将形成不可逆的空洞
        // (B 站 append 只能末尾追加,缺口补不回)。立即停下,等 k 结清。
        break;
      }
    }
    return { uploaded, deleted, ambiguous: this.ambiguousIndices };
  }

  /** 上传一个封口段:P1(无 bv)建稿 → 落 BV;其余 append。每次外发前先把意图写盘。 */
  private async uploadSegment(seg: RollingSegment): Promise<void> {
    const cookies = this.cookiesPath();
    // 可见性:清单里的策略快照优先(接管续传须与建稿时一致);否则取本次配置。
    const priv = this.m.policy?.private ?? this.o.uploadPrivate;
    const meta = {
      cookies,
      tag: this.o.uploadMeta.tag,
      tid: this.o.uploadMeta.tid,
      desc: this.o.uploadMeta.desc,
      // 边录边传默认「仅自己可见」(公开不可逆);唯一显式 override = hub 规则 upload.private:false。
      public: priv === false,
    };
    const attempts = (this.m.segs.find((s) => s.index === seg.index)?.attempts ?? 0) + 1;
    const intentOf = (kind: "create" | "append") => ({ attemptId: randomUUID(), kind, index: seg.index, startedAt: this.now() });
    if (!this.m.bv) {
      if (!this.allowCreate) throw new Error("接管模式禁止建稿");
      const base = segmentSessionBase(path.basename(seg.path)) ?? this.m.sessionBase;
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
      // WAL:先落「建稿中」意图 + 可见性策略快照,再真正建稿。崩溃后据此转人工,绝不自动重建稿(重复投稿不可逆)。
      this.m = setSegStatus(this.m, seg.index, "uploading", { attempts });
      this.m = { ...this.m, intent: intentOf("create"), policy: { private: priv !== false } };
      if (!this.persist()) throw new Error("sidecar 写失败(建稿意图),中止上传并保留源");
      const up = this.o.uploadPlainRaw ?? uploadPlain;
      const bv = await this.gate.run(this.accountKey, () => up({ plain: { ...meta, video: seg.path, title } }));
      // 把「当段已确认」并入同一次写:建稿成功即确认段 0,防止 bv 与确认分两次写之间崩溃。
      this.m = setSegStatus(this.m, seg.index, "acked");
      this.m = { ...this.m, bv };
      this.clearIntent();
      if (!this.persist()) throw new Error(`sidecar 写失败(建稿结果 BV=${bv}),状态不可信,保留源`);
      this.log(`[rolling] 段 ${seg.index} 建稿 BV=${bv}`);
      return;
    }
    const bv = this.m.bv;
    // WAL:先落「追加第 index 段中」意图。崩溃后凭分 P 数回读核对是否已提交(见 settleIntent)。
    this.m = setSegStatus(this.m, seg.index, "uploading", { attempts });
    this.m = { ...this.m, intent: intentOf("append") };
    if (!this.persist()) throw new Error("sidecar 写失败(append 意图),中止上传并保留源");
    const ap = this.o.appendGroupRaw ?? appendGroup;
    await this.gate.run(this.accountKey, () =>
      ap({
        ...meta,
        bv,
        files: [seg.path],
        // 幂等核对:失败后重查分 P 数,变多 = 其实已成功;查不到 → 抛 ambiguous 标记转人工。
        countParts: () => this.countPartsInner(bv, cookies),
      }),
    );
    // 与建稿同口径:确认并入同一次写,防止 append 成功后、补确认前崩溃导致重复 append。
    this.m = setSegStatus(this.m, seg.index, "acked");
    this.clearIntent();
    if (!this.persist()) throw new Error(`sidecar 写失败(append 结果段 ${seg.index}),状态不可信,保留源`);
    this.log(`[rolling] 段 ${seg.index} append 到 ${bv}`);
  }

  /**
   * 删除该段**源视频**(仅当 core 的删源三重证据齐备:封口 + 已确认 + 房间身份一致)。
   * `.xml`/`.ass` 不在此路径(绝不删弹幕源)。删成功 → 段状态 acked→sourceDeleted。
   */
  private deleteConfirmedSource(seg: RollingSegment, confirmed: ReadonlySet<number>, sealed: boolean): boolean {
    const evidence = {
      // 证据**派生自** core 的封口判定,绝不硬编码 true —— 硬编码一旦被将来的新调用点复用,
      // 就可能删掉「正在写」的段(不可逆)。调用方必须把当前轮的封口集合算出来传进来。
      sealed,
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
        const cur = this.m.segs.find((s) => s.index === seg.index);
        if (cur?.status === "acked") {
          this.m = setSegStatus(this.m, seg.index, "sourceDeleted");
          this.persist();
        }
        return true;
      }
      return false;
    } catch (e) {
      this.log(`[rolling] 删源失败(保留): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return false;
    }
  }
}

/** 读 `{base}.session.json` 里的房间身份(老 v2 清单没有 room 字段时的兜底)。 */
export function readSessionRoom(dir: string, base: string): { platform: string; roomSlug: string } | undefined {
  try {
    const j = JSON.parse(readFileSync(path.join(dir, `${base}.session.json`), "utf-8")) as { roomSlug?: unknown; platform?: unknown };
    if (typeof j.roomSlug === "string" && j.roomSlug) {
      return { platform: typeof j.platform === "string" && j.platform ? j.platform : "douyin", roomSlug: j.roomSlug };
    }
  } catch { /* 无 session.json / 坏文件 → 未知 */ }
  return undefined;
}

/** 列出目录下的清单会话 base(排除临时文件)。 */
export function listManifestBases(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((f) => /^(.+)\.rolling\.json$/.exec(f)?.[1])
      .filter((b): b is string => !!b);
  } catch {
    return [];
  }
}

/** 从 hub 全局配置解析上传 metadata(与 cli 的 resolveCfg 同口径:规则 upload > hub.config uploadDefaults)。 */
export function resolveRollingUploadMeta(
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
 * 语义:`enabled=true`(= 任务的**派生字段 `rollingEffective`**)时返回一个工厂,每次 `_startInner`
 * 造一个**本会话专属**的 {@link RollingUploader} 钩子;否则返回 undefined(**完全不启用**,行为不变)。
 *
 * 为什么在 app 而非 cli:metadata 来自 hub 规则 + hub.config(文件),app 已有 hub-store/paths,
 * 且 manager(录制端)只认 `makeRolling` 接口 —— 上传/删源实现全在 app,manager 零依赖。
 *
 * ⚠️ **判定不在这里**(issue #40):是否边录边传、以及「多节点重复投稿闸门」(边录边传是**录制节点
 * 自己**建稿,多节点同录一个房间会各建一稿,B 站不可逆)全部由 master 用 core `resolveRollingPolicy`
 * 一次算定,写进任务派生字段 `rollingEffective` 下发(见 cli 的 `desiredFor` 与 app 的
 * `refreshLocalRollingEffective`)。本工厂**只信 `o.enabled`**,不读 hub 规则做判定。
 * (上传 metadata 仍在 `resolveRollingUploadMeta` 读规则 —— 下发 metadata 属 S9,本 PR 未做。)
 */
export function makeRollingUploadHookFactory(o: {
  enabled: boolean;
  platform: string;
  roomSlug: string;
  timeZone?: string;
  uploadPrivate?: boolean;
  cookies?: string;
  minSegmentSec?: number;
  log?: (msg: string) => void;
  notify?: (stage: string, message: string) => void;
  uploadPlainRaw?: typeof uploadPlain;
  appendGroupRaw?: typeof appendGroup;
  countPartsRaw?: (bv: string, cookies: string) => Promise<number | null>;
  removeFile?: (p: string) => boolean;
  now?: () => number;
  gate?: UploadGate;
  readbackGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pidAlive?: (pid: number) => boolean;
}): (() => RollingUploadHook) | undefined {
  if (!o.enabled) return undefined;
  return () => {
    const { meta, private: isPrivate } = resolveRollingUploadMeta(o.platform, o.roomSlug);
    const uploader = new RollingUploader({
      room: { platform: o.platform, roomSlug: o.roomSlug },
      uploadMeta: meta,
      timeZone: o.timeZone,
      uploadPrivate: o.uploadPrivate ?? isPrivate,
      cookies: o.cookies,
      minSegmentSec: o.minSegmentSec,
      log: o.log,
      notify: o.notify,
      readbackGapMs: o.readbackGapMs,
      sleep: o.sleep,
      pidAlive: o.pidAlive,
      uploadPlainRaw: o.uploadPlainRaw,
      appendGroupRaw: o.appendGroupRaw,
      countPartsRaw: o.countPartsRaw,
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
      // 重连(wait=false):封口落盘即返回,上传后台继续;停止(默认):有限等待。
      onSessionEnd: (o?: { wait?: boolean; waitMs?: number }): Promise<void> =>
        uploader.endSession({ wait: o?.wait ?? true, waitMs: o?.waitMs }),
    };
  };
}
