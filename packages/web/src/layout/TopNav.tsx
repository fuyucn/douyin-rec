import { useAtomValue } from "jotai";
import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Settings } from "lucide-react";
import { cookieStatusAtom, hubEnabledAtom } from "../atoms";
import { RecordGlyph } from "../components/Brand";
import { ThemeToggle } from "../components/ThemeToggle";
import { LangToggle } from "../components/LangToggle";
import { CookieDialog } from "../modals/CookieDialog";
import { QrLoginDialog } from "../modals/QrLoginDialog";
import { SettingsDialog } from "../modals/SettingsDialog";
import { useT } from "../lib/i18n";

/** Top nav: brand + global cookie status pill + ⚙️ settings(账号/Webhook/通知). */
export function TopNav(): ReactNode {
  const t = useT();
  const cookie = useAtomValue(cookieStatusAtom);
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const [qrOpen, setQrOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  let pillText = t("cookie.checking");
  let pillColor = "var(--warning)";
  if (cookie) {
    if (cookie.set && cookie.hasSession) {
      pillText = t("cookie.loggedIn");
      pillColor = "var(--success)";
      if (cookie.expiresAt) {
        const days = Math.floor((cookie.expiresAt - Date.now()) / 86400000);
        if (days < 0) {
          pillText = t("cookie.expired");
          pillColor = "var(--error)";
        } else if (days <= 3) {
          pillText = t("cookie.expiresIn", { days });
          pillColor = "var(--warning)";
        } else {
          pillText = t("cookie.loggedInDays", { days });
        }
      }
    } else if (cookie.set) {
      pillText = t("cookie.noSession");
      pillColor = "var(--warning)";
    } else {
      pillText = t("cookie.notSet");
      pillColor = "var(--warning)";
    }
  }

  return (
    <header className="sticky top-0 z-40 bg-canvas border-b border-hairline">
      <div className="max-w-[1200px] mx-auto h-16 px-4 sm:px-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded bg-ink grid place-items-center text-canvas shrink-0">
            <RecordGlyph />
          </div>
          <span className="headline text-[17px] truncate">{t("nav.title")}</span>
          <nav className="hidden sm:flex items-center gap-1 ml-4">
            {(([
              ["/", "录制"],
              // Hub 仅 master(启用 hub)显示;slave/未开不显示。
              ...(hubEnabled ? [["/hub", "Hub"] as const] : []),
            ]) as const).map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    isActive ? "bg-surface-soft text-ink" : "text-muted hover:text-ink hover:bg-surface-soft"
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* 登录状态一目了然(操作收进 ⚙️ 设置 → 账号 tab)。点 pill 也开设置。 */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="pill"
            style={{ background: "var(--surface-soft)", color: "var(--body)" }}
            title={t("settings.title")}
          >
            <span className="dot" style={{ background: pillColor }} />
            <span>{pillText}</span>
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={t("settings.title")}
            className="grid place-items-center w-8 h-8 rounded-md text-muted hover:text-ink hover:bg-surface-soft transition-colors"
          >
            <Settings className="w-4 h-4" />
          </button>
          <LangToggle />
          <ThemeToggle />
        </div>
      </div>

      <QrLoginDialog open={qrOpen} onClose={() => setQrOpen(false)} />
      <CookieDialog open={pasteOpen} onClose={() => setPasteOpen(false)} />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenQr={() => setQrOpen(true)}
        onOpenPaste={() => setPasteOpen(true)}
      />
    </header>
  );
}
