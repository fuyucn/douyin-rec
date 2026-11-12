/**
 * Hub assembly seam (plans/045 P1-3 / audit 2026-11-10 group C).
 *
 * The web layer reads hub state and asks the running hub to act through the accessors below;
 * hub startup (hubStarter.start) publishes its providers here. Keeping this layer out of cli.ts
 * leaves cli as command wiring and gives the hub-compose services a home between orchestrator (L4.5)
 * and cli (L5).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { HubBlockedBroadcastDTO, HubPoolSnapshotDTO, NodeTaskLogsDTO, NodeTasksDTO, RecordingWorkerStatusDTO, RollingDeliveryDTO, ZeroDiskNodeStatusDTO } from "@drec/core";
import type { TaskStore } from "@drec/app";
import type { FleetController, WorkflowNodeKey } from "@drec/orchestrator";
import { SyncGate } from "./sync-gate.js";

let hubFleet: FleetController | null = null;
/** Published by hubStarter.start when `fleet.controllerUrl` is configured; cleared on stop. */
export const setFleetController = (controller: FleetController | null): void => { hubFleet = controller; };
/** WebSocket upgrade entry for /fleet; false when the fleet link is not configured or not started. */
export const fleetUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean =>
  hubFleet?.upgrade(req, socket, head) ?? false;
export const stopFleet = (): void => { hubFleet?.stop(); hubFleet = null; };
/** For every SshTransport this process builds: fleet first, ssh otherwise (read per call). */
export const fleetLink = (): import("@drec/orchestrator").FleetLink | null => hubFleet?.link ?? null;

/** The hub sync tick published by hubStarter.start; undefined when the hub is not running. */
let hubSyncTasks: ((opts?: { force?: boolean }) => Promise<void>) | undefined;
export const setSyncTasks = (task: ((opts?: { force?: boolean }) => Promise<void>) | undefined): void => { hubSyncTasks = task; };

/** Force/rerun gate shared with the hub sync loop (cli drives beginRun/endRun/bind). */
export const hubSyncGate = new SyncGate();
export const requestHubSync = (opts?: { force?: boolean }): void => {
  // 返回 true = 现在就跑一轮(force 由 beginRun 消费);false = 已合并进补跑 / 等就绪。
  if (hubSyncGate.request(opts?.force)) void hubSyncTasks!({ force: hubSyncGate.beginRun() });
};

let hubRetryNode:
  | ((streamKey: string, node: WorkflowNodeKey, opts?: { force?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number }>)
  | undefined;
let hubStopJob:
  | ((streamKey: string) => Promise<{ ok: boolean; error?: string; code?: number }>)
  | undefined;
let hubAckJob:
  | ((streamKey: string, opts: { note?: string; undo?: boolean }) => { ok: boolean; error?: string; code?: number })
  | undefined;
let hubRunNow:
  | ((opts: { streamKey: string; winnerWorker?: string; wait?: boolean; force?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number; streamKey?: string; forceable?: boolean }>)
  | undefined;
/**
 * 远端排空能力探测(issue #569;hubStarter.start 注入)。master 在把 hub 源任务置停用前调用;
 * hub 未启动 / 未注入 → 返回失败(API 保持录制,不回退成硬停)。
 */
let hubProbeDrainSupport: ((workerIds: string[]) => Promise<{ ok: boolean; error?: string }>) | undefined;
export const setRetryNode = (fn: typeof hubRetryNode): void => { hubRetryNode = fn; };
export const setStopJob = (fn: typeof hubStopJob): void => { hubStopJob = fn; };
export const setAckJob = (fn: typeof hubAckJob): void => { hubAckJob = fn; };
export const setRunNow = (fn: typeof hubRunNow): void => { hubRunNow = fn; };
export const setProbeDrainSupport = (fn: typeof hubProbeDrainSupport): void => { hubProbeDrainSupport = fn; };
/** Drop pending sync requests on hub stop so a later request cannot hit the stopped runner. */
export const unbindSyncGate = (): void => { hubSyncGate.unbind(); };
export const requestHubProbeDrainSupport = async (
  workerIds: string[],
): Promise<{ ok: boolean; error?: string }> => (hubProbeDrainSupport
  ? hubProbeDrainSupport(workerIds)
  : { ok: false, error: "hub 未启动" });
let hubRecordingSnapshot = new Map<string, RecordingWorkerStatusDTO[]>();
export const setRecordingSnapshot = (next: Map<string, RecordingWorkerStatusDTO[]>): void => { hubRecordingSnapshot = next; };
/** Raw snapshot values (read-only use: "is any remote node recording right now"). */
export const recordingSnapshotValues = (): RecordingWorkerStatusDTO[] => [...hubRecordingSnapshot.values()].flat();
/** Zero-disk side-node status snapshot (issue #331); replaced wholesale on each hub sync tick, display only. */
let hubZeroDiskSnapshot = new Map<string, ZeroDiskNodeStatusDTO[]>();
export const setZeroDiskSnapshot = (next: Map<string, ZeroDiskNodeStatusDTO[]>): void => { hubZeroDiskSnapshot = next; };
 let hubZeroDiskLive: ((platform: string, roomSlug: string) => Array<{
  workerId: string; workerName: string;
  current?: import("@drec/core").LiveUploadSnapshot;
  previous?: import("@drec/core").LiveUploadSnapshot;
  history?: import("@drec/core").LiveUploadSnapshot[];
}>) | undefined;
export type ZeroDiskLiveProvider = (platform: string, roomSlug: string) => Array<{
  workerId: string; workerName: string;
  current?: import("@drec/core").LiveUploadSnapshot;
  previous?: import("@drec/core").LiveUploadSnapshot;
  history?: import("@drec/core").LiveUploadSnapshot[];
}>;
export const setZeroDiskLive = (provider: ZeroDiskLiveProvider | undefined): void => { hubZeroDiskLive = provider; };
/** 各节点边录边传的实时进度(F1;随 5 秒状态轮询整体替换,只读展示)。 */
let hubDeliverySnapshot: RollingDeliveryDTO[] = [];
export const setDeliverySnapshot = (next: RollingDeliveryDTO[]): void => { hubDeliverySnapshot = next; };
/** probeAllWorkers 的结果缓存 TTL。 */
export const PROBE_CACHE_MS = 30_000;
export const readRollingDelivery = (): RollingDeliveryDTO[] => hubDeliverySnapshot;
export const recordingSnapshotKey = (platform: string, roomSlug: string): string => `${platform}:${roomSlug}`;

/**
 * Issue #481: the rule file stem is the identity, but the SOURCE TASK decides which room is actually synced.
 * A divergent stem (rule.room edited / task room edited after creation) must not drop the room from desired —
 * that would make task-sync delete the remote managed task. Warn once per (stem -> task room) pair.
 */
const warnedRuleIdentity = new Set<string>();
export const warnRuleIdentityMismatch = (
  rule: { key: string; platform: string; roomSlug: string },
  sync: { platform: string; roomSlug: string; mismatched: boolean },
  warn: (m: string) => void,
): void => {
  if (!sync.mismatched) return;
  const token = `${rule.key}->${sync.platform}.${sync.roomSlug}`;
  if (warnedRuleIdentity.has(token)) return;
  warnedRuleIdentity.add(token);
  warn(`[hub] 规则 ${rule.key} 的 stem(${rule.platform}.${rule.roomSlug})与绑定源任务房间(${sync.platform}.${sync.roomSlug})不一致;按源任务房间继续同步`);
};
export const readRecordingWorkers = (platform: string, roomSlug: string): RecordingWorkerStatusDTO[] =>
  hubRecordingSnapshot.get(recordingSnapshotKey(platform, roomSlug)) ?? [];
export const readZeroDiskStatus = (platform: string, roomSlug: string): ZeroDiskNodeStatusDTO[] =>
  hubZeroDiskSnapshot.get(recordingSnapshotKey(platform, roomSlug)) ?? [];
export const readZeroDiskLive = (platform: string, roomSlug: string): Array<{
  workerId: string; workerName: string;
  current?: import("@drec/core").LiveUploadSnapshot;
  previous?: import("@drec/core").LiveUploadSnapshot;
  history?: import("@drec/core").LiveUploadSnapshot[];
}> => hubZeroDiskLive?.(platform, roomSlug) ?? [];
/** master 资源池快照提供者(由 hubStarter.start 注入,读同一 ResourcePool 实例);未启动 → undefined。 */
let hubPoolSnapshot: (() => HubPoolSnapshotDTO) | undefined;
/** Blocked-broadcast provider (injected by hubStarter.start from the live Reconciler); hub not started → empty. */
let hubBlockedBroadcasts: (() => HubBlockedBroadcastDTO[]) | undefined;
export const setPoolProviders = (providers: { poolSnapshot?: () => HubPoolSnapshotDTO; blockedBroadcasts?: () => HubBlockedBroadcastDTO[] }): void => {
  hubPoolSnapshot = providers.poolSnapshot;
  hubBlockedBroadcasts = providers.blockedBroadcasts;
};
export const readBlockedBroadcasts = (): HubBlockedBroadcastDTO[] => hubBlockedBroadcasts?.() ?? [];
export const readPoolSnapshot = (): HubPoolSnapshotDTO | undefined => hubPoolSnapshot?.();
/**
 * Master-side sync receipt settings (expected version / last sync error).
 * Hub start injects the live TaskStore; undefined until hub starts.
 */
let hubReceiptSettings: Pick<TaskStore, "getSetting" | "setSetting"> | undefined;
export const setReceiptSettings = (store: Pick<TaskStore, "getSetting" | "setSetting"> | undefined): void => { hubReceiptSettings = store; };
export const getReceiptSettings = (): Pick<TaskStore, "getSetting" | "setSetting"> | undefined => hubReceiptSettings;
/** web API → hubStarter.retryNode 的统一入口(hub 未启动 → 400)。 */
export const requestHubRetryNode = async (
  streamKey: string,
  node: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; error?: string; code?: number }> => {
  if (!hubRetryNode) return { ok: false, error: "hub 未启动", code: 400 };
  return hubRetryNode(streamKey, node as WorkflowNodeKey, opts);
};
export const requestHubStopJob = async (
  streamKey: string,
): Promise<{ ok: boolean; error?: string; code?: number }> => {
  if (!hubStopJob) return { ok: false, error: "hub 未启动", code: 400 };
  return hubStopJob(streamKey);
};
export const requestHubAckJob = async (
  streamKey: string,
  opts: { note?: string; undo?: boolean },
): Promise<{ ok: boolean; error?: string; code?: number }> => {
  if (!hubAckJob) return { ok: false, error: "hub 未启动", code: 400 };
  return hubAckJob(streamKey, opts);
};
/**
 * web API → 节点日志代查的统一入口(F3)。
 *
 * 每次现读 hub.config.json 找 worker(与 probeAllWorkers 同源)→ 建 scoped transport → 读日志。
 * **刻意不缓存结果**:日志就是要看最新的;一次点击一条 ssh,代价可接受。
 *
 * 本机(local)worker 直接回提示:它的日志就在 master 自己的任务详情页,F3 要解决的是
 * 「远端节点要登机器看网页」,本机代查没有意义。
 */
export const requestNodeTaskLogs = async (workerId: string, taskId: number, lines: number): Promise<NodeTaskLogsDTO> => {
  const { SshTransport } = await import("@drec/orchestrator");
  const { workerStore, rootHubConfig } = await import("@drec/app");
  const w = workerStore.listWorkers(rootHubConfig()).find((x) => x.id === workerId);
  if (!w) return { workerId, taskId, lines: [], error: `未配置的 worker id: ${workerId}` };
  if (w.kind === "local") return { workerId, taskId, lines: [], error: "本机节点:日志就在 master 的任务详情页" };
  const t = new SshTransport({ id: w.id, host: w.host!, dataRoot: w.dataRoot!, fleet: fleetLink });
  try {
    const r = await t.taskLogs(taskId, lines);
    return { workerId, taskId, lines: r.lines, ...(r.error ? { error: r.error } : {}) };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    // 旧 bundle 没有该隐藏命令 → 说清楚是「节点版本旧」,别让用户以为是网络问题。
    const unsupported = /unknown command|未知命令/i.test(msg);
    return { workerId, taskId, lines: [], error: unsupported ? "节点 bundle 过旧,不支持日志代查(需升级节点)" : msg };
  }
};

/** web API → 读某节点的任务清单(F3)。与日志代查同一取舍:现读配置、不缓存。 */
export const requestNodeTasks = async (workerId: string): Promise<NodeTasksDTO> => {
  const { SshTransport } = await import("@drec/orchestrator");
  const { workerStore, rootHubConfig } = await import("@drec/app");
  const w = workerStore.listWorkers(rootHubConfig()).find((x) => x.id === workerId);
  if (!w) return { workerId, tasks: [], error: `未配置的 worker id: ${workerId}` };
  if (w.kind === "local") return { workerId, tasks: [], error: "本机节点:日志就在 master 的任务详情页" };
  const t = new SshTransport({ id: w.id, host: w.host!, dataRoot: w.dataRoot!, fleet: fleetLink });
  try {
    const r = await t.listTasks();
    return { workerId, tasks: r.tasks };
  } catch (e) {
    return { workerId, tasks: [], error: (e as Error)?.message ?? String(e) };
  }
};

/**
 * 主控拉取某个节点的通知发件箱(issue #405)。
 * 本机节点直接读本地库;远端走既有 SSH 通道,不开新端口。
 */
export const requestNotifyOutbox = async (
  workerId: string,
  after: number,
  limit: number,
  ackIds: number[] = [],
): Promise<Array<{ id: number; at: number; taskId: number | null; room: string | null; wantWebhook: boolean; event: import("@drec/core").NotifyEvent }>> => {
  const { workerStore, rootHubConfig, NotifyOutbox, drecRoot } = await import("@drec/app");
  const w = workerStore.listWorkers(rootHubConfig()).find((x) => x.id === workerId);
  if (!w) return [];
  if (w.kind === "local") {
    const box = new NotifyOutbox(`${w.dataRoot ?? drecRoot()}/db/notify-outbox.db`);
    try {
      if (ackIds.length > 0) box.ack(ackIds);
      return box.list(after, limit);
    } finally {
      box.close();
    }
  }
  const { SshTransport } = await import("@drec/orchestrator");
  const t = new SshTransport({ id: w.id, host: w.host!, dataRoot: w.dataRoot!, fleet: fleetLink });
  const rows = await t.notifyOutbox(after, limit, ackIds);
  return (rows ?? []) as Array<{ id: number; at: number; taskId: number | null; room: string | null; wantWebhook: boolean; event: import("@drec/core").NotifyEvent }>;
};

export const requestHubRunNow = async (
  opts: { streamKey: string; winnerWorker?: string; wait?: boolean; force?: boolean },
): Promise<{ ok: boolean; error?: string; code?: number; streamKey?: string; forceable?: boolean }> => {
  if (!hubRunNow) return { ok: false, error: "hub 未启动", code: 400 };
  return hubRunNow(opts);
};

