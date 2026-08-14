export * from "./transport.js";
export { scanRecordings } from "./scan.js";
export type { FfprobeAdapter } from "./scan.js";
export { Reconciler } from "./reconciler.js";
export { EndDebouncer } from "./trigger.js";
export { SyncLedger } from "./ledger.js";
export type { PipelineDeps, PipelineCfg, PipelineSteps, PipelineCleanup } from "./pipeline.js";
export {
  buildWorkflow,
  runWorkflowNodes,
  ResourcePool,
  deriveStageProducts,
} from "./workflow.js";
export type {
  Workflow,
  WorkflowNode,
  WorkflowNodeKey,
  WorkflowBuildInput,
  WorkflowRunOptions,
  WorkflowRunResult,
  ResourcePoolCfg,
  StageProducts,
} from "./workflow.js";
export { LocalTransport } from "./transport-local.js";
export { SshTransport } from "./transport-ssh.js";
export { startHub } from "./hub.js";

import { registerTransport } from "./transport.js";
import type { ApplyTasksResult } from "./transport.js";
import { LocalTransport } from "./transport-local.js";
import { SshTransport } from "./transport-ssh.js";
import type { NodeTaskDTO, RemoteTaskSpec } from "@drec/core";

export function registerBuiltinTransports(deps: {
  ffprobe: (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;
  /** anchorName(目录名) → roomSlug 映射；接受普通 Record 或 getter 函数（默认空 Record）。 */
  taskRooms?: Record<string, string> | (() => Record<string, string>);
  /** 某 roomSlug 此刻是否还在本机录制(local transport 的 isDone 用;不传 → isDone 恒 true)。 */
  isRoomRecording?: (roomSlug: string) => boolean;
  /** hub 任务同步:读本机任务清单(local worker = master 自身)。 */
  listTasks?: () => NodeTaskDTO[];
  /** hub 任务同步:把期望任务应用到本机 store。 */
  applyTasks?: (input: { desired: RemoteTaskSpec[] }) => ApplyTasksResult;
}): void {
  const taskRooms = deps.taskRooms ?? {};
  registerTransport("local", (cfg) =>
    new LocalTransport({
      id: cfg.id,
      recordingsDir: `${cfg.dataRoot}/recordings`,
      taskRooms,
      ffprobe: deps.ffprobe,
      isRoomRecording: deps.isRoomRecording,
      listTasks: deps.listTasks,
      applyTasks: deps.applyTasks,
    }),
  );
  registerTransport("ssh", (cfg) =>
    new SshTransport({ id: cfg.id, host: cfg.host!, dataRoot: cfg.dataRoot! }),
  );
  registerTransport("tailscale-ssh", (cfg) =>
    new SshTransport({ id: cfg.id, host: cfg.host!, dataRoot: cfg.dataRoot! }),
  );
}
