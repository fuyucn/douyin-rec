/**
 * experimental.ts — 实验性功能注册表(rank 0,纯数据 + 纯函数,无 IO)。
 *
 * 唯一用途:驱动 Web 的「实验性」徽标与悬浮说明(名称 / 说明 / 风险 / 默认策略 / 去向)。
 * **不参与任何行为判定**:上传、删源、选优等语义仍由各自模块(如 rolling-policy.ts)决定,
 * 这里只回答「哪些功能在观察期、该怎么向用户讲清楚」。新增实验功能只需在
 * {@link EXPERIMENTAL_FEATURES} 登记一条 + 在 web i18n 补四条文案(`scripts/check-i18n.mjs` 会核对 key 存在)。
 *
 * 不做单独「实验性」分区(issue #43 用户修订):功能留在原位置,徽标挂在控件旁。
 * 功能稳定后删除登记项即可摘掉徽标。
 */

/** 功能所属配置层:hub = hub 规则;task = 任务/房间录制配置;global = 全局设置。 */
export type ExperimentalLayer = "hub" | "task" | "global";

export interface ExperimentalFeature {
  /** 稳定 id(唯一,kebab-case)。 */
  id: string;
  /** 显示名 i18n key。 */
  nameKey: string;
  /** 说明 i18n key(一行,讲功能做什么)。 */
  descKey: string;
  /** 风险提示 i18n key(讲观察期可能出什么问题)。 */
  riskKey: string;
  /** 「在哪里开关」i18n key(徽标里的去向提示)。 */
  whereKey: string;
  /** 晋升/退役条件 i18n key:写清「满足什么就摘徽标」,避免「实验性」变成永久装饰。 */
  graduationKey: string;
  /** 退役的机器可核对口径:跟踪票关闭 + 线上观察满 observeHours 小时无新增 incident → 删本登记项即摘徽标。 */
  graduation: { observeHours: number; closeTrackingIssue: boolean };
  /** 跟踪 GitHub issue 号(徽标里展示);无独立 issue(仅 TODO 台账)时为 null。 */
  trackingIssue: number | null;
  layer: ExperimentalLayer;
  /** 默认状态:false = 默认关闭(需显式开启);true = 默认开启(罕见,须在说明里写清)。 */
  defaultEnabled: boolean;
}

/**
 * 首批登记:
 *  - rolling-upload:边录边传(hub 规则 pipeline.upload.mode=rolling,issue #40)。
 *  - node-side-upload:节点侧上传(hub 规则 steps.nodeSideUpload;原文案里就写着「(实验)」,收归注册表)。
 *  - segment-part-xml:分段模式(steps.mergeSegments=false)按分 P 派生弹幕 xml(issue #7),仍在观察期,
 *    归入实验性 —— 它写入用户可见的稿件分 P 产物,窗口口径一旦错位会误导用户,宜带徽标提示。
 *    语义约束(用户设计,issue #7/#43):派生文件由会话总 xml 同步切片而来,**只新增、与总 xml 并存**,
 *    不得替换/改名/覆盖/据此删除总 xml;关闭或回退时可回收派生文件,总 xml 永不受影响
 *    (「不得删掉最后一份 .xml」口径同样适用于派生文件所在 stage)。
 */
export const EXPERIMENTAL_FEATURES: readonly ExperimentalFeature[] = [
  {
    id: "rolling-upload",
    nameKey: "experimental.rollingUpload.name",
    descKey: "experimental.rollingUpload.desc",
    riskKey: "experimental.rollingUpload.risk",
    whereKey: "experimental.rollingUpload.where",
    graduationKey: "experimental.rollingUpload.graduation",
    graduation: { observeHours: 48, closeTrackingIssue: true },
    trackingIssue: 40,
    layer: "hub",
    defaultEnabled: false,
  },
  {
    id: "node-side-upload",
    nameKey: "experimental.nodeSideUpload.name",
    descKey: "experimental.nodeSideUpload.desc",
    riskKey: "experimental.nodeSideUpload.risk",
    whereKey: "experimental.nodeSideUpload.where",
    graduationKey: "experimental.nodeSideUpload.graduation",
    graduation: { observeHours: 48, closeTrackingIssue: false },
    trackingIssue: null,
    layer: "hub",
    defaultEnabled: false,
  },
  {
    // 0 落盘流式直传(plans/039):ffmpeg stdout → UPOS 直传,源录像不落盘;以字节/时长上限
    // 先到者结算一个分 P,续同一稿件。层 = task(任务录制配置开关,与 rolling 的 hub 规则入口不同)。
    id: "stream-upload",
    nameKey: "experimental.streamUpload.name",
    descKey: "experimental.streamUpload.desc",
    riskKey: "experimental.streamUpload.risk",
    whereKey: "experimental.streamUpload.where",
    graduationKey: "experimental.streamUpload.graduation",
    // 0 落盘一旦断流丢的是**没上传完的那一段**(没有源文件可回退),观察期按最长口径留。
    graduation: { observeHours: 168, closeTrackingIssue: true },
    trackingIssue: null,
    layer: "task",
    defaultEnabled: false,
  },
  {
    id: "segment-part-xml",
    nameKey: "experimental.segmentPartXml.name",
    descKey: "experimental.segmentPartXml.desc",
    riskKey: "experimental.segmentPartXml.risk",
    whereKey: "experimental.segmentPartXml.where",
    graduationKey: "experimental.segmentPartXml.graduation",
    graduation: { observeHours: 48, closeTrackingIssue: true },
    trackingIssue: 7,
    layer: "hub",
    defaultEnabled: false,
  },
];

/** 按 id 取登记项;未登记 → undefined(徽标组件据此不渲染,避免拼错 id 显示空壳)。 */
export function getExperimentalFeature(id: string): ExperimentalFeature | undefined {
  return EXPERIMENTAL_FEATURES.find((f) => f.id === id);
}

/** id 是否已登记为实验性功能。 */
export function isExperimental(id: string): boolean {
  return getExperimentalFeature(id) !== undefined;
}

/** 某配置层下登记的实验性功能。 */
export function experimentalByLayer(layer: ExperimentalLayer): ExperimentalFeature[] {
  return EXPERIMENTAL_FEATURES.filter((f) => f.layer === layer);
}

/**
 * 是否满足退役口径(仅供维护者/脚本核对,不参与运行时行为):
 * 观察时长达标,且(若要求)跟踪票已关闭 → 可删登记项摘徽标。
 */
export function isGraduated(
  f: Pick<ExperimentalFeature, "graduation">,
  s: { observedHours: number; trackingIssueClosed: boolean },
): boolean {
  return s.observedHours >= f.graduation.observeHours && (!f.graduation.closeTrackingIssue || s.trackingIssueClosed);
}

/** 默认策略 i18n key:徽标据此渲染「默认关闭 / 默认开启」。 */
export function experimentalDefaultKey(f: Pick<ExperimentalFeature, "defaultEnabled">): string {
  return f.defaultEnabled ? "experimental.defaultOn" : "experimental.defaultOff";
}
