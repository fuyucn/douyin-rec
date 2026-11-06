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
 * ⚠️ 会话隔离 + 同场续稿(#148):每个会话各有 sidecar/段号;但相邻会话间隔 <= `SAME_BROADCAST_GAP_MS`
 * 视为同一场断流重连,后会话从磁盘上的前序 sidecar 继承 BV 并 append(见 findPredecessor),
 * 不再另起稿件;前序状态不确定 → 不建稿不 append,转人工。间隔更大 = 新场次,照常建稿。
 *
 * 接管残段(#46):后继会话在**首次上传前**先接管前序会话留下的未确认分段(结算悬空意图 → 按段号 append →
 * 确认后删源),再传自己的段(分 P 顺序 = 前序在前)。前提 = 前序 owner 进程已退出(sidecar 记 ownerPid +
 * heartbeatAt;pid 存活 → 等待,不上传);前序末段需两次探测大小不变才算封口。
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path, { join } from "node:path";
import {
  canDeleteRollingSource,
  isSameBroadcast,
  isSameBroadcastGap,
  resolveSubmissionTitle,
  processTimeZone,
  zonedStamp,
  DEFAULT_TITLE_TEMPLATE,
  formatPartTitle,
  sanitizeStem,
  headOfLineFilter,
  planRollingUploads,
  resolveOutputStem,
  sealedSegmentIndices,
  segmentSessionBase,
  stripVideoExt,
  withFileLockSync,
  UploadGate,
  noteRecorderProgress,
  recorderIsFinalizing,
  isSlotBusy,
  SLOT_BUSY_MARKER,
  addArchiveToSeasonIfConfigured,
  seasonCheckpointState,
  resolveSeasonSectionId,
  isValidPartSizeMiB,
  type UploadSlot,
  type RollingSegment,
  type UploadOwner,
} from "@drec/core";
import { appendGroup, countVideoParts, uploadPlain, type BiliupHooks } from "./upload/biliup.js";
import { readTcpAckedAsync, type AckSample } from "@drec/processors";
import { rootBiliupCookies } from "./paths.js";
import { openNodeUploadGate, openNodeUploadSlot, resolveUploadAccountKey } from "./node-pipeline.js";

/** One node-wide upload slot per process; null when the node store cannot be opened (no coordination). */
let sharedSlot: UploadSlot | null | undefined;
export function sharedNodeUploadSlot(log?: (m: string) => void): UploadSlot | null {
  if (sharedSlot === undefined) sharedSlot = openNodeUploadSlot(log ? { log } : {});
  return sharedSlot;
}
import { getHubRule, hubKey } from "./hub-store.js";
import { rootHubConfig, rootHubDir } from "./paths.js";
import { effectiveHubConfig } from "./disk-gate.js";
import { sanitizePathSegment } from "@drec/record-engine";
import type { RollingUploadHook } from "@drec/manager";
// Plan 046 PR6 queue adapters (方案 A). No cycle: rolling-queue imports store/paths/node-enqueue only.
import {
  enqueueRollingUploadPart, enqueueRollingSkipPart, importRollingConfirmedPart, queueOrderHasRows,
  rollingQueueMaxSeq,
} from "./rolling-queue.js";

/** 一个会话的持久化确认状态(防重启后重复投稿)。 */
interface RollingState {
  /** sidecar schema 版本;老文件(0.0.82 之前)无此字段 = v1,读时兼容。 */
  schemaVersion?: number;
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
  /** plan 046 PR7: sealed parts whose upload is owned by the hub; source is retained for master. */
  hubSkipped?: number[];
  /** Plan 046 PR6: same-broadcast queue order key (all sessions of one broadcast share it). */
  queueOrderKey?: string;
  /**
   * Plan 046 PR6: same-broadcast key for a MASTER-owned session's skip rows. Local only: the master's
   * hold keys off queueOrderKey, which a hub-owned session must never write.
   */
  hubOrderKey?: string;
  /** Plan 046 PR6: first queue seq for this session (continues across same-broadcast sessions). */
  queueSeqBase?: number;
  /**
   * **WAL 意图标记**:开始上传前先落盘(`create` = P1 建稿中,`append` = 追加第 index 段中)。
   * 进程崩溃后凭它恢复:create 无 BV 可查 → 保守转人工(绝不自动重创建稿);append 用分 P 数核对。
   */
  uploading?: { index: number; kind: "create" | "append" };
  /**
   * 会话第一段写入时刻(epoch ms)。**必须持久化**:建稿标题里的 `{HH}-{mm}-{ss}` 用它渲染,
   * 若重启后按「本进程首个上报的段」现算(崩溃恢复常见:重启时只见尾段)→ 标题时间漂到收尾时刻,
   * 与文件名/实际开播时间不一致。老文件无此字段 → 回落现算(行为不变)。
   */
  startMs?: number;
  /** Room this session belongs to; lets a successor session recognise same-room sidecars in a shared directory. */
  room?: { platform: string; roomSlug: string };
  /**
   * Issue #148: parts already in `bv` that were contributed by predecessor session(s) of the same broadcast
   * (this session continued their submission instead of creating its own). Crash recovery compares the
   * submission's part count against `inheritedParts + confirmed.length`, so it must be persisted.
   */
  inheritedParts?: number;
  /** Predecessor session base this session continued (diagnostics only). */
  inheritedFrom?: string;
  /**
   * Issue #46: pid of the process that last wrote this sidecar (the recorder, or a successor that took the session
   * over) and when it did so. A successor only takes over leftover segments when this pid is gone; sidecars written
   * before this field existed have neither (legacy → judged by file activity instead).
   */
  ownerPid?: number;
  heartbeatAt?: number;
  /**
   * Issue #309: set once the owner finished this session (session-end flush returned, or a successor finished
   * taking it over). Absent while the owner may still upload it, so the master can tell "owner still working
   * on it" (wait) from "owner gone mid-upload" (manual). Sidecars written before this field existed never have it.
   */
  closedAt?: number;
  /**
   * Season association state (issue #364). Persisted together with the BV so a crash between create and
   * association is recoverable: "pending" = BV saved, add not confirmed; "done"/"failed" = terminal.
   */
  seasonState?: "pending" | "done" | "failed";
  updatedAt: number;
}

/** Outcome of looking for a predecessor session whose submission this session should continue. */
type PredecessorLink =
  | { kind: "none" }
  | { kind: "inherit"; bv: string; parts: number; from: string; seasonState?: "pending" | "done" | "failed" }
  | { kind: "uncertain"; reason: string };

/** sidecar schema 版本(WAL 字段演进;老文件无此字段 = v1,读时兼容)。 */
const ROLLING_STATE_SCHEMA_VERSION = 2;
/** 碎片段阈值:预计时长低于该秒数的封口段不上传(默认 2s,源保留)。 */
const DEFAULT_MIN_SEGMENT_SEC = 2;

/** Legacy sidecars carry no owner pid: treat the owner as possibly alive while any of its files changed this recently. */
const LEGACY_OWNER_QUIET_MS = 10 * 60_000;
/** Longest a successor waits for a predecessor's (identity-checked) live owner before failing closed. */
const DEFAULT_OWNER_WAIT_MS = 30 * 60_000;
/** How long a failed legacy-import archive proof is cached before the next flush measures it again. */
const DEFAULT_PROOF_RETRY_MS = 60_000;
/** Bounded archive-proof retries per session: a dead lookup must not poll forever (rework addendum 9). */
const DEFAULT_PROOF_MAX_ATTEMPTS = 3;
/** The predecessor's last segment must keep the same size across this pause before it counts as sealed. */
const DEFAULT_STABLE_CHECK_MS = 2_000;

/** Does this argv look like this program's `record` subcommand (the process that owns rolling sidecars)? */
export function looksLikeRecordProcess(args: readonly string[]): boolean {
  const hasProgram = args.some((a) => /douyin-rec(\.mjs)?$/.test(a));
  return hasProgram && args.includes("record");
}

/**
 * Read `/proc/<pid>/cmdline` as argv. `null` = no such process; `undefined` = /proc unusable on this platform
 * (caller falls back to a bare kill(pid, 0) probe).
 */
function readProcCmdline(pid: number): string[] | null | undefined {
  if (!existsSync("/proc/self/cmdline")) return undefined;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter((x) => x.length > 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? null : undefined;
  }
}

/**
 * Is `pid` still the recorder that owned a sidecar? kill(pid, 0) alone is fooled by pid reuse (container restarts
 * hand small pids to unrelated processes), so on Linux the command line must also look like our `record`
 * subcommand. A reused pid held by another recorder of this program still counts as alive: the room is not
 * checked (the `--room` argument may be a short link that does not carry the slug), the bounded wait covers it.
 */
function isPidAlive(pid: number, cmdlineOf: (pid: number) => string[] | null | undefined = readProcCmdline): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM = exists but not ours; anything but ESRCH is treated as alive (fail closed).
    if ((e as NodeJS.ErrnoException)?.code === "ESRCH") return false;
  }
  const args = cmdlineOf(pid);
  if (args === undefined) return true; // /proc unavailable: the bare probe is all we have
  if (args === null || args.length === 0) return false; // gone or zombie
  return looksLikeRecordProcess(args);
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

/**
 * Atomic sidecar write (tmp → fsync → rename), stamped with the writer's pid + heartbeat. Throws on failure.
 * Runs under the shared sidecar lock so the queue processor's merge cannot land between our read and rename;
 * `merge` receives the current disk state and returns the body to write (the merged state is returned).
 */
function writeStateFile(
  dir: string, state: RollingState, pid: number, nowMs: number,
  merge?: (disk: RollingState | null) => RollingState,
  lock?: { timeoutMs?: number; staleMs?: number },
): RollingState {
  const target = statePathFor(dir, state.sessionBase);
  return withFileLockSync(target, () => {
    const merged = merge ? merge(readState(dir, state.sessionBase)) : state;
    const tmp = `${target}.tmp.${process.pid}.${Date.now().toString(36)}`;
    try {
      const fd = openSync(tmp, "w", 0o644);
      try {
        const body = { ...merged, ownerPid: pid, heartbeatAt: nowMs, schemaVersion: ROLLING_STATE_SCHEMA_VERSION };
        writeFileSync(fd, JSON.stringify(body), "utf-8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, target);
      return merged;
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* best-effort 清理临时文件 */ }
      throw e;
    }
  }, lock);
}

/** True when `s` still has an unconfirmed, non-empty segment file on disk. */
function hasUnsentContent(s: RollingState): boolean {
  const confirmed = new Set(s.confirmed);
  return (s.segments ?? []).some((x) => {
    if (confirmed.has(x.index)) return false;
    try { return statSync(x.path).size > 0; } catch { return false; }
  });
}

/** Platform live id the recorder wrote into `{base}.session.json` (issue #320); null when missing or unreadable. */
function readSessionLiveId(dir: string, base: string): string | null {
  try {
    const d = JSON.parse(readFileSync(join(dir, `${base}.session.json`), "utf-8")) as { liveSessionId?: unknown };
    return typeof d.liveSessionId === "string" && d.liveSessionId ? d.liveSessionId : null;
  } catch {
    return null;
  }
}

/** A same-room sidecar found next to this session that started earlier. */
interface PredecessorCand { base: string; s: RollingState; start: number; last: number; lastMedia: number }

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
    partTitleTemplate?: string;
    seasonSectionId?: number;
  };
  timeZone?: string;
  /** 缺省 true(仅自己可见);false = 公开。 */
  uploadPrivate?: boolean;
  /** biliup cookies 路径;缺省 env/数据根默认。 */
  cookies?: string;
  /** 封口段「预计时长」低于该秒数 → 不上传(碎片段;源保留,不阻塞后续段)。默认 2。 */
  minSegmentSec?: number;
  /** 分 P 数查询接缝(append 幂等核对 / 崩溃恢复);缺省 {@link countVideoParts}。 */
  countPartsRaw?: (bv: string, cookies: string) => Promise<number | null>;
  /** 限流闸门;缺省按节点本地库装配(与节点侧上传同一账号键)。 */
  gate?: UploadGate;
  /**
   * Node-wide upload slot (plan 038 PR4). **Default = no slot**: the slot is opened by the CLI wiring
   * (one per node, shared with the queue path), because a caller that does not know the node's data root
   * must not silently lock against a real on-disk slot.
   */
  slot?: UploadSlot | null;
  /** 槽等待上限;超过则本段本轮放弃(保留源,下轮重试)。默认 30 分钟。 */
  slotWaitMs?: number;
  log?: (msg: string) => void;
  /** 上传接缝(测试注入)。 */
  uploadPlainRaw?: typeof uploadPlain;
  appendGroupRaw?: typeof appendGroup;
  /** Per-socket TCP acked reader for the biliup child (test seam); default async `ss`. */
  readAcked?: (pid: number) => AckSample | Promise<AckSample>;
  /** Whether sampling is worth doing now (test seam); default: the recorder is in the finalizing phase. */
  shouldSample?: () => boolean;
  /** Progress report sink (test seam); default reports to the recorder state file. */
  noteProgress?: () => void;
  /** How often the live biliup child is sampled for progress; default 30s. */
  progressIntervalMs?: number;
  /** 删源接缝(测试注入);缺省 fs.rm。返回是否删除成功。 */
  removeFile?: (p: string) => boolean;
  /** 时间源(测试注入)。 */
  now?: () => number;
  /** Pid stamped into sidecars as the owner (test seam; default `process.pid`). */
  pid?: number;
  /** Liveness probe for a predecessor's owner pid (test seam; default `process.kill(pid, 0)`). */
  isPidAlive?: (pid: number) => boolean;
  /** /proc/<pid>/cmdline reader for the default owner-identity check (test seam; null = no process, undefined = no /proc). */
  procCmdline?: (pid: number) => string[] | null | undefined;
  /** How long to keep waiting for a live predecessor owner before failing closed (default 30 min). */
  ownerWaitMs?: number;
  /** Alert channel for rolling cases that need a human (same sink as the recorder's error notifications). */
  notify?: (message: string) => void;
  /** Pause between the two size checks of a predecessor's last segment (default 2s; tests pass 0). */
  stableCheckMs?: number;
  /** Plan 046 PR7: evaluated at each seal; master = write skipped(hub-owned) instead of uploading. */
  uploadOwner?: () => UploadOwner;
  /** Test/production seam for the queue skip write; omitted = no queue write (tests/back-compat). */
  enqueueHubSkipped?: (input: {
    file: string; index: number; seq?: number; streamKey: string; title?: string; expectedDurationSec?: number; confirmedAt?: number;
  }) => boolean | void;
  /**
   * Plan 046 PR6 (方案 A): when on, the recorder only enqueues upload-part rows; the serve runner uploads and
   * cleanup-part deletes. Default off => the legacy path is used unchanged (byte-identical behaviour).
   */
  queueMode?: boolean;
  /** Test seam for the enqueue adapter; production resolves it lazily (module cycle avoidance). */
  enqueueQueuePart?: (input: {
    file: string; index: number; seq?: number; orderKey: string; bv?: string; expectedDurationSec?: number; taskId?: number;
    meta: { cookies: string; title: string; tid: number; tag: string; desc?: string; public: boolean; seasonSectionId?: number };
  }) => "queued" | "already" | "failed" | "terminal";
  /** Test seam for the skipped placeholder (empty/fragment parts). */
  enqueueQueueSkip?: (input: {
    file: string; index: number; seq?: number; orderKey: string; expectedDurationSec?: number; taskId?: number;
    meta: { cookies: string; title: string; tid: number; tag: string; desc?: string; public: boolean; seasonSectionId?: number };
  }) => "queued" | "already" | "failed" | "terminal";
  /** Test seam for the legacy-sidecar import (confirmed part => done row). */
  importQueueConfirmed?: (input: {
    file: string; index: number; seq?: number; orderKey: string; bv: string; expectedDurationSec?: number; taskId?: number;
    withCleanup?: boolean;
    meta: { cookies: string; title: string; tid: number; tag: string; desc?: string; public: boolean; seasonSectionId?: number };
  }) => "queued" | "already" | "failed" | "terminal";
  /** Highest seq already present for one order key (restart/same-broadcast continuation). */
  queueMaxSeq?: (orderKey: string) => number;
  /**
   * Plan 046 PR6 rollback guard: does the node queue still own parts of this order (open rows only)?
   * Production wires the proc-queue lookup; missing = no guard (legacy callers unchanged).
   */
  queueOrderHasRows?: (orderKey: string) => boolean;
  /** Delay before retrying a failed queue enqueue (tests pass 0). */
  queueRetryMs?: number;
  /** How long a failed legacy-import archive proof is cached before it is measured again (default 60s). */
  queueProofRetryMs?: number;
  /** How many archive-proof measurements a session makes before giving up (default 3). */
  queueProofMaxAttempts?: number;
  /**
   * Sidecar lock budget (two writers: the recorder and the queue processor). The default (5s) already
   * outlives any realistic holder, but a loaded host can be configured higher instead of letting a
   * single slow writer poison the whole session (rework addendum 13).
   */
  sidecarLock?: { timeoutMs?: number; staleMs?: number };
  /** Task id stamped onto queue rows (owner routing for alerts). */
  taskId?: number;
}

/**
 * 边录边传执行器(一个会话一个实例)。调用方:
 *   - `onSegment(path)` → {@link noteSegment} 记录段序 + 触发一次 {@link flush}(fire-and-forget);
 *   - 会话收尾 → `await flush({ recordingActive:false })` 处理最后一段并等上传完成;
 *   - 建稿 BV 经 {@link bv} 暴露,供调用方回传 master(可选)。
 */
export class RollingUploader {
  /** Season calls are best-effort and must not delay the next part upload. */
  private seasonTail: Promise<void> = Promise.resolve();
  private seasonWriteFails = false;
  private readonly o: RollingUploaderOpts;
  private readonly log: (m: string) => void;
  private readonly gate: UploadGate | null;
  private readonly slot: UploadSlot | null;
  private readonly accountKey: string;
  private readonly now: () => number;
  private readonly minSegmentSec: number;
  private readonly pid: number;
  private readonly pidAlive: (pid: number) => boolean;
  /** Takeover wait reason already logged (one line per distinct reason, not per flush). */
  private takeoverWaitLogged = "";
  /** When this session first found the predecessor's owner alive (cleared once the owner is gone). */
  private ownerWaitSince = 0;
  /** Set once the owner wait exceeded its bound: findPredecessor then fails closed (no create, no append). */
  private takeoverGaveUp = "";
  /** 段文件所在目录(首个段确定;sidecar 写在这里)。 */
  private segDir = "";
  private state: RollingState;
  /** 段路径 → 段号(按首次上报顺序)。 */
  private readonly indexByPath = new Map<string, number>();
  /** 串行链:同一会话的上传/删除严格串行(防并发 append 撞稿 + 防重入)。 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 会话第一段写入时刻(epoch ms)—— 标题 `{HH}-{mm}-{ss}` 用它,避免用上传时刻漂移。 */
  private firstSegMtimeMs = 0;
  /** sidecar 原子写失败 → true:停止上传/删源(保留源,状态不可信,转人工)。 */
  private stateUntrusted = false;
  /** 从磁盘读到「已确认」段 → 恢复后补删「确认了但没删成」(崩溃窗口)的源。 */
  private needsConfirmCleanup = false;
  /** 崩溃恢复只应跑一次(读盘所得状态一次性结算,避免重复 query 分 P 数)。 */
  private recoveryDone = false;
  /** 已记过「碎片段跳过」日志的段号(避免每轮 flush 刷屏)。 */
  private readonly loggedSkipped = new Set<number>();
  /** The node-wide upload slot this instance may take (null in queue mode: the runner is the only uploader). */
  uploadSlot(): UploadSlot | null { return this.slot; }
  /** Plan 046 PR6: indices already enqueued (or placeholder-queued) in queue mode; in-memory only. */
  private readonly queuedIndices = new Set<number>();
  /** Pending queue-enqueue retry timer (PR6 MEDIUM 7: session-end flush is one-shot). */
  private queueRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** recordingActive of the latest failed queue flush (retry must not force false). */
  private queueRetryActive = false;
  /** Confirmed legacy segments blocked by a failed import/proof (never enqueue them as fresh uploads). */
  private readonly queueBlocked = new Set<number>();
  /** Cached archive proof for the legacy sidecar import (one query per session). */
  private queueImportProof: number | null = null;
  /** When queueImportProof was measured (0 = never); a failed proof is re-measured after a bounded window. */
  private queueImportProofAt = 0;
  /** Failed archive-proof measurements this session (bounded, exponential backoff). */
  private queueProofAttempts = 0;
  /** Indices blocked only because the archive proof failed; released once a later proof succeeds. */
  private readonly queueBlockedByProof = new Set<number>();
  /** Alerts already sent for this session (one per reason/index, not per flush). */
  private readonly queueNotified = new Set<string>();
  /** True when this session loaded an existing sidecar from disk (the only safe trigger for legacy import). */
  private loadedExistingSidecar = false;
  /** Rollback guard result (undefined = not computed yet): order key already owned by the queue. */
  private legacyQueueBlock: string | null | undefined = undefined;

  constructor(o: RollingUploaderOpts) {
    this.o = o;
    this.log = o.log ?? ((m: string): void => console.error(m));
    this.now = o.now ?? Date.now;
    this.minSegmentSec = Math.max(0, o.minSegmentSec ?? DEFAULT_MIN_SEGMENT_SEC);
    this.pid = o.pid ?? process.pid;
    this.pidAlive = o.isPidAlive ?? ((pid: number): boolean => isPidAlive(pid, o.procCmdline));
    const cookiesPath = o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
    // Queue mode never uploads from the recorder: do not open the account gate (a second sqlite handle)
    // and do not resolve the account key at all.
    this.gate = o.queueMode === true ? null : (o.gate ?? openNodeUploadGate({ warn: this.log }));
    // Plan 046 PR6 (方案 A): in queue mode the runner owns the only uploader; never take the node slot.
    this.slot = o.queueMode === true ? null : (o.slot ?? null);
    this.accountKey = o.queueMode === true ? "" : resolveUploadAccountKey(cookiesPath);
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
      this.loadSession(dir, segmentSessionBase(path.basename(filePath)) ?? stripVideoExt(path.basename(filePath)));
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
      // 首段时刻一旦确定就落盘(此后不覆盖):崩溃恢复的建稿标题必须用原始开播时刻。
      startMs: this.state.startMs ?? (Number.isFinite(this.firstSegMtimeMs) && this.firstSegMtimeMs > 0 ? this.firstSegMtimeMs : this.now()),
      updatedAt: this.now(),
    };
    this.persist();
    return idx;
  }

  /** Load (or initialise) the sidecar of session `base` in `dir`; rebuilds the path → index map. */
  private loadSession(dir: string, base: string): void {
    const loaded = readState(dir, base);
    this.loadedExistingSidecar = loaded !== null;
    this.state = loaded ?? {
      streamKey: this.o.streamKeyOf?.(base) ?? `${this.o.room.platform}:${this.o.room.roomSlug}:${base}`,
      sessionBase: base,
      room: { platform: this.o.room.platform, roomSlug: this.o.room.roomSlug },
      segments: [],
      confirmed: [],
      updatedAt: this.now(),
    };
    // 重启读回建稿时刻:标题时间锚定**会话首段**,不受「重启后先看到哪个段」影响。
    if (Number.isFinite(this.state.startMs) && (this.state.startMs ?? 0) > 0) {
      this.firstSegMtimeMs = this.state.startMs as number;
    }
    // 重启/换进程读到「已确认」段 → 需要补删「确认了但没删成」的源(崩溃窗口:确认后、删前被杀)。
    if (this.state.confirmed.length > 0) this.needsConfirmCleanup = true;
    // 从持久化状态重建「路径 → 段号」映射(重启后段号续号,不漏传、不重复建稿)。
    for (const s of this.state.segments ?? []) {
      if (s && typeof s.path === "string" && typeof s.index === "number") this.indexByPath.set(s.path, s.index);
    }
    this.segDir = dir;
    // Owner flip (node -> master) or a sidecar left by an older build (addendum 10/11).
    this.dropStaleQueueClaim();
  }

  /**
   * A master-owned session must never keep claiming a node queue: the master's hold keys off exactly that
   * field, so a leftover queueOrderKey would hold the broadcast with nobody uploading. Cleared only when the
   * queue owns nothing any more (no pending/running/reconciling/failed/uncertain rows) - with open rows the
   * claim is still true (the runner is uploading them) and must stay.
   */
  private dropStaleQueueClaim(): void {
    if (this.o.uploadOwner?.() !== "master") return;
    const key = this.state.queueOrderKey;
    if (!key) return;
    let openRows: boolean;
    try { openRows = this.o.queueOrderHasRows?.(key) ?? false; } catch { openRows = true; } // unknown: keep holding
    if (openRows) return;
    const next: RollingState = { ...this.state };
    delete next.queueOrderKey;
    delete next.queueSeqBase;
    this.state = next;
    // Write it out now: the master reads the file, and a finished session may never persist again.
    this.persist();
  }

  /** 当前 BV(建稿后;诊断/回传用)。 */
  get bv(): string | undefined { return this.state.bv; }
  /** 已确认段号(诊断/测试)。 */
  get confirmedIndices(): number[] { return [...this.state.confirmed]; }
  /** 结果不确定段号(转人工;诊断/测试)。 */
  get ambiguousIndices(): number[] { return [...(this.state.ambiguous ?? [])]; }

  /**
   * Best-effort season association after the BV is already durable. Never throws: a season failure must
   * not fail the upload or trigger a re-upload. The persisted seasonState makes an interrupted call
   * recoverable on the next run.
   */
  private async associateSeason(bv: string, reconcileFirst: boolean): Promise<void> {
    if (!this.o.uploadMeta.seasonSectionId) return;
    if (this.state.seasonState === "done" || this.state.seasonState === "failed") return;
    if (!this.state.sessionBase || !this.segDir) return;
    const cookies = this.o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
    const outcome = await addArchiveToSeasonIfConfigured({
      cookiesPath: cookies,
      sectionId: this.o.uploadMeta.seasonSectionId,
      bvid: bv,
      reconcileFirst,
      note: (m) => this.log(m),
    });
    const seasonState = seasonCheckpointState(outcome);
    try {
      if (this.seasonWriteFails) {
        this.seasonWriteFails = false;
        throw new Error("injected season checkpoint write failure");
      }
      // Season metadata is best-effort and must never set stateUntrusted: the sidecar still
      // carries the authoritative upload progress, and losing this field cannot justify
      // stopping the session's uploads and keeping every source.
      this.writeSidecar({ seasonState, updatedAt: this.now() });
    } catch (e) {
      this.log(`[rolling] season 状态落盘失败(保留 pending,不影响上传): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  private queueSeason(bv: string, reconcileFirst: boolean): void {
    if (!this.o.uploadMeta.seasonSectionId) return;
    if (this.state.seasonState === "done" || this.state.seasonState === "failed") return;
    this.seasonTail = this.seasonTail
      .then(() => this.associateSeason(bv, reconcileFirst))
      .catch(() => undefined);
  }

  /** Drain the best-effort season call at session end; ordinary flushes never wait on it. */
  drainSeason(): Promise<void> {
    return this.seasonTail;
  }

  /** Test seam: make the next season checkpoint write fail (metadata only, uploads continue). */
  failSeasonWriteOnce(): void {
    this.seasonWriteFails = true;
  }

  /**
   * 原子写 sidecar(WAL 语义):先写临时文件 → fsync → rename 原子替换。失败**不静默**:
   * 置 `stateUntrusted`(保留源、停止自动上传/删源,转人工)并打日志。
   */
  private persist(): boolean {
    if (this.stateUntrusted) return false;
    // 防御:还没上报过任何分段就没有 sessionBase → 没有可写的 sidecar 路径(拼出来会落到进程 cwd
    // 的 `.rolling.json`)。此时无事可持久化,直接跳过,绝不写脏文件。
    if (!this.state.sessionBase || !this.segDir) return true;
    const target = statePathFor(this.segDir, this.state.sessionBase);
    try {
      // The queue runner may have written bv/confirmed into the sidecar. Merge on disk under the
      // shared lock before writing so the recorder's in-memory state cannot erase them (two writers,
      // one file); the lock is what makes the merge race-free, not just best-effort.
      this.writeSidecar();
      return true;
    } catch (e) {
      this.stateUntrusted = true;
      this.log(
        `[rolling] ⚠️ sidecar 原子写失败(${target}),会话幂等状态不可信 → 停止自动上传并保留源(转人工): ` +
        String((e as Error)?.message ?? e).slice(0, 200),
      );
      // Queue mode: losing the sidecar silently stops every enqueue, which must reach a human
      // (rework addendum 10). Same dedupe key as the flush-time alert.
      if (this.o.queueMode === true) {
        this.notifyOnce("untrusted", "边录边传队列模式:sidecar 落盘失败(写盘),停止入队并保留源(转人工)");
      }
      return false;
    }
  }

  /**
   * Write the sidecar under the shared lock, merging runner-written fields from disk first.
   * Returns the merged state (also installed as this.state).
   */
  private writeSidecar(patch: Partial<RollingState> = {}): RollingState {
    const base = { ...this.state, ...patch };
    const merged = writeStateFile(this.segDir, base, this.pid, this.now(),
      (disk) => this.mergeSidecarState(base, disk), this.o.sidecarLock);
    this.state = merged;
    return merged;
  }

  /** Merge durable bv/confirmed/queueOrderKey written by the queue runner into this in-memory state. */
  private mergeSidecarState(state: RollingState, disk: RollingState | null): RollingState {
    if (!disk) return state;
    const confirmed = [...new Set([...(state.confirmed ?? []), ...(disk.confirmed ?? [])])].sort((a, b) => a - b);
    const merged: RollingState = {
      ...state,
      ...(state.bv ? {} : disk.bv ? { bv: disk.bv } : {}),
      ...(state.queueOrderKey ? {} : disk.queueOrderKey ? { queueOrderKey: disk.queueOrderKey } : {}),
      ...(state.hubOrderKey ? {} : disk.hubOrderKey ? { hubOrderKey: disk.hubOrderKey } : {}),
      confirmed,
      updatedAt: state.updatedAt,
    };
    // Owner flip (node -> master) or a sidecar left by an older build: a hub-owned session must not keep
    // claiming a node queue, or the master holds the broadcast forever. Only drop the key when the queue
    // has no open rows left (otherwise the runner may still be uploading and the hold is correct).
    const key = merged.queueOrderKey;
    if (this.o.uploadOwner?.() === "master" && key) {
      let openRows: boolean;
      try { openRows = this.o.queueOrderHasRows?.(key) ?? false; } catch { openRows = true; } // unknown: keep holding
      if (!openRows) {
        delete merged.queueOrderKey;
        delete merged.queueSeqBase;
      }
    }
    return merged;
  }

  /** 查询 BV 当前分 P 数(append 幂等核对 / 崩溃恢复)。 */
  private countPartsInner(bv: string, cookies: string): Promise<number | null> {
    return (this.o.countPartsRaw ?? countVideoParts)(bv, cookies);
  }

  /**
   * **崩溃恢复**:读盘到 `uploading` 意图标记(进程在「开始上传 → 落结果」之间被杀)时结算一次。
   *   - `create` 且无 BV:无法查证是否已建稿 → 保守转人工,**绝不自动重建稿**(避免重复投稿)。
   *   - `append` 且有 BV:用分 P 数核对 —— 比 `confirmed.length` 多 1 → 其实已追加成功(补确认);
   *     等于 `confirmed.length` → 未提交(安全,让正常循环重试);查不到/异常 → 转人工。
   */
  private async recoverDanglingUpload(): Promise<void> {
    if (this.recoveryDone || !this.state.uploading) return;
    this.recoveryDone = true;
    this.state = await this.settleIntent(this.state);
    this.persist();
  }

  /**
   * Settle the dangling `uploading` intent of `s` and return the resulting state (the caller persists it).
   * Works on any session's state, so a successor can settle its predecessor's intent with identical semantics.
   */
  private async settleIntent(s: RollingState): Promise<RollingState> {
    if (!s.uploading) return s;
    const { index, kind } = s.uploading;
    const confirmed = new Set(s.confirmed);
    const manual = (): RollingState => ({
      ...s,
      uploading: undefined,
      ambiguous: [...(s.ambiguous ?? []), index],
      updatedAt: this.now(),
    });
    if (confirmed.has(index)) {
      // 已在确认后、销标记前被杀:仅清标记,源由 needsConfirmCleanup 补删。
      return { ...s, uploading: undefined, updatedAt: this.now() };
    }
    if (kind === "create") {
      this.log(`[rolling] ⚠️ 上次会话在 P1 建稿过程中中断(BV 未知),段 ${index} 转人工核对,绝不自动重建稿`);
      return manual();
    }
    if (kind === "append" && s.bv) {
      const cookies = this.o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
      let parts: number | null = null;
      try {
        // Queue mode has no gate; the read-only part-count is the same evidence either way.
        parts = this.gate
          ? await this.gate.run(this.accountKey, () => this.countPartsInner(s.bv!, cookies))
          : await this.countPartsInner(s.bv!, cookies);
      } catch { parts = null; }
      // Parts inherited from predecessor sessions of the same broadcast are already in the submission.
      const expected = (s.inheritedParts ?? 0) + s.confirmed.length;
      // 用**分 P 数**做唯一证据(不额外要求段号连续):碎片段会被跳过(minSegmentSec),
      // 那时 confirmed 天然非连续(如 0,1,3)但分 P 数**仍然** = 已上传段数 = confirmed.length
      // —— 再要求连续会把这种正常情况误判成「历史/人工干预」→ 无谓转人工。
      if (parts == null) {
        this.log(`[rolling] ⚠️ 上电恢复失败(parts=${String(parts)} confirmed=${s.confirmed.join(",")}),段 ${index} 转人工核对`);
        return manual();
      }
      if (parts === expected + 1) {
        // 上次 append 其实已成功(客户端没拿到响应即被杀)→ 补确认,源交 needsConfirmCleanup 删除。
        confirmed.add(index);
        this.log(`[rolling] 上电恢复:段 ${index} 上次 append 已提交(分P数=${parts}),补确认`);
        return { ...s, uploading: undefined, confirmed: [...confirmed], updatedAt: this.now() };
      }
      if (parts === expected) {
        // 未提交 → 安全,清意图标记;正常循环会重试该段。
        this.log(`[rolling] 上电恢复:段 ${index} 上次 append 未提交(分P数=${parts}),安全重试`);
        return { ...s, uploading: undefined, updatedAt: this.now() };
      }
      this.log(`[rolling] ⚠️ 上电恢复:段 ${index} 分P数异常(${parts} != 期望 ${expected}/${expected + 1}),转人工核对`);
      return manual();
    }
    // append 意图但无 BV(状态不一致)→ 保守转人工。
    this.log(`[rolling] ⚠️ 上电恢复:append 意图但无 BV,段 ${index} 转人工核对`);
    return manual();
  }

  /**
   * Rollback guard (PR6): the order key of this broadcast if it was ever handed to the node queue AND
   * the queue still holds rows for it. Only the recorder's own sidecar or a *same-broadcast*
   * predecessor counts, so unrelated sessions never block. Computed once per session.
   */
  private legacyQueueConflictKey(): string | null {
    if (this.legacyQueueBlock !== undefined) return this.legacyQueueBlock;
    let key = this.state.queueOrderKey ?? null;
    if (!key) {
      const found = this.locatePredecessor();
      const prevKey = found.kind === "found" ? found.prev.s.queueOrderKey : undefined;
      if (prevKey) key = prevKey;
    }
    let blocked: string | null = null;
    if (key) {
      try { blocked = this.o.queueOrderHasRows && !this.o.queueOrderHasRows(key) ? null : key; }
      catch { blocked = key; } // unreadable queue: fail closed (never double-upload)
    }
    this.legacyQueueBlock = blocked;
    return blocked;
  }

  private isEmptySegment(seg: RollingSegment): boolean {
    // Read the real size: a 0-byte segment (ffmpeg reports `Opening` before any write) uploads as
    // duration=0 and Bilibili rejects the whole submission (state -16, irreversible). Independent of
    // the previous segment's mtime, which is gone once that source was uploaded and deleted.
    // An unreadable file counts as empty: nothing safe to upload, source kept.
    try { return statSync(seg.path).size <= 0; } catch { return true; }
  }

  /**
   * 判断封口段是否为「碎片段」(时长小于 {@link minSegmentSec})。
   * 时长用「本段 mtime − 上一段 mtime」近似(上一段关闭 ≈ 本段开始)。段 0 无前驱 → 恒非碎片
   * (P1 必传)。碎片段不上传、不删、不阻塞后续段(内容缺口极小,交给人工)。
   * 前驱 mtime 不可用(前驱源已上传并删除)时本判定放行,由 {@link isEmptySegment} 的真实大小检查兜底。
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

  private async _flush(recordingActive: boolean): Promise<{ uploaded: number[]; deleted: string[]; ambiguous: number[] }> {
    // Plan 046 PR6 (方案 A): queue mode only enqueues; the serve runner uploads and cleanup-part deletes.
    // The legacy implementation below is untouched, so the default (off) path stays byte-identical.
    if (this.o.queueMode) return this._flushQueue(recordingActive);
    // Plan 046 PR6 rollback guard: turning the queue switch OFF while rows for this broadcast exist is
    // unsafe. The serve runner keeps claiming upload-part rows (its own process never reads the switch)
    // while this recorder would upload the same sealed segments from the legacy path -> duplicate
    // create/append. Fail closed: keep every source, alert once, do nothing here.
    if (this.legacyQueueConflictKey()) {
      this.notifyOnce("queue-conflict",
        "边录边传队列模式:本场已有节点队列行(upload-part),旧路径上传会重复投稿;本进程已停止上传并保留源,请先跑完/清空队列再回退");
      return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    }
    const nowMs = this.now();
    if (this.stateUntrusted) {
      // 失败已在 persist() 日志明示;此后不做任何上传/删源(保留源,转人工)。
      return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    }
    // 崩溃恢复:结算上次进程留下的 uploading 意图(可能补确认 / 安全重试 / 转人工)。
    await this.recoverDanglingUpload();
    if (this.stateUntrusted) return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    const confirmed = new Set(this.state.confirmed);
    const ambiguous = new Set(this.state.ambiguous ?? []);
    const { rolling, sealed, pending, hubOwned } = this.planPending(recordingActive, nowMs, confirmed, ambiguous);
    const hubSkipped = new Set(this.state.hubSkipped ?? []);
    for (const seg of hubOwned) {
      if (hubSkipped.has(seg.index)) continue;
      try {
        this.o.enqueueHubSkipped?.({
          file: seg.path, index: seg.index, streamKey: this.state.streamKey,
          ...(typeof this.o.uploadMeta.partTitleTemplate === "string" ? { title: this.o.uploadMeta.partTitleTemplate } : {}),
          ...(this.state.startMs !== undefined ? { confirmedAt: this.state.startMs } : {}),
        });
        hubSkipped.add(seg.index);
        this.state = { ...this.state, hubSkipped: [...hubSkipped], updatedAt: this.now() };
        if (!this.persist()) return { uploaded: [], deleted: [], ambiguous: [...ambiguous] };
        this.log("[rolling] 段 " + seg.index + " 归 master 上传:写 skipped(hub-owned),保留源");
      } catch (e) {
        this.log("[rolling] 段 " + seg.index + " hub-owned skip 写队列失败(保留源,下轮重试): " + String((e as Error)?.message ?? e).slice(0, 200));
      }
    }
    // Issue #46: a successor must settle and upload its predecessor's leftover segments before its own first
    // upload to the inherited submission (part order = A's parts, then B's).
    if (pending.length > 0 && !this.state.bv && (await this.takeOverPredecessor()) === "wait") {
      return { uploaded: [], deleted: [], ambiguous: [...ambiguous] };
    }
    // A crash after the BV was saved but before the season call completed leaves "pending".
    // Queue it off the part-upload path; the add is idempotent and the flush only waits at the end.
    if (this.state.bv && this.state.seasonState === "pending") {
      this.queueSeason(this.state.bv, true);
    }

    const uploaded: number[] = [];
    const deleted: string[] = [];
    // 崩溃窗口补删:上次「确认后、删源前」被杀留下的源(幂等;仅重启后首轮执行)。
    if (this.needsConfirmCleanup) {
      this.needsConfirmCleanup = false;
      for (const s of rolling) {
        if (confirmed.has(s.index) && sealed.has(s.index)) this.deleteConfirmedSource(s, confirmed, sealed.has(s.index));
      }
    }
    for (const seg of pending) {
      // 不确定段绝不重传(可能已提交分 P)。
      if (ambiguous.has(seg.index) || confirmed.has(seg.index)) continue;
      try {
        // 成功时把 confirmed 并入**同一次** sidecar 写(见 uploadSegment):
        // 避免「uploadSegment 落 bv 后、_flush 再落 confirmed」之间崩溃 → 重启漏确认 → 重复 append。
        await this.uploadSegment(seg, confirmed);
        uploaded.push(seg.index);
        if (this.deleteConfirmedSource(seg, confirmed, sealed.has(seg.index))) deleted.push(seg.path);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // 槽被别的上传占着(队列上传/另一会话)→ **暂时**状态:什么都没上传,保留源,下一轮再试。
        // 绝不能记 ambiguous:那会让后续段永久被头阻塞挡回,线上的队列上传一旦跑起来就必然撞上。
        if (isSlotBusy(e)) {
          this.log(`[rolling] 段 ${seg.index} 等不到上传槽,保留源,下轮重试: ${msg.slice(0, 200)}`);
          break;
        }
        // 结果不确定(限流重试耗尽 / 网络) → 转人工:保留源,记 ambiguous,不自动重传。
        ambiguous.add(seg.index);
        this.state = { ...this.state, uploading: undefined, ambiguous: [...ambiguous], updatedAt: this.now() };
        this.persist();
        this.log(`[rolling] 段 ${seg.index} 上传失败/不确定,保留源并转人工(不自动重传): ${msg.slice(0, 200)}`);
        // **头阻塞**:段号升序处理,一旦第 k 段失败,之后所有段(>k)若继续上传将形成不可逆的空洞
        // (B 站 append 只能末尾追加,缺口补不回)。立即停下,等 k 结清(headOfLineFilter 在下一轮
        // 会把 k 及其后全部挡回)。
        break;
      }
    }
    return { uploaded, deleted, ambiguous: [...ambiguous] };
  }

  /** Seal + head-of-line + skip filters shared by the own flush and the successor's readiness check. */
  private planPending(
    recordingActive: boolean,
    nowMs: number,
    confirmed: ReadonlySet<number>,
    ambiguous: ReadonlySet<number>,
  ): { rolling: RollingSegment[]; sealed: Set<number>; pending: RollingSegment[]; hubOwned: RollingSegment[] } {
    return this.planPendingFrom(recordingActive, nowMs, confirmed, ambiguous);
  }

  /**
   * Plan 046 PR6 queue-mode flush: enqueue one upload-part per sealed, non-skipped segment.
   * Nothing is uploaded or deleted here: no biliup spawn, no slot, no gate, no unlink.
   */
  private async _flushQueue(recordingActive: boolean): Promise<{ uploaded: number[]; deleted: string[]; ambiguous: number[] }> {
    if (this.stopQueueUntrusted()) return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    // Same recovery as the legacy path: settle any dangling legacy intent before touching the queue.
    await this.recoverDanglingUpload();
    if (this.stopQueueUntrusted()) return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    if (this.state.uploading) {
      // Fail closed: a legacy create/append was interrupted. Never re-enqueue it (a create could duplicate the draft).
      this.notifyOnce("intent:" + String(this.state.uploading.index),
        "边录边传队列模式:上电发现未结算的上传意图(" + this.state.uploading.kind + "),该段保留源待人工核对");
      return { uploaded: [], deleted: [], ambiguous: this.ambiguousIndices };
    }
    const confirmed = new Set(this.state.confirmed);
    const ambiguous = new Set(this.state.ambiguous ?? []);
    const plan = this.planPendingFrom(recordingActive, this.now(), confirmed, ambiguous);
    const rolling = plan.rolling;
    const sealed = plan.sealed;
    const hubOwned = this.o.uploadOwner?.() === "master";
    // A mid-session owner flip must take effect on the very next flush, even when no new segment arrives.
    if (hubOwned) this.dropStaleQueueClaim();
    // Master-owned rooms upload on the master, not here. Their order key must stay LOCAL: persisting
    // queueOrderKey would make the master's rolling short-circuit read "node queue still uploading"
    // and hold the whole broadcast forever (plan 046 PR6 addendum 8, P1).
    const orderKey = this.queueOrderKey(!hubOwned);
    if (orderKey === null) return { uploaded: [], deleted: [], ambiguous: [...ambiguous] };
    const seqBase = this.queueSeqBase(orderKey, !hubOwned);
    if (ambiguous.size > 0) {
      // Ambiguous legacy segments are never retried automatically (duplicate append risk).
      this.notifyOnce("ambiguous", "边录边传队列模式:存在结果不确定的段,该段及之后不入队,保留源待人工");
    }
    // Legacy sidecar import: only on a same-base reload, never for hub-owned rooms, and only with independent
    // archive proof (a sidecar alone must not authorize a delete).
    if (this.state.bv && this.loadedExistingSidecar && !hubOwned) {
      const cookies = this.o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
      // A failed lookup (0) is only cached for a bounded window: a transient archive error must not
      // block every confirmed legacy part for the rest of the session, and a later good proof must win.
      const proofRetryMs = this.o.queueProofRetryMs ?? DEFAULT_PROOF_RETRY_MS;
      const maxAttempts = this.o.queueProofMaxAttempts ?? DEFAULT_PROOF_MAX_ATTEMPTS;
      // Bounded, with exponential backoff: a permanently failing lookup must not re-query biliup and
      // re-arm the retry once a minute for the whole session (rework addendum 9). After the cap the
      // confirmed parts stay blocked (sources kept) under the single alert already sent.
      const backoffMs = proofRetryMs * 2 ** Math.max(0, this.queueProofAttempts - 1);
      const proofDue = this.queueImportProofAt > 0 && this.now() - this.queueImportProofAt >= backoffMs
        && this.queueProofAttempts < maxAttempts;
      let proof = this.queueImportProof;
      if (proof === null || ((proof ?? 0) <= 0 && proofDue)) {
        try { proof = await this.countPartsInner(this.state.bv, cookies) ?? 0; } catch { proof = 0; }
        this.queueImportProof = proof;
        this.queueImportProofAt = this.now();
        if (proof <= 0) this.queueProofAttempts += 1;
      }
      if (proof <= 0) {
        this.notifyOnce("import-proof", "边录边传队列模式:老 sidecar 的已确认段无法在稿件侧核对,保留源待人工");
        // Never fall through to a fresh upload of an already-confirmed legacy part.
        for (const seg of rolling) {
          if (!confirmed.has(seg.index)) continue;
          this.queueBlocked.add(seg.index);
          this.queueBlockedByProof.add(seg.index);
        }
        // A transient archive failure must be re-checked: the session-end flush is one-shot, so
        // schedule the ordinary queue retry instead of waiting for the next seal - but only while the
        // attempt budget lasts.
        if (this.queueProofAttempts < maxAttempts) this.scheduleQueueRetry(recordingActive);
      } else {
        // The proof recovered: parts blocked only by it may be imported now.
        for (const i of this.queueBlockedByProof) this.queueBlocked.delete(i);
        this.queueBlockedByProof.clear();
        for (const seg of rolling) {
          if (!confirmed.has(seg.index)) continue;
          try {
            const meta = this.queueMetaFor(seg);
            const r = this.o.importQueueConfirmed?.({
              file: seg.path, index: seg.index, seq: seqBase + seg.index + 1, orderKey, bv: this.state.bv,
              withCleanup: true,
              ...(this.o.taskId !== undefined ? { taskId: this.o.taskId } : {}), meta,
            });
            if (r === "failed" || r === "terminal") {
              this.queueBlocked.add(seg.index);
              this.queueFailed(seg.index, "兼容导入失败", recordingActive, r === "terminal");
            }
          } catch (e) {
            this.queueBlocked.add(seg.index);
            this.queueFailed(seg.index, "兼容导入异常: " + String((e as Error)?.message ?? e).slice(0, 160), recordingActive);
          }
        }
      }
    }
    const queued: number[] = [];
    for (const seg of rolling) {
      if (this.queuedIndices.has(seg.index)) continue;
      if (this.queueBlocked.has(seg.index)) continue;
      if (!sealed.has(seg.index)) continue;
      if (this.state.hubSkipped?.includes(seg.index)) continue;
      // Ambiguous head-of-line: this segment and everything after it stays out of the queue (risk 7).
      if (ambiguous.size > 0 && [...ambiguous].some((a) => a <= seg.index)) break;
      const seq = seqBase + seg.index + 1;
      let meta: ReturnType<RollingUploader["queueMetaFor"]>;
      try {
        meta = this.queueMetaFor(seg);
      } catch (e) {
        this.queueFailed(seg.index, "元数据渲染失败: " + String((e as Error)?.message ?? e).slice(0, 160), recordingActive);
        break;
      }
      if (hubOwned) {
        // PR7 single owner decision: hub-owned parts write only skipped(hub-owned), never an upload row.
        const ok = this.o.enqueueHubSkipped?.({
          file: seg.path, index: seg.index, seq, streamKey: orderKey,
          ...(this.o.taskId !== undefined ? { taskId: this.o.taskId } : {}),
          ...(this.state.startMs !== undefined ? { confirmedAt: this.state.startMs } : {}),
        });
        if (ok === false) {
          this.queueFailed(seg.index, "hub-owned 占位写入失败", recordingActive);
          break;
        }
        this.queuedIndices.add(seg.index);
        queued.push(seg.index);
        continue;
      }
      const skip = this.isEmptySegment(seg) || this.isFragment(seg, rolling);
      const r = skip
        ? this.o.enqueueQueueSkip?.({ file: seg.path, index: seg.index, seq, orderKey, ...(this.o.taskId !== undefined ? { taskId: this.o.taskId } : {}), meta })
        : this.o.enqueueQueuePart?.({
          file: seg.path, index: seg.index, seq, orderKey,
          ...(this.state.bv ? { bv: this.state.bv } : {}),
          ...(this.o.taskId !== undefined ? { taskId: this.o.taskId } : {}), meta,
        });
      if (r === "terminal") {
        // Already failed/cancelled: keep the source, stop retrying (notify once), let a human decide.
        this.notifyOnce("terminal:" + seg.index, "边录边传队列模式:段 " + seg.index + " 已有失败/取消记录,保留源待人工");
        this.queuedIndices.add(seg.index);
        break;
      }
      if (r === "failed") {
        this.queueFailed(seg.index, skip ? "空/碎片段占位失败" : "入队失败", recordingActive);
        break; // head-of-line: later parts wait so seq stays gapless
      }
      if (r !== undefined) {
        this.queuedIndices.add(seg.index);
        queued.push(seg.index);
      }
    }
    if (queued.length > 0) {
      this.log("[rolling-queue] queued parts " + queued.join(",") + " (runner uploads, cleanup-part deletes after confirmation)");
      noteRecorderProgress();
    }
    return { uploaded: queued, deleted: [], ambiguous: [...ambiguous] };
  }

  /**
   * Same-broadcast order key. Queue-mode predecessors have no bv, so this deliberately uses
   * locatePredecessor (gap/live-id rule) instead of findPredecessor (which demands a bv). Null = fail closed.
   */
  private queueOrderKey(persist: boolean): string | null {
    const existing = persist ? this.state.queueOrderKey : (this.state.queueOrderKey ?? this.state.hubOrderKey);
    if (existing) return existing;
    const found = this.locatePredecessor();
    let key = this.state.streamKey || this.state.sessionBase;
    if (found.kind === "uncertain") {
      this.notifyOnce("predecessor", "边录边传队列模式:无法确认同场前序会话,本会话暂不入队,保留源: " + found.reason);
      return null;
    }
    if (found.kind === "found") {
      const prev = found.prev;
      // Keep the legacy uncertainty gate: an interrupted upload in the predecessor is not a safe
      // continuation base (missing part / duplicate append would go unnoticed).
      if (prev.s.uploading) {
        this.notifyOnce("pred-intent", "边录边传队列模式:前序会话有未结算的上传意图,本会话暂不入队,保留源");
        return null;
      }
      if ((prev.s.ambiguous?.length ?? 0) > 0) {
        this.notifyOnce("pred-ambiguous", "边录边传队列模式:前序会话有结果不确定的段,本会话暂不入队,保留源");
        return null;
      }
      if (this.ownerMayBeAlive(prev.s, prev.last)) {
        this.notifyOnce("pred-owner", "边录边传队列模式:前序会话的录制进程可能仍存活,本会话暂不入队,保留源");
        return null;
      }
      const startMs = this.state.startMs ?? (this.firstSegMtimeMs || this.now());
      const prevLiveId = readSessionLiveId(this.segDir, prev.base);
      const ownLiveId = readSessionLiveId(this.segDir, this.state.sessionBase);
      const same = prev.s.bv
        ? isSameBroadcast({ aLiveId: prevLiveId, bLiveId: ownLiveId, gapMs: startMs - prev.last })
        : (() => {
          if (prevLiveId && ownLiveId && prevLiveId !== ownLiveId) return false;
          const ref = prev.lastMedia > 0 ? prev.lastMedia : prev.last;
          return isSameBroadcastGap(startMs - ref);
        })();
      if (same) {
        key = (prev.s.queueOrderKey || prev.s.hubOrderKey) || prev.s.streamKey || key;
        if (!persist) {
          // Master-owned: persist ONE local key per broadcast so consecutive sessions keep the same
          // skip-row order key and seq baseline (timeline stays continuous), while never writing
          // queueOrderKey - that field is the master's "node queue in flight" signal.
          this.state = { ...this.state, hubOrderKey: key, updatedAt: this.now() };
          if (!this.persist()) {
            this.stateUntrusted = true;
            this.notifyOnce("persist-key", "边录边传队列模式:场键落盘失败,停止入队并保留源");
            return null;
          }
          return key;
        }
        const parts = (prev.s.inheritedParts ?? 0) + prev.s.confirmed.length;
        this.state = {
          ...this.state,
          queueOrderKey: key,
          // Hub-owned rooms never upload on this node: inheriting a bv would make the master's
          // short-circuit skip an upload whose sources are all still retained.
          ...(this.o.uploadOwner?.() !== "master" && prev.s.bv && !this.state.bv ? { bv: prev.s.bv } : {}),
          ...(typeof parts === "number" && parts > 0 ? { inheritedParts: parts } : {}),
          updatedAt: this.now(),
        };
        if (!this.persist()) {
          this.stateUntrusted = true;
          this.notifyOnce("persist-key", "边录边传队列模式:场键落盘失败,停止入队并保留源");
          return null;
        }
        return key;
      }
    }
    if (!persist) {
      this.state = { ...this.state, hubOrderKey: key, updatedAt: this.now() };
      if (!this.persist()) {
        this.stateUntrusted = true;
        this.notifyOnce("persist-key", "边录边传队列模式:场键落盘失败,停止入队并保留源");
        return null;
      }
      return key;
    }
    this.state = { ...this.state, queueOrderKey: key, updatedAt: this.now() };
    if (!this.persist()) {
      this.stateUntrusted = true;
      this.notifyOnce("persist-key", "边录边传队列模式:场键落盘失败,停止入队并保留源");
      return null;
    }
    return key;
  }

  /**
   * First queue seq for this session: continues after queue rows and inherited predecessor parts.
   * `persist=false` (master-owned rooms) recomputes from the store each flush instead of writing the
   * baseline into the sidecar.
   */
  private queueSeqBase(orderKey: string, persist = true): number {
    let queueMax = 0;
    try { queueMax = Math.max(0, this.o.queueMaxSeq?.(orderKey) ?? 0); } catch { queueMax = 0; }
    const inherited = Math.max(0, this.state.inheritedParts ?? 0);
    const base = Math.max(queueMax, inherited);
    if (typeof this.state.queueSeqBase === "number" && this.state.queueSeqBase >= base) return this.state.queueSeqBase;
    if (!persist) return base;
    this.state = { ...this.state, queueSeqBase: base, updatedAt: this.now() };
    if (!this.persist()) {
      this.stateUntrusted = true;
      this.notifyOnce("persist-base", "边录边传队列模式:seq 基线落盘失败,停止入队并保留源");
    }
    return base;
  }
  /** Fully resolved biliup metadata for one part (same values the legacy path sends). */
  private queueMetaFor(seg: RollingSegment): {
    cookies: string; title: string; tid: number; tag: string; desc?: string; public: boolean; seasonSectionId?: number;
  } {
    const cookies = this.o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
    const base = segmentSessionBase(path.basename(seg.path)) ?? this.state.sessionBase;
    const startMs = this.firstSegMtimeMs || this.state.startMs || this.now();
    const stem = resolveOutputStem({
      template: this.o.uploadMeta.titleTemplate, sessionBase: base, startMs,
      timeZone: this.o.timeZone ?? processTimeZone(),
    });
    const title = resolveSubmissionTitle({
      submissionTemplate: this.o.uploadMeta.submissionTitleTemplate,
      template: this.o.uploadMeta.titleTemplate, stem,
      ctx: { sessionBase: base, startMs, timeZone: this.o.timeZone ?? processTimeZone() },
    });
    return {
      cookies, title, tid: this.o.uploadMeta.tid, tag: this.o.uploadMeta.tag,
      ...(this.o.uploadMeta.desc ? { desc: this.o.uploadMeta.desc } : {}),
      public: this.o.uploadPrivate === false,
      ...(this.o.uploadMeta.seasonSectionId ? { seasonSectionId: this.o.uploadMeta.seasonSectionId } : {}),
    };
  }

  /** Enqueue failure must be visible and retried: session-end flush is one-shot (TODO(?): no orphan scan yet). */
  private queueFailed(index: number, what: string, recordingActive: boolean, terminal = false): void {
    this.notifyOnce("fail:" + index, "边录边传队列模式:段 " + index + " " + what + ",保留源" + (terminal ? "待人工" : "并稍后重试"));
    if (terminal) return;
    // A later failure may know that recording has finished; the retry must use the LATEST state, never
    // the first failure's: an active failure followed by a session-end failure must retry with
    // recordingActive=false, otherwise the tail segment is never sealed and never enqueued.
    this.scheduleQueueRetry(recordingActive);
  }

  /** Schedule (at most one) delayed queue flush; the timer reads the LATEST recording state. */
  private scheduleQueueRetry(recordingActive: boolean): void {
    this.queueRetryActive = recordingActive;
    if (this.queueRetryTimer) return;
    const timer = setTimeout(() => {
      this.queueRetryTimer = null;
      // Never force recordingActive=false: that would seal the still-growing newest segment.
      void this.flush({ recordingActive: this.queueRetryActive }).catch(() => undefined);
    }, this.o.queueRetryMs ?? 60_000);
    timer.unref?.();
    this.queueRetryTimer = timer;
  }

  /**
   * Queue mode: a failed sidecar write stops every enqueue, which must never be only a log line
   * (rework addendum 9). Returns true when this flush must stop.
   */
  private stopQueueUntrusted(): boolean {
    if (!this.stateUntrusted) return false;
    this.notifyOnce("untrusted", "边录边传队列模式:sidecar 落盘失败,状态不可信 → 已停止入队并保留源(转人工)");
    return true;
  }

  /** One alert per reason for this session (flush runs on every seal). */
  private notifyOnce(key: string, msg: string): void {
    if (this.queueNotified.has(key)) return;
    this.queueNotified.add(key);
    this.log("[rolling-queue] " + msg);
    try { this.o.notify?.(msg); } catch { /* alert is best-effort */ }
  }

  private planPendingFrom(
    recordingActive: boolean,
    nowMs: number,
    confirmed: ReadonlySet<number>,
    ambiguous: ReadonlySet<number>,
  ): { rolling: RollingSegment[]; sealed: Set<number>; pending: RollingSegment[]; hubOwned: RollingSegment[] } {
    const rolling: RollingSegment[] = [...this.indexByPath.entries()].map(([p, index]) => {
      let mtimeMs = 0;
      try { mtimeMs = statSync(p).mtimeMs; } catch { mtimeMs = 0; }
      return { path: p, index, mtimeMs };
    });
    // 封口判定(唯一真理 = core.sealedSegmentIndices),grace 恒为 0:
    //   - 录制中:最新段**恒不封口**(只有「出现后继段」才封口),grace 根本不参与判定;
    //   - 收尾(recordingActive=false):调用方契约是**录制进程已退出** —— manager 在
    //     `await recorder.stop()`(SIGINT + 8s SIGKILL 兜底)之后才调 `onSessionEnd`,最后一段不会再增长。
    //   ⚠️ 这里曾经沿用 `DEFAULT_SEAL_GRACE_MS`(3s):而「刚写完就收尾」的末段 mtime 距今 < 3s
    //   → 判不出封口 → **末段永不上传、源永残留**(master 见「有 rolling.bv 但仍有 ts」→ 整场转人工)。
    //   收尾是**一次性**调用(不重试),所以这个宽限没有任何补救机会,只有害处。见 rolling-upload.test.ts
    //   「默认收尾 flush 上传末段」回归用例。
    const sealOpts = { recordingActive, nowMs, sealGraceMs: 0 };
    const sealed = sealedSegmentIndices(rolling, sealOpts);
    const planned = planRollingUploads(rolling, sealOpts, confirmed);
    const hubOwned = planned.filter(() => this.o.uploadOwner?.() === "master");
    const hubOwnedIndices = new Set(hubOwned.map((s) => s.index));
    // 头阻塞:ambiguous 段及其后的段一律不外发(B 站 append 只能追加末尾,缺口不可逆)。
    const headBlocked = headOfLineFilter(planned.filter((s) => !hubOwnedIndices.has(s.index)), ambiguous);
    const hubSkipped = new Set(this.state.hubSkipped ?? []);
    const pending: RollingSegment[] = [];
    for (const s of headBlocked) {
      if (hubSkipped.has(s.index)) continue;
      if (this.isEmptySegment(s)) {
        if (this.loggedSkipped.has(s.index)) continue;
        this.loggedSkipped.add(s.index);
        this.log(`[rolling] 段 ${s.index} 为 0 字节,不上传、保留源(转人工处理)`);
        continue;
      }
      if (this.isFragment(s, rolling)) {
        if (this.loggedSkipped.has(s.index)) continue;
        this.loggedSkipped.add(s.index);
        this.log(`[rolling] 段 ${s.index} 时长过短(< ${this.minSegmentSec}s),不上传、保留源(转人工处理)`);
        continue;
      }
      pending.push(s);
    }
    return { rolling, sealed, pending, hubOwned };
  }

  /** 上传一个封口段:P1(无 bv)建稿 → 落 BV;其余 append。 */
  private async uploadSegment(seg: RollingSegment, confirmed: Set<number>): Promise<void> {
    const cookies = this.o.cookies ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
    const meta = {
      cookies,
      tag: this.o.uploadMeta.tag,
      tid: this.o.uploadMeta.tid,
      desc: this.o.uploadMeta.desc,
      // 边录边传默认「仅自己可见」(公开不可逆);唯一显式 override = hub 规则 upload.private:false。
      public: this.o.uploadPrivate === false,
    };
    if (!this.state.bv) {
      const link = this.findPredecessor();
      if (link.kind === "uncertain") {
        throw new Error(`边录边传:无法确认前序会话稿件状态(${link.reason}),不建稿、不 append,保留源转人工`);
      }
      if (link.kind === "inherit") {
        // Same broadcast (gap <= SAME_BROADCAST_GAP_MS): continue the predecessor's submission.
        this.state = {
      ...this.state, bv: link.bv, inheritedParts: link.parts, inheritedFrom: link.from,
      ...(this.o.uploadMeta.seasonSectionId && link.seasonState === "pending"
        ? { seasonState: "pending" as const }
        : {}),
          updatedAt: this.now(),
        };
        if (!this.persist()) throw new Error("sidecar 写失败(继承前序稿件),中止上传并保留源");
        this.log(`[rolling] 同一场断流重连:续用前序会话 ${link.from} 的稿件(已有 ${link.parts} 个分P),本会话段改为 append`);
        if (this.o.uploadMeta.seasonSectionId && link.seasonState === "pending") {
          this.queueSeason(link.bv, true);
        }
      }
    }
    if (!this.state.bv) {
      const base = segmentSessionBase(path.basename(seg.path)) ?? this.state.sessionBase;
      // startMs 用**会话第一段写入时刻**(不是上传时刻):`{HH}-{mm}-{ss}` 渲染才与文件名一致。
      const startMs = this.firstSegMtimeMs || this.now();
      const stem = resolveOutputStem({
        template: this.o.uploadMeta.titleTemplate,
        sessionBase: base,
        startMs,
        timeZone: this.o.timeZone ?? processTimeZone(),
      });
      const title = resolveSubmissionTitle({
        submissionTemplate: this.o.uploadMeta.submissionTitleTemplate,
        template: this.o.uploadMeta.titleTemplate,
        stem,
        ctx: { sessionBase: base, startMs, timeZone: this.o.timeZone ?? processTimeZone() },
      });
      // WAL:先落「建稿中」意图,再真正建稿。崩溃后据此转人工,绝不自动重建稿(重复投稿不可逆)。
      // Issue #309: written only once the slot and the gate let biliup start, so a wait never leaves an intent.
      const up = this.o.uploadPlainRaw ?? uploadPlain;
      const bv = await this.withUploadProgress((hooks) => this.withSlot(() => this.gate!.run(this.accountKey, () => {
        this.writeIntent(seg.index, "create");
        return up({ plain: { ...meta, video: seg.path, title }, hooks });
      })));
      // 把「当段已确认」并入同一次写:建稿成功即确认段 0,防止 bv 与 confirmed 分两次写之间崩溃。
      confirmed.add(seg.index);
      // Persist the BV BEFORE the best-effort season call: a kill during that call must not lose the BV.
      this.state = {
        ...this.state, bv, uploading: undefined, confirmed: [...confirmed],
        ...(this.o.uploadMeta.seasonSectionId ? { seasonState: "pending" as const } : {}),
        updatedAt: this.now(),
      };
      if (!this.persist()) throw new Error(`sidecar 写失败(建稿结果 BV=${bv}),状态不可信,保留源`);
      noteRecorderProgress(); // a confirmed segment is progress for the finalizing stall judge (plans/044)
      this.log(`[rolling] 段 ${seg.index} 建稿 BV=${bv}`);
      this.queueSeason(bv, false);
      return;
    }
    const bv = this.state.bv;
    // WAL:先落「追加第 index 段中」意图。崩溃后凭分 P 数核对是否已提交(见 recoverDanglingUpload)。
    // Written right before biliup starts (issue #309), same as the create intent.
    const ap = this.o.appendGroupRaw ?? appendGroup;
    await this.withUploadProgress((hooks) => this.withSlot(() => this.gate!.run(this.accountKey, () => {
      this.writeIntent(seg.index, "append");
      return ap({
        ...meta,
        bv,
        files: [seg.path],
        // 幂等核对:失败后重查分 P 数,变多 = 其实已成功;查不到 → 抛 ambiguous 标记转人工。
        countParts: () => this.countPartsInner(bv, cookies),
        hooks,
      });
    })));
    // 与建稿同口径:确认并入同一次写,防止 append 成功后、补 confirmed 前崩溃导致重复 append。
    confirmed.add(seg.index);
    this.state = { ...this.state, uploading: undefined, confirmed: [...confirmed], updatedAt: this.now() };
    if (!this.persist()) throw new Error(`sidecar 写失败(append 结果段 ${seg.index}),状态不可信,保留源`);
    noteRecorderProgress(); // a confirmed segment is progress for the finalizing stall judge (plans/044)
    this.log(`[rolling] 段 ${seg.index} append 到 ${bv}`);
  }

  /**
   * Report upload progress for the recorder's finalizing stall judge (plans/044) for the whole upload attempt:
   * slot wait, rate-limit gate wait, then each biliup child (line retries included).
   *  - Waiting (no child yet, or between retries): a legitimate pause (slot up to 30 min, gate window or a
   *    30 min cooldown after 601/21566) counts as progress every tick; the judge's 24h backstop bounds it.
   *  - Child alive: biliup's output is NOT a signal (no progress bar on a pipe, plans/038); TCP bytes acked on its
   *    sockets is. Any socket whose acked bytes grew (or a new socket carrying bytes) is progress, as in
   *    TransferWatch. No usable reading (no `ss`, non-Linux, no visible sockets) is no evidence: a live child counts.
   * `ss` is only spawned while the recorder is finalizing, and asynchronously. One interval for the whole attempt,
   * cleared in `finally`.
   */
  private async withUploadProgress<T>(run: (hooks: BiliupHooks) => Promise<T>): Promise<T> {
    const note = this.o.noteProgress ?? noteRecorderProgress;
    const read = this.o.readAcked ?? readTcpAckedAsync;
    const shouldSample = this.o.shouldSample ?? recorderIsFinalizing;
    let childPid: number | null = null;
    let prev: AckSample = null;
    let generation = 0; // a sample that finishes after its child closed must not count
    let sampling = false;
    const tick = async (): Promise<void> => {
      if (childPid === null) { note(); return; } // waiting for a turn / between retries
      if (sampling || !shouldSample()) return;
      sampling = true;
      const gen = generation;
      try {
        let sample: AckSample = null;
        try { sample = await read(childPid); } catch { sample = null; }
        if (gen !== generation) return;
        if (sample === null || sample.size === 0) { prev = null; note(); return; }
        let gained = false;
        for (const [k, v] of sample) {
          const before = prev?.get(k);
          if (before === undefined ? v > 0 : v > before) gained = true;
        }
        prev = sample;
        if (gained) note();
      } finally {
        sampling = false;
      }
    };
    const timer = setInterval(() => { void tick(); }, this.o.progressIntervalMs ?? 30_000);
    timer.unref?.();
    const hooks: BiliupHooks = {
      onSpawn: (pid) => { generation++; prev = null; childPid = pid ?? null; },
      onClose: () => { generation++; prev = null; childPid = null; },
    };
    try {
      return await run(hooks);
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Issue #148: find the predecessor session (same room, sidecar in the same directory) whose submission this
   * session must continue. Derived from on-disk state, never process memory, so a restart re-derives the same link.
   * Fail closed: anything we cannot judge (unreadable sidecar near this session, pending create/append intent,
   * ambiguous segments, a submission-less session with create intent) returns `uncertain` — the caller then neither
   * creates nor appends. A gap above SAME_BROADCAST_GAP_MS means a new broadcast → `none` (new submission).
   */
  private locatePredecessor():
    | { kind: "none" }
    | { kind: "uncertain"; reason: string }
    | { kind: "found"; prev: PredecessorCand } {
    const own = this.state.sessionBase;
    const startMs = this.state.startMs ?? (this.firstSegMtimeMs || this.now());
    let names: string[];
    try {
      names = readdirSync(this.segDir).filter((f) => f.endsWith(".rolling.json"));
    } catch (e) {
      return { kind: "uncertain", reason: `读不到会话目录: ${String((e as Error)?.message ?? e).slice(0, 80)}` };
    }
    const cands: PredecessorCand[] = [];
    for (const f of names) {
      const base = f.slice(0, -".rolling.json".length);
      if (base === own) continue;
      let s: RollingState;
      try {
        s = JSON.parse(readFileSync(join(this.segDir, f), "utf-8")) as RollingState;
        if (!s || typeof s !== "object" || !Array.isArray(s.confirmed)) throw new Error("bad shape");
      } catch {
        // Unreadable sidecar: its room/BV are unknown. Only matters when it was written near this session.
        let m = 0;
        try { m = statSync(join(this.segDir, f)).mtimeMs; } catch { /* treat as unknown time */ }
        if (m === 0 || isSameBroadcastGap(startMs - m)) return { kind: "uncertain", reason: `前序 sidecar 不可读(${f})` };
        continue;
      }
      const sameRoom = s.room
        ? s.room.platform === this.o.room.platform && s.room.roomSlug === this.o.room.roomSlug
        : typeof s.streamKey === "string" && s.streamKey.startsWith(`${this.o.room.platform}:${this.o.room.roomSlug}:`);
      if (!sameRoom) continue;
      const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);
      let lastMedia = 0;
      for (const seg of s.segments ?? []) {
        try { lastMedia = Math.max(lastMedia, statSync(seg.path).mtimeMs); } catch { /* segment already deleted */ }
      }
      const last = Math.max(num(s.updatedAt), lastMedia);
      const start = num(s.startMs) || num(s.updatedAt);
      if (start >= startMs) continue; // not a predecessor
      cands.push({ base, s, start, last, lastMedia });
    }
    // Sessions that never created or intended a submission have nothing to continue, unless they still hold
    // non-empty unconfirmed segments: a slot-starved session that never got to create (issue #309 review). Its
    // content would have to lead the submission; this session fails closed instead of creating one without it.
    // A queue-mode predecessor is meaningful even with no bv/intent/unsent content: its parts may already
    // be uploaded and their sources deleted (cleanup-part is the only deleter), and its bv never reached
    // the sidecar. Without this the successor takes a fresh key and creates a SECOND draft.
    // Scoped to queue mode so the legacy path (switch off) stays byte-identical (rework addendum 9).
    const meaningful = cands.filter((c) => c.s.bv || c.s.uploading || (c.s.ambiguous?.length ?? 0) > 0
      || hasUnsentContent(c.s) || (this.o.queueMode === true && !!c.s.queueOrderKey));
    if (meaningful.length === 0) return { kind: "none" };
    const prev = meaningful.reduce((a, b) => (b.start > a.start ? b : a));
    const prevLiveId = readSessionLiveId(this.segDir, prev.base);
    const ownLiveId = readSessionLiveId(this.segDir, own);
    if (!prev.s.bv) {
      // A BV-less predecessor is an ordinary upload candidate for the master, which joins only by its time window
      // (measured from the video end) and lets the live id only split. Use the same rule here, from the same clock
      // (segment mtimes, not sidecar writes: `closedAt` can land a slot wait later), so the master never uploads it
      // while this session also takes it over (#317 / #321 review).
      if (prevLiveId && ownLiveId && prevLiveId !== ownLiveId) return { kind: "none" };
      const ref = prev.lastMedia > 0 ? prev.lastMedia : prev.last;
      if (!isSameBroadcastGap(startMs - ref)) return { kind: "none" };
      return { kind: "found", prev };
    }
    // Issue #320: with a BV the master closes the session out without uploading, so the live id decides (also
    // across a long recorder gap); without ids on both sides the 60-minute gap rule applies.
    if (!isSameBroadcast({ aLiveId: prevLiveId, bLiveId: ownLiveId, gapMs: startMs - prev.last })) return { kind: "none" };
    return { kind: "found", prev };
  }

  private findPredecessor(): PredecessorLink {
    if (this.takeoverGaveUp) return { kind: "uncertain", reason: this.takeoverGaveUp };
    const found = this.locatePredecessor();
    if (found.kind !== "found") return found;
    const { prev } = found;
    const { s } = prev;
    if (s.uploading) return { kind: "uncertain", reason: `${prev.base} 有未结算的上传意图(${s.uploading.kind})` };
    if ((s.ambiguous?.length ?? 0) > 0) return { kind: "uncertain", reason: `${prev.base} 有结果不确定的段` };
    if (!s.bv) return { kind: "uncertain", reason: `${prev.base} 无稿件号` };
    const inherited = s.inheritedParts ?? 0;
    if (!Number.isInteger(inherited) || inherited < 0) return { kind: "uncertain", reason: `${prev.base} 继承分P数非法` };
    return { kind: "inherit", bv: s.bv, parts: inherited + s.confirmed.length, from: prev.base, seasonState: s.seasonState };
  }

  /** Is the process that owned predecessor sidecar `s` possibly still running? Unknown owner → judged by file activity. */
  private ownerMayBeAlive(s: RollingState, lastActivityMs: number): boolean {
    const pid = s.ownerPid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      // Same process: the earlier session ended (its onSessionEnd was awaited before this one started).
      return pid === this.pid ? false : this.pidAlive(pid);
    }
    const hb = typeof s.heartbeatAt === "number" && Number.isFinite(s.heartbeatAt) ? s.heartbeatAt : 0;
    return this.now() - Math.max(hb, lastActivityMs) < LEGACY_OWNER_QUIET_MS;
  }

  private waitForPredecessor(reason: string): "wait" {
    if (this.takeoverWaitLogged !== reason) {
      this.takeoverWaitLogged = reason;
      this.log(`[rolling] 前序会话残段暂不接管,本会话先不上传: ${reason}`);
    }
    return "wait";
  }

  /**
   * Issue #46: before this session's first upload to an inherited submission, finish the predecessor's leftovers:
   * settle its dangling intent (part-count readback), then append its remaining sealed segments in index order,
   * through a peer uploader on the predecessor's sidecar (same WAL, same delete-after-confirm rules).
   * Returns `wait` when it is not safe/possible yet (owner may be alive, last segment still growing, leftovers
   * still pending) — nothing of this session is uploaded then and the next flush re-checks. `proceed` means the
   * predecessor is settled, absent, or fail-closed (the caller's findPredecessor then yields `uncertain`).
   */
  private async takeOverPredecessor(): Promise<"proceed" | "wait"> {
    const found = this.locatePredecessor();
    if (found.kind !== "found") return "proceed";
    const { prev } = found;
    // No BV / ambiguous segments: fail closed (findPredecessor reports uncertain). A BV-less predecessor is never
    // taken over: it is an ordinary upload candidate for the master (run-now skips the reconnect window), so a
    // node-side create from its segments could duplicate a manuscript the master uploads (#317 review rounds 2-3).
    if (!prev.s.bv || (prev.s.ambiguous?.length ?? 0) > 0) return "proceed";
    const confirmed = new Set(prev.s.confirmed);
    const exists = (f: string): boolean => { try { statSync(f); return true; } catch { return false; } };
    const leftovers = (prev.s.segments ?? []).filter((x) => !confirmed.has(x.index) && exists(x.path));
    if (!prev.s.uploading && leftovers.length === 0) return "proceed";
    if (this.ownerMayBeAlive(prev.s, prev.last)) {
      const nowMs = this.now();
      if (!this.ownerWaitSince) this.ownerWaitSince = nowMs;
      const limit = this.o.ownerWaitMs ?? DEFAULT_OWNER_WAIT_MS;
      if (nowMs - this.ownerWaitSince >= limit) {
        // Fail closed like an uncertain predecessor: no create, no append, sources kept, one alert.
        this.takeoverGaveUp = `${prev.base} 的录制进程持续存活超过 ${Math.round(limit / 60_000)} 分钟,放弃等待`;
        const msg = `边录边传:${this.takeoverGaveUp},本会话不建稿不 append,保留源转人工`;
        this.log(`[rolling] ⚠️ ${msg}`);
        try { this.o.notify?.(msg); } catch { /* alert is best-effort */ }
        return "proceed";
      }
      return this.waitForPredecessor(`${prev.base} 的录制进程可能仍存活(pid=${String(prev.s.ownerPid ?? "未知")})`);
    }
    this.ownerWaitSince = 0;
    // Owner is gone, but an orphaned recorder child could still be writing: the newest segment only counts as
    // sealed when its size is unchanged across two checks.
    const last = leftovers.reduce<{ index: number; path: string } | undefined>((m, x) => (!m || x.index > m.index ? x : m), undefined);
    const lastIndex = Math.max(...(prev.s.segments ?? []).map((x) => x.index));
    if (last && last.index === lastIndex) {
      const size = (): number => { try { return statSync(last.path).size; } catch { return -1; } };
      const before = size();
      await new Promise((r) => setTimeout(r, this.o.stableCheckMs ?? DEFAULT_STABLE_CHECK_MS));
      if (before < 0 || before !== size()) return this.waitForPredecessor(`${prev.base} 的末段仍在变化或已消失`);
    }
    const peer = new RollingUploader({ ...this.o, ...(this.gate ? { gate: this.gate } : {}), slot: this.slot });
    peer.loadSession(this.segDir, prev.base);
    // Claim: stamps this process as the sidecar owner so a racing successor sees a live owner and waits.
    if (!peer.persist()) return this.waitForPredecessor(`${prev.base} 的 sidecar 无法写入`);
    this.log(`[rolling] 接管前序会话 ${prev.base} 的 ${leftovers.length} 个未确认分段(owner 已退出)`);
    await peer.flush({ recordingActive: false });
    await peer.drainSeason();
    if (peer.stateUntrusted) return this.waitForPredecessor(`${prev.base} 的 sidecar 写失败`);
    if (peer.hasUploadablePending()) return this.waitForPredecessor(`${prev.base} 仍有分段待上传(槽忙/未完成)`);
    // The claim above stamped this live pid as owner; close it so the master does not keep waiting on it.
    await peer.markClosed();
    return "proceed";
  }

  /** True while sealed, unconfirmed, non-skipped segments remain (everything counts as sealed: owner is gone). */
  private hasUploadablePending(): boolean {
    const confirmed = new Set(this.state.confirmed);
    const ambiguous = new Set(this.state.ambiguous ?? []);
    return this.planPending(false, this.now(), confirmed, ambiguous).pending.length > 0;
  }

  /**
   * Stamp the session as finished by its owner (issue #309). Queued on the serial chain so it lands after the
   * session-end flush; an intent or leftover segment may remain (they are reported as-is, not resolved here).
   */
  markClosed(): Promise<void> {
    const run = this.chain.then(() => this.stampClosed(), () => this.stampClosed());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private stampClosed(): void {
    if (!this.state.sessionBase || this.state.closedAt) return;
    this.state = { ...this.state, closedAt: this.now(), updatedAt: this.now() };
    this.persist();
  }

  /** Persist the write-ahead intent immediately before biliup starts; throws (source kept) when it cannot be written. */
  private writeIntent(index: number, kind: "create" | "append"): void {
    this.state = { ...this.state, uploading: { index, kind }, updatedAt: this.now() };
    if (!this.persist()) throw new Error(`sidecar 写失败(${kind === "create" ? "建稿" : "append"} 意图),中止上传并保留源`);
  }

  /**
   * One biliup per node (plan 038 PR4): take the node-wide slot around a single part upload and always give
   * it back. Waiting is not an error — the segment stays on disk and the next flush retries.
   */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.slot) return fn();
    const ok = await this.slot.acquire("rolling", this.o.slotWaitMs ?? 30 * 60_000);
    if (!ok) {
      // Nothing was started and no intent was written (it is written inside `fn`, issue #309).
      throw new Error(`${SLOT_BUSY_MARKER} within the wait limit; keeping the segment for the next try`);
    }
    try { return await fn(); } finally { this.slot.release(); }
  }

  /**
   * 删除该段**源视频**(仅当 core 的删源三重证据齐备:封口 + 已确认 + 房间身份一致)。
   * `.xml`/`.ass` 不在此路径(绝不删弹幕源)。
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
        return true;
      }
      return false;
    } catch (e) {
      this.log(`[rolling] 删源失败(保留): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return false;
    }
  }
}

/** 规则/hub.config 上传 metadata 的读取(两个公开解析器的共同实现)。 */
function resolveRollingUploadMetaInner(
  platform: string,
  roomSlug: string,
): { meta: RollingUploaderOpts["uploadMeta"]; private: boolean; partSizeMiB?: number } {
  // hub 规则(现读不缓存;无规则/坏 JSON → null)。A disabled rule or a stage-only rule
  // must not leak upload metadata: a manually started stream-upload task could otherwise
  // inherit a stale `private:false` and publish irreversibly.
  const rule = getHubRule(rootHubDir(), hubKey(platform, roomSlug));
  const mode = rule?.pipeline?.upload?.mode;
  const ruleActive = rule?.enabled !== false && (mode === "upload" || mode === "rolling");
  let uploadDefaults: {
    tag?: string; tid?: number; desc?: string; titleTemplate?: string;
    submissionTitleTemplate?: string; partTitleTemplate?: string; seasonSectionId?: number;
  } = {};
  try {
    // `serve` may be running with --hub-config, settings, or inline JSON. The child record
    // process receives the effective source through DOUYIN_REC_HUB_CONFIG(_JSON); reading
    // only rootHubConfig() would silently ignore the configuration the user is running.
    const eff = effectiveHubConfig();
    const text = eff.json !== undefined
      ? eff.json
      : readFileSync(eff.path || rootHubConfig(), "utf-8");
    const raw = JSON.parse(text) as {
      uploadDefaults?: typeof uploadDefaults;
      uploadMeta?: typeof uploadDefaults;
    };
    // `uploadMeta` is the documented legacy alias; keep both paths on one resolver.
    uploadDefaults = raw.uploadDefaults ?? raw.uploadMeta ?? {};
  } catch {
    /* 无 hub.config → 用规则/内置默认 */
  }
  const up = ruleActive ? rule?.pipeline?.upload : undefined;
  const seasonSectionId = resolveSeasonSectionId(up?.seasonSectionId, uploadDefaults.seasonSectionId);
  return {
    meta: {
      tag: up?.tag || uploadDefaults.tag || "直播,录像",
      tid: up?.tid ?? uploadDefaults.tid ?? 21,
      desc: up?.desc ?? uploadDefaults.desc,
      titleTemplate: (up?.titleTemplate ?? "").trim() || uploadDefaults.titleTemplate,
      submissionTitleTemplate: (up?.submissionTitleTemplate ?? "").trim() || uploadDefaults.submissionTitleTemplate,
      partTitleTemplate: (up?.partTitleTemplate ?? "").trim() || uploadDefaults.partTitleTemplate,
      ...(seasonSectionId ? { seasonSectionId } : {}),
    },
    // 可见性:规则 upload.private 缺省 true(= 仅自己可见)。**保守默认 true**(公开是不可逆的曝光)。
    private: up?.private !== false,
    ...(isValidPartSizeMiB(up?.partSizeMiB) ? { partSizeMiB: up.partSizeMiB } : {}),
  };
}

/**
 * 上传 metadata 的**唯一解析处**(规则 upload > hub.config uploadDefaults > 内置默认)。
 *
 * 边录边传(rolling)与 0 落盘流式直传共用它:两条路都建稿,用户在 hub 规则里配的分区/标签/标题/
 * 可见性必须同样生效。此前它是私有函数,0 落盘路径只能退回 CLI 默认值 —— 规则里配的标题模板会
 * 静默失效,这种「看起来配了其实没生效」正是要避免的。
 */
export function resolveRollingUploadMeta(
  platform: string,
  roomSlug: string,
): { meta: RollingUploaderOpts["uploadMeta"]; private: boolean; partSizeMiB?: number } {
  return resolveRollingUploadMetaInner(platform, roomSlug);
}

/**
 * 0 落盘流式直传(plans/039)建稿用的 metadata。
 *
 * `tid` / `tag` / `private` 与边录边传**同一处解析**(规则 upload > hub.config uploadDefaults >
 * 内置默认)。为什么这三项必须接进来:它们在 hub 规则里配了却对 0 落盘路径静默失效,会导致
 * 稿件投到错误分区/标签,或该房间要求公开时变成私稿 —— 都是不可逆的投稿事故。
 * 标题见 {@link resolveStreamUploadTitle};显式 `--stream-upload-*` 参数继续优先。
 */
export function resolveStreamUploadMeta(
  platform: string,
  roomSlug: string,
): { tid: number; tag: string; desc?: string; partTitleTemplate?: string; seasonSectionId?: number; partSizeMiB?: number; private: boolean } {
  const { meta, private: isPrivate, partSizeMiB } = resolveRollingUploadMetaInner(platform, roomSlug);
  return {
    tid: meta.tid,
    tag: meta.tag,
    ...(meta.desc ? { desc: meta.desc } : {}),
    ...(meta.partTitleTemplate ? { partTitleTemplate: meta.partTitleTemplate } : {}),
    ...(meta.seasonSectionId ? { seasonSectionId: meta.seasonSectionId } : {}),
    ...(partSizeMiB ? { partSizeMiB } : {}),
    private: isPrivate,
  };
}

/**
 * 0 落盘的稿件标题:显式参数优先,否则按 hub 规则/submission 模板渲染,回落 `{name}_{date}`。
 *
 * 0 落盘没有录像文件名可继承(标题此前只能来自 CLI `--name`,规则里配的模板对它无效),
 * 所以渲染口径与边录边传的建稿渲染保持同一套(core 的 `resolveSubmissionTitle`)。
 */
export function resolveStreamUploadTitle(o: {
  platform: string;
  roomSlug: string;
  /** Explicit CLI title override (manual debug runs); wins over hub templates. */
  explicit?: string;
  /** Anchor name for `{name}`; falls back to the room slug. */
  anchorName: string;
  /** Session start time (epoch ms) for `{date}`/`{HH}-{mm}-{ss}`; reuse it across restarts. */
  startMs: number;
  timeZone?: string;
  /** Live stream title for `{title}`; absent until the first stream acquisition. */
  liveTitle?: string;
  /**
   * Master-delivered metadata (hub-managed side node, issue #331). When given it is the ONLY source:
   * the node's own rule directory is empty and must not be consulted.
   */
  meta?: RollingUploaderOpts["uploadMeta"];
}): string {
  const explicit = (o.explicit ?? "").trim();
  if (explicit) return explicit.slice(0, 80);
  const meta = o.meta ?? resolveRollingUploadMetaInner(o.platform, o.roomSlug).meta;
  const timeZone = o.timeZone ?? processTimeZone();
  // A bare anchor name has no `YYYY-MM-DD_HH-mm-ss` suffix, so `{name}` is not derivable from
  // `sessionBase` alone. Prefix the start stamp, then the shared renderer sees the same shape
  // rolling upload gets from a recorded segment's filename.
  const z = zonedStamp(o.startMs, timeZone);
  const sessionBase = `${o.anchorName.trim() || o.roomSlug}_${z.date}_${z.hh}-${z.mm}-${z.ss}`;
  const ctx = { sessionBase, startMs: o.startMs, timeZone, ...(o.liveTitle ? { liveTitle: o.liveTitle } : {}) };
  // The built-in default is date-only, which cannot distinguish two broadcasts on the same
  // day. Zero-disk has no filename to inherit the start time from, so only the *default*
  // gains the start stamp; an explicit template is honored verbatim.
  const explicitTemplate = (meta.titleTemplate ?? "").trim();
  const timedTemplate = explicitTemplate || `${DEFAULT_TITLE_TEMPLATE}_{HH}-{mm}-{ss}`;
  let stem: string;
  try {
    stem = resolveOutputStem({ template: timedTemplate, sessionBase, startMs: o.startMs, timeZone, ...(o.liveTitle ? { liveTitle: o.liveTitle } : {}) });
  } catch {
    // Zero-disk has no filename, so a strict stem failure must not abort recording. Keep a
    // safe, truncated fallback for `resolveSubmissionTitle`; the submission title itself is
    // rendered loosely and capped at 80 chars.
    stem = (sanitizeStem(`${o.anchorName.trim() || o.roomSlug}_${z.date}`) || o.roomSlug).slice(0, 80);
  }
  return resolveSubmissionTitle({
    submissionTemplate: meta.submissionTitleTemplate,
    template: timedTemplate,
    stem,
    ctx,
  });
}

/** Rolling's default part title: the recorded segment stem (`sanitizePathSegment(name)_stamp_NNN`), capped at 80. */
function rollingStyleStem(
  name: string,
  z: { date: string; hh: string; mm: string; ss: string },
  partIndex: number,
): string {
  const idx = String(Math.max(partIndex - 1, 0)).padStart(3, "0");
  const tail = `_${z.date}_${z.hh}-${z.mm}-${z.ss}_${idx}`;
  const head = (sanitizePathSegment(name) || "live").slice(0, 80 - tail.length);
  return `${head}${tail}`;
}

/**
 * Render a zero-disk part title from the hub `partTitleTemplate`. Without a template, fall back to
 * what rolling upload shows (the recorded segment stem `{name}_{date}_{HH-mm-ss}_{NNN}`), never the
 * internal spool file name.
 */
export function resolveStreamPartTitle(o: {
  platform: string;
  roomSlug: string;
  anchorName: string;
  startMs: number;
  timeZone?: string;
  liveTitle?: string;
  partIndex: number;
  partTotal?: number;
  /** Master-delivered metadata (issue #331); the only source when given. */
  meta?: RollingUploaderOpts["uploadMeta"];
}): string {
  const meta = o.meta ?? resolveRollingUploadMetaInner(o.platform, o.roomSlug).meta;
  const timeZone = o.timeZone ?? processTimeZone();
  const z = zonedStamp(o.startMs, timeZone);
  const sessionBase = `${o.anchorName.trim() || o.roomSlug}_${z.date}_${z.hh}-${z.mm}-${z.ss}`;
  return formatPartTitle(meta.partTitleTemplate, {
    sessionBase,
    startMs: o.startMs,
    timeZone,
    ...(o.liveTitle ? { liveTitle: o.liveTitle } : {}),
    partIndex: o.partIndex,
    partTotal: o.partTotal,
  }, "plain") ?? rollingStyleStem(o.anchorName || o.roomSlug, z, o.partIndex);
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
  /** Plan 046 PR6 switch; default off keeps the legacy recorder-side upload path. */
  queueMode?: boolean;
  /** Task id stamped onto queue rows (alerts route to it). */
  taskId?: number;
  /** Test seams for the queue adapters; production resolves them lazily inside the hook. */
  enqueueQueuePart?: RollingUploaderOpts["enqueueQueuePart"];
  enqueueQueueSkip?: RollingUploaderOpts["enqueueQueueSkip"];
  importQueueConfirmed?: RollingUploaderOpts["importQueueConfirmed"];
  /** Test seam for the highest seq already present in one order. */
  queueMaxSeq?: RollingUploaderOpts["queueMaxSeq"];
  /** Production rollback guard: are there upload-part rows for this order key? */
  queueOrderHasRows?: RollingUploaderOpts["queueOrderHasRows"];
  timeZone?: string;
  uploadPrivate?: boolean;
  cookies?: string;
  minSegmentSec?: number;
  log?: (msg: string) => void;
  /** Alert sink for cases needing a human (wired to the recorder's notifier in the CLI). */
  notify?: (message: string) => void;
  uploadPlainRaw?: typeof uploadPlain;
  appendGroupRaw?: typeof appendGroup;
  countPartsRaw?: (bv: string, cookies: string) => Promise<number | null>;
  removeFile?: (p: string) => boolean;
  now?: () => number;
  gate?: UploadGate;
  /** Node-wide upload slot (plan 038 PR4); undefined = open the node's own slot, null = do not use one. */
  slot?: UploadSlot | null;
  /** plan 046 PR7: evaluated per seal; master skips node upload and writes the queue placeholder. */
  uploadOwner?: () => UploadOwner;
  enqueueHubSkipped?: RollingUploaderOpts["enqueueHubSkipped"];
}): (() => RollingUploadHook) | undefined {
  // TODO(?): plan 046 PR6 will move the seal hook into the queue path; until then this hub-owned
  // branch only covers sessions where rolling upload is enabled. Non-rolling hub rooms get their
  // skip rows when PR6 wires the shared seal hook.
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
      uploadPlainRaw: o.uploadPlainRaw,
      appendGroupRaw: o.appendGroupRaw,
      countPartsRaw: o.countPartsRaw,
      removeFile: o.removeFile,
      now: o.now,
      gate: o.gate,
      uploadOwner: o.uploadOwner,
      enqueueHubSkipped: o.enqueueHubSkipped,
      queueMode: o.queueMode === true,
      ...(o.taskId !== undefined ? { taskId: o.taskId } : {}),
      enqueueQueuePart: o.enqueueQueuePart ?? enqueueRollingUploadPart,
      enqueueQueueSkip: o.enqueueQueueSkip ?? enqueueRollingSkipPart,
      importQueueConfirmed: o.importQueueConfirmed ?? importRollingConfirmedPart,
      queueMaxSeq: o.queueMaxSeq ?? rollingQueueMaxSeq,
      queueOrderHasRows: o.queueOrderHasRows ?? queueOrderHasRows,
      // One slot per node process, shared with the queue's biliup processor (plan 038 PR4).
      // Queue mode must never take the upload slot (the runner owns the only uploader).
      slot: o.queueMode === true ? null : (o.slot ?? sharedNodeUploadSlot(o.log)),
    });
    return {
      onSegment: (p: string): void => {
        uploader.noteSegment(p);
        // 每产生新段 → 尝试处理:新段存在即意味着**旧段已封口**(滚动即封口)。fire-and-forget,
        // 不阻塞录制;串行链保证同一会话不并发上传。失败/不确定在 uploader 内部转人工(保留源)。
        void uploader.flush({ recordingActive: true }).catch(() => undefined);
      },
      onSessionEnd: async (): Promise<void> => {
        try {
          await uploader.flush({ recordingActive: false });
          await uploader.drainSeason();
        } finally { await uploader.markClosed(); }
      },
    };
  };
}
