export * from "./transport.js";
export { Reconciler } from "./reconciler.js";
export { EndDebouncer } from "./trigger.js";
export { SyncLedger } from "./ledger.js";
export type { PipelineDeps } from "./pipeline.js";
export { LocalTransport } from "./transport-local.js";
export { SshTransport } from "./transport-ssh.js";
export { startHub } from "./hub.js";

import { registerTransport } from "./transport.js";
import { LocalTransport } from "./transport-local.js";
import { SshTransport } from "./transport-ssh.js";

export function registerBuiltinTransports(deps: {
  ffprobe: (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;
  /** anchorName(目录名) → roomSlug 映射；接受普通 Record 或 getter 函数（默认空 Record）。 */
  taskRooms?: Record<string, string> | (() => Record<string, string>);
}): void {
  const taskRooms = deps.taskRooms ?? {};
  registerTransport("local", (cfg) =>
    new LocalTransport({
      id: cfg.id,
      recordingsDir: `${cfg.dataRoot}/recordings`,
      taskRooms,
      ffprobe: deps.ffprobe,
    }),
  );
  registerTransport("ssh", (cfg) =>
    new SshTransport({ id: cfg.id, host: cfg.host!, dataRoot: cfg.dataRoot! }),
  );
  registerTransport("tailscale-ssh", (cfg) =>
    new SshTransport({ id: cfg.id, host: cfg.host!, dataRoot: cfg.dataRoot! }),
  );
}
