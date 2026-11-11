/**
 * driver.ts — 通用驱动的类型边界(plans/049 §4.1)。
 *
 * 阶段 0 只定义「驱动吃什么、吐什么」,不提供实现:
 * `ensureArchive` / `appendParts` / `verify` 在阶段 1 落地,由 target 的 proof 决定
 * 重试 / 冷却 / 转人工。现在没有任何生产路径 import 本包。
 */
import type {
  ArchiveRef,
  CredentialRef,
  UploadFile,
  UploadPolicy,
  UploadTarget,
} from "@drec/core";
import type { UploadStateStore } from "./state-store.js";

export interface UploadRuntimeDeps {
  target: UploadTarget;
  store: UploadStateStore;
  /** 测试注入:冷却退避不走真实 sleep。 */
  sleep(ms: number): Promise<void>;
  now(): number;
  log(msg: string): void;
}

export interface EnsureArchiveRequest {
  cred: CredentialRef;
  title: string;
  files: UploadFile[];
  policy: UploadPolicy;
  expectedDurationSec?: number;
}

export interface EnsureArchiveOutcome {
  ref: ArchiveRef;
  /** true = findRecent 命中已有稿件,没有新建。 */
  reused: boolean;
}

export interface AppendPartsRequest {
  cred: CredentialRef;
  ref: ArchiveRef;
  files: UploadFile[];
  policy: UploadPolicy;
}

export interface AppendPartsOutcome {
  /** 本次确认成功的分 P 序号(proof = observed 的那几段)。 */
  confirmed: number[];
}

export interface VerifyRequest {
  cred: CredentialRef;
  ref: ArchiveRef;
  /** 期望分 P 数;inspect 返回 null 或数量不符 → 转人工。 */
  expectedParts: number | null;
}

export interface VerifyOutcome {
  ok: boolean;
  /** inspect 读到的分 P 数;null = 查不到。 */
  observedParts: number | null;
}
