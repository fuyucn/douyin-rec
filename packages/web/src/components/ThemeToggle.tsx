import { useAtom } from "jotai";
import { Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { applyTheme, themeAtom } from "../lib/theme";

/** Light/dark toggle — flips the `.dark` class on <html> and persists. */
export function ThemeToggle(): ReactNode {
  const [theme, setTheme] = useAtom(themeAtom);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="btn-icon"
      aria-label={next === "dark" ? "切换到暗色" : "切换到亮色"}
      title={next === "dark" ? "暗色模式" : "亮色模式"}
      onClick={() => {
        setTheme(next);
        applyTheme(next);
      }}
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
