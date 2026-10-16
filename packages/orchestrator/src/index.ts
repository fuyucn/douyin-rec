export * from "./transport.js";
export { scanRecordings, scanRollingSessions } from "./scan.js";
export type { FfprobeAdapter } from "./scan.js";
export { Reconciler } from "./reconciler.js";
// 能力门控纯函数已下沉 @drec/core(app L4 的「本机抑制」也要用;见 core/src/capabilities.ts)。
// 这里 re-export 保持 orchestrator 现有消费方(cli/reconciler)导入路径不变。
export { satisfiesCapabilities, gateWorkers, explainRejections } from "@drec/core";
export type { CapabilityRejection } from "@drec/core";
export { EndDebouncer } from "./trigger.js";
export { SyncLedger } from "./ledger.js";
export type { PipelineDeps, PipelineCfg, PipelineSteps, PipelineCleanup } from "./pipeline.js";
export {
  buildWorkflow,
  runWorkflowNodes,
  ResourcePool,
  deriveStageProducts,
  withOutputStem,
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
export { openUploadLimitStore, sanitizeUploadLimitState } from "./upload-limits.js";
export type { UploadLimitState, UploadLimitStore } from "./upload-limits.js";
// verify.ts 的纯判定/推导函数(T32 重核工具也要用;单一真理源,不在工具里另写一份)。
export {
  expectedPartCount,
  submittedPlanFromLedger,
  partCountOf,
  verifyParts,
  verifyUploaded,
  verifyAllowsCleanup,
  verifyBlocksOnMismatch,
  isRetryableVerify,
  verifyMessage,
  PART_GROUP_ALIASES,
  PART_GROUP_CANONICAL,
} from "./verify.js";
export type { VerifyGroup, VerifyResult, VerifyOpts, PartsReader, SubmittedPlan } from "./verify.js";
export { planSurvivorRemux, dispatchSurvivorRemux, pollFollowups, parseFollowups, STAGE_TARGET } from "./finalize-format.js";
export type { FinalizeFormatDeps, StageProcChannel, Followups, FollowupItem } from "./finalize-format.js";
export { LocalTransport } from "./transport-local.js";
export { SshTransport } from "./transport-ssh.js";
export { startHub } from "./hub.js";

import { registerTransport } from "./transport.js";
import type { ActiveRecordingRoom, ApplyTasksResult } from "./transport.js";
import { LocalTransport } from "./transport-local.js";
import { SshTransport } from "./transport-ssh.js";
import type { EnqueueRequest, EnqueueResponse, NodeTaskDTO, ProcessReceipt, RemoteTaskSpec } from "@drec/core";

export function registerBuiltinTransports(deps: {
  ffprobe: (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;
  /** anchorName(目录名) → roomSlug 映射；接受普通 Record 或 getter 函数（默认空 Record）。 */
  taskRooms?: Record<string, string> | (() => Record<string, string>);
  /** 某 roomSlug 此刻是否还在本机录制(local transport 的 isDone 用;不传 → isDone 恒 true)。 */
  isRoomRecording?: (roomSlug: string) => boolean;
  /** local worker 当前正在写流的房间。 */
  activeRecordingRooms?: () => ActiveRecordingRoom[];
  /** hub 任务同步:读本机任务清单(local worker = master 自身)。 */
  listTasks?: () => NodeTaskDTO[];
  /** hub 任务同步:把期望任务应用到本机 store。 */
  applyTasks?: (input: { desired: RemoteTaskSpec[]; force?: boolean }) => ApplyTasksResult;
  /** 处理任务表通道(plans/036 T9a):按 worker 的数据根执行入队 / 回执;不传 = local worker 不支持。 */
  procChannel?: {
    enqueue(dataRoot: string, req: EnqueueRequest): EnqueueResponse;
    procStatus(dataRoot: string, jobIds: string[]): ProcessReceipt[];
  };
}): void {
  const taskRooms = deps.taskRooms ?? {};
  registerTransport("local", (cfg) =>
    new LocalTransport({
      id: cfg.id,
      recordingsDir: `${cfg.dataRoot}/recordings`,
      taskRooms,
      ffprobe: deps.ffprobe,
      isRoomRecording: deps.isRoomRecording,
      activeRecordingRooms: deps.activeRecordingRooms,
      listTasks: deps.listTasks,
      applyTasks: deps.applyTasks,
      ...(deps.procChannel
        ? {
            enqueue: (req: EnqueueRequest) => deps.procChannel!.enqueue(cfg.dataRoot!, req),
            procStatus: (ids: string[]) => deps.procChannel!.procStatus(cfg.dataRoot!, ids),
          }
        : {}),
    }),
  );
  registerTransport("ssh", (cfg) =>
    new SshTransport({ id: cfg.id, host: cfg.host!, dataRoot: cfg.dataRoot! }),
  );
  registerTransport("tailscale-ssh", (cfg) =>
    new SshTransport({ id: cfg.id, host: cfg.host!, dataRoot: cfg.dataRoot! }),
  );
}
