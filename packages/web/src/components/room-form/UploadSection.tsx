import type { ReactNode } from "react";
import { ExperimentalBadge } from "../ExperimentalBadge";
import { Switch } from "../Switch";
import { useT } from "../../lib/i18n";
import type { Constraints, Lock, UploadMethod } from "../../lib/room-form-rules";
import { previewPartTitles, previewTitle } from "../../lib/title-preview";
import { SectionHeader, ToggleRow } from "./parts";

export interface UploadValue {
  uploadOn: boolean;
  method: UploadMethod;
  tsDirect: boolean;
  uploadPrivate: boolean;
  tid: string;
  tag: string;
  desc: string;
  titleTemplate: string;
  submissionTitleTemplate: string;
  partTitleTemplate: string;
}

interface Props {
  value: UploadValue;
  onChange: (patch: Partial<UploadValue>) => void;
  constraints: Pick<Constraints, "rolling" | "nodeSide" | "tsDirect">;
  /** 处理关闭时上传无从发生,整区禁用。 */
  procEnabled: boolean;
  /** 标题预览里的主播名。 */
  anchorName: string;
}

const METHODS: { id: UploadMethod; labelKey: string; hintKey: string; badge?: string }[] = [
  { id: "after", labelKey: "roomForm.method.after", hintKey: "roomForm.method.afterHint" },
  { id: "nodeSide", labelKey: "rooms.nodeSideUpload", hintKey: "hub.ruleDialog.toggleNodeSideUploadSub", badge: "node-side-upload" },
  { id: "rolling", labelKey: "rooms.rollingUpload", hintKey: "rooms.rollingUploadHint", badge: "rolling-upload" },
];

function MethodOption({ id, labelKey, hintKey, badge, selected, lock, onSelect }: (typeof METHODS)[number] & {
  selected: boolean;
  lock: Lock;
  onSelect: () => void;
}): ReactNode {
  const t = useT();
  const pick = (): void => { if (!lock.locked) onSelect(); };
  return (
    // div 而非 button:选项内含实验性徽标(本身是 button),button 不能嵌套。
    <div role="radio" tabIndex={lock.locked ? -1 : 0} aria-checked={selected} aria-disabled={lock.locked} data-method={id}
         className={`method-option${selected ? " is-active" : ""}`} onClick={pick}
         onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); pick(); } }}>
      <span className="method-dot" aria-hidden />
      <span className="flex flex-col min-w-0 text-left">
        <span className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
          {t(labelKey)}
          {/* 点徽标是看说明,不是选这个方式 */}
          {badge && <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}><ExperimentalBadge id={badge} /></span>}
        </span>
        <span className="text-xs text-muted mt-0.5">{t(hintKey)}</span>
        {lock.locked && lock.reasonKey && <span className="text-xs text-warning-fg mt-0.5">{t(lock.reasonKey)}</span>}
      </span>
    </div>
  );
}

function TemplateField({ label, hint, placeholder, value, presets, preview, onChange }: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  presets: readonly string[];
  preview?: string;
  onChange: (v: string) => void;
}): ReactNode {
  return (
    <div className="sm:col-span-2">
      <label className="field-label">{label}</label>
      <input className="input font-mono text-sm" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {presets.map((preset) => (
          <button key={preset} type="button" onClick={() => onChange(preset)}
                  className="text-[11px] font-mono px-2 py-0.5 rounded border border-hairline text-muted hover:text-ink">
            {preset}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-soft mt-1">
        {hint}{preview && <span className="font-mono text-body ml-1">{preview}</span>}
      </p>
    </div>
  );
}

export function UploadSection({ value: v, onChange, constraints: c, procEnabled, anchorName }: Props): ReactNode {
  const t = useT();
  const locks: Record<UploadMethod, Lock> = { after: { locked: false }, nodeSide: c.nodeSide, rolling: c.rolling };
  return (
    <section className="space-y-3">
      <SectionHeader title={t("hub.ruleDialog.uploadSection")}
                     toggle={{ checked: procEnabled && v.uploadOn, onChange: (x) => onChange({ uploadOn: x }), disabled: !procEnabled }} />
      <p className="text-xs text-muted -mt-1">{t(v.uploadOn ? "hub.ruleDialog.uploadOnHint" : "hub.ruleDialog.uploadOffHint")}</p>
      {procEnabled && v.uploadOn && (
        <>
          <span className="field-label">{t("roomForm.method.label")}</span>
          <div className="space-y-2" role="radiogroup">
            {METHODS.map((m) => (
              <MethodOption key={m.id} {...m} selected={v.method === m.id} lock={locks[m.id]}
                            onSelect={() => onChange({ method: m.id })} />
            ))}
          </div>
          <ToggleRow nested label={t("hub.ruleDialog.toggleTsDirectLabel")} hint={t("hub.ruleDialog.toggleTsDirectSub")}
                     checked={v.tsDirect} onChange={(x) => onChange({ tsDirect: x })} lock={c.tsDirect} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="switch-row">
              <span className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-ink">{t("hub.ruleDialog.publicLabel")}</span>
                <span className="text-xs text-muted mt-0.5">{t(v.uploadPrivate ? "hub.ruleDialog.privateHint" : "hub.ruleDialog.publicHint")}</span>
              </span>
              <Switch checked={!v.uploadPrivate} onCheckedChange={(x) => onChange({ uploadPrivate: !x })} />
            </label>
            <label className="block">
              <span className="field-label">{t("hub.ruleDialog.tidLabel")}</span>
              <input type="number" min={1} className="input" value={v.tid} onChange={(e) => onChange({ tid: e.target.value })} />
            </label>
            <label className="block sm:col-span-2">
              <span className="field-label">{t("hub.ruleDialog.tagLabel")}</span>
              <input className="input" placeholder={t("hub.ruleDialog.tagPlaceholder")} value={v.tag} onChange={(e) => onChange({ tag: e.target.value })} />
            </label>
            <TemplateField label={t("hub.ruleDialog.titleTemplateLabel")} hint={t("hub.ruleDialog.titleTemplateHint")}
                           placeholder="{name}_{date}" value={v.titleTemplate} onChange={(x) => onChange({ titleTemplate: x })}
                           presets={["{name}_{date}", "{name}_{date}_{HH}-{mm}", "{name}_{date}_{HH}-{mm}-{ss}", "{name}_{title}_{date}"]}
                           preview={previewTitle(v.titleTemplate, anchorName)} />
          </div>
          <details className="group">
            <summary className="text-xs text-muted cursor-pointer">{t("roomForm.moreUpload")}</summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <TemplateField label={t("hub.ruleDialog.submissionTitleTemplateLabel")} hint={t("hub.ruleDialog.submissionTitleTemplateHint")}
                             placeholder={t("hub.ruleDialog.submissionTitleTemplatePlaceholder")} value={v.submissionTitleTemplate}
                             onChange={(x) => onChange({ submissionTitleTemplate: x })}
                             presets={["{name}_{date}", "{name}_{date} 直播回放", "{name}_{title}"]}
                             preview={previewTitle(v.submissionTitleTemplate || v.titleTemplate, anchorName)} />
              <TemplateField label={t("hub.ruleDialog.partTitleTemplateLabel")} hint={t("hub.ruleDialog.partTitleTemplateHint")}
                             placeholder={t("hub.ruleDialog.partTitleTemplatePlaceholder")} value={v.partTitleTemplate}
                             onChange={(x) => onChange({ partTitleTemplate: x })}
                             presets={["{name}_P{part}", "{name}_{date}_P{part}", "{name}_{date}"]}
                             preview={v.partTitleTemplate.trim() ? previewPartTitles(v.partTitleTemplate, anchorName) : undefined} />
              <label className="block sm:col-span-2">
                <span className="field-label">{t("hub.ruleDialog.descLabel")}</span>
                <textarea className="textarea font-mono text-sm" rows={4} placeholder={t("hub.ruleDialog.descPlaceholder")}
                          value={v.desc} onChange={(e) => onChange({ desc: e.target.value })} />
              </label>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
