import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { SectionHeader } from "./parts";

export function NotifySection({ webhook, onChange }: { webhook: string; onChange: (v: string) => void }): ReactNode {
  const t = useT();
  return (
    <section className="space-y-2">
      <SectionHeader title={t("roomForm.notifySection")} />
      <label className="block">
        <span className="field-label">{t("rooms.webhook")}</span>
        <input className="input" placeholder={t("dialog.webhookPlaceholder")} value={webhook}
               onChange={(e) => onChange(e.target.value)} />
        <p className="text-xs text-muted mt-1">{t("rooms.webhookHint")}</p>
      </label>
    </section>
  );
}
