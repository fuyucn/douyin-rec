/**
 * log-level.ts — 把一行日志归类成等级，供 TUI 日志视图按行上色。
 * 纯函数、无依赖（web 端有一份等价副本 web/src/lib/logLevel.ts，因 web 是独立工程）。
 */
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
