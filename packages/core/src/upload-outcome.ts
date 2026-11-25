/**
 * upload-outcome.ts — 上传类失败的**唯一分类口径**(issue #752)。
 *
 * 目的:把「上传失败一律转人工」换成**按证据分流**,让能安全重试/幂等续跑的失败回到队列,
 * 只有结果不确定的才交给人。三条纪律:
 *
 *   1. **BV 是稿件身份,不是 append 的幂等键** —— 有 BV 只说明「稿已建」,逐P是否已提交要看
 *      `partsConfirmed`;两者都成立才敢续跑,否则只能只读核验。
 *   2. **最终一致性不能证明「未提交」** —— 查不到分P ≠ 没提交过。只有 `intentCommitted=false`
 *      且没有 BV 才算「确定没副作用」。
 *   3. **不确定(pending 回执 / append-ambiguous / 用户停止)一律 verify-manual**:只读核验,
 *      绝不自动重发(重发可能产生重复分P或第二个稿)。
 *
 * 这里只做判定,不做 IO;调度(退避/到期唤醒/占闸)在调用方(reconciler / 节点 runner)。
 */
import { classifyRetryableFailure, isUncertainOutcome, type RetryFailureCode } from "./processor.js";
import { isAppendAmbiguous } from "./upload-contract.js";
import { isJobAbort } from "./job-abort.js";

/** 失败处置:安全重试 / 幂等续跑 / 只读核验后转人工。 */
export type UploadFailureClass = "safe-retry" | "resume-append" | "verify-manual";

export interface UploadFailureEvidence {
  /** 提交意图已落盘(建稿/append 的请求发出前写过 intent):一旦为真,平台可能已受理。 */
  intentCommitted?: boolean;
  /** 已建稿的 BV/aid(checkpoint)。 */
  bv?: string | null;
  /** 逐P成功证据完整(每段都有 confirmed / 回读到对应分P)。 */
  partsConfirmed?: boolean;
  /** 明确的结果不确定标记(append-ambiguous / 已提交未回读)。 */
  ambiguous?: boolean;
  /** 用户主动停止:永不自动复活。 */
  userStop?: boolean;
  /** 原始错误(交给 core 的 classifyRetryableFailure 判限流/凭据)。 */
  error?: unknown;
}

export interface UploadFailurePlan {
  class: UploadFailureClass;
  /** 是否允许自动回到队列(verify-manual 为 false:只读核验,不重传)。 */
  retryable: boolean;
  /** 是否消耗重试次数;限流不消耗(与 core 的 retry 口径一致)。 */
  countsAsFailure: boolean;
  code: RetryFailureCode | "user-stop" | "ambiguous" | "no-intent" | "bv-unconfirmed" | "intent-unknown";
  reason: string;
}

const MANUAL = (code: UploadFailurePlan["code"], reason: string): UploadFailurePlan =>
  ({ class: "verify-manual", retryable: false, countsAsFailure: false, code, reason });

/**
 * 判定一次上传失败该怎么处置。**顺序敏感**:不确定/用户停止/凭据问题优先于一切重试。
 */
export function classifyUploadOutcome(evidence: UploadFailureEvidence = {}): UploadFailurePlan {
  // 原始错误里带的**权威标记**优先于调用方传的布尔值(避免两套判定漂移):
  // 用户停止 / append-ambiguous / 不确定回执 → 一律只读核验,永不自动重发。
  const err = evidence.error;
  if (evidence.userStop || isJobAbort(err)) return MANUAL("user-stop", "用户主动停止,不自动复活");
  if (evidence.ambiguous || isAppendAmbiguous(err) || isUncertainOutcome(err)) {
    return MANUAL("ambiguous", "结果不确定(可能已提交),只读核验,禁止自动重发");
  }

  const retry = classifyRetryableFailure(evidence.error);
  if (retry.kind === "deterministic") {
    // 凭据/权限/缺失类:重试只会一直失败,先修账号(不伪装成网络抖动)。
    return MANUAL(retry.code, `凭据或权限问题(${retry.code}),需先修账号再重试`);
  }

  const bv = (evidence.bv ?? "").trim();
  if (bv) {
    if (evidence.partsConfirmed) {
      return {
        class: "resume-append",
        retryable: true,
        countsAsFailure: retry.countsAsFailure,
        code: retry.code,
        reason: `已建稿 ${bv} 且逐P证据完整,只补未提交的分P`,
      };
    }
    return MANUAL("bv-unconfirmed", `已建稿 ${bv} 但逐P证据不完整,需只读回读确认后再补`);
  }

  if (evidence.intentCommitted !== false) {
    // 意图**已落盘或未知**(缺省 = 未知,旧数据 / 读不到)都不能证明「请求没发出」:
    // 建稿可能已在平台侧成功,重发会造第二个稿 → 只读核验。
    return MANUAL("intent-unknown", evidence.intentCommitted ? "提交意图已落盘但未拿到 BV,需只读核验" : "无法证明未提交(缺 intent 证据),先只读核验");
  }

  // 明确 `intentCommitted === false` 且没有 BV ⇒ 确定没有副作用,可以安全重发。
  return {
    class: "safe-retry",
    retryable: true,
    countsAsFailure: retry.countsAsFailure,
    code: retry.code,
    reason: retry.kind === "rate-limit" ? "被限流拒绝(无副作用),退避后重试" : "提交前失败(无副作用),可安全重试",
  };
}
