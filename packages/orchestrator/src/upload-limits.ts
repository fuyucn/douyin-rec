/**
 * upload-limits.ts — 上传限流状态(冷却截止 + 滑动窗口提交时刻)的**跨重启持久化**(master 侧入口)。
 *
 * T19 之后:**实现已下沉到 core/upload-gate.ts**(`openUploadLimitStore`,按账号键分行的 sqlite 适配器)。
 * 本文件只做**转出 + 兼容旧调用点**,不再持有第二份实现 —— 单一真理源,禁止在这里再写一份判定或表结构。
 *
 * 为什么下沉 core:B 站按「提交次数」限流(601/21566),master 侧 ResourcePool(orchestrator L4.5)
 * 与节点侧上传(app L4 的 node-pipeline)必须共享同一判定与同一份持久化实现,而 app 不得 import
 * orchestrator(test/arch/layering.test.ts 守护)。故契约 + store 都在 core(rank 0)。
 */
export {
  openUploadLimitStore,
  sanitizeUploadLimitState,
  UPLOAD_FAIL_CLOSED_MS,
  UPLOAD_GATE_DEFAULT_KEY,
  biliAccountKey,
  biliAccountKeyFromCookiesJson,
  UploadGate,
} from "@drec/core";
export type { UploadLimitState, UploadGateStore, UploadGateOpts } from "@drec/core";

import type { UploadGateStore } from "@drec/core";

/** 旧名保留:`UploadLimitStore` 现在就是 core 的 `UploadGateStore`(load(key)/save(key,state))。 */
export type UploadLimitStore = UploadGateStore;
