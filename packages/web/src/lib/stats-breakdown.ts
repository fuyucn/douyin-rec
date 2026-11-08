/**
 * stats-breakdown.ts — how a stats Breakdown card renders its categories. Pure, tested.
 *
 * A bar encodes "share of the total". With exactly one category the share is always 100%, so a full
 * bar states nothing and stretches the card for no reason: read it as one label · count line instead.
 */
export interface BreakdownItem {
  label: string;
  count: number;
}

export type BreakdownShape =
  | { kind: "empty" }
  | { kind: "single"; item: BreakdownItem }
  | { kind: "bars"; items: BreakdownItem[] };

export function breakdownShape(items: readonly BreakdownItem[]): BreakdownShape {
  if (items.length === 0) return { kind: "empty" };
  if (items.length === 1) return { kind: "single", item: items[0]! };
  return { kind: "bars", items: [...items] };
}
