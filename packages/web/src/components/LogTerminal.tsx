/**
 * LogTerminal — the dark log console, shared by the task detail page and the room detail page.
 * Sticks to the bottom unless the user scrolled up; `TaskLogPanel` adds the polling.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Terminal } from "lucide-react";
import { api } from "../api/client";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { classifyLogLine, LOG_LINE_STYLE } from "../lib/logLevel";

/** `open` + `onToggle` make the title bar a disclosure button; omit both for an always-open console. */
export function LogTerminal({ lines, running, className = "", open = true, onToggle }: {
  lines: string[]; running: boolean; className?: string; open?: boolean; onToggle?: () => void;
}): ReactNode {
  const t = useT();
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const pre = preRef.current;
    if (pre && stickRef.current) pre.scrollTop = pre.scrollHeight;
  }, [lines]);

  const onScroll = (): void => {
    const el = preRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className={`terminal ${className}`}>
      <div className={`terminal-head${onToggle ? " cursor-pointer select-none" : ""}`}
           {...(onToggle ? { role: "button", tabIndex: 0, "aria-expanded": open, onClick: onToggle,
             onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } } } : {})}>
        <span className="terminal-title">
          {onToggle && <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />}
          <span className={`dot${running ? " dot-running" : ""}`} style={{ background: running ? "var(--success)" : "var(--muted-soft)" }} />
          <Terminal className="w-3.5 h-3.5" />
          {t("tasks.logs")}
        </span>
        <span className="terminal-count">{lines.length ? t("tasks.lines", { count: lines.length }) : ""}</span>
      </div>
      {open && <pre ref={preRef} onScroll={onScroll} className="terminal-body">
        {lines.length
          ? lines.map((line, i) => (
              <div key={i} style={{ ...LOG_LINE_STYLE[classifyLogLine(line)], margin: "0 -14px", padding: "0 14px" }}>
                {line || " "}
              </div>
            ))
          : t("tasks.noLogs")}
      </pre>}
    </div>
  );
}

/** Collapsible log console; polls the task's log tail only while open. */
export function TaskLogPanel({ taskId, running, open, onToggle }: { taskId: number; running: boolean; open: boolean; onToggle: () => void }): ReactNode {
  const [lines, setLines] = useState<string[]>([]);
  const poll = useCallback(
    () => (open ? api.getTaskLogs(taskId).then((l) => setLines(l.lines ?? [])).catch(() => {}) : Promise.resolve()),
    [taskId, open],
  );
  usePolling(poll, 2_000);
  return <LogTerminal lines={lines} running={running} className="room-log" open={open} onToggle={onToggle} />;
}
