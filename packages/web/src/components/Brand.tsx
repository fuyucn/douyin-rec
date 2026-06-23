import type { ReactNode } from "react";

/** The concentric-circle record glyph used in the nav + footer. */
export function RecordGlyph({ stroke = "currentColor" }: { stroke?: string }): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill={stroke} />
    </svg>
  );
}
