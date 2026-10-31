/**
 * CurrentRunTree — the running broadcast of a live-upload / rolling room (issue #401, #407, #413).
 *
 * It is a row **inside** the room's run list (处理运行态), not a block of its own: the current run sits
 * at the top of the list like the newest hub run, and expands into the same per-part tree.
 * Those modes have no hub run until the broadcast ends, so the data is the live snapshot / rolling progress.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { api, type RollingDeliveryDTO, type Task, type WorkerDTO } from "../api/client";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { liveBroadcast, liveNode, rollingNode, type PartsNode, type StepState } from "../lib/run-tree";
import type { LiveDetailEntry } from "../lib/zero-disk-status";
import { RunTreeView, StatePill } from "./RunTree";

/** One expandable live row in the run list; shared by the current run and the history. */
export function LiveRunRow({ title, badge, state, bv, nodes, defaultOpen }: {
  title: string;
  badge: string;
  state: StepState;
  bv?: string | null;
  nodes: PartsNode[];
  defaultOpen: boolean;
}): ReactNode {
  return (
    <details className="group px-3" open={defaultOpen}>
      <summary className="flex items-center justify-between gap-2 py-3 cursor-pointer list-none">
        <span className="flex items-center gap-2 flex-wrap min-w-0">
          <ChevronDown className="w-3.5 h-3.5 text-muted-soft transition-transform group-open:rotate-0 -rotate-90" />
          <span className="font-mono text-[13px] text-ink">{title}</span>
          <span className="tr-pill">{badge}</span>
          <StatePill state={state} />
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {bv && <span className="font-mono text-[11px] text-muted">{bv}</span>}
        </span>
      </summary>
      <div className="pb-3">
        <RunTreeView root={{ title, sub: badge, state, bv: bv ?? null }} tree={{ kind: "parts", nodes }} />
      </div>
    </details>
  );
}

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
  // The root state comes from what the nodes report (issue #408), not a hard-coded "running".
  let state: StepState = "running";
  if (live) {
    const broadcast = liveBroadcast(entries.flatMap((e) => (e.current ? [{ e, s: e.current }] : [])), ({ s }) => s.state);
    state = broadcast.state;
    // Only a node that is actually streaming / submitting can be the winner (same rule as the runtime page).
    const active = broadcast.onAir.filter(({ s }) => s.state === "streaming" || s.state === "submitting");
    const newest = [...active].sort((a, b) => b.s.updatedAt - a.s.updatedAt)[0];
    for (const { e, s } of broadcast.onAir) nodes.push(liveNode(s, e.workerId, name(e.workerId, e.workerName), e === newest?.e ? "winner" : "standby"));
  } else {
    const byWorker = new Map<string, RollingDeliveryDTO[]>();
    for (const r of rolling) byWorker.set(r.workerId, [...(byWorker.get(r.workerId) ?? []), r]);
    for (const [id, rows] of byWorker) nodes.push(rollingNode(rows, id, name(id, rows[0]?.workerName), rows.some((r) => r.recording) ? "winner" : "standby"));
  }
  if (nodes.length === 0) return null;
  const bv = (live ? entries.find((e) => e.current?.bvid)?.current?.bvid : rolling.find((r) => r.bv)?.bv) ?? null;
  return (
    <LiveRunRow
      title={t(live ? "room.runtime.mode.live-direct" : "room.runtime.mode.rolling")}
      badge={t("room.runTree.current")}
      state={state}
      bv={bv}
      nodes={nodes}
      defaultOpen
    />
  );
}
