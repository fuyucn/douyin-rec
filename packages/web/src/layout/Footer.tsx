import type { ReactNode } from "react";
import { RecordGlyph } from "../components/Brand";
import { useT } from "../lib/i18n";

/** The single dark surface that closes the page. */
export function Footer(): ReactNode {
  const t = useT();
  return (
    <footer style={{ background: "var(--footer-bg)" }}>
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded bg-white grid place-items-center shrink-0">
            <RecordGlyph stroke="#101010" />
          </div>
          <span className="headline text-white text-base">{t("nav.title")}</span>
        </div>
        <p className="text-sm" style={{ color: "var(--footer-text)" }}>
          {t("footer.tagline")} · © 2026
        </p>
      </div>
    </footer>
  );
}
