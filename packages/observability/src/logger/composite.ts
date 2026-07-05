import type { ScopedLogger } from "@drec/core";

/** 把一条日志扇出到多个 ScopedLogger(如 console + file)。任一实现抛错不影响其余。 */
export function composite(...loggers: ScopedLogger[]): ScopedLogger {
  const fan = (fn: (l: ScopedLogger) => void): void => {
    for (const l of loggers) {
      try {
        fn(l);
      } catch {
        /* 忽略单个 sink 的异常 */
      }
    }
  };
  return {
    info: (...args: unknown[]): void => fan((l) => l.info(...args)),
    warn: (...args: unknown[]): void => fan((l) => l.warn(...args)),
    error: (...args: unknown[]): void => fan((l) => l.error(...args)),
  };
}
