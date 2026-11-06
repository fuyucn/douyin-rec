/**
 * ModeLogo — small, self-contained SVG marks for the room delivery modes.
 *
 * They are decorative (aria-hidden): the adjacent label always carries the meaning, so the marks
 * must never be the only difference between two options. `currentColor` keeps them on the theme's
 * ink/muted tokens in both light and dark mode.
 */
import type { ReactNode } from "react";

export type ModeLogoKind = "bilibili" | "archive" | "zero-disk" | "segment" | "merge" | "node" | "split";

export function ModeLogo({ kind, className }: { kind: ModeLogoKind; className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {kind === "bilibili" && (
        <>
          {/* TV mark, not the official artwork: two antennae, rounded body, two eyes. */}
          <rect x="2.5" y="7.5" width="19" height="12.5" rx="3.5" />
          <path d="M7.5 7.5 5.2 4.2M16.5 7.5l2.3-3.3" />
          <circle cx="8.6" cy="13.4" r="1.15" fill="currentColor" stroke="none" />
          <circle cx="15.4" cy="13.4" r="1.15" fill="currentColor" stroke="none" />
        </>
      )}
      {kind === "archive" && (
        <>
          <path d="M3 7h18v3.2H3z" />
          <path d="M4.6 10.2v9.3h14.8v-9.3" />
          <path d="M9.4 14.2h5.2" />
        </>
      )}
      {kind === "zero-disk" && (
        <>
          <path d="M7.2 18h9.5a3.7 3.7 0 0 0 .3-7.4 5.8 5.8 0 0 0-11.2-1.3A3.9 3.9 0 0 0 7.2 18Z" />
          <path d="M13.1 9.1 10.3 14h2.3l-.7 3.9 3-5.2h-2.3l.5-3.6Z" fill="currentColor" stroke="none" />
        </>
      )}
      {kind === "segment" && (
        <>
          <rect x="2.8" y="4.2" width="8.4" height="4" rx="1.2" />
          <rect x="2.8" y="10" width="12" height="4" rx="1.2" />
          <rect x="2.8" y="15.8" width="6.5" height="4" rx="1.2" />
          <path d="M19 16.8V5.2m0 0-2.2 2.2M19 5.2l2.2 2.2" />
        </>
      )}
      {kind === "merge" && (
        <>
          <path d="M3.6 5.5h5.7V10H3.6zM14.7 5.5h5.7V10h-5.7z" />
          <path d="M6.4 10c0 2.4 1.8 3.1 5.6 4.7 3.8-1.6 5.6-2.3 5.6-4.7" />
          <path d="M12 14.7v5.8m0 0-2.4-2.4M12 20.5l2.4-2.4" />
        </>
      )}
      {kind === "node" && (
        <>
          <rect x="3.5" y="4.8" width="7.5" height="14.4" rx="1.5" />
          <path d="M6 8.4h2.5M6 12h2.5M6 15.6h2.5" />
          <path d="M15.5 17.5V7m0 0-2.5 2.5M15.5 7l2.5 2.5" />
        </>
      )}
      {kind === "split" && (
        <>
          <rect x="3" y="4" width="8" height="7" rx="1.4" />
          <rect x="13" y="4" width="8" height="7" rx="1.4" />
          <rect x="3" y="13" width="8" height="7" rx="1.4" />
          <rect x="13" y="13" width="8" height="7" rx="1.4" />
        </>
      )}
    </svg>
  );
}
