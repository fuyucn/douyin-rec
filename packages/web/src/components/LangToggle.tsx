import { type ReactNode } from "react";
import { useLang } from "../lib/i18n";

/** 中 / EN 语言切换(持久化到 localStorage)。 */
export function LangToggle(): ReactNode {
  const [lang, setLang] = useLang();
  return (
    <button
      type="button"
      onClick={() => setLang(lang === "zh" ? "en" : "zh")}
      title={lang === "zh" ? "Switch to English" : "切换到中文"}
      className="grid place-items-center h-8 px-2 rounded-md text-xs font-medium text-muted hover:text-ink hover:bg-surface-soft transition-colors"
    >
      {lang === "zh" ? "EN" : "中"}
    </button>
  );
}
