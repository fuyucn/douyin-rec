import { readFileSync } from "node:fs";

export interface GapInterval { startMs: number; endMs: number; }
export interface GapsSidecar { sessionBase: string; gaps: GapInterval[]; totalGapSec: number; }

export function totalGapSecOf(gaps: GapInterval[]): number {
  return Math.round(gaps.reduce((s, g) => s + Math.max(0, g.endMs - g.startMs), 0) / 1000);
}

export function readGaps(jsonPath: string): GapsSidecar | null {
  try {
    const d = JSON.parse(readFileSync(jsonPath, "utf-8")) as GapsSidecar;
    if (!Array.isArray(d.gaps)) return null;
    return { sessionBase: d.sessionBase ?? "", gaps: d.gaps, totalGapSec: d.totalGapSec ?? totalGapSecOf(d.gaps) };
  } catch { return null; }
}
