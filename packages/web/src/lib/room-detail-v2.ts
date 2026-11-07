/**
 * room-detail-v2.ts — 房间详情页 v2 的展示模型(#557,基准 = dev/room-detail-v2-proto.html)。
 *
 * 页面优先级原则:正在录的房间,进度 + 日志是高频,配置是低频。
 * 本模块只做纯函数:四域字段的常用/更多分组、summary 摘要文案。数据全部来自 RoomDTO
 * (与 RoomEditor 的 formFromRoom 同源投影),不发明字段、不新造判定。
 */
import type { RoomDTO } from "../api/client";

/** 一个配置字段的展示投影。value 已是可读文案;unset=true 时 UI 弱化显示。 */
export interface CfgField {
  key: string;
  label: string;
  value: string;
  /** 摘要里的短形态(缺省回落 value)。 */
  short?: string;
  note?: string;
  mono?: boolean;
  unset?: boolean;
}

export type DomainId = "record" | "process" | "upload" | "notify";

export interface DomainDef {
  id: DomainId;
  titleKey: string;
  /** 摘要取这些字段的 short/value,按序拼接。 */
  summaryKeys: string[];
  /** 「常用」组:展开域时第一眼看到的字段。 */
  primaryKeys: string[];
  /** 全部字段(常用 + 更多),保持稳定顺序。 */
  fields: CfgField[];
}

const f = (key: string, label: string, value: string, opts: Partial<Omit<CfgField, "key" | "label" | "value">> = {}): CfgField =>
  ({ key, label, value, ...opts });

const YES = "开";
const NO = "关";

/** 录制域:任务半边 + 输出格式(含锁定原因)。 */
function recordFields(room: RoomDTO, opts: DomainInput): CfgField[] {
  const rec = room.recording;
  if (!rec) return [f("taskId", "录制任务", "未绑定", { unset: true })];
  const out: CfgField[] = [
    f("platform", "平台", room.platform, { mono: true }),
    f("quality", "画质", opts.qualityFull(rec.quality)),
    f("engine", "录制引擎", rec.engine, { mono: true }),
    f("segmentSec", "分段时长", rec.segmentSec > 0 ? opts.segmentUnit(rec.segmentSec) : opts.noSegment, { mono: true }),
    f("danmu", "录制弹幕", rec.danmu ? YES : NO, { short: rec.danmu ? "弹幕开" : "不录弹幕" }),
    f("schedule", "录制窗口", opts.schedule, { mono: true }),
    f("name", "保存名称", rec.name ?? "-", { note: "文件名优先取解析名" }),
    f("anchorName", "主播名", rec.anchorName ?? "-", { note: "运行时解析名,与任务名称独立" }),
    f("useLoginState", "带账号信息", rec.useCookie ? YES : NO, { note: "取流匿名,账号只用于礼物/入场弹幕" }),
    f("outDir", "输出目录", rec.outDir ?? "-", { mono: true, unset: !rec.outDir, note: rec.outDir ? undefined : "留空 = 数据根默认输出目录" }),
    f("outputFormat", "输出格式", rec.outputFormat === "original" ? opts.fmtOriginal : rec.outputFormat.toUpperCase(), {
      mono: true,
      note: opts.lockReason,
    }),
  ];
  return out;
}

/** 处理域:规则半边的管线步骤与版本。 */
function processFields(room: RoomDTO, opts: DomainInput): CfgField[] {
  const proc = room.processing;
  if (!proc) return [f("procEnabled", "编排", "未配置处理", { unset: true })];
  const steps = proc.pipeline.steps ?? {};
  return [
    f("procEnabled", "编排此房间", proc.enabled ? YES : NO, { short: proc.enabled ? "编排开" : "已暂停", note: proc.enabled ? undefined : "各节点停录,录完也不处理;任务与配置保留" }),
    f("mergeSegments", "产出形态", steps.mergeSegments === false ? "按录制分段" : "合并为一个视频"),
    f("burnDanmu", "烧录弹幕", steps.burnDanmu === false ? NO : YES, { short: steps.burnDanmu === false ? "不烧录" : "烧弹幕" }),
    f("burnLivechat", "烧录聊天", steps.burnLivechat === false ? NO : YES),
    f("versions", "要哪些版本", opts.versions),
    f("where", "参与节点", opts.where, { mono: true }),
    ...(proc.requires?.length ? [f("requires", "能力要求", proc.requires.join(" · "), { mono: true })] : []),
  ];
}

/** 投稿域:上传方式与稿件字段。 */
function uploadFields(room: RoomDTO, opts: DomainInput): CfgField[] {
  const up = room.processing?.pipeline?.upload;
  if (!up) return [f("uploadOn", "录完之后", "未配置", { unset: true, note: "无处理规则" })];
  return [
    f("uploadMode", "上传方式", opts.delivery, { short: opts.delivery }),
    f("uploadPrivate", "可见性", opts.privateLabel),
    f("tid", "分区 tid", up.tid != null ? String(up.tid) : "-", { mono: true, unset: up.tid == null }),
    f("tag", "标签", up.tag || "-", { unset: !up.tag }),
    f("titleTemplate", "文件名模板", up.titleTemplate || "-", { mono: true, unset: !up.titleTemplate, note: up.titleTemplate ? undefined : "编辑时预填统一默认值" }),
    f("submissionTitleTemplate", "稿件标题模板", up.submissionTitleTemplate || "-", { mono: true, unset: !up.submissionTitleTemplate }),
    f("partTitleTemplate", "分 P 标题模板", up.partTitleTemplate || "-", { mono: true, unset: !up.partTitleTemplate }),
    f("desc", "简介", up.desc || "-", { unset: !up.desc, note: up.desc ? undefined : "留空 = 不额外填写" }),
    f("seasonSectionId", "合集 ID", up.seasonSectionId != null ? String(up.seasonSectionId) : "-", {
      mono: true,
      unset: up.seasonSectionId == null,
      note: up.seasonSectionId == null ? "未加入合集;投稿成功后可自动加入" : undefined,
    }),
    f("partSizeMiB", "每 P 大小(MiB)", up.partSizeMiB != null ? String(up.partSizeMiB) : "-", {
      mono: true,
      unset: up.partSizeMiB == null,
      note: up.partSizeMiB == null ? "继承默认 1540(10 MiB 对齐)" : undefined,
    }),
  ];
}

/** 通知与清理域。 */
function notifyFields(room: RoomDTO, opts: { cleanupSummary: string; createdAt: string | null }): CfgField[] {
  const rec = room.recording;
  const out: CfgField[] = [
    f("webhook", "通知推送地址", rec?.hasWebhook === true ? "已设置(不回显)" : "-", { unset: rec?.hasWebhook !== true, note: rec?.hasWebhook === true ? "凭据不回显;留空 = 用全局配置" : undefined }),
  ];
  if (room.processing) {
    out.push(f("cleanup", "清理行为", opts.cleanupSummary, { note: "弹幕与字幕文件永不删到最后一份" }));
  }
  if (opts.createdAt) out.push(f("createdAt", "创建时间", opts.createdAt, { mono: true }));
  return out;
}

export interface DomainInput {
  room: RoomDTO;
  /** 渲染层文案(已翻译)由调用方注入,本模块不依赖 i18n。 */
  qualityFull: (q: string) => string;
  segmentUnit: (s: number) => string;
  noSegment: string;
  fmtOriginal: string;
  schedule: string;
  lockReason: string | undefined;
  versions: string;
  where: string;
  delivery: string;
  privateLabel: string;
  cleanupSummary: string;
  createdAt: string | null;
}

/** 四域完整定义:字段全集 = 编辑器可见字段 + DTO 派生,一个不删。 */
export function configDomains(input: DomainInput): DomainDef[] {
  return [
    {
      id: "record",
      titleKey: "room.cfg.record",
      summaryKeys: ["quality", "engine", "segmentSec", "danmu"],
      primaryKeys: ["quality", "engine", "segmentSec", "danmu", "schedule"],
      fields: recordFields(input.room, input),
    },
    {
      id: "process",
      titleKey: "room.cfg.process",
      summaryKeys: ["procEnabled", "mergeSegments", "burnDanmu"],
      primaryKeys: ["procEnabled", "mergeSegments", "versions", "where"],
      fields: processFields(input.room, input),
    },
    {
      id: "upload",
      titleKey: "room.cfg.upload",
      summaryKeys: ["uploadMode", "uploadPrivate", "seasonSectionId"],
      primaryKeys: ["uploadMode", "uploadPrivate", "tid", "tag"],
      fields: uploadFields(input.room, input),
    },
    {
      id: "notify",
      titleKey: "room.cfg.notify",
      summaryKeys: ["webhook", "cleanup"],
      primaryKeys: ["webhook"],
      fields: notifyFields(input.room, input),
    },
  ];
}

/** 摘要行:按 summaryKeys 取 short/value,未设置项跳过;全空返回 null(UI 显示默认摘要)。 */
export function domainSummary(domain: DomainDef): string | null {
  const byKey = new Map(domain.fields.map((x) => [x.key, x]));
  const parts = domain.summaryKeys
    .map((k) => byKey.get(k))
    .filter((x): x is CfgField => !!x)
    .map((x) => (x.unset ? "" : (x.short ?? x.value).trim()))
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/** 域内分组:常用(按 primaryKeys 序)+ 更多(其余,保持 fields 序)。 */
export function domainGroups(domain: DomainDef): { primary: CfgField[]; more: CfgField[] } {
  const rank = new Map(domain.primaryKeys.map((k, i) => [k, i]));
  const primary = domain.fields
    .filter((x) => rank.has(x.key))
    .sort((a, b) => (rank.get(a.key) ?? 99) - (rank.get(b.key) ?? 99));
  const primaryKeys = new Set(domain.primaryKeys);
  const more = domain.fields.filter((x) => !primaryKeys.has(x.key));
  return { primary, more };
}
