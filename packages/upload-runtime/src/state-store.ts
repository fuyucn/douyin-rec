/**
 * state-store.ts — 驱动需要的持久化接口,由调用方注入。
 *
 * 放在接口而不是实现里:orchestrator(rank 4.5)与 app(4)都有自己的状态存储
 * (SyncLedger / proc-queue),驱动不能直接开库,否则又会变成「一份 schema 两个所有者」。
 */

/** 一段已提交过的分 P 的幂等线索(plans/049 §4.2)。不存内容哈希。 */
export interface UploadPartRecord {
  index: number;
  size: number;
  mtimeMs: number;
  title?: string;
  confirmedAt?: string;
}

export interface UploadCheckpoint {
  targetId: string;
  archiveId: string;
  parts: UploadPartRecord[];
}

export interface UploadStateStore {
  /** 按「目标 + 稿件」键读取 checkpoint;没有返回 null。 */
  load(key: string): UploadCheckpoint | null;
  save(key: string, checkpoint: UploadCheckpoint): void;
  /** 单段确认:proof = observed 时调用。 */
  confirmPart(key: string, part: UploadPartRecord): void;
}
