/**
 * CurrentRunTree — the running broadcast of a live-upload / rolling room as a per-part tree (issue #401).
 * Those modes have no hub run until the broadcast ends, so the data is the live snapshot / rolling progress.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type RollingDeliveryDTO, type Task, type WorkerDTO } from "../api/client";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { liveNode, rollingNode, type PartsNode } from "../lib/run-tree";
import type { LiveDetailEntry } from "../lib/zero-disk-status";
import { RunTreeView } from "./RunTree";

export function CurrentRunTree({ task, rolling, workers }: { task: Task | undefined; rolling: RollingDeliveryDTO[]; workers: WorkerDTO[] }): ReactNode {
  const t = useT();
  const taskId = task?.id ?? null;
  const live = !!task?.streamUpload && (task.zeroDisk ?? []).some((z) => z.live);
  const [entries, setEntries] = useState<LiveDetailEntry[]>([]);
  const ref = useRef(taskId);
  useEffect(() => { ref.current = taskId; setEntries([]); }, [taskId]);
  usePolling(() => {
    if (taskId === null) return;
    const id = taskId;
    void api.getTaskLive(id).then((r) => { if (ref.current === id) setEntries(r.entries); }).catch(() => {});
  }, 10_000, live && taskId !== null);

  const name = (id: string, fallback?: string): string => workers.find((w) => w.id === id)?.name ?? fallback ?? id;
  const nodes: PartsNode[] = [];
  if (live) {
    const snaps = entries.flatMap((e) => (e.current ? [{ e, s: e.current }] : []));
    const newest = [...snaps].sort((a, b) => b.s.updatedAt - a.s.updatedAt)[0];
    for (const { e, s } of snaps) nodes.push(liveNode(s, e.workerId, name(e.workerId, e.workerName), e === newest?.e ? "winner" : "standby"));
  } else {
    const byWorker = new Map<string, RollingDeliveryDTO[]>();
    for (const r of rolling) byWorker.set(r.workerId, [...(byWorker.get(r.workerId) ?? []), r]);
    for (const [id, rows] of byWorker) nodes.push(rollingNode(rows, id, name(id, rows[0]?.workerName), rows.some((r) => r.recording) ? "winner" : "standby"));
  }
  if (nodes.length === 0) return null;
  const bv = (live ? entries.find((e) => e.current?.bvid)?.current?.bvid : rolling.find((r) => r.bv)?.bv) ?? null;
  return (
    <section className="run-list-shell mb-4">
      <div className="px-3 py-2.5 border-b border-hairline flex items-center justify-between">
        <span className="section-label">{t("room.runTree.current")}</span>
      </div>
      <div className="p-3">
        <RunTreeView
          root={{ title: t("room.runTree.current"), sub: t(live ? "room.runtime.mode.live-direct" : "room.runtime.mode.rolling"), state: "running", bv }}
          tree={{ kind: "parts", nodes }}
        />
      </div>
    </section>
  );
}
