/**
 * room-form-rules.ts — 房间 / Hub 规则 / 任务表单的**字段依赖唯一推导**(Pure,可直测)。
 *
 * 为什么单独抽:「边录边传和烧录互斥」「节点侧上传只在上传时有效」这类依赖原本在
 * 房间编辑弹窗(RoomEditor)与 HubRuleDialog 里各写一份,改一处漏一处。表单只渲染这里的结果。
 * 边录边传是否可用直接调 core 的 `resolveRollingPolicy`,与 master 下发同一判定。
 */
import { resolveRollingPolicy, type RollingReason } from "@drec/rolling-policy";
import type { OutputFormatLock } from "@drec/contracts";
import { DEFAULT_OUTPUT_FORMAT, effectiveStageFormat, isOutputFormat, outputFormatLocked, type OutputFormat } from "@drec/output-format";

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
  /** 是否上传到 B 站(false = 只存档)。 */
  uploadOn: boolean;
  method: UploadMethod;
  tsDirect: boolean;
  mergeSegments: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
  /** 「投稿后保留存档」= 存储 cleanup.stageAfterDone 取反;映射见 {@link keepArchiveFromStored} / {@link storedFromForm}。 */
  clKeepArchive: boolean;
  /** 输出格式(缺省 original);读入见 {@link outputFormatFromStored},写回见 {@link storedFromForm}。 */
  outputFormat: OutputFormat;
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
  /** 不投稿时存档就是成品,后端在清理前即返回、从不清存档:锁定为保留。 */
  clKeepArchive: Lock;
  /** 投稿(收播后 / 节点侧 / 边录边传)一律 mp4:平台要求,选项锁定。 */
  outputFormat: Lock;
}

const OPEN: Lock = { locked: false };

/**
 * 实际会烧录的版本:不录弹幕(或平台无弹幕)时没有弹幕文件、无从烧录,按关处理。
 * 锁判定、流程摘要与存储(storedFromForm)统一用它,三方一致。
 */
function effectiveBurn(f: FormFacts): { burnDanmu: boolean; burnLivechat: boolean } {
  const canBurn = f.danmu && f.danmuAvailable;
  return { burnDanmu: canBurn && f.burnDanmu, burnLivechat: canBurn && f.burnLivechat };
}
const lock = (reasonKey: string): Lock => ({ locked: true, reasonKey });

/** resolveRollingPolicy 的拒绝原因 → 文案 key(以 mode=rolling、规则启用调用,只会命中这两种)。 */
const ROLLING_REASON_KEY: Partial<Record<RollingReason, string>> = {
  "needs-burn": "rooms.rollingNeedsBurn",
  "multi-node": "rooms.rollingReasonMultiNode",
};

function rollingLock(f: FormFacts): Lock {
  const rule = f.hasRule ? { enabled: true, mode: "rolling", workers: f.workers, steps: effectiveBurn(f) } : null;
  const policy = resolveRollingPolicy(rule, true);
  if (policy.effective) return OPEN;
  return lock(ROLLING_REASON_KEY[policy.reason] ?? "rooms.rollingReasonMultiNode");
}

/** 「带 Cookie」开关:未登录一律锁;抖音上它只服务弹幕,不录弹幕时也锁。任务弹窗单独用它。 */
export function cookieLock(f: Pick<FormFacts, "danmu" | "danmuAvailable" | "cookieReady" | "cookieForStream">): Lock {
  if (!f.cookieReady) return lock("dialog.giftNeedCookie");
  const noDanmu = !f.danmu || !f.danmuAvailable;
  return noDanmu && !f.cookieForStream ? lock("roomForm.lock.needDanmu") : OPEN;
}

/**
 * 任务对话框的输出格式锁:**完全由后端下发的 `outputFormatLock` 决定**(= 后端 `nodeOutputFormatLock`,
 * 与「是否真的替换」同源),前端不再自己判 hub 状态。字段缺失(旧后端)→ 不锁,降级但不崩。
 */
export function taskOutputFormatLock(f: { outputFormatLock?: OutputFormatLock | null }): Lock {
  const reason = f.outputFormatLock;
  switch (reason) {
    case "hub-managed": return lock("roomForm.lock.outputFormatHub");
    case "hub-rule": return lock("roomForm.lock.outputFormatHubRule");
    case "rolling": return lock("roomForm.lock.outputFormatRolling");
    case "no-survivors": return lock("roomForm.lock.outputFormatNoSurvivors");
    case null:
    case undefined: return OPEN;
    default: {
      // 后端新增锁原因而这里漏分支 → 此处编译报错(reason 不再是 never);运行期遇到未知值按不锁降级。
      const unhandled: never = reason;
      void unhandled;
      return OPEN;
    }
  }
}

export function deriveConstraints(f: FormFacts): Constraints {
  const noDanmu = !f.danmu || !f.danmuAvailable;
  const burn = effectiveBurn(f);
  const burning = burn.burnDanmu || burn.burnLivechat;
  const rolling = rollingLock(f);
  const nodeSide = burning ? lock("rooms.nodeSideUploadDisabled") : OPEN;
  return {
    cookie: cookieLock(f),
    burn: noDanmu ? lock("roomForm.lock.needDanmu") : OPEN,
    rolling,
    nodeSide,
    tsDirect: f.uploadOn && effectiveMethod(f, { rolling, nodeSide }) === "nodeSide" ? OPEN : lock("roomForm.lock.needNodeSide"),
    clStageSourceAfterMerge: f.mergeSegments ? OPEN : lock("roomForm.lock.needMerge"),
    clKeepArchive: f.uploadOn ? OPEN : lock("roomForm.lock.needUploadForCleanArchive"),
    // 是否锁、锁成什么,唯一判定 = core outputFormatLocked / effectiveStageFormat,与后端一致。
    outputFormat: outputFormatLocked(f.uploadOn ? "upload" : "stage") ? lock("roomForm.lock.outputFormatUpload") : OPEN,
  };
}

/** 当前选择的方式若已被锁 → 回落「收播后上传」。 */
function effectiveMethod(f: FormFacts, c: Pick<Constraints, "rolling" | "nodeSide">): UploadMethod {
  if (f.method === "rolling" && c.rolling.locked) return "after";
  if (f.method === "nodeSide" && c.nodeSide.locked) return "after";
  return f.method;
}

/** 按当前依赖结算出的上传方式(已失效的方式回落「收播后上传」)。 */
export function settledMethod(f: FormFacts): UploadMethod {
  return effectiveMethod(f, deriveConstraints(f));
}

/** 写入一个字段后重算方式:开烧录 / 改节点数让当前方式失效时自动回落,不留「看着开着其实没生效」。 */
export function applyChange<T extends FormFacts, K extends keyof T>(f: T, key: K, value: T[K]): T {
  const next = { ...f, [key]: value };
  return { ...next, method: settledMethod(next) };
}

/** 存储(upload.mode + steps.nodeSideUpload)→ 表单。 */
export function methodFromStored(mode: string | undefined, nodeSideUpload: boolean): { uploadOn: boolean; method: UploadMethod } {
  const uploadOn = mode === "upload" || mode === "rolling";
  const method: UploadMethod = mode === "rolling" ? "rolling" : nodeSideUpload ? "nodeSide" : "after";
  return { uploadOn, method };
}

/** 存储 outputFormat → 表单;缺省 / 老数据 / 非白名单值一律按 original。 */
export function outputFormatFromStored(v: unknown): OutputFormat {
  return isOutputFormat(v) ? v : DEFAULT_OUTPUT_FORMAT;
}

/** 下拉里实际显示的格式:被锁(投稿)时恒为生效容器 mp4,否则为所选值。 */
export function shownOutputFormat(f: Pick<FormFacts, "uploadOn" | "outputFormat">): OutputFormat {
  return f.uploadOn ? effectiveStageFormat(f.outputFormat, "upload") : f.outputFormat;
}

export interface StoredFields {
  mode: "stage" | "upload" | "rolling";
  /** 写回源任务的输出格式。投稿时被锁:original 保持 original(同为 mp4,不制造无谓改动),其余一律写 mp4。 */
  outputFormat: OutputFormat;
  nodeSideUpload: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
  /** 存储 cleanup.stageAfterDone。 */
  stageAfterDone: boolean;
}

/** 存储 cleanup.stageAfterDone → 表单「投稿后保留存档」(取反;缺省 = 不清 = 保留)。 */
export function keepArchiveFromStored(stageAfterDone: boolean | undefined): boolean {
  return stageAfterDone !== true;
}

/**
 * 表单 → 存储。被锁的方式按「收播后上传」写回;烧录开关**一律写回实际值**(effectiveBurn):不录弹幕就
 * 没有弹幕文件,存原值会让后端照常执行烧录并失败,表单、流程摘要、后端三方必须一致。
 * 代价:之后重新打开录弹幕时,烧录需手动重开(原值不保留)。
 * 不投稿时「保留存档」被锁:stageAfterDone 一律写 false(后端此时从不清存档);投稿时 = !clKeepArchive。
 * tsDirect 原值由调用方提交。
 */
export function storedFromForm(f: FormFacts): StoredFields {
  const burn = effectiveBurn(f);
  if (!f.uploadOn) return { mode: "stage", outputFormat: f.outputFormat, nodeSideUpload: false, ...burn, stageAfterDone: false };
  const method = effectiveMethod(f, deriveConstraints(f));
  return {
    mode: method === "rolling" ? "rolling" : "upload",
    outputFormat: f.outputFormat === "original" ? "original" : "mp4",
    nodeSideUpload: method === "nodeSide",
    ...burn,
    stageAfterDone: !f.clKeepArchive,
  };
}

export interface FlowStep {
  /** i18n key。 */
  key: string;
  on: boolean;
  /** i18n 插值参数。 */
  vars?: Record<string, string>;
}

/** 顶部流程摘要:录制 → 处理步骤 → 交付。只描述「按当前表单会发生什么」。 */
export function flowSummary(f: FormFacts, recEnabled: boolean): FlowStep[] {
  // 规则停用 = 暂停整个房间:各节点也停录(core isWorkerAssigned),不只是不处理。
  const paused = f.hasRule && !f.procEnabled;
  const steps: FlowStep[] = [{ key: "roomForm.flow.record", on: recEnabled && !paused }];
  if (!f.procEnabled) return [...steps, { key: "roomForm.flow.noProcess", on: false }];
  const method = effectiveMethod(f, deriveConstraints(f));
  if (f.uploadOn && method === "rolling") return [...steps, { key: "roomForm.flow.rolling", on: true }];
  const burn = effectiveBurn(f);
  steps.push({ key: f.mergeSegments ? "roomForm.flow.merge" : "roomForm.flow.split", on: true });
  if (burn.burnDanmu) steps.push({ key: "roomForm.flow.burnDanmu", on: true });
  if (burn.burnLivechat) steps.push({ key: "roomForm.flow.burnLivechat", on: true });
  if (!f.uploadOn) {
    steps.push({ key: "roomForm.flow.stageOnly", on: false });
    // 存档形态末尾带所选格式(original = 现状,不带)。
    if (f.outputFormat !== "original") steps.push({ key: "roomForm.flow.format", on: false, vars: { fmt: f.outputFormat.toUpperCase() } });
  }
  else steps.push({ key: method === "nodeSide" ? "roomForm.flow.nodeSide" : "roomForm.flow.upload", on: true });
  return steps;
}
