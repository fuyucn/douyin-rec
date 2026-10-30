/**
 * LiveRunHistory — the finished live-upload runs of a room, one expandable tree per run (issue #413).
 * Sits in the room's run list next to the hub history, so a live-upload room reads like a multi-node one.
 * Data: the node's per-room history file, carried by the live detail endpoint (newest first).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Task, type WorkerDTO } from "../api/client";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { liveBroadcast, liveNode } from "../lib/run-tree";
import type { LiveDetailEntry } from "../lib/zero-disk-status";
import { RunTreeView, StatePill } from "./RunTree";

export function LiveRunHistory({ task, workers }: { task: Task | undefined; workers: WorkerDTO[] }): ReactNode {
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

  // A run that just ended is also the node's current run until the next one starts: CurrentRunTree shows it, so skip it here.
  const shown = new Set(entries.flatMap((e) => (e.current?.sessionId ? [e.current.sessionId] : [])));
  const runs = entries
    .flatMap((e) => (e.history ?? []).filter((s) => !s.sessionId || !shown.has(s.sessionId)).map((s) => ({ e, s })))
    .sort((a, b) => b.s.startedAt - a.s.startedAt);
  if (runs.length === 0) return null;

  return (
    <section className="run-list-shell mb-4">
      <div className="px-3 py-2.5 border-b border-hairline flex items-center justify-between">
        <span className="section-label">{t("room.runTree.liveHistory")}</span>
        <span className="font-mono text-[11px] text-muted-soft">{runs.length}</span>
      </div>
      <div className="p-1.5">
        {runs.map(({ e, s }) => {
          const name = workers.find((w) => w.id === e.workerId)?.name ?? e.workerName ?? e.workerId;
          const state = liveBroadcast([s], (x) => x.state).state;
          const when = new Date(s.startedAt).toLocaleString();
          return (
            <details key={`${e.workerId}:${s.sessionId ?? s.startedAt}`} className="px-1.5 py-1">
              <summary className="flex items-center justify-between gap-2 px-2 py-2 cursor-pointer text-sm">
                <span className="min-w-0 truncate">{when} · {name}</span>
                <span className="flex items-center gap-2 shrink-0">
                  {s.bvid && <span className="font-mono text-[11px] text-muted">{s.bvid}</span>}
                  <StatePill state={state} />
                </span>
              </summary>
              <div className="p-3">
                <RunTreeView
                  root={{ title: name, sub: when, state, bv: s.bvid ?? null }}
                  tree={{ kind: "parts", nodes: [liveNode(s, e.workerId, name, "winner")] }}
                />
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
