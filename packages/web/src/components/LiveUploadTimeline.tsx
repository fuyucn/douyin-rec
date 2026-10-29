import { useEffect, useState, type ReactNode } from "react";
import type { LiveUploadSummary } from "@drec/contracts";
import { api } from "../api/client";
import { useT } from "../lib/i18n";
import { liveUploadView, type LiveDetailEntry } from "../lib/zero-disk-status";

const MiB = 1024 * 1024;
const fmt = (n: number): string => `${(n / MiB).toFixed(1)} MiB`;

export function LiveUploadTimeline({ taskId, summaries }: { taskId: number; summaries: Array<{ workerId: string; summary: LiveUploadSummary }> }): ReactNode {
  const t = useT();
  const [entries, setEntries] = useState<LiveDetailEntry[]>([]);
  const newest = [...summaries].sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)[0];

  useEffect(() => {
    if (!newest) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      try {
        const r = await api.getTaskLive(taskId);
        if (!stop) setEntries(r.entries);
      } catch { /* old node / endpoint unavailable */ }
      if (stop) return;
      const active = newest.summary.state === "waiting" || newest.summary.state === "streaming" || newest.summary.state === "submitting";
      if (active) timer = setTimeout(() => void load(), 10_000);
    };
    void load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [taskId, newest?.summary.updatedAt, newest?.summary.state]);

  if (!newest) return <p className="text-xs text-muted">{t("room.zeroDisk.live.empty")}</p>;
  const v = liveUploadView(newest.summary, entries);
  return (
    <div className="space-y-2" data-testid="live-upload-timeline">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="badge badge-muted">{t(`room.zeroDisk.live.state.${v.state}`)}</span>
        {v.currentPart !== undefined && <span className="font-mono">{t("room.zeroDisk.live.currentPart", { n: String(v.currentPart + 1) })}</span>}
        {v.bvid && <span className="font-mono">{v.bvid}</span>}
        <span className="text-muted-soft">{t("room.zeroDisk.live.updated", { time: new Date(v.updatedAt).toLocaleTimeString() })}</span>
      </div>
      {v.parts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead><tr className="text-muted"><th className="text-left">P</th><th className="text-left">{t("room.zeroDisk.live.phaseLabel")}</th><th className="text-right">MiB</th></tr></thead>
            <tbody>{v.parts.map((p) => (
              <tr key={p.index}>
                <td>P{p.index + 1}</td>
                <td>{t(`room.zeroDisk.live.phase.${p.phase}`)}</td>
                <td className="text-right">{((p.bytes ?? p.uploadedBytes) / MiB).toFixed(1)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="max-h-48 overflow-auto rounded bg-surface-soft p-2">
        {v.events.length === 0 ? <p className="text-[11px] text-muted">{t("room.zeroDisk.live.noEvents")}</p> : (
          <ul className="space-y-1 text-[11px]">
            {v.events.map((e, i) => (
              <li key={`${e.at}-${e.kind}-${e.part ?? "-"}-${i}`} className="flex gap-2">
                <span className="text-muted-soft tabular-nums">{new Date(e.at).toLocaleTimeString()}</span>
                <span>{t(`room.zeroDisk.live.event.${e.kind}`)}</span>
                {e.part !== undefined && <span className="text-muted">P{e.part + 1}</span>}
                {e.uploadedBytes !== undefined && <span className="text-muted">{fmt(e.uploadedBytes)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
