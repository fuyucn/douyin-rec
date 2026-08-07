import { useAtom } from "jotai";
import { Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { applyTheme, themeAtom } from "../lib/theme";
import { useT } from "../lib/i18n";

/** Light/dark toggle — flips the `.dark` class on <html> and persists. */
export function ThemeToggle(): ReactNode {
  const t = useT();
  const [theme, setTheme] = useAtom(themeAtom);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="btn-icon"
      aria-label={next === "dark" ? t("theme.toDark") : t("theme.toLight")}
      title={next === "dark" ? t("theme.darkMode") : t("theme.lightMode")}
      onClick={() => {
        setTheme(next);
        applyTheme(next);
      }}
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
