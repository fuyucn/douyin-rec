/**
 * queue-live.ts — pure presentation model for the Queue live-operations view.
 *
 * The backend already supplies the facts. This module only groups them so the page can answer
 * "what is running", "what needs a person", and "what is history" without scanning every row.
 * It never fabricates progress or changes queue semantics.
 */
import type {
  HubBlockedBroadcastDTO,
  HubPoolSnapshotDTO,
  QueueItemDTO,
  RollingDeliveryDTO,
} from "../api/client";

export type AttentionKind =
  | "upload_unknown"
  | "part_unknown"
  | "stage_ready"
  | "node_failure"
  | "stopped"
  | "blocked"
  | "other";

export interface AttentionGroup {
  kind: AttentionKind;
  rows: QueueItemDTO[];
  blocked: HubBlockedBroadcastDTO[];
  /** Number of distinct rooms represented by this group. */
  rooms: number;
}

export interface QueueSections {
  live: QueueItemDTO[];
  attention: AttentionGroup[];
  stageReady: QueueItemDTO[];
  history: QueueItemDTO[];
  delivering: RollingDeliveryDTO[];
  blocked: HubBlockedBroadcastDTO[];
}

const LIVE_PHASES = new Set(["running", "queued", "waiting_settle"]);

/** Stable, deterministic ordering for the NOW section: active work first, then queue position/age. */
export function sortLive(rows: readonly QueueItemDTO[]): QueueItemDTO[] {
  const rank = (r: QueueItemDTO): number => (r.phase === "running" ? 0 : r.phase === "queued" ? 1 : 2);
  return [...rows].sort((a, b) =>
    rank(a) - rank(b)
    || (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER)
    || (a.enqueuedAt ?? a.updatedAt) - (b.enqueuedAt ?? b.updatedAt)
    || a.streamKey.localeCompare(b.streamKey),
  );
}

/** Classify a real-attention row by its operator-facing cause. */
export function attentionKindOf(row: QueueItemDTO): AttentionKind {
  if (row.phase === "stopped") return "stopped";
  if (row.phase === "waiting_upload") return "stage_ready";
  const err = row.error ?? "";
  // `node_upload` and node-side ssh failures are explicit; a master-side upload failure is not.
  if (/节点侧上传失败|ssh rc|ssh 超时/i.test(err)) return "node_failure";
  if (/节点已开始上传但结果未知|上传结果未知|结果不确定|uncertain/i.test(err)) return "upload_unknown";
  if (/不确定段|人工核对分\s*P|已建稿.*核对分\s*P|分\s*P\s*(数|数量).*(不符|缺失|待核对)/i.test(err)) return "part_unknown";
  return "other";
}

const ATTENTION_ORDER: AttentionKind[] = [
  "upload_unknown", "part_unknown", "node_failure", "blocked", "other", "stage_ready", "stopped",
];

/** Group attention rows by cause and count distinct rooms; stage-ready rows stay separate. */
export function groupAttention(rows: readonly QueueItemDTO[], blocked: readonly HubBlockedBroadcastDTO[]): AttentionGroup[] {
  const groups = new Map<AttentionKind, AttentionGroup>();
  const add = (kind: AttentionKind, row: QueueItemDTO): void => {
    const g = groups.get(kind) ?? { kind, rows: [], blocked: [], rooms: 0 };
    g.rows.push(row);
    groups.set(kind, g);
  };
  for (const row of rows) {
    if (row.phase === "done") continue;
    if (LIVE_PHASES.has(row.phase)) continue;
    if (row.phase === "waiting_upload") continue;
    if (row.phase === "waiting_manual" || row.phase === "stopped" || row.phase === "failed") add(attentionKindOf(row), row);
  }
  for (const b of blocked) {
    const g = groups.get("blocked") ?? { kind: "blocked", rows: [], blocked: [], rooms: 0 };
    g.blocked.push(b);
    groups.set("blocked", g);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      rooms: new Set([
        ...g.rows.map((r) => `${r.platform}:${r.roomSlug}`),
        ...g.blocked.map((b) => `${b.platform}:${b.roomSlug}`),
      ]).size,
    }))
    .sort((a, b) => ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind));
}

/**
 * Split one queue snapshot into live work, real attention, normal stage archives, and history.
 * `blocked` is promoted into attention because it is actionable even though no ledger row exists yet.
 */
export function splitQueue(
  rows: readonly QueueItemDTO[],
  delivering: readonly RollingDeliveryDTO[],
  blocked: readonly HubBlockedBroadcastDTO[],
): QueueSections {
  const live = sortLive(rows.filter((r) => LIVE_PHASES.has(r.phase)));
  const realAttention = rows.filter((r) => r.phase === "waiting_manual" || r.phase === "stopped" || r.phase === "failed");
  const stageReady = rows.filter((r) => r.phase === "waiting_upload");
  const history = rows.filter((r) => r.phase === "done");
  return {
    live,
    attention: groupAttention(realAttention, blocked),
    stageReady,
    history,
    delivering: [...delivering].sort((a, b) =>
      Number(b.recording) - Number(a.recording)
      || a.anchorName?.localeCompare(b.anchorName ?? "") || a.sessionBase.localeCompare(b.sessionBase)),
    blocked: [...blocked],
  };
}

/** Queue health summary; all values are direct counts from the snapshot. */
export function queueSummary(sections: QueueSections, pool: HubPoolSnapshotDTO | null): {
  live: number;
  attention: number;
  delivering: number;
  stageReady: number;
  history: number;
  activeSlots: number;
  maxSlots: number;
} {
  return {
    live: sections.live.length,
    attention: sections.attention.reduce((n, g) => n + g.rows.length + g.blocked.length, 0),
    delivering: sections.delivering.length,
    stageReady: sections.stageReady.length,
    history: sections.history.length,
    activeSlots: (pool?.cpu.active ?? 0) + (pool?.upload.active ?? 0),
    maxSlots: (pool?.cpu.max ?? 0) + (pool?.upload.windowLimit ?? 0),
  };
}

/** A compact, deterministic status label for a queue row (used by lanes and history). */
export function liveStepLabel(row: QueueItemDTO): string {
  if (row.phase === "queued") return row.resource ?? "queued";
  return row.currentNode ?? "preparing";
}
