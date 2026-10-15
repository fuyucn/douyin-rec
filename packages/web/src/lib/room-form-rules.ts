/**
 * room-form-rules.ts — 房间 / Hub 规则 / 任务表单的**字段依赖唯一推导**(Pure,可直测)。
 *
 * 为什么单独抽:「边录边传和烧录互斥」「节点侧上传只在上传时有效」这类依赖原本在
 * RoomEditPanel 与 HubRuleDialog 里各写一份,改一处漏一处。表单只渲染这里的结果。
 * 边录边传是否可用直接调 core 的 `resolveRollingPolicy`,与 master 下发同一判定。
 */
import { resolveRollingPolicy, type RollingReason } from "@drec/rolling-policy";

/** 上传方式(UI 三选一);存储映射见 {@link methodFromStored} / {@link storedFromForm}。 */
export type UploadMethod = "after" | "nodeSide" | "rolling";

/** 推导依赖所需的表单最小投影。 */
export interface FormFacts {
  danmu: boolean;
  /** 平台是否支持弹幕(快手无)。 */
  danmuAvailable: boolean;
  /** 是否已登录平台账号(带 Cookie 需要)。 */
  cookieReady: boolean;
  /** Cookie 是否用于取流(B站/快手 true;抖音取流恒匿名,Cookie 只影响弹幕礼物/入场 → false)。 */
  cookieForStream: boolean;
  procEnabled: boolean;
  /** 是否上传到 B 站(false = 只合成)。 */
  uploadOn: boolean;
  method: UploadMethod;
  tsDirect: boolean;
  mergeSegments: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
  /** 规则勾选的节点;空 = 全部节点。 */
  workers: readonly string[];
  /** 该房间是否有 hub 规则(无规则 = 单机任务,边录边传不受节点数约束)。 */
  hasRule: boolean;
}

export interface Lock {
  locked: boolean;
  /** 锁定原因的 i18n key。 */
  reasonKey?: string;
}

export interface Constraints {
  /** 「带 Cookie」开关;抖音上它只服务弹幕,所以依赖录弹幕。 */
  cookie: Lock;
  burn: Lock;
  rolling: Lock;
  nodeSide: Lock;
  tsDirect: Lock;
  clStageSourceAfterMerge: Lock;
  /** 只合成时「完成后清空 stage」会删掉成品:只警示不禁用。 */
  clStageAfterDoneWarn: boolean;
}

const OPEN: Lock = { locked: false };
const lock = (reasonKey: string): Lock => ({ locked: true, reasonKey });

/** resolveRollingPolicy 的拒绝原因 → 文案 key(以 mode=rolling、规则启用调用,只会命中这两种)。 */
const ROLLING_REASON_KEY: Partial<Record<RollingReason, string>> = {
  "needs-burn": "rooms.rollingNeedsBurn",
  "multi-node": "rooms.rollingReasonMultiNode",
};

function rollingLock(f: FormFacts): Lock {
  const rule = f.hasRule
    ? { enabled: true, mode: "rolling", workers: f.workers, steps: { burnDanmu: f.burnDanmu, burnLivechat: f.burnLivechat } }
    : null;
  const policy = resolveRollingPolicy(rule, true);
  if (policy.effective) return OPEN;
  return lock(ROLLING_REASON_KEY[policy.reason] ?? "rooms.rollingReasonMultiNode");
}

export function deriveConstraints(f: FormFacts): Constraints {
  const noDanmu = !f.danmu || !f.danmuAvailable;
  const burning = f.burnDanmu || f.burnLivechat;
  const rolling = rollingLock(f);
  const nodeSide = burning ? lock("rooms.nodeSideUploadDisabled") : OPEN;
  return {
    cookie: !f.cookieReady ? lock("dialog.giftNeedCookie") : noDanmu && !f.cookieForStream ? lock("roomForm.lock.needDanmu") : OPEN,
    burn: noDanmu ? lock("roomForm.lock.needDanmu") : OPEN,
    rolling,
    nodeSide,
    tsDirect: f.uploadOn && effectiveMethod(f, { rolling, nodeSide }) === "nodeSide" ? OPEN : lock("roomForm.lock.needNodeSide"),
    clStageSourceAfterMerge: f.mergeSegments ? OPEN : lock("roomForm.lock.needMerge"),
    clStageAfterDoneWarn: !f.uploadOn,
  };
}

/** 当前选择的方式若已被锁 → 回落「收播后上传」。 */
function effectiveMethod(f: FormFacts, c: Pick<Constraints, "rolling" | "nodeSide">): UploadMethod {
  if (f.method === "rolling" && c.rolling.locked) return "after";
  if (f.method === "nodeSide" && c.nodeSide.locked) return "after";
  return f.method;
}

/** 写入一个字段后重算方式:开烧录 / 改节点数让当前方式失效时自动回落,不留「看着开着其实没生效」。 */
export function applyChange<T extends FormFacts, K extends keyof T>(f: T, key: K, value: T[K]): T {
  const next = { ...f, [key]: value };
  return { ...next, method: effectiveMethod(next, deriveConstraints(next)) };
}

/** 存储(upload.mode + steps.nodeSideUpload)→ 表单。 */
export function methodFromStored(mode: string | undefined, nodeSideUpload: boolean): { uploadOn: boolean; method: UploadMethod } {
  const uploadOn = mode === "upload" || mode === "rolling";
  const method: UploadMethod = mode === "rolling" ? "rolling" : nodeSideUpload ? "nodeSide" : "after";
  return { uploadOn, method };
}

/** 表单 → 存储。被锁的方式按「收播后上传」写回;tsDirect 原值由调用方原样提交。 */
export function storedFromForm(f: FormFacts): { mode: "stage" | "upload" | "rolling"; nodeSideUpload: boolean } {
  if (!f.uploadOn) return { mode: "stage", nodeSideUpload: false };
  const method = effectiveMethod(f, deriveConstraints(f));
  return { mode: method === "rolling" ? "rolling" : "upload", nodeSideUpload: method === "nodeSide" };
}

export interface FlowStep {
  /** i18n key。 */
  key: string;
  on: boolean;
}

/** 顶部流程摘要:录制 → 处理步骤 → 交付。只描述「按当前表单会发生什么」。 */
export function flowSummary(f: FormFacts, recEnabled: boolean): FlowStep[] {
  const steps: FlowStep[] = [{ key: "roomForm.flow.record", on: recEnabled }];
  if (!f.procEnabled) return [...steps, { key: "roomForm.flow.noProcess", on: false }];
  const method = effectiveMethod(f, deriveConstraints(f));
  if (f.uploadOn && method === "rolling") return [...steps, { key: "roomForm.flow.rolling", on: true }];
  steps.push({ key: f.mergeSegments ? "roomForm.flow.merge" : "roomForm.flow.split", on: true });
  if (f.burnDanmu) steps.push({ key: "roomForm.flow.burnDanmu", on: true });
  if (f.burnLivechat) steps.push({ key: "roomForm.flow.burnLivechat", on: true });
  if (!f.uploadOn) steps.push({ key: "roomForm.flow.stageOnly", on: false });
  else steps.push({ key: method === "nodeSide" ? "roomForm.flow.nodeSide" : "roomForm.flow.upload", on: true });
  return steps;
}
