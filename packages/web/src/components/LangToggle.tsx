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
      className="icon-btn px-2 text-xs font-semibold"
    >
      {lang === "zh" ? "EN" : "中"}
    </button>
  );
}
