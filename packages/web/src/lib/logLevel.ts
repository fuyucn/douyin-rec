/**
 * logLevel.ts — 把一行日志归类成等级，供日志台按行上色。
 * 纯函数（与 src/app/tui/log-level.ts 等价；web 是独立工程故各存一份）。
 */
import type { CSSProperties } from "react";

export type LogLevel = "error" | "warn" | "success" | "danmu" | "status" | "info";

export function classifyLogLine(line: string): LogLevel {
  if (/错误|error|失败|fail|exited with code|RecordStop|流断开|致命|SIGSEGV|rc=-?\d|spawn error/i.test(line))
    return "error";
  if (/警告|warn|⚠|排空|超时|timeout|重连|reconnect|断开/i.test(line)) return "warn";
  if (/完成|成功|✓|投稿成功|已上传|已停止|录制中|准备开始录制/i.test(line)) return "success";
  if (/\[弹幕\]|收到第/.test(line)) return "danmu";
  if (/\[状态\]|\[主播\]|新分段|启动|开始录制|等待开播/.test(line)) return "status";
  return "info";
}

/** 每行内联样式（用 rgba 兜底，深浅色模式都可读；error 浅红行背景）。 */
export const LOG_LINE_STYLE: Record<LogLevel, CSSProperties> = {
  error: { background: "rgba(239,68,68,0.15)", color: "#ef4444" },
  warn: { color: "var(--warning)" },
  success: { color: "var(--success)" },
  danmu: { color: "var(--muted-soft)" },
  status: { color: "#0ea5e9" },
  info: {},
};
