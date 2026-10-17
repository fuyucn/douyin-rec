/**
 * LogTerminal — the dark log console, shared by the task detail page and the room detail page.
 * Sticks to the bottom unless the user scrolled up; `TaskLogPanel` adds the polling.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Terminal } from "lucide-react";
import { api } from "../api/client";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { classifyLogLine, LOG_LINE_STYLE } from "../lib/logLevel";

export function LogTerminal({ lines, running, className = "" }: { lines: string[]; running: boolean; className?: string }): ReactNode {
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
      <div className="terminal-head">
        <span className="terminal-title">
          <span className={`dot${running ? " dot-running" : ""}`} style={{ background: running ? "var(--success)" : "var(--muted-soft)" }} />
          <Terminal className="w-3.5 h-3.5" />
          {t("tasks.logs")}
        </span>
        <span className="terminal-count">{lines.length ? t("tasks.lines", { count: lines.length }) : ""}</span>
      </div>
      <pre ref={preRef} onScroll={onScroll} className="terminal-body">
        {lines.length
          ? lines.map((line, i) => (
              <div key={i} style={{ ...LOG_LINE_STYLE[classifyLogLine(line)], margin: "0 -14px", padding: "0 14px" }}>
                {line || " "}
              </div>
            ))
          : t("tasks.noLogs")}
      </pre>
    </div>
  );
}

/** Polls a task's log tail while mounted (mount it only when the panel is open). */
export function TaskLogPanel({ taskId, running }: { taskId: number; running: boolean }): ReactNode {
  const [lines, setLines] = useState<string[]>([]);
  const poll = useCallback(() => api.getTaskLogs(taskId).then((l) => setLines(l.lines ?? [])).catch(() => {}), [taskId]);
  usePolling(poll, 2_000);
  return <LogTerminal lines={lines} running={running} className="room-log" />;
}
