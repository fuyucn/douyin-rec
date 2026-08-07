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

/** 每行内联样式（按日志台深色底校准，见 index.css .terminal-body；error 浅红行背景）。 */
export const LOG_LINE_STYLE: Record<LogLevel, CSSProperties> = {
  error: { background: "rgba(255,35,87,0.14)", color: "#ff8fa3" },
  warn: { color: "#ffc04d" },
  success: { color: "#5ee9b5" },
  danmu: { color: "#9aa0a6" },
  status: { color: "#6db9f4" },
  info: {},
};
