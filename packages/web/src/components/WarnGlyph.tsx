import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

/** Inline warning mark for text lines (replaces the warning emoji, which renders differently per OS). */
export function WarnGlyph(): ReactNode {
  return <TriangleAlert className="w-3 h-3 inline-block align-[-2px] mr-1" aria-hidden="true" />;
}
