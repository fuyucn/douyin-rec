/**
 * 日志端口(port)。实现(Console/File/Ring/composite)在 @drec/observability;
 * 消费方(manager/orchestrator)只依赖本接口,由组合根(CLI)注入实现。
 */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
