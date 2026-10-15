import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import type { Constraints } from "../../lib/room-form-rules";
import { SectionHeader, ToggleRow } from "./parts";

export interface CleanupValue {
  clStageSourceAfterMerge: boolean;
  clSourceAfterDone: boolean;
  clStageAfterDone: boolean;
}

interface Props {
  value: CleanupValue;
  onChange: (patch: Partial<CleanupValue>) => void;
  constraints: Pick<Constraints, "clStageSourceAfterMerge" | "clStageAfterDoneWarn">;
  procEnabled: boolean;
}

export function CleanupSection({ value: v, onChange, constraints: c, procEnabled }: Props): ReactNode {
  const t = useT();
  return (
    <section className="space-y-3">
      <SectionHeader title={t("roomForm.cleanupSection")} />
      <fieldset disabled={!procEnabled} className="space-y-3 disabled:opacity-50">
        <ToggleRow label={t("hub.ruleDialog.toggleClStageSourceAfterMergeLabel")} hint={t("hub.ruleDialog.toggleClStageSourceAfterMergeSub")}
                   checked={v.clStageSourceAfterMerge} onChange={(x) => onChange({ clStageSourceAfterMerge: x })}
                   lock={c.clStageSourceAfterMerge} />
        <ToggleRow label={t("hub.ruleDialog.toggleClSourceAfterDoneLabel")} hint={t("hub.ruleDialog.toggleClSourceAfterDoneSub")}
                   checked={v.clSourceAfterDone} onChange={(x) => onChange({ clSourceAfterDone: x })} />
        <ToggleRow label={t("hub.ruleDialog.toggleClStageAfterDoneLabel")}
                   hint={c.clStageAfterDoneWarn && v.clStageAfterDone
                     ? <span className="text-warning-fg">{t("roomForm.stageAfterDoneWarn")}</span>
                     : t("hub.ruleDialog.toggleClStageAfterDoneSub")}
                   checked={v.clStageAfterDone} onChange={(x) => onChange({ clStageAfterDone: x })} />
      </fieldset>
    </section>
  );
}
