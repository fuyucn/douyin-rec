/** Queue-specific projections built on shared hub job and ledger readers. */

import { DatabaseSync } from "node:sqlite";
import { HUB_FLOW_ORDER, classifySqliteError, dbPathMissing, isSidecarSkipEvent, readyNodes, STAGE_READY, USER_STOP, type HubPoolSnapshotDTO, type HubQueueDTO, type HubQueueStats, type QueueItemDTO, type QueuePhase } from "@drec/core";
import { openLedger, queueStats, tableExists, TERMINAL } from "./hub-job-ledger.js";
import { hubStageDir, hubLogsDir, listHubJobs, needsManualPhaseOf } from "./hub-job-reads.js";
import type { HubJobStep, HubJobView, BuildQueueOpts } from "./hub-job-types.js";

function splitStreamKey(streamKey: string): { platform: string; roomSlug: string } {
  const parts = streamKey.split(":");
  return { platform: parts[0] ?? "", roomSlug: parts[1] ?? "" };
}

function resourceOfNode(node: string | null): "cpu" | "net" | "upload" | null {
  if (!node) return null;
  if (node === "upload_plain" || node === "append_danmu" || node === "append_livechat") return "upload";
  if (node === "merge" || node === "burn_danmu" || node === "burn_livechat") return "cpu";
  return null;
}

export const UNKNOWN_MANUAL_REASON = "缺少失败原因(数据异常或修复前遗留的旧记录,请核对后标记已核对)";

export function digestManualError(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const sshWarn = /ssh rc=\d+: Warning: Permanently added \S+ \([^)]*\) to the list of known hosts\.\s*/i;

  const ffmpegArgs = /^(ffmpeg 失败 \(rc=\d+\)):\s*--/;
  if (ffmpegArgs.test(text)) return text.match(ffmpegArgs)![1];
  if (sshWarn.test(text)) {

    const stripped = text.replace(sshWarn, "").trim().replace(/^[^:]{1,20}:\s*$/, "").trim();
    return stripped || "节点侧上传失败:SSH 连接失败(节点首次连线提示,非故障原因)";
  }
  return null;
}

const EMPTY_POOL: HubPoolSnapshotDTO = {
  cpu: { active: 0, queued: 0, max: 0 },
  net: { active: 0, queued: 0, max: 0 },
  upload: { active: 0, queued: 0, cooldownUntil: 0, windowUsed: 0, windowLimit: 0, windowResetAt: 0 },
  waiting: [],
};

type QueueRows = {
  active: HubJobView[];
  manual: ReturnType<typeof listHubJobs>;
  manualAcked: number;
  stageReady: ReturnType<typeof listHubJobs>;
  recent: HubJobView[];
};

function loadQueueRows(syncDbPath: string, opts: BuildQueueOpts, manualLimit: number, recentLimit: number, stageDir: string, logsDir: string): QueueRows {
  const options = { now: opts.now, stageDir, logsDir };
  return {
    active: listHubJobs(syncDbPath, { ...options, excludeStates: [...TERMINAL], limit: 200, offset: 0 }).jobs,
    manual: listHubJobs(syncDbPath, { ...options, states: ["needs_manual"], limit: manualLimit, offset: 0, excludeError: STAGE_READY, acked: false }),
    manualAcked: listHubJobs(syncDbPath, { ...options, states: ["needs_manual"], limit: 0, offset: 0, acked: true }).total,
    stageReady: listHubJobs(syncDbPath, { ...options, states: ["needs_manual"], limit: manualLimit, offset: 0, onlyError: STAGE_READY, acked: false }),
    recent: listHubJobs(syncDbPath, { ...options, states: ["done", "failed"], limit: recentLimit, offset: 0 }).jobs,
  };
}

function waitingMap(pool: HubPoolSnapshotDTO): Map<string, (typeof EMPTY_POOL.waiting)[number]> {
  const result = new Map<string, (typeof EMPTY_POOL.waiting)[number]>();
  for (const waiting of [...pool.waiting].sort((a, b) => a.since - b.since)) {
    if (!result.has(waiting.streamKey)) result.set(waiting.streamKey, waiting);
  }
  return result;
}

function sortQueueRows(active: QueueItemDTO[], stageReady: QueueItemDTO[], recent: QueueItemDTO[], oldestFirst: boolean): QueueItemDTO[] {
  const direction = oldestFirst ? 1 : -1;
  active.sort((a, b) => {
    const left = a.enqueuedAt ?? a.updatedAt;
    const right = b.enqueuedAt ?? b.updatedAt;
    return left === right ? compareStreamKeys(a.streamKey, b.streamKey) : (left - right) * direction;
  });
  recent.sort((a, b) => b.updatedAt - a.updatedAt);
  const rows = [...active, ...stageReady, ...recent];
  rows.sort((a, b) => {
    const left = a.phase === "done" || a.phase === "failed" ? (a.finishedAt ?? a.updatedAt) : (a.enqueuedAt ?? a.updatedAt);
    const right = b.phase === "done" || b.phase === "failed" ? (b.finishedAt ?? b.updatedAt) : (b.enqueuedAt ?? b.updatedAt);
    return left === right ? compareStreamKeys(a.streamKey, b.streamKey) : (left - right) * direction;
  });
  return rows;
}

function compareStreamKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 读台账内的 done 计数（测试可注入 read 观察 I/O 故障路径）。 */
export function doneCount(syncDbPath: string, read: (path: string) => number = readDoneFromLedger): number {
  // 台账文件还不存在 = hub 首次启动前的正常空态（#561），不是故障 → 0。
  // 存在性判定与 hub-job-reads 共用 core 的同一份实现（#742 review 第二轮 P2-2）。
  if (dbPathMissing(syncDbPath)) return 0;
  try {
    return read(syncDbPath);
  } catch (error) {
    // issue #742: 「读不到」不能报成「已完成 0 个」。io / locked / corrupt 一律上抛
    // （上游 /api/hub/queue 会回 503/500 并带原文）；只有结构性缺失（缺表/缺列等 other）
    // 才退回空态 —— 与注释口径一致（#742 review 第二轮 P2-1）。
    if (classifySqliteError(error) !== "other") throw error;
    return 0;
  }
}

function readDoneFromLedger(syncDbPath: string): number {
  const db = openLedger(syncDbPath);
  try { return Number(db.prepare("SELECT COUNT(*) AS n FROM sync_jobs WHERE state = 'done'").all()[0]?.n ?? 0); }
  finally { db.close(); }
}

function phaseOf(job: HubJobView, waiting: (typeof EMPTY_POOL.waiting)[number] | undefined): QueuePhase {
  if (job.state === "done") return "done";
  if (job.state === "failed") return "failed";
  if (job.state === "needs_manual") return needsManualPhaseOf(job.error);
  if (waiting) return "queued";
  if (job.state === "pending" || job.state === "settling") return "waiting_settle";
  return "running";
}

function nextStepsOf(job: HubJobView, currentNode: string | null, disabled: ReadonlySet<string> | null, phase: QueuePhase): string[] {
  if (phase === "done" || phase === "failed") return [];
  const settled = new Set<string>([
    ...job.nodeStates.filter((node) => node.state === "done" || node.state === "skipped").map((node) => node.node),
    ...(disabled ?? []),
  ]);
  if (!currentNode) return readyNodes(settled);
  return HUB_FLOW_ORDER.filter((node) => !settled.has(node) && node !== currentNode);
}

function queueRow(job: HubJobView, waitingByKey: Map<string, (typeof EMPTY_POOL.waiting)[number]>, opts: BuildQueueOpts): QueueItemDTO {
  const { platform, roomSlug } = splitStreamKey(job.streamKey);
  const runningNode = job.nodeStates.find((node) => node.state === "running")?.node ?? null;
  const currentNode = runningNode ?? stateToNode(job.state);
  const waiting = waitingByKey.get(job.streamKey);
  const phase = phaseOf(job, waiting);
  const disabled = opts.disabledOf?.(platform, roomSlug) ?? null;
  return {
    streamKey: job.streamKey,
    platform,
    roomSlug,
    anchorName: opts.anchorOf ? opts.anchorOf(platform, roomSlug) : null,
    state: job.state,
    phase,
    resource: resourceOfNode(currentNode),
    queuePosition: waiting ? waiting.position : null,
    currentNode,
    doneSteps: doneStepsOf(job),
    nextSteps: nextStepsOf(job, currentNode, disabled, phase),
    currentStepSec: job.currentStepSec,
    etaSec: job.etaSec,
    winnerWorker: job.winnerWorker,
    fails: job.fails,
    updatedAt: job.updatedAt,
    error: job.state === "needs_manual" && !(job.error ?? "").trim()
      ? UNKNOWN_MANUAL_REASON
      : digestManualError(job.error) ?? job.error ?? null,
    bv: job.bv ?? null,
    videoDurationSec: job.videoDurationSec,
    finishedAt: TERMINAL.has(job.state) && job.events.length > 0 ? job.events[job.events.length - 1].at : null,
    enqueuedAt: job.startedAt,
    nodeUpload: job.nodeUpload,
  };
}

export function buildQueueView(syncDbPath: string, opts: BuildQueueOpts = {}): HubQueueDTO {
  const { pool = EMPTY_POOL, recentLimit = 8, manualLimit = 20, stageDir = hubStageDir(), logsDir = hubLogsDir() } = opts;
  const loaded = loadQueueRows(syncDbPath, opts, manualLimit, recentLimit, stageDir, logsDir);
  const waitingByKey = waitingMap(pool);
  const active = [...loaded.active, ...loaded.manual.jobs].map((job) => queueRow(job, waitingByKey, opts));
  const recent = loaded.recent;
  recent.sort((a, b) => b.updatedAt - a.updatedAt);
  const finishedRows = recent.map((job) => queueRow(job, waitingByKey, opts));
  const stageReady = loaded.stageReady.jobs.map((job) => queueRow(job, waitingByKey, opts));
  const rows = sortQueueRows(active, stageReady, finishedRows, opts.sort === "oldest");

  const phaseSet = opts.phase && opts.phase.length > 0 ? new Set(opts.phase) : null;
  const stateSet = opts.states && opts.states.length > 0 ? new Set(opts.states) : null;
  const platSet = opts.platform && opts.platform.length > 0 ? new Set(opts.platform) : null;
  const q = (opts.q ?? "").trim().toLowerCase();
  const keep = (it: QueueItemDTO): boolean => {
    if (phaseSet && !phaseSet.has(it.phase)) return false;
    if (stateSet && !stateSet.has(it.state)) return false;
    if (platSet && !platSet.has(it.platform)) return false;
    if (q) {
      const hay = `${it.anchorName ?? ""} ${it.roomSlug} ${it.streamKey}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  // Count all completed jobs for the View all total; older ledgers may lack the table.
  const doneTotal = doneCount(syncDbPath);

  return {
    active: active.filter(keep),
    rows: rows.filter(keep),
    recent: recent.slice(0, recentLimit),
    pool,
    // Totals ignore the filters on purpose: they size the whole inbox, not the current view.
    manualTotal: loaded.manual.total,
    manualAcked: loaded.manualAcked,
    stats: queueStats(syncDbPath, 7, opts.now ?? Date.now()),
    doneTotal,
  };
}

export function doneStepsOf(job: HubJobView): HubJobStep[] {
  const seen = new Set<string>();
  const out: HubJobStep[] = [];
  for (const s of job.steps) {

    if (s.phase !== "done" || isSidecarSkipEvent(s) || seen.has(s.step)) continue;
    seen.add(s.step);
    out.push(s);
  }
  return out;
}

export function stateToNode(state: string): string | null {
  switch (state) {
    case "merging": return "merge";
    case "uploading": return "upload_plain";
    case "syncing": return "pull";
    default: return null;
  }
}
