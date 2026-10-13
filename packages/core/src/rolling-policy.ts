/**
 * rolling-policy.ts — 「边录边传」是否生效的**唯一判定**(rank 0,纯函数,无 IO)。
 *
 * 设计依据:issue #40 / docs/architecture-package-split.md S3、S4。
 * 「何时上传、传完删源」属于 hub 后处理职责 → 配置入口是 hub 规则 `pipeline.upload.mode = "rolling"`;
 * task 只保留录制参数。**只有 master 调用本函数**(下发任务 / 启动时刷新本机任务),结果写成只读
 * 派生字段 `rollingEffective`;录制端(子进程、record 参数构造、上传钩子工厂)只读该字段,
 * 不得再自行读规则或自行判定(此前散在 master 下发 / 录制子进程 / flag 解析三处)。
 */

import type { UploadMode } from "./api-types.js";
import { rollingUploadSingleNode } from "./rolling.js";

/**
 * 规则里写的 mode → 规范取值;**未配置(undefined/null/空串)→ undefined**。
 * 其它字符串(含旧的 stage-only)→ "stage"(与 cli 既有「其它值回落 stage」同口径)。
 */
export function normalizeUploadMode(mode: unknown): UploadMode | undefined {
  if (mode == null) return undefined;
  const s = String(mode).trim();
  if (!s) return undefined;
  return s === "upload" || s === "rolling" ? s : "stage";
}

/** 该模式是否会把成品传到 B 站(upload 与 rolling 都传;rolling 只是上传时机提前到录制中)。 */
export function isUploadingMode(mode: unknown): boolean {
  const m = normalizeUploadMode(mode);
  return m === "upload" || m === "rolling";
}

export type RollingReason =
  | "rule-rolling"      // 规则 mode=rolling
  | "legacy-task-flag"  // 旧 task.rollingUpload=true,规则未配置 mode / 无规则 / mode=upload → 等价 rolling
  | "rule-stage"        // 规则显式 mode=stage(只合成)→ 即便旧开关为 true 也不边录边传
  | "not-requested"     // 规则非 rolling 且旧开关为 false
  | "multi-node";       // 请求了 rolling,但规则不是「恰好 1 个节点」→ 回落整场管线(防重复投稿)

export interface RollingPolicy {
  effective: boolean;
  reason: RollingReason;
}

/** 判定所需的规则最小投影(HubRule 的子集;无规则传 null/undefined)。 */
export interface RollingPolicyRule {
  /** `pipeline.upload.mode` 原值。 */
  mode?: unknown;
  /** 规则选中的 worker id;undefined/空 = 全部节点。 */
  workers?: readonly string[];
}

/**
 * 优先级(高 → 低):
 *   1. 规则 mode=rolling → 请求 rolling。
 *   2. 规则 mode=stage(显式只合成)→ 不 rolling(旧开关不得绕过规则去上传)。
 *   3. 旧 task 开关 true(规则无 mode / mode=upload / 无规则)→ 请求 rolling(读取时迁移,行为同改前)。
 *   4. 否则不 rolling。
 * 请求了 rolling 之后过**跨节点重复投稿闸门**(`rollingUploadSingleNode`):有规则且未恰好勾选 1 个节点
 * → 不生效、回落整场管线(master 选优后只传 winner)。无规则 = 单机任务 → 恒单节点。
 *
 * ⚠️ 必须由 master 调用 —— hub 规则文件只存在于 master。
 */
export function resolveRollingPolicy(
  rule: RollingPolicyRule | null | undefined,
  legacyTaskFlag: boolean,
): RollingPolicy {
  const mode = normalizeUploadMode(rule?.mode);
  let reason: RollingReason;
  if (mode === "rolling") reason = "rule-rolling";
  else if (mode === "stage") return { effective: false, reason: "rule-stage" };
  else if (legacyTaskFlag) reason = "legacy-task-flag";
  else return { effective: false, reason: "not-requested" };
  if (!rollingUploadSingleNode(rule != null, rule?.workers)) return { effective: false, reason: "multi-node" };
  return { effective: true, reason };
}
