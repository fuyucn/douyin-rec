/**
 * log.ts — 带 scope 的轻量日志(统一录制管线日志前缀,便于排查)。
 *
 * 录制子进程的 stdout 经 manager 加 `[task N]` 前缀 → web/TUI 实时 tail。每个子系统再带自己的
 * scope → 最终形如 `[task 1] [danmaku_recorder] WS 已连接 …`,一眼看出来自哪个子系统。
 *
 * 录制管线 scope(见各包):
 *   - stream_processor  取流 / probe / 流信息 / 主播名解析
 *   - stream_recorder   录制编排 / 引擎 spawn / 分段 / 卡死看门狗 / 状态
 *   - danmaku_recorder  弹幕 WS / 解析 / 健康告警
 *   - session           会话编排 / 重连 / drain
 *
 * 只是 console 的薄封装(prefix `[scope]`),不改变输出去向,故 docker/serve/TUI 一致。
 */
export interface ScopedLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 建一个带 `[scope]` 前缀的 logger。info→stdout,warn/error→stderr(同 console)。 */
export function createLogger(scope: string): ScopedLogger {
  const tag = `[${scope}]`;
  return {
    info: (...args: unknown[]): void => console.log(tag, ...args),
    warn: (...args: unknown[]): void => console.warn(tag, ...args),
    error: (...args: unknown[]): void => console.error(tag, ...args),
  };
}
