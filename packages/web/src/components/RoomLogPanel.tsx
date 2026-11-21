/** Room-only, read-only multi-source log tail. Other local log panels stay unchanged. */
import { useEffect, useState, type ReactNode } from "react";
import { api, type RoomDTO, type WorkerDTO } from "../api/client";
import { useT } from "../lib/i18n";
import { createRoomLogReader, mergeRoomLogs, roomLogSources, type RoomLogResult, type RoomLogSource } from "../lib/room-logs";
import { LogTerminal } from "./LogTerminal";

export function RoomLogPanel({ room, workers, nodes, running, open, onToggle }: {
  room: RoomDTO; workers: WorkerDTO[]; nodes: boolean; running: boolean; open: boolean; onToggle: () => void;
}): ReactNode {
  const sources = roomLogSources(room, workers, nodes);
  // Navigation resets the displayed tail immediately, BEFORE effects run; cleanup drops late replies.
  return <RoomLogSession key={JSON.stringify([room.key, room.platform, room.roomSlug, sources])}
    room={room} sources={sources} nodes={nodes} running={running} open={open} onToggle={onToggle} />;
}

function RoomLogSession({ room, sources, nodes, running, open, onToggle }: {
  room: RoomDTO; sources: RoomLogSource[]; nodes: boolean; running: boolean; open: boolean; onToggle: () => void;
}): ReactNode {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  const [results, setResults] = useState<RoomLogResult[]>(() => sources.map((source) => ({ source, status: "loading", lines: [] })));
  // Session identity is keyed by room + source plan; parent room/task polling must not restart reads.
  const [context] = useState(() => ({ sources, room: { platform: room.platform, roomSlug: room.roomSlug } }));
  useEffect(() => {
    if (!open) return;
    const reader = createRoomLogReader(context.sources, context.room, api, (result) => {
      setResults((prev) => prev.map((item) => item.source.id === result.source.id ? result : item));
    });
    void reader.refresh();
    const timer = setInterval(() => { void reader.refresh(); }, 5_000);
    return () => { reader.cancel(); clearInterval(timer); };
  }, [open, context]);

  const label = (source: RoomLogSource): string => source.kind === "local" ? t(nodes ? "room.logs.hub" : "room.detail.local") : source.name;
  const merged = mergeRoomLogs(results, selected, limit);
  const visible = results.filter((result) => selected === null || result.source.id === selected);
  return (
    <div className="min-w-0 max-w-full">
      {open && <div className="space-y-2 mb-2 text-xs text-muted min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 min-w-0 max-w-full">
            {t("room.logs.source")}
            <select className="input min-w-0 max-w-full" value={selected ?? ""} onChange={(e) => setSelected(e.target.value || null)}>
              <option value="">{t("room.logs.all")}</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{label(source)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            {t("room.logs.limit")}
            <select className="input" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <p>{t(merged.mode === "time" ? "room.logs.timeOrder" : "room.logs.grouped")}</p>
        {merged.total > merged.entries.length && <p>{t("room.logs.capped", { shown: merged.entries.length, total: merged.total })}</p>}
        {nodes && sources.length === 1 && <p>{t("room.logs.noNodes")}</p>}
        <ul className="space-y-1 break-all" aria-live="polite">
          {visible.map((result) => <li key={result.source.id}>
            <span className="font-mono">[{label(result.source)}]</span>{" "}
            {t(`room.logs.status.${result.status}`)}
            {result.error && <span> · {result.error}</span>}
          </li>)}
        </ul>
      </div>}
      <LogTerminal lines={merged.entries.map((entry) => `[${label(entry.source)}] ${entry.text}`)}
        running={running} className="room-log min-w-0 max-w-full" open={open} onToggle={onToggle} />
    </div>
  );
}
