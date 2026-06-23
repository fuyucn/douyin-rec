import { useEffect, useRef, useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { TuiApi, type TuiTask, type TuiEvent } from "./api.js";
import { classifyLogLine, type LogLevel } from "./log-level.js";

/** 站内事件 → 一行提醒文案;null = 不提醒此类。 */
function eventLine(e: TuiEvent): string | null {
  const ev = e.event as Record<string, unknown>;
  const s = (k: string): string => String(ev[k] ?? "");
  switch (ev.kind) {
    case "recordStart":
      return `🔴 开播 · 开始录制：${s("anchor")}`;
    case "recordEnd":
      return `✅ 录制完成：${s("anchor")}`;
    case "mergeDone":
      return `✅ 合成完成：${s("file").split(/[/\\]/).pop()}`;
    case "burnDone":
      return `✅ 烧录完成：${s("file").split(/[/\\]/).pop()}`;
    case "uploadDone":
      return `✅ 上传完成：${s("bv")}`;
    case "error":
      return `✗ 出错[${s("stage")}]：${s("message")}`;
    default:
      return null;
  }
}

/** 日志等级 → Ink 文本样式（error 浅红行背景，其余不同前景色）。 */
const LOG_STYLE: Record<LogLevel, { color?: string; backgroundColor?: string }> = {
  error: { color: "white", backgroundColor: "#7a2b2b" }, // 浅红行背景
  warn: { color: "yellow" },
  success: { color: "green" },
  danmu: { color: "gray" },
  status: { color: "cyan" },
  info: {},
};

/** 任务状态 → 徽章文本 + 颜色。 */
function statusBadge(t: TuiTask): { text: string; color: string } {
  if (!t.enabled && !t.running) return { text: "○ 已停用", color: "gray" };
  if (t.status === "draining") return { text: "⏳ 排空中", color: "yellow" };
  if (t.running) {
    return t.recording
      ? { text: "● 录制中", color: "green" }
      : { text: "◌ 等待开播", color: "magenta" };
  }
  if (t.status === "error") return { text: "✗ 错误", color: "red" };
  return { text: "○ 待命", color: "cyan" };
}

const displayName = (t: TuiTask): string => t.name || t.anchorName || t.room;

interface Props {
  api: TuiApi;
  apiBase: string;
}

export function App({ api, apiBase }: Props): React.ReactNode {
  const { exit } = useApp();
  const [tasks, setTasks] = useState<TuiTask[]>([]);
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<"list" | "logs">("list");
  const [logs, setLogs] = useState<string[]>([]);
  const [logTask, setLogTask] = useState<TuiTask | null>(null);
  const [conn, setConn] = useState<"ok" | "down" | "init">("init");
  const [flash, setFlash] = useState("");

  const refresh = useCallback(async () => {
    try {
      const list = await api.listTasks();
      setTasks(list);
      setConn("ok");
      setSel((s) => Math.min(s, Math.max(0, list.length - 1)));
    } catch {
      setConn("down");
    }
  }, [api]);

  // 列表轮询 2s。
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [refresh]);

  // 日志视图：1.5s 轮询所选任务日志。
  useEffect(() => {
    if (view !== "logs" || !logTask) return;
    let alive = true;
    const pull = async (): Promise<void> => {
      const lines = await api.getLogs(logTask.id);
      if (alive) setLogs(lines);
    };
    void pull();
    const id = setInterval(() => void pull(), 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [view, logTask, api]);

  const note = (m: string): void => {
    setFlash(m);
    setTimeout(() => setFlash(""), 2500);
  };

  // 站内事件流 → 提醒(flash 行)。首轮只播种游标不回放历史;新事件按类型显示最近一条。
  const evCursor = useRef(0);
  const evSeeded = useRef(false);
  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const { events, cursor } = await api.getEvents(evCursor.current);
      evCursor.current = cursor;
      if (!alive) return;
      if (!evSeeded.current) {
        evSeeded.current = true;
        return;
      }
      const lines = events.map(eventLine).filter((x): x is string => x !== null);
      if (lines.length) note(lines[lines.length - 1]);
    };
    void tick();
    const id = setInterval(() => void tick(), 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [api]);

  useInput((input, key) => {
    if (view === "logs") {
      if (key.escape || input === "q" || input === "l") {
        setView("list");
        setLogs([]);
        setLogTask(null);
      }
      return;
    }
    // list view
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.upArrow || input === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow || input === "j") setSel((s) => Math.min(tasks.length - 1, s + 1));
    else if (input === "r") void refresh();
    else if (input === "s") {
      const t = tasks[sel];
      if (t) {
        void api.startTask(t.id).then(() => refresh());
        note(`▶ 启动 #${t.id} ${displayName(t)}`);
      }
    } else if (input === "x") {
      const t = tasks[sel];
      if (t) {
        void api.stopTask(t.id).then(() => refresh());
        note(`■ 停止 #${t.id} ${displayName(t)}`);
      }
    } else if (input === "l" || key.return) {
      const t = tasks[sel];
      if (t) {
        setLogTask(t);
        setView("logs");
      }
    }
  });

  // ── Logs view ──────────────────────────────────────────────────────────
  if (view === "logs" && logTask) {
    const tail = logs.slice(-30);
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color="cyan">
            日志 · #{logTask.id} {displayName(logTask)}
          </Text>
          <Text color="gray"> （{logs.length} 行，显示末 {tail.length}）</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {tail.length === 0 ? (
            <Text color="gray">（暂无日志）</Text>
          ) : (
            tail.map((line, i) => {
              const st = LOG_STYLE[classifyLogLine(line)];
              return (
                <Text key={i} color={st.color} backgroundColor={st.backgroundColor} wrap="truncate-end">
                  {line}
                </Text>
              );
            })
          )}
        </Box>
        <Box marginTop={1}>
          <Text color="gray">[esc/q/l] 返回列表 · 自动刷新</Text>
        </Box>
      </Box>
    );
  }

  // ── List view ──────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="magenta">
          抖音录制 · TUI
        </Text>
        <Text color="gray">  {apiBase}  </Text>
        <Text color={conn === "ok" ? "green" : conn === "down" ? "red" : "yellow"}>
          {conn === "ok" ? "● 已连接" : conn === "down" ? "✗ serve 未连接" : "… 连接中"}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {conn === "down" ? (
          <Text color="red">
            连不上 serve（{apiBase}）。先启动：node dist/douyin-rec.mjs task serve --port 7860
          </Text>
        ) : tasks.length === 0 ? (
          <Text color="gray">（无任务）</Text>
        ) : (
          tasks.map((t, i) => {
            const b = statusBadge(t);
            const selected = i === sel;
            return (
              <Box key={t.id}>
                <Text color={selected ? "black" : undefined} backgroundColor={selected ? "cyan" : undefined}>
                  {selected ? "❯ " : "  "}
                </Text>
                <Box width={12}>
                  <Text color={b.color}>{b.text}</Text>
                </Box>
                <Box width={22}>
                  <Text bold={selected} wrap="truncate-end">
                    {displayName(t)}
                  </Text>
                </Box>
                <Text color="gray" wrap="truncate-end">
                  {t.room} · {t.quality} · {t.danmu ? "弹幕" : "无弹幕"}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {flash ? <Text color="yellow">{flash}</Text> : null}
        <Text color="gray">
          [↑/↓] 选择 · [s] 启动 · [x] 停止 · [l/⏎] 日志 · [r] 刷新 · [q] 退出
        </Text>
      </Box>
    </Box>
  );
}
