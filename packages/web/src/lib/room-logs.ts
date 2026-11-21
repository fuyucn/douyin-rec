/** Room-only log projection; no new server model and no inferred cross-node clock. */
import type { NodeTaskLogsDTO, NodeTasksDTO, RoomDTO, WorkerDTO } from "../api/client";
import { isWorkerAssigned } from "../../../core/src/capabilities.js";

export const ROOM_LOG_MAX_LINES = 500;
export interface RoomLogSource {
  id: string;
  name: string;
  kind: "local" | "worker" | "missing";
  workerId?: string;
  taskId?: number;
}
export type RoomLogStatus = "loading" | "ready" | "empty" | "unavailable" | "unsupported" | "noTask" | "ambiguous" | "missing";
export interface RoomLogResult {
  source: RoomLogSource;
  status: RoomLogStatus;
  lines: string[];
  error?: string;
}
export interface RoomLogClient {
  getTaskLogs(id: number): Promise<{ lines: string[] }>;
  getNodeTasks(workerId: string): Promise<NodeTasksDTO>;
  getNodeTaskLogs(workerId: string, taskId: number, lines: number): Promise<NodeTaskLogsDTO>;
}

/** Always show the local reader once. Only assigned remote workers are queried. */
export function roomLogSources(room: RoomDTO, workers: WorkerDTO[], nodes: boolean): RoomLogSource[] {
  const sources: RoomLogSource[] = [{ id: "local", name: "", kind: "local", taskId: room.recording?.taskId ?? undefined }];
  const rule = room.processing;
  if (!nodes || !rule) return sources;
  const seen = new Set<string>();
  for (const worker of workers) {
    if (seen.has(worker.id)) continue;
    seen.add(worker.id);
    if (worker.kind === "local" || !isWorkerAssigned(rule, worker.id, worker.capabilities)) continue;
    sources.push({ id: `worker:${worker.id}`, name: worker.name || worker.id, kind: "worker", workerId: worker.id });
  }
  // A dangling explicit assignment must not silently look like a successful empty node.
  if (rule.enabled !== false) for (const id of rule.workers ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    sources.push({ id: `worker:${id}`, name: id, kind: "missing", workerId: id });
  }
  return sources;
}

export function matchRoomLogTask(tasks: NodeTasksDTO["tasks"], room: Pick<RoomDTO, "platform" | "roomSlug">):
  { status: "matched"; taskId: number } | { status: "noTask" | "ambiguous" } {
  const matches = tasks.filter((task) => task.platform === room.platform && task.roomSlug === room.roomSlug);
  if (matches.length !== 1) return { status: matches.length ? "ambiguous" : "noTask" };
  return { status: "matched", taskId: matches[0].id };
}

export function roomLogFailure(source: RoomLogSource, reason: unknown): RoomLogResult {
  const error = reason instanceof Error ? reason.message : String(reason);
  const unsupported = /unknown command|未知命令|过旧|不支持|unsupported|not supported/i.test(error);
  return { source, status: unsupported ? "unsupported" : "unavailable", lines: [], error };
}

async function readSource(source: RoomLogSource, room: Pick<RoomDTO, "platform" | "roomSlug">, client: RoomLogClient): Promise<RoomLogResult> {
  if (source.kind === "missing") return { source, status: "missing", lines: [] };
  let response: { lines: string[]; error?: string };
  if (source.kind === "local") {
    if (source.taskId == null) return { source, status: "noTask", lines: [] };
    response = await client.getTaskLogs(source.taskId);
  } else {
    const tasks = await client.getNodeTasks(source.workerId!);
    if (tasks.error) return roomLogFailure(source, tasks.error);
    const match = matchRoomLogTask(tasks.tasks, room);
    if (match.status !== "matched") return { source, status: match.status, lines: [] };
    response = await client.getNodeTaskLogs(source.workerId!, match.taskId, ROOM_LOG_MAX_LINES);
  }
  if (response.error) return roomLogFailure(source, response.error);
  const lines = response.lines.slice(-ROOM_LOG_MAX_LINES);
  return { source, status: lines.length ? "ready" : "empty", lines };
}

/**
 * Effect-scoped reader: cleanup invalidates every pending reply, including A -> B -> A navigation.
 * Results publish independently; a slow source neither hides nor blocks refreshing healthy ones.
 */
export function createRoomLogReader(sources: RoomLogSource[], room: Pick<RoomDTO, "platform" | "roomSlug">,
  client: RoomLogClient, publish: (result: RoomLogResult) => void): { refresh: () => Promise<unknown>; cancel: () => void } {
  let active = true;
  const pending = new Set<string>();
  return {
    cancel: () => { active = false; },
    refresh: () => Promise.allSettled(sources.map(async (source) => {
      if (!active || pending.has(source.id)) return;
      pending.add(source.id);
      try {
        const result = await readSource(source, room, client);
        if (active) publish(result);
      } catch (error) {
        if (active) publish(roomLogFailure(source, error));
      } finally {
        pending.delete(source.id);
      }
    })),
  };
}

/** Only full ISO dates WITH an explicit timezone are comparable across nodes. Time-only / naive dates are not. */
export function roomLogTimestamp(line: string): number | null {
  const iso = line.match(/^\s*\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))(?=\]|\s|$)/)?.[1];
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

export interface RoomLogEntry { source: RoomLogSource; text: string }
/** Filter first, cap the actual displayed lines. Unknown timestamps keep ALL lines source-grouped. */
export function mergeRoomLogs(results: RoomLogResult[], sourceId: string | null, limit: number):
  { entries: RoomLogEntry[]; mode: "time" | "grouped"; total: number } {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.min(ROOM_LOG_MAX_LINES, Math.trunc(limit))) : 200;
  const groups = results.filter((r) => sourceId === null || r.source.id === sourceId)
    .map((r) => r.lines.map((text) => ({ source: r.source, text, time: roomLogTimestamp(text) })));
  const all = groups.flat();
  const timed = all.length > 0 && all.every((entry) => entry.time !== null);
  if (timed) {
    all.sort((a, b) => a.time! - b.time!);
    return { entries: cap ? all.slice(-cap) : [], mode: "time", total: all.length };
  }
  // Share a grouped tail's budget across sources, rather than letting the last worker erase the hub.
  const counts = groups.map(() => 0);
  let remaining = Math.min(cap, all.length);
  while (remaining > 0) for (let i = 0; i < groups.length && remaining > 0; i++) {
    if (counts[i] < groups[i].length) { counts[i]++; remaining--; }
  }
  return { entries: groups.flatMap((group, i) => counts[i] ? group.slice(-counts[i]) : []), mode: "grouped", total: all.length };
}
