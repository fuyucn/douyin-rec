import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { SectionHeader } from "./parts";

export function NotifySection({ webhook, onChange, hasStored, clear, onClearChange }: {
  webhook: string;
  onChange: (v: string) => void;
  /** A webhook is already stored server-side (never echoed). */
  hasStored: boolean;
  clear: boolean;
  onClearChange: (v: boolean) => void;
}): ReactNode {
  const t = useT();
  return (
    <section className="space-y-2">
      <SectionHeader title={t("roomForm.notifySection")} />
      <label className="block">
        <span className="field-label">{t("rooms.webhook")}</span>
        <input className="input" placeholder={hasStored && !clear ? t("dialog.webhookPlaceholderSet") : t("dialog.webhookPlaceholder")}
               value={webhook} disabled={clear} onChange={(e) => onChange(e.target.value)} />
        {hasStored && (
          <label className="flex items-center gap-2 text-xs mt-1">
            <input type="checkbox" checked={clear} onChange={(e) => onClearChange(e.target.checked)} />
            {t("dialog.webhookClear")}
          </label>
        )}
        <p className="text-xs text-muted mt-1">{t("rooms.webhookHint")}</p>
      </label>
    </section>
  );
}
