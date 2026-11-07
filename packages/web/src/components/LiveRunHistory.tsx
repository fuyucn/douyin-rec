/**
 * LiveRunHistory — the finished live-upload runs of a room, one expandable row per run (issue #413).
 * The rows belong to the room's single run list (处理运行态), below the current run; each expands into the
 * same per-part tree a hub run uses. Data: the node's per-room history carried by the live detail endpoint.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Task, type WorkerDTO } from "../api/client";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { liveBroadcast, liveNode } from "../lib/run-tree";
import type { LiveDetailEntry } from "../lib/zero-disk-status";
import { LiveRunRow } from "./CurrentRunTree";

export function LiveRunHistory({ task, workers, onRowsChange }: {
  task: Task | undefined;
  workers: WorkerDTO[];
  /** Report how many rows this component renders, so the list's count and empty state follow the rendered rows. */
  onRowsChange?: (rows: number) => void;
}): ReactNode {
  const t = useT();
  const taskId = task?.id ?? null;
  // History outlives the broadcast, so it is read for any live-upload task, not only while a node is live.
  const live = !!task?.streamUpload;
  const [entries, setEntries] = useState<LiveDetailEntry[]>([]);
  const ref = useRef(taskId);
  useEffect(() => { ref.current = taskId; setEntries([]); }, [taskId]);
  usePolling(() => {
    if (taskId === null) return;
    const id = taskId;
    void api.getTaskLive(id).then((r) => { if (ref.current === id) setEntries(r.entries); }).catch(() => {});
  }, 30_000, live && taskId !== null);

  // A run that just ended is also the node's current run until the next one starts: the current row
  // already shows it, so skip it here.
  const shown = new Set(entries.flatMap((e) => (e.current?.sessionId ? [e.current.sessionId] : [])));
  const runs = entries
    .flatMap((e) => (e.history ?? []).filter((s) => !s.sessionId || !shown.has(s.sessionId)).map((s) => ({ e, s })))
    .sort((a, b) => b.s.startedAt - a.s.startedAt);
  useEffect(() => {
    onRowsChange?.(runs.length);
    return () => onRowsChange?.(0);
  }, [onRowsChange, runs.length]);
  if (runs.length === 0) return null;

  return (
    <>
      {runs.map(({ e, s }) => {
        const name = workers.find((w) => w.id === e.workerId)?.name ?? e.workerName ?? e.workerId;
        const state = liveBroadcast([s], (x) => x.state).state;
        return (
          <LiveRunRow
            key={`${e.workerId}:${s.sessionId ?? s.startedAt}`}
            title={new Date(s.startedAt).toLocaleString()}
            badge={t("room.runTree.historyBadge")}
            state={state}
            bv={s.bvid ?? null}
            nodes={[liveNode(s, e.workerId, name, "winner")]}
            defaultOpen={false}
          />
        );
      })}
    </>
  );
}
