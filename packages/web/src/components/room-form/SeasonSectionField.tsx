import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

interface Props {
  /** 合集 ID (issue #460): entered from the creator center and resolved to a section at upload time. */
  seasonId: string;
  /** Legacy season section id; rendered only for rules that already stored one (round-trip). */
  seasonSectionId: string;
  /** Whether the stored rule already carries a legacy seasonSectionId (including an explicit null). */
  seasonSectionIdStored: boolean;
  onChange: (patch: { seasonId?: string; seasonSectionId?: string }) => void;
}

/** Bilibili 合集 ID input, plus the legacy section id for rules that still carry one. */
export function SeasonSectionField({ seasonId, seasonSectionId, seasonSectionIdStored, onChange }: Props): ReactNode {
  const t = useT();
  return (
    <>
      <label className="block sm:col-span-2">
        <span className="field-label">{t("hub.ruleDialog.seasonIdLabel")}</span>
        <input type="number" min={1} className="input font-mono text-sm"
               placeholder={t("hub.ruleDialog.seasonIdPlaceholder")}
               value={seasonId} onChange={(e) => onChange({ seasonId: e.target.value })} />
        <p className="text-[11px] text-muted-soft mt-1">{t("hub.ruleDialog.seasonIdHint")}</p>
      </label>
      {seasonSectionIdStored && (
        <label className="block sm:col-span-2">
          <span className="field-label">{t("hub.ruleDialog.legacySeasonSectionIdLabel")}</span>
          <input type="number" min={1} className="input font-mono text-sm"
                 placeholder={t("hub.ruleDialog.seasonSectionIdPlaceholder")}
                 value={seasonSectionId} onChange={(e) => onChange({ seasonSectionId: e.target.value })} />
          <p className="text-[11px] text-muted-soft mt-1">{t("hub.ruleDialog.seasonSectionIdHint")}</p>
        </label>
      )}
    </>
  );
}
