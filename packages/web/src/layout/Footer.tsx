import type { ReactNode } from "react";
import { RecordGlyph } from "../components/Brand";
import { useT } from "../lib/i18n";

/** Single-line inline footer, hairline separated from the workbench. */
export function Footer(): ReactNode {
  const t = useT();
  return (
    <footer className="border-t border-hairline" style={{ background: "var(--canvas)" }}>
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-5 h-5 rounded-[4px] grid place-items-center shrink-0 border border-hairline" style={{ background: "var(--surface)" }}>
            <RecordGlyph stroke="var(--muted)" />
          </span>
          <span className="font-mono text-[11px] uppercase tracking-normal text-muted truncate">
            {t("nav.title")}
          </span>
        </div>
        <p className="font-mono text-[11px] uppercase tracking-normal text-muted-soft">
          {t("footer.tagline")} / 2026
        </p>
      </div>
    </footer>
  );
}
