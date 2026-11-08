/**
 * room-detail-v2.ts — 房间详情页 v2 的展示模型(#557,基准 = docs/design-archive/room-detail-v2-proto.html)。
 *
 * 页面优先级原则:正在录的房间,进度 + 日志是高频,配置是低频。
 * 本模块只做纯函数:四域字段的常用/更多分组、summary 摘要文案。数据全部来自 RoomDTO,
 * 不发明字段、不新造判定。**零硬编码文案**:label/note 走 i18n key,由调用方注入
 * `tr()` 翻译;value 的可读词(开/关/已设置等)由调用方经 `words` 注入。
 */
import type { RoomDTO } from "../api/client";

/** 值域可读词(调用方从 i18n 注入;模块零中文)。 */
export interface ValueWords {
  yes: string;
  no: string;
  unsetMark: string;
  stored: string;
  paused: string;
  merged: string;
  perSegment: string;
  seasonNote: string;
  partSizeNote: string;
  templateNote: string;
  descNote: string;
  webhookStoredNote: string;
  webhookUnsetNote: string;
  cleanupNote: string;
  anchorNote: string;
  loginNote: string;
  outDirNote: string;
  procPausedNote: string;
  engineValue: (engine: string) => string;
}

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

/** 标签与备注统一走 i18n key(room.cfg.f.*),调用方注入 tr。 */
const L = (input: DomainInput, key: string): string => input.tr(`room.cfg.f.${key}`);

/** 录制域:任务半边 + 输出格式(含锁定原因)。 */
function recordFields(room: RoomDTO, opts: DomainInput): CfgField[] {
  const rec = room.recording;
  const w = opts.words;
  const L_ = (k: string) => L(opts, k);
  if (!rec) return [f("taskId", L_("task"), w.unsetMark, { unset: true })];
  return [
    f("platform", L_("platform"), room.platform, { mono: true }),
    f("quality", L_("quality"), opts.qualityFull(rec.quality)),
    f("engine", L_("engine"), w.engineValue(rec.engine), { mono: true }),
    f("segmentSec", L_("segmentSec"), rec.segmentSec > 0 ? opts.segmentUnit(rec.segmentSec) : opts.noSegment, { mono: true }),
    f("danmu", L_("danmu"), rec.danmu ? w.yes : w.no, { short: rec.danmu ? w.yes : w.no }),
    f("schedule", L_("schedule"), opts.schedule, { mono: true }),
    f("name", L_("name"), rec.name ?? w.unsetMark, { unset: !rec.name, note: opts.tr("room.cfg.f.nameNote") }),
    f("anchorName", L_("anchorName"), rec.anchorName ?? w.unsetMark, { unset: !rec.anchorName, note: opts.tr("room.cfg.f.anchorNote") }),
    f("useLoginState", L_("useLoginState"), rec.useCookie ? w.yes : w.no, { note: opts.tr("room.cfg.f.loginNote") }),
    f("hasLoginState", L_("hasLoginState"), rec.hasCookies === true ? w.stored : w.unsetMark, { unset: rec?.hasCookies !== true, note: opts.tr("room.cfg.f.webhookStoredNote") }),
    f("taskId", L_("taskId"), String(rec.taskId ?? w.unsetMark), { mono: true, unset: rec.taskId == null }),
    f("enabled", L_("enabled"), rec.enabled ? w.yes : w.no, { short: rec.enabled ? w.yes : w.no, note: opts.tr("room.cfg.f.enabledNote") }),
    f("rollingEffective", L_("rollingEffective"), rec.rollingEffective || rec.rollingUpload ? w.yes : w.no, { short: rec.rollingEffective || rec.rollingUpload ? w.yes : w.no }),
    f("outDir", L_("outDir"), rec.outDir ?? w.unsetMark, { mono: true, unset: !rec.outDir, note: rec.outDir ? undefined : opts.tr("room.cfg.f.outDirNote") }),
    f("outputFormat", L_("outputFormat"), rec.outputFormat === "original" ? opts.fmtOriginal : rec.outputFormat.toUpperCase(), {
      mono: true,
      note: opts.lockReason,
    }),
  ];
}

/** 处理域:规则半边的管线步骤与版本。 */
function processFields(room: RoomDTO, opts: DomainInput): CfgField[] {
  const proc = room.processing;
  const w = opts.words;
  const L_ = (k: string) => L(opts, k);
  if (!proc) return [f("procEnabled", L_("procEnabled"), w.unsetMark, { unset: true })];
  const steps = proc.pipeline.steps ?? {};
  return [
    f("procEnabled", L_("procEnabled"), proc.enabled ? w.yes : w.no, { short: proc.enabled ? w.yes : w.paused, note: proc.enabled ? undefined : opts.tr("room.cfg.f.procPausedNote") }),
    f("mergeSegments", L_("mergeSegments"), steps.mergeSegments === false ? w.perSegment : w.merged),
    f("burnDanmu", L_("burnDanmu"), steps.burnDanmu === false ? w.no : w.yes, { short: steps.burnDanmu === false ? w.no : w.yes }),
    f("burnLivechat", L_("burnLivechat"), steps.burnLivechat === false ? w.no : w.yes),
    f("nodeSideUpload", L_("nodeSideUpload"), steps.nodeSideUpload === true ? w.yes : w.no),
    f("tsDirect", L_("tsDirect"), steps.tsDirect === true ? w.yes : w.no),
    f("versions", L_("versions"), opts.versions),
    f("where", L_("where"), opts.where, { mono: true }),
    ...(proc.requires?.length ? [f("requires", L_("requires"), proc.requires.join(" · "), { mono: true })] : []),
  ];
}

/** 投稿域:上传方式与稿件字段。 */
function uploadFields(room: RoomDTO, opts: DomainInput): CfgField[] {
  const up = room.processing?.pipeline?.upload;
  const w = opts.words;
  const L_ = (k: string) => L(opts, k);
  if (!up) return [f("uploadOn", L_("uploadOn"), w.unsetMark, { unset: true })];
  return [
    f("uploadMode", L_("uploadMode"), opts.delivery, { short: opts.delivery }),
    f("streamUpload", L_("streamUpload"), room.recording?.streamUpload === true ? w.yes : w.no, { short: room.recording?.streamUpload === true ? w.yes : w.no, note: opts.tr("room.cfg.f.streamUploadNote") }),
    f("streamUploadSpool", L_("streamUploadSpool"), w.yes, { note: opts.tr("room.cfg.f.spoolNote") }),
    f("uploadPrivate", L_("uploadPrivate"), opts.privateLabel),
    f("tid", L_("tid"), up.tid != null ? String(up.tid) : w.unsetMark, { mono: true, unset: up.tid == null }),
    f("tag", L_("tag"), up.tag || w.unsetMark, { unset: !up.tag }),
    f("titleTemplate", L_("titleTemplate"), up.titleTemplate || w.unsetMark, { mono: true, unset: !up.titleTemplate, note: up.titleTemplate ? undefined : opts.tr("room.cfg.f.templateNote") }),
    f("submissionTitleTemplate", L_("submissionTitleTemplate"), up.submissionTitleTemplate || w.unsetMark, { mono: true, unset: !up.submissionTitleTemplate }),
    f("partTitleTemplate", L_("partTitleTemplate"), up.partTitleTemplate || w.unsetMark, { mono: true, unset: !up.partTitleTemplate }),
    f("desc", L_("desc"), up.desc || w.unsetMark, { unset: !up.desc, note: up.desc ? undefined : opts.tr("room.cfg.f.descNote") }),
    f("seasonSectionId", L_("seasonSectionId"), up.seasonSectionId != null ? String(up.seasonSectionId) : w.unsetMark, {
      mono: true,
      unset: up.seasonSectionId == null,
      note: up.seasonSectionId == null ? opts.tr("room.cfg.f.seasonNote") : undefined,
    }),
    f("partSizeMiB", L_("partSizeMiB"), up.partSizeMiB != null ? String(up.partSizeMiB) : w.unsetMark, {
      mono: true,
      unset: up.partSizeMiB == null,
      note: up.partSizeMiB == null ? opts.tr("room.cfg.f.partSizeNote") : undefined,
    }),
  ];
}

/** 通知与清理域。 */
function notifyFields(room: RoomDTO, opts: DomainInput): CfgField[] {
  const rec = room.recording;
  const w = opts.words;
  const L_ = (k: string) => L(opts, k);
  const out: CfgField[] = [
    f("webhook", L_("webhook"), rec?.hasWebhook === true ? w.stored : w.unsetMark, { unset: rec?.hasWebhook !== true, note: rec?.hasWebhook === true ? opts.tr("room.cfg.f.webhookStoredNote") : opts.tr("room.cfg.f.webhookUnsetNote") }),
  ];
  if (room.processing) {
    out.push(f("cleanup", L_("cleanup"), opts.cleanupSummary, { note: opts.tr("room.cfg.f.cleanupNote") }));
  }
  out.push(f("notifyToggles", L_("notifyToggles"), opts.tr("room.cfg.f.notifyTogglesValue")));
  if (opts.createdAt) out.push(f("createdAt", L_("createdAt"), opts.createdAt, { mono: true }));
  return out;
}

export interface DomainInput {
  room: RoomDTO;
  /** i18n 注入:key → 已翻译文案(标签与备注)。 */
  tr: (key: string) => string;
  words: ValueWords;
  /** 渲染层文案(已翻译)由调用方注入。 */
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
