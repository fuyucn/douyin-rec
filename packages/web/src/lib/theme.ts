/**
 * lib/theme.ts — light/dark theme state.
 *
 * The actual switch is a single `.dark` class on <html> (see index.css
 * `:root.dark`). We persist the choice to localStorage and fall back to the
 * OS `prefers-color-scheme` on first visit. `applyTheme` is called both at
 * pre-render (main.tsx, to avoid a flash) and from the toggle.
 */
import { atom } from "jotai";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

/** Stored choice, else OS preference, else light. */
export function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* localStorage unavailable (private mode / SSR) */
  }
  if (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

/** Toggle the `.dark` class on <html> and persist the choice. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore persistence failures */
  }
}

/** Current theme; seeded from getInitialTheme() so UI matches the DOM class. */
export const themeAtom = atom<Theme>(getInitialTheme());
