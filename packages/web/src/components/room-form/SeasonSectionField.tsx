import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

/** Shared Bilibili season-section input used by the unified and legacy room editors. */
export function SeasonSectionField({ value, onChange }: Props): ReactNode {
  const t = useT();
  return (
    <label className="block sm:col-span-2">
      <span className="field-label">{t("hub.ruleDialog.seasonSectionIdLabel")}</span>
      <input type="number" min={1} className="input font-mono text-sm"
             placeholder={t("hub.ruleDialog.seasonSectionIdPlaceholder")}
             value={value} onChange={(e) => onChange(e.target.value)} />
      <p className="text-[11px] text-muted-soft mt-1">{t("hub.ruleDialog.seasonSectionIdHint")}</p>
    </label>
  );
}
