import { Fragment, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import type { FlowStep } from "../../lib/room-form-rules";

/** 表单顶部的流程摘要:只渲染 flowSummary() 的结果,不自行推导。 */
export function FlowSummary({ steps }: { steps: FlowStep[] }): ReactNode {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label={t("roomForm.flowLabel")}>
      {steps.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && <span className="text-muted-soft" aria-hidden>→</span>}
          <span className={`chip${s.on ? " chip-accent" : " opacity-60"}`}>{t(s.key, s.vars)}</span>
        </Fragment>
      ))}
    </div>
  );
}
