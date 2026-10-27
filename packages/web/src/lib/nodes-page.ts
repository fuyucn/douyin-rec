/**
 * nodes-page.ts — pure model for the master Nodes page.
 *
 * Nodes is intentionally separate from Queue: it answers which controller/worker is healthy, what
 * it is assigned, and what sessions it currently carries. All data comes from existing APIs.
 */
import type { RoomDTO, Task, WorkerDTO, WorkerStatus } from "../api/client";
import { roomSlugOf, type NodeSummary, summarizeNodes } from "./nodes-summary";

export interface NodeRoomView {
  key: string;
  label: string;
  platform: string;
  roomSlug: string;
  state: "recording" | "waiting" | "unavailable" | "disabled";
  taskId: number | null;
  checkedAt?: number;
  sessions: NodeSummary["rooms"][number]["sessions"];
}

export interface NodeView extends Omit<NodeSummary, "rooms"> {
  rooms: NodeRoomView[];
  /** Number of assigned rooms that are not disabled. */
  activeRooms: number;
  /** Number of rooms with a recording process in this node. */
  recordingRooms: number;
  /** Number of rolling sessions still carrying ambiguous parts. */
  uncertainSessions: number;
}

const STATE_RANK: Record<NodeRoomView["state"], number> = {
  recording: 0,
  unavailable: 1,
  waiting: 2,
  disabled: 3,
};

/**
 * Build node cards from the same three sources used by Rooms and Queue:
 * task recording workers, worker health, and rolling-delivery snapshots.
 */
export function buildNodes(
  tasks: readonly Task[],
  rooms: readonly RoomDTO[],
  workers: readonly WorkerDTO[],
  status: Record<string, WorkerStatus | undefined>,
  delivering: Parameters<typeof summarizeNodes>[2],
  masterVersion: string,
): NodeView[] {
  const bySlug = new Map(rooms.map((r) => [`${r.platform}:${r.roomSlug}`, r]));
  const base = summarizeNodes(tasks, status, delivering, masterVersion, workers);
  const workerNames = new Map(workers.map((w) => [w.id, w.name || w.host || w.id]));
  // `summarizeNodes` only creates nodes referenced by tasks. A rolling session can outlive its task
  // row (or arrive before the task list refreshes), so seed those nodes here instead of hiding them.
  for (const d of delivering) {
    if (base.some((n) => n.id === d.workerId)) continue;
    const s = status[d.workerId];
    base.push({
      id: d.workerId,
      name: d.workerName || workerNames.get(d.workerId) || d.workerId,
      ok: s?.ok,
      error: s?.error,
      version: s?.appVersion,
      drift: false,
      diskFreeGB: typeof s?.diskFreeGB === "number" ? s.diskFreeGB : undefined,
      diskLow: false,
      diskMinGB: s?.diskMinGB,
      recording: 0,
      unavailable: 0,
      rollingSessions: 0,
      lockedBytes: 0,
      ambiguous: 0,
      rooms: [],
      appliedVersion: s?.appliedVersion,
      expectedVersion: s?.expectedVersion,
      appliedAt: s?.appliedAt,
      syncError: s?.syncError,
      syncLag: !!(s?.ok && s.expectedVersion != null && s.appliedVersion != null && s.expectedVersion !== s.appliedVersion),
    });
  }
  // Re-run only the delivery attachment for seeded nodes; summarizeNodes already attached task rooms.
  for (const n of base) {
    if (n.rollingSessions > 0) continue;
    for (const d of delivering) {
      if (d.workerId !== n.id) continue;
      n.rollingSessions++;
      n.lockedBytes += typeof d.lockedBytes === "number" ? d.lockedBytes : 0;
      n.ambiguous += d.ambiguous;
      const identity = `${d.workerId}:${d.platform}:${d.roomSlug}`;
      let row = n.rooms.find((r) => r.key === identity);
      if (!row) {
        row = {
          key: identity,
          platform: d.platform,
          roomSlug: d.roomSlug,
          label: d.anchorName || d.roomSlug,
          state: d.recording ? "recording" : "disabled",
          sessions: [],
        };
        n.rooms.push(row);
      }
      row.sessions.push(d);
    }
  }
  return base.map((n) => {
    const roomsOut: NodeRoomView[] = n.rooms.map((nr) => {
      const roomSlug = nr.roomSlug ?? nr.key.split(":").slice(2).join(":");
      const platform = nr.platform ?? "";
      const room = bySlug.get(`${platform}:${roomSlug}`);
      const task = tasks.find((t) => (t.platform ?? "") === platform && roomSlugOf(t.room) === roomSlug);
      return {
        key: nr.key,
        label: nr.label,
        platform: room?.platform ?? task?.platform ?? platform ?? "douyin",
        roomSlug,
        state: nr.state,
        taskId: task?.id ?? room?.recording?.taskId ?? null,
        checkedAt: nr.checkedAt,
        sessions: nr.sessions,
      };
    }).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.label.localeCompare(b.label));
    return {
      ...n,
      name: n.name || workerNames.get(n.id) || n.id,
      rooms: roomsOut,
      activeRooms: roomsOut.filter((r) => r.state !== "disabled").length,
      recordingRooms: roomsOut.filter((r) => r.state === "recording").length,
      uncertainSessions: roomsOut.reduce((sum, r) => sum + r.sessions.filter((s) => s.ambiguous > 0).length, 0),
    };
  }).sort((a, b) => {
    // Controller first, then healthy nodes, then offline nodes.
    if (a.id === "local") return -1;
    if (b.id === "local") return 1;
    const health = (n: NodeView): number => (n.ok === false ? 1 : n.ok === undefined ? 2 : 0);
    return health(a) - health(b) || a.name.localeCompare(b.name);
  });
}

/** Link a node room to its unified room detail when the slug is known. */
export function nodeRoomHref(room: Pick<NodeRoomView, "platform" | "roomSlug">): string {
  return `/rooms/${encodeURIComponent(`${room.platform}.${room.roomSlug}`)}`;
}

/** Human-facing node label: controller for `local`, otherwise configured name. */
export function nodeRoleLabel(id: string, t: (key: string) => string): string {
  return id === "local" ? t("nodes.role.controller") : t("nodes.role.worker");
}

/** Count the room states shown in a node header. */
export function nodeCounts(n: Pick<NodeView, "activeRooms" | "recordingRooms" | "unavailable">): {
  active: number;
  recording: number;
  unavailable: number;
} {
  return { active: n.activeRooms, recording: n.recordingRooms, unavailable: n.unavailable };
}
