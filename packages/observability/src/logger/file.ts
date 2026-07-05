import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ScopedLogger } from "@drec/core";

/**
 * 追加到文件的 Logger(hub 的 job.log 用)。首写建目录;写失败静默(日志绝不反噬主流程)。
 * 实现 core 的 ScopedLogger 契约(与 createLogger 同接口),info/warn/error 均追加一行,带 ISO 时间戳 + 级别。
 */
export class FileLogger implements ScopedLogger {
  private dirReady = false;
  constructor(private readonly path: string) {}
  private write(level: string, args: unknown[]): void {
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.dirReady = true;
      }
      const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      appendFileSync(this.path, `[${new Date().toISOString()}] ${level} ${msg}\n`, "utf-8");
    } catch {
      /* 忽略:日志失败不影响主流程 */
    }
  }
  info(...args: unknown[]): void {
    this.write("INFO", args);
  }
  warn(...args: unknown[]): void {
    this.write("WARN", args);
  }
  error(...args: unknown[]): void {
    this.write("ERROR", args);
  }
}
