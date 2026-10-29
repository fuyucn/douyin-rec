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

/** 规则 pipeline.steps 里与烧录相关的最小投影。 */
export interface BurnSteps {
  burnDanmu?: boolean;
  burnLivechat?: boolean;
}

/**
 * 烧录开关的**唯一口径**:`burnDanmu` / `burnLivechat` 缺省都是开(`!== false`)。
 * orchestrator 的管线(pipeline / segment-pipeline / cli 重跑)、rolling 判定、规则校验都走这里,不得再各抄一份。
 */
export function burnFlags(steps?: BurnSteps | null): { burnDanmu: boolean; burnLivechat: boolean } {
  return { burnDanmu: steps?.burnDanmu !== false, burnLivechat: steps?.burnLivechat !== false };
}

/** 该 steps 是否会产出任一烧录版(弹幕版 / 互动版)。 */
export function pipelineBurns(steps?: BurnSteps | null): boolean {
  const f = burnFlags(steps);
  return f.burnDanmu || f.burnLivechat;
}

export type RollingReason =
  | "rule-rolling"      // 规则 mode=rolling
  | "legacy-task-flag"  // 旧 task.rollingUpload=true,规则未配置 mode / 无规则 / mode=upload → 等价 rolling
  | "rule-disabled"     // 规则 enabled=false(停用)→ 视为关闭,旧开关与 mode 都不得放行
  | "rule-stage"        // 规则显式 mode=stage(只合成)→ 即便旧开关为 true 也不边录边传
  | "not-requested"     // 规则非 rolling 且旧开关为 false
  | "needs-burn"        // 请求了 rolling,但规则开着烧录:rolling 执行体只传 plain,弹幕版/互动版分P会被静默丢掉
  | "multi-node";       // 请求了 rolling,但规则不是「恰好 1 个节点」→ 回落整场管线(防重复投稿)

export interface RollingPolicy {
  effective: boolean;
  reason: RollingReason;
}

/** 判定所需的规则最小投影(HubRule 的子集;无规则传 null/undefined)。 */
export interface RollingPolicyRule {
  /** 规则是否启用;`false` = 停用 → 边录边传关闭(undefined 视为启用,兼容旧调用方)。 */
  enabled?: boolean;
  /** `pipeline.upload.mode` 原值。 */
  mode?: unknown;
  /** 规则选中的 worker id;undefined/空 = 全部节点。 */
  workers?: readonly string[];
  /** 规则 `pipeline.steps`;**未给 = 烧录默认开**(同 {@link burnFlags}),所以有规则的调用方必须传它。 */
  steps?: BurnSteps | null;
}

/**
 * 优先级(高 → 低):
 *   0. 规则 enabled=false(停用)→ 一律关闭。
 *   1. 规则 mode=rolling → 请求 rolling。
 *   2. 规则 mode=stage(显式只合成)→ 不 rolling(旧开关不得绕过规则去上传)。
 *   3. 旧 task 开关 true(规则无 mode / mode=upload / 无规则)→ 请求 rolling(读取时迁移,行为同改前)。
 *   4. 否则不 rolling。
 * 请求了 rolling 之后依次过两道闸门:
 *   a. **烧录互斥**(issue #48):有规则且烧录开着(默认开)→ 不生效(reason=needs-burn)。rolling 只上传 plain,
 *      且 master 的 rolling 短路会直接收口,弹幕版/互动版分P会被静默丢掉。无规则 = 无后处理管线 = 不涉及烧录。
 *   b. **跨节点重复投稿闸门**(`rollingUploadSingleNode`):有规则且未恰好勾选 1 个节点
 * → 不生效、回落整场管线(master 选优后只传 winner)。无规则 = 单机任务 → 恒单节点。
 *
 * ⚠️ 必须由 master 调用 —— hub 规则文件只存在于 master。
 */
export function resolveRollingPolicy(
  rule: RollingPolicyRule | null | undefined,
  legacyTaskFlag: boolean,
): RollingPolicy {
  if (rule?.enabled === false) return { effective: false, reason: "rule-disabled" };
  const mode = normalizeUploadMode(rule?.mode);
  let reason: RollingReason;
  if (mode === "rolling") reason = "rule-rolling";
  else if (mode === "stage") return { effective: false, reason: "rule-stage" };
  else if (legacyTaskFlag) reason = "legacy-task-flag";
  else return { effective: false, reason: "not-requested" };
  if (rule != null && pipelineBurns(rule.steps)) return { effective: false, reason: "needs-burn" };
  if (!rollingUploadSingleNode(rule != null, rule?.workers)) return { effective: false, reason: "multi-node" };
  return { effective: true, reason };
}

/** reason → 给人看的一句话(日志 / Web 共用同一份文案来源)。 */
export function rollingReasonText(reason: RollingReason): string {
  switch (reason) {
    case "needs-burn": return "规则开着烧录(弹幕版/互动版),与边录边传互斥(rolling 只传 plain,会丢分P);请先关闭烧录,或改用「合成并上传」";
    case "multi-node": return "规则未恰好勾选 1 个节点,回落整场管线(防重复投稿)";
    case "rule-disabled": return "规则已停用";
    case "rule-stage": return "规则为「只合成」";
    case "not-requested": return "未开启边录边传";
    case "rule-rolling": return "规则 mode=rolling";
    case "legacy-task-flag": return "沿用旧任务开关";
  }
}
