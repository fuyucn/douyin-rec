import type { ReactNode } from "react";
import { ExperimentalBadge } from "../ExperimentalBadge";
import { useT } from "../../lib/i18n";
import type { Lock } from "../../lib/room-form-rules";
import { SectionHeader, ToggleRow } from "./parts";

export interface ProcessingValue {
  procEnabled: boolean;
  mergeSegments: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
}

interface Props {
  value: ProcessingValue;
  onChange: (patch: Partial<ProcessingValue>) => void;
  burn: Lock;
}

export function ProcessingSection({ value: v, onChange, burn }: Props): ReactNode {
  const t = useT();
  return (
    <section className="space-y-3">
      <SectionHeader title={t("rooms.processingSection")} />
      <fieldset disabled={!v.procEnabled} className="space-y-3 disabled:opacity-50">
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="field-label !mb-0">{t("roomForm.output")}</span><ExperimentalBadge id="segment-part-xml" />
          </div>
          <div className="seg-group" role="radiogroup">
            {([true, false] as const).map((merge) => (
              <button key={String(merge)} type="button" role="radio" aria-checked={v.mergeSegments === merge}
                      className={`seg-btn${v.mergeSegments === merge ? " is-active" : ""}`}
                      onClick={() => onChange({ mergeSegments: merge })}>
                {t(merge ? "roomForm.mergeOne" : "roomForm.mergeSplit")}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted mt-1">{t("roomForm.outputHint")}</p>
        </div>
        <ToggleRow label={t("rooms.burnDanmu")} hint={t("hub.ruleDialog.toggleBurnDanmuSub")}
                   checked={v.burnDanmu} onChange={(x) => onChange({ burnDanmu: x })} lock={burn} />
        <ToggleRow label={t("rooms.burnLivechat")} hint={t("hub.ruleDialog.toggleBurnLivechatSub")}
                   checked={v.burnLivechat} onChange={(x) => onChange({ burnLivechat: x })} lock={burn} />
      </fieldset>
    </section>
  );
}
