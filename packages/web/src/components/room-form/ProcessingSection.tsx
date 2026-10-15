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
      <SectionHeader title={t("rooms.processingSection")}
                     toggle={{ checked: v.procEnabled, onChange: (x) => onChange({ procEnabled: x }) }} />
      <p className="text-xs text-muted -mt-1">{t("rooms.procEnabledHint")}</p>
      <fieldset disabled={!v.procEnabled} className="space-y-3 disabled:opacity-50">
        <div>
          <span className="field-label inline-flex items-center gap-1.5">
            {t("roomForm.output")}<ExperimentalBadge id="segment-part-xml" />
          </span>
          <div className="seg-group" role="radiogroup">
            {([true, false] as const).map((merge) => (
              <button key={String(merge)} type="button" role="radio" aria-checked={v.mergeSegments === merge}
                      className={`seg-btn${v.mergeSegments === merge ? " is-active" : ""}`}
                      onClick={() => onChange({ mergeSegments: merge })}>
                {t(merge ? "roomForm.mergeOne" : "roomForm.mergeSplit")}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted mt-1">{t("hub.ruleDialog.toggleMergeSegmentsSub")}</p>
        </div>
        <ToggleRow label={t("rooms.burnDanmu")} hint={t("hub.ruleDialog.toggleBurnDanmuSub")}
                   checked={v.burnDanmu} onChange={(x) => onChange({ burnDanmu: x })} lock={burn} />
        <ToggleRow label={t("rooms.burnLivechat")} hint={t("hub.ruleDialog.toggleBurnLivechatSub")}
                   checked={v.burnLivechat} onChange={(x) => onChange({ burnLivechat: x })} lock={burn} />
      </fieldset>
    </section>
  );
}
