/**
 * runtime-tree.ts — pure derivation of the room runtime responsibility tree (issue #398).
 *
 * The tree answers four questions with data the console already has: which run is current, who is
 * recording, what stage that node is on, and what the hub is doing. It is deliberately read-only and
 * derived — no synthetic progress, no guesses. Stages with no observable source stay `unknown`.
 *
 * Kept pure so the stage/mode mapping can be unit tested without a browser.
 */
import type {
  QueueItemDTO,
  RollingDeliveryDTO,
  RoomDTO,
  Task,
  TaskDetail,
  WorkerDTO,
  WorkerStatus,
} from "../api/client";
import { pipelineBurns } from "@drec/rolling-policy";
import type { LiveDetailEntry } from "./zero-disk-status";

export type RuntimeMode = "live-direct" | "rolling" | "node-upload" | "upload" | "archive";
export type NodeRole = "winner" | "candidate" | "standby" | "controller";
export type NodeState = "recording" | "uploading" | "syncing" | "idle" | "offline" | "unknown";
export type StageState = "done" | "running" | "waiting" | "failed" | "skipped" | "unknown";
export type RuntimeStageKey =
  | "record"
  | "transfer"
  | "merge"
  | "burn"
  | "upload"
  | "confirm"
  | "cleanup"
  | "select"
  | "ledger"
  | "segmentUpload"
  | "reconcile";

export type RuntimeNote =
  | { kind: "recording" }
  | { kind: "recorded" }
  | { kind: "part"; part: number; uploadedMiB?: number; capMiB?: number }
  | { kind: "partsConfirmed"; count: number }
  | { kind: "winner"; name: string }
  | { kind: "runState"; state: string }
  | { kind: "confirmedBv"; bv: string }
  | { kind: "failed"; reason?: string }
  | { kind: "ambiguous"; count: number }
  | { kind: "segmentConfirmed"; confirmed: number; total: number }
  | { kind: "skipped"; reason: "noMerge" | "noBurn" | "noUpload" }
  | { kind: "noData" };

export interface RuntimeStage {
  key: RuntimeStageKey;
  state: StageState;
  note?: RuntimeNote;
}

export interface RuntimeNode {
  id: string;
  name: string;
  role: NodeRole;
  state: NodeState;
  version?: string;
  diskFreeGB?: number;
  stages: RuntimeStage[];
}

export interface RuntimeEvent {
  at: number;
  kind: string;
  part?: number;
  uploadedBytes?: number;
}

export interface RuntimeTreeModel {
  mode: RuntimeMode;
  startedAt: number | null;
  elapsedMs: number | null;
  bvid: string | null;
  overall: "live" | "running" | "done" | "attention" | "waiting";
  winnerId: string | null;
  winnerName: string | null;
  nodes: RuntimeNode[];
  events: RuntimeEvent[];
  totals: { nodes: number; recording: number };
  /** Real upload facts for the telemetry strip. */
  upload: { part: number; uploadedMiB: number; confirmed: number } | null;
}

export interface RuntimeTreeInput {
  room: RoomDTO;
  task?: Task;
  detail?: TaskDetail | null;
  workers: WorkerDTO[];
  workerStatus?: WorkerStatus[];
  rolling?: RollingDeliveryDTO[];
  queueItem?: QueueItemDTO | null;
  live?: LiveDetailEntry[];
  /** Latest hub run state for this room (already loaded by the room page). */
  run?: { state: string; bv: string | null } | null;
}

const MiB = 1024 * 1024;

/** Which high-level delivery mode this room is configured for. */
export function runtimeMode(room: RoomDTO, task?: Task): RuntimeMode {
  const upload = room.processing?.pipeline?.upload;
  // The room's recording projection is derived from the same task, so either source is authoritative;
  // a stale task object must not hide a live-direct room.
  const streamUpload = task?.streamUpload === true || room.recording?.streamUpload === true;
  if (streamUpload) return "live-direct";
  if (upload?.mode === "rolling") return "rolling";
  if (upload?.mode === "upload") {
    // Node-side upload is ignored by the backend whenever burn-in is on (burn flags default to ON).
    const steps = room.processing?.pipeline?.steps;
    return steps?.nodeSideUpload && !pipelineBurns(steps) ? "node-upload" : "upload";
  }
  return "archive";
}

/** Hub DAG steps that represent each semantic stage. */
const STAGE_STEPS: Record<RuntimeStageKey, string[]> = {
  record: [],
  transfer: ["pull"],
  merge: ["merge"],
  burn: ["burn_danmu", "burn_livechat"],
  upload: ["upload_plain", "append_danmu", "append_livechat", "node_upload"],
  confirm: ["upload_plain", "append_danmu", "append_livechat"],
  cleanup: ["clean_source", "clean_stage", "clean_stage_src", "clean_verify"],
  select: ["select"],
  ledger: [],
  segmentUpload: [],
  reconcile: [],
};

/** Resolve one semantic stage from the queue item's real step records. */
function stageFromSteps(item: QueueItemDTO, key: RuntimeStageKey): StageState {
  const names = STAGE_STEPS[key];
  if (names.length === 0) return "unknown";
  const done = item.doneSteps.filter((s) => names.includes(s.step));
  if (done.some((s) => s.phase === "done")) return "done";
  if (done.length > 0 && done.every((s) => s.phase === "skipped")) return "skipped";
  if (item.currentNode && names.includes(item.currentNode)) {
    const failed = item.state === "failed" || item.state === "needs_manual" || item.phase === "failed";
    return failed ? "failed" : "running";
  }
  if (item.nextSteps.some((n) => names.includes(n))) return "waiting";
  return "unknown";
}

function needsBurn(room: RoomDTO): boolean {
  return pipelineBurns(room.processing?.pipeline?.steps);
}

function mergeSegments(room: RoomDTO): boolean {
  return room.processing?.pipeline?.steps?.mergeSegments !== false;
}

/** Hub-side stage chain for the file-based modes (pull / node-side upload / stage). */
function hubPipelineStages(room: RoomDTO, mode: RuntimeMode, item: QueueItemDTO | null | undefined, run: RuntimeTreeInput["run"]): RuntimeStage[] {
  const uploadMode = room.processing?.pipeline?.upload?.mode ?? "stage";
  const stages: RuntimeStage[] = [];
  const push = (key: RuntimeStageKey, state: StageState, note?: RuntimeNote): void => {
    stages.push(note ? { key, state, note } : { key, state });
  };

  const select = item ? stageFromSteps(item, "select") : run ? "done" : "waiting";
  push("select", select, item?.winnerWorker ? { kind: "winner", name: item.winnerWorker } : undefined);

  if (mode !== "node-upload") {
    push("transfer", item ? stageFromSteps(item, "transfer") : "unknown");
  }

  if (mergeSegments(room)) {
    push("merge", item ? stageFromSteps(item, "merge") : "unknown");
  } else {
    push("merge", "skipped", { kind: "skipped", reason: "noMerge" });
  }

  if (needsBurn(room)) {
    push("burn", item ? stageFromSteps(item, "burn") : "unknown");
  } else {
    push("burn", "skipped", { kind: "skipped", reason: "noBurn" });
  }

  if (uploadMode === "stage") {
    push("upload", "skipped", { kind: "skipped", reason: "noUpload" });
  } else {
    const uploadState = item ? stageFromSteps(item, "upload") : run?.state === "done" ? "done" : run ? "running" : "waiting";
    push("upload", uploadState, run?.bv ? { kind: "confirmedBv", bv: run.bv } : undefined);
  }

  push("cleanup", item ? stageFromSteps(item, "cleanup") : "unknown");
  return stages;
}

function nodeStateFromWorker(
  workerId: string,
  task: Task | undefined,
  liveByWorker: Map<string, LiveDetailEntry[]>,
  rollingByWorker: Map<string, RollingDeliveryDTO[]>,
): NodeState {
  const zero = task?.zeroDisk?.find((z) => z.workerId === workerId);
  if (zero?.state === "offline" || zero?.state === "unsupported") return "offline";
  const live = liveByWorker.get(workerId)?.find((e) => e.current)?.current;
  if (live && (live.state === "streaming" || live.state === "submitting")) return "uploading";
  if (live && live.state === "waiting") return "idle";
  const rolling = rollingByWorker.get(workerId) ?? [];
  if (rolling.some((r) => r.recording)) return "recording";
  const rec = task?.recordingWorkers?.find((w) => w.workerId === workerId);
  if (rec?.state === "recording") return "recording";
  if (rec?.state === "unavailable") return "offline";
  if (rec?.state === "not_recording") return "idle";
  if (!rec && !zero && rolling.length === 0) return "unknown";
  return "idle";
}

function liveStages(entry: LiveDetailEntry | undefined): RuntimeStage[] {
  const snap = entry?.current ?? entry?.previous;
  if (!snap) {
    return [
      { key: "record", state: "unknown", note: { kind: "noData" } },
      { key: "upload", state: "unknown", note: { kind: "noData" } },
      { key: "confirm", state: "unknown", note: { kind: "noData" } },
    ];
  }
  const active = snap.state === "waiting" || snap.state === "streaming" || snap.state === "submitting";
  const recordState: StageState = snap.state === "failed" ? "failed" : active ? "running" : "done";
  const current = snap.currentPart;
  const confirmed = snap.parts.filter((p) => p.phase === "confirmed").length;
  const uploadState: StageState = !current
    ? confirmed > 0 ? "done" : snap.state === "failed" ? "failed" : "waiting"
    : current.phase === "failed" ? "failed" : "running";
  const confirmState: StageState = current?.phase === "submitting"
    ? "running"
    : confirmed > 0
      ? "done"
      : snap.state === "failed"
        ? "failed"
        : "waiting";
  const partNote: RuntimeNote | undefined = current
    ? {
      kind: "part",
      part: current.index + 1,
      ...(current.uploadedBytes > 0 ? { uploadedMiB: current.uploadedBytes / MiB } : {}),
      ...(current.bytes ? { capMiB: current.bytes / MiB } : {}),
    }
    : undefined;
  return [
    { key: "record", state: recordState, note: active ? { kind: "recording" } : { kind: "recorded" } },
    { key: "upload", state: uploadState, ...(partNote ? { note: partNote } : {}) },
    {
      key: "confirm",
      state: confirmState,
      note: confirmed > 0 ? { kind: "partsConfirmed", count: confirmed } : { kind: "noData" },
    },
  ];
}

function rollingStages(rows: RollingDeliveryDTO[]): RuntimeStage[] {
  if (rows.length === 0) {
    return [
      { key: "record", state: "unknown", note: { kind: "noData" } },
      { key: "segmentUpload", state: "unknown", note: { kind: "noData" } },
    ];
  }
  const recording = rows.some((r) => r.recording);
  const uploading = rows.find((r) => r.uploading);
  const confirmed = rows.reduce((n, r) => n + r.confirmed, 0);
  const total = rows.reduce((n, r) => n + r.total, 0);
  const ambiguous = rows.reduce((n, r) => n + r.ambiguous, 0);
  const confirmedAll = total > 0 && confirmed >= total && !uploading;
  return [
    { key: "record", state: recording ? "running" : "done", note: recording ? { kind: "recording" } : { kind: "recorded" } },
    {
      key: "segmentUpload",
      state: uploading ? "running" : confirmed > 0 ? "done" : "waiting",
      note: uploading
        ? { kind: "part", part: uploading.uploading!.index + 1 }
        : { kind: "segmentConfirmed", confirmed, total },
    },
    {
      key: "confirm",
      state: ambiguous > 0 ? "failed" : confirmedAll ? "done" : uploading ? "running" : "waiting",
      note: ambiguous > 0 ? { kind: "ambiguous", count: ambiguous } : { kind: "segmentConfirmed", confirmed, total },
    },
    { key: "cleanup", state: "unknown" },
  ];
}

function workerPipelineStages(mode: RuntimeMode, state: NodeState, item: QueueItemDTO | null | undefined): RuntimeStage[] {
  const recordState: StageState = state === "recording" || state === "uploading"
    ? "running"
    : state === "offline"
      ? "failed"
      : state === "idle"
        ? "done"
        : "unknown";
  const record: RuntimeStage = recordState === "running"
    ? { key: "record", state: "running", note: { kind: "recording" } }
    : { key: "record", state: recordState === "done" ? "waiting" : recordState };
  if (mode === "node-upload") {
    return [
      record,
      { key: "merge", state: item ? stageFromSteps(item, "merge") : "unknown" },
      { key: "upload", state: item ? stageFromSteps(item, "upload") : "unknown" },
      { key: "confirm", state: item?.phase === "done" ? "done" : item ? "running" : "unknown" },
    ];
  }
  return [record, { key: "transfer", state: "unknown" }];
}

function hubLiveStages(entry: LiveDetailEntry | undefined, item: QueueItemDTO | null | undefined, run: RuntimeTreeInput["run"]): RuntimeStage[] {
  if (item) {
    const state = item.phase === "done" ? "done" : item.state === "failed" || item.state === "needs_manual" ? "failed" : "running";
    return [{ key: "ledger", state, note: item.error ? { kind: "failed", reason: item.error } : undefined }];
  }
  const snap = entry?.current ?? entry?.previous;
  if (!snap) return [{ key: "ledger", state: run?.state === "done" ? "done" : "waiting" }];
  const active = snap.state === "waiting" || snap.state === "streaming" || snap.state === "submitting";
  const state: StageState = snap.state === "failed" ? "failed" : active ? "running" : "done";
  return [{ key: "ledger", state }];
}

function hubRollingStages(rows: RollingDeliveryDTO[]): RuntimeStage[] {
  if (rows.length === 0) return [{ key: "reconcile", state: "waiting" }];
  const recording = rows.some((r) => r.recording);
  const ambiguous = rows.reduce((n, r) => n + r.ambiguous, 0);
  return [{
    key: "reconcile",
    state: ambiguous > 0 ? "failed" : recording ? "running" : "done",
    ...(ambiguous > 0 ? { note: { kind: "ambiguous" as const, count: ambiguous } } : {}),
  }];
}

function nodeVersion(status: WorkerStatus | undefined): string | undefined {
  return status?.appVersion;
}

function overallOf(nodes: RuntimeNode[], run: RuntimeTreeInput["run"]): RuntimeTreeModel["overall"] {
  if (nodes.some((n) => n.state === "recording" || n.state === "uploading")) return "live";
  if (nodes.some((n) => n.stages.some((s) => s.state === "running"))) return "running";
  if (run?.state === "failed" || run?.state === "needs_manual") return "attention";
  if (run?.state === "done") return "done";
  return "waiting";
}

/** Deduplicate identical live events across the current and previous snapshots. */
function collectEvents(entries: LiveDetailEntry[]): RuntimeEvent[] {
  const seen = new Set<string>();
  const out: RuntimeEvent[] = [];
  for (const entry of entries) {
    for (const snap of [entry.current, entry.previous]) {
      if (!snap) continue;
      for (const ev of snap.events) {
        const key = `${ev.at}|${ev.kind}|${ev.part ?? ""}|${ev.uploadedBytes ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          at: ev.at,
          kind: ev.kind,
          ...(ev.part !== undefined ? { part: ev.part } : {}),
          ...(ev.uploadedBytes !== undefined ? { uploadedBytes: ev.uploadedBytes } : {}),
        });
      }
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 12);
}

/** Build the full tree model from the room page's already-loaded data. */
export function buildRuntimeTree(input: RuntimeTreeInput): RuntimeTreeModel {
  const { room, task, detail, workers, workerStatus = [], rolling = [], live = [], run } = input;
  // A finished/failed queue row belongs to a previous run: it must not decide the current winner or stages.
  const queueItem = input.queueItem && input.queueItem.phase !== "done" && input.queueItem.phase !== "failed" ? input.queueItem : null;
  const mode = runtimeMode(room, task);
  const liveByWorker = new Map<string, LiveDetailEntry[]>();
  for (const entry of live) {
    const list = liveByWorker.get(entry.workerId) ?? [];
    list.push(entry);
    liveByWorker.set(entry.workerId, list);
  }
  const rollingByWorker = new Map<string, RollingDeliveryDTO[]>();
  for (const row of rolling) {
    if (!row.workerId) continue;
    const list = rollingByWorker.get(row.workerId) ?? [];
    list.push(row);
    rollingByWorker.set(row.workerId, list);
  }
  const statusById = new Map(workerStatus.map((s) => [s.id, s]));
  const nameById = new Map(workers.map((w) => [w.id, w.name]));

  // Worker ids to show: everything the task/rule already references, in stable order.
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (id: string | null | undefined): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const w of task?.recordingWorkers ?? []) add(w.workerId);
  for (const z of task?.zeroDisk ?? []) add(z.workerId);
  for (const e of live) add(e.workerId);
  for (const r of rolling) add(r.workerId);
  for (const id of room.processing?.workers ?? []) add(id);

  const states = new Map<string, NodeState>();
  for (const id of ids) states.set(id, nodeStateFromWorker(id, task, liveByWorker, rollingByWorker));

  // Winner priority: the ledger's own winner, then an active live node, then a recording worker,
  // then a rolling row. No winner is reported when nothing is running — the UI shows "not selected".
  const winnerFromLive = [...live]
    .filter((e) => e.current && (e.current.state === "streaming" || e.current.state === "submitting"))
    .sort((a, b) => (b.current?.updatedAt ?? 0) - (a.current?.updatedAt ?? 0))[0]?.workerId;
  const winnerId = queueItem?.winnerWorker
    ?? winnerFromLive
    ?? ids.find((id) => states.get(id) === "recording")
    ?? rolling.find((r) => r.recording)?.workerId
    ?? null;
  const winnerName = winnerId ? nameById.get(winnerId) ?? winnerId : null;

  const workerNodes: RuntimeNode[] = ids.map((id) => {
    const state = states.get(id) ?? "unknown";
    const role: NodeRole = id === winnerId
      ? "winner"
      : state === "recording" || state === "uploading"
        ? "candidate"
        : "standby";
    let stages: RuntimeStage[];
    if (mode === "live-direct") {
      stages = liveByWorker.get(id) ? liveStages(liveByWorker.get(id)![0]) : [];
    } else if (mode === "rolling") {
      stages = rollingStages(rollingByWorker.get(id) ?? []);
    } else {
      stages = workerPipelineStages(mode, state, queueItem ?? null);
    }
    const status = statusById.get(id);
    const rec = task?.recordingWorkers?.find((w) => w.workerId === id);
    return {
      id,
      name: rec?.workerName ?? nameById.get(id) ?? id,
      role,
      state,
      ...(nodeVersion(status) ? { version: nodeVersion(status)! } : {}),
      ...(typeof status?.diskFreeGB === "number" ? { diskFreeGB: status.diskFreeGB } : {}),
      stages,
    };
  });

  const hubStages = mode === "live-direct"
    ? hubLiveStages(winnerId ? liveByWorker.get(winnerId)?.[0] ?? live[0] : live[0], queueItem, run)
    : mode === "rolling"
      ? hubRollingStages(rolling)
      : hubPipelineStages(room, mode, queueItem, run);
  const hub: RuntimeNode = {
    id: "hub",
    name: "hub",
    role: "controller",
    state: hubStages.some((s) => s.state === "running") ? "syncing" : "idle",
    stages: hubStages,
  };

  const nodes = [...workerNodes, hub];
  const liveSnap = live.find((e) => e.current)?.current ?? live[0]?.previous;
  const current = liveSnap?.currentPart;
  const confirmed = liveSnap?.parts.filter((p) => p.phase === "confirmed").length ?? 0;
  const events = collectEvents(live);

  return {
    mode,
    startedAt: detail?.runtime?.startedAt ?? null,
    elapsedMs: detail?.runtime?.elapsedMs ?? null,
    bvid: liveSnap?.bvid ?? run?.bv ?? task?.zeroDisk?.find((z) => z.bvid)?.bvid ?? null,
    overall: overallOf(nodes, run),
    winnerId,
    winnerName,
    nodes,
    events,
    totals: {
      nodes: nodes.length,
      recording: workerNodes.filter((n) => n.state === "recording" || n.state === "uploading").length,
    },
    upload: current
      ? {
        part: current.index + 1,
        uploadedMiB: current.uploadedBytes / MiB,
        confirmed,
      }
      : null,
  };
}
