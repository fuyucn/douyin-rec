import { useAtomValue } from "jotai";
import { useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { Settings } from "lucide-react";
import { cookieStatusAtom, hubEnabledAtom } from "../atoms";
import { RecordGlyph } from "../components/Brand";
import { ThemeToggle } from "../components/ThemeToggle";
import { LangToggle } from "../components/LangToggle";
import { CookieDialog } from "../modals/CookieDialog";
import { QrLoginDialog } from "../modals/QrLoginDialog";
import { SettingsDialog } from "../modals/SettingsDialog";
import { useT } from "../lib/i18n";

/** 顶栏:控制台式导航 + 全局 cookie 状态 + 设置(账号/Webhook/通知)。 */
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
    <header className="sticky top-0 z-40 topbar">
      <div className="max-w-[1200px] mx-auto h-[56px] px-4 sm:px-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/" className="flex items-center gap-3 min-w-0 shrink-0">
            <div className="brand-mark">
              <RecordGlyph />
            </div>
            <span className="flex flex-col min-w-0 leading-none">
              <span className="headline text-[15px] truncate">{t("nav.title")}</span>
              <span className="hidden sm:block font-mono text-[10px] uppercase text-muted mt-1">
                Douyin Rec
              </span>
            </span>
          </Link>
          <nav className="hidden sm:flex items-center gap-1 ml-2">
            {(([
              ["/", t("nav.tasksList")],
              // Hub 仅 master(启用 hub)显示;slave/未开不显示。
              ...(hubEnabled ? [["/hub", "Hub"] as const] : []),
            ]) as const).map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `topbar-link ${
                    isActive ? "topbar-link-active" : ""
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* 登录状态一目了然(操作收进设置 → 账号 tab)。点 pill 也开设置。 */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="status-pill"
            title={t("settings.title")}
          >
            <span className="dot" style={{ background: pillColor }} />
            <span>{pillText}</span>
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={t("settings.title")}
            className="icon-btn"
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
