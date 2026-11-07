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
  /** Connection target from the worker config (ssh/tailscale-ssh host); undefined = none configured. */
  host?: string;
  /** Worker-configured web entry (apiUrl); rendered as a quick link when set. */
  apiUrl?: string;
  /** Capability tags from the worker config (absent on old configs / unknown nodes). */
  capabilities?: string[];
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
  const workerCfg = new Map(workers.map((w) => [w.id, w]));
  const order = workers.map((w) => w.id);
  return base.map((n) => {
    const roomsOut: NodeRoomView[] = n.rooms.map((nr) => {
      const roomSlug = nr.roomSlug ?? nr.key.split(":").slice(2).join(":");
      const platform = nr.platform || "";
      const room = bySlug.get(`${platform}:${roomSlug}`);
      const task = tasks.find((t) => (t.platform ?? "") === platform && roomSlugOf(t.room) === roomSlug);
      return {
        key: nr.key,
        label: nr.label,
        platform: room?.platform || task?.platform || platform,
        roomSlug,
        state: nr.state,
        taskId: task?.id ?? room?.recording?.taskId ?? null,
        checkedAt: nr.checkedAt,
        sessions: nr.sessions,
      };
    }).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.label.localeCompare(b.label));
    const cfg = workerCfg.get(n.id);
    return {
      ...n,
      name: n.name || workerNames.get(n.id) || n.id,
      host: cfg?.host,
      apiUrl: cfg?.apiUrl,
      capabilities: cfg?.capabilities,
      rooms: roomsOut,
      activeRooms: roomsOut.filter((r) => r.state !== "disabled").length,
      recordingRooms: roomsOut.filter((r) => r.state === "recording").length,
      uncertainSessions: roomsOut.reduce((sum, r) => sum + r.sessions.filter((s) => s.ambiguous > 0).length, 0),
    };
  }).sort((a, b) => {
    // Display order = configured worker order (drag-reorder persists exactly this; the controller
    // card stays first). Inline reordering would be pointless if health/name re-sorted the cards.
    if (a.id === "local") return -1;
    if (b.id === "local") return 1;
    const rank = (n: NodeView): number => {
      const i = order.indexOf(n.id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
}

/** Link a node room to its unified room detail. Empty = identity is incomplete, so do not link. */
export function nodeRoomHref(room: Pick<NodeRoomView, "platform" | "roomSlug">): string {
  if (!room.platform || !room.roomSlug) return "";
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

/** Nodes with management actions: everything except the controller itself (never editable/deletable). */
export function nodeManagable(node: Pick<NodeView, "id">): boolean {
  return node.id !== "local";
}

/** Show connection info only when the worker config actually carries it (never render empty hints). */
export function nodeConnectionInfo(n: Pick<NodeView, "host" | "apiUrl">): { host?: string; apiUrl?: string } {
  return { host: n.host || undefined, apiUrl: n.apiUrl || undefined };
}
