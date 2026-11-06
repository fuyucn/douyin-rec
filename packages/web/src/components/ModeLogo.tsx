/**
 * ModeLogo — small SVG marks for the room delivery modes.
 *
 * The eight standalone assets under ../assets/modes are the only geometry source; this component
 * references each asset's internal <g> by id. `?no-inline` keeps Vite from inlining the marks as
 * data URLs, because <use> fragments do not resolve inside them. The marks stay decorative
 * (aria-hidden): the surrounding control supplies its accessible name. `currentColor` follows the theme's
 * ink/muted tokens in both light and dark mode.
 */
import type { ReactNode } from "react";
import archiveUrl from "../assets/modes/archive.svg?no-inline";
import bilibiliUrl from "../assets/modes/bilibili.svg?no-inline";
import danmuUrl from "../assets/modes/danmu.svg?no-inline";
import mergeUrl from "../assets/modes/merge.svg?no-inline";
import nodeUrl from "../assets/modes/node.svg?no-inline";
import segmentUrl from "../assets/modes/segment.svg?no-inline";
import splitUrl from "../assets/modes/split.svg?no-inline";
import zeroDiskUrl from "../assets/modes/zero-disk.svg?no-inline";

export type ModeLogoKind = "bilibili" | "archive" | "zero-disk" | "segment" | "merge" | "node" | "split" | "danmu";

const MODE_URLS: Record<ModeLogoKind, string> = {
  archive: archiveUrl,
  bilibili: bilibiliUrl,
  "zero-disk": zeroDiskUrl,
  segment: segmentUrl,
  merge: mergeUrl,
  node: nodeUrl,
  split: splitUrl,
  danmu: danmuUrl,
};

export function ModeLogo({ kind, className }: { kind: ModeLogoKind; className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <use href={`${MODE_URLS[kind]}#mode-${kind}`} />
    </svg>
  );
}
