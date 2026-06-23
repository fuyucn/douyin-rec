// ts/src/core/post/ass/emoji.ts
export const EMOJI_FONT = "Noto Emoji";

// 移植 ass_writer.py _EMOJI_RANGES（含 BMP + 扩展平面）
const EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1f300, 0x1faff], [0x1f000, 0x1f0ff], [0x2600, 0x27bf],
  [0x231a, 0x231b], [0x23e9, 0x23f3], [0x23f8, 0x23fa],
  [0x25aa, 0x25ab], [0x25fb, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x2702, 0x2702], [0x2705, 0x2705], [0x2708, 0x270d],
  [0x2753, 0x2755], [0x2795, 0x2797], [0xfe00, 0xfe0f],
];

export function isEmoji(cp: number): boolean {
  return EMOJI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** 将 emoji 段用 {\fnNoto Emoji} 包裹，普通段切回 mainFont。移植 _tag_emoji。 */
export function tagEmoji(text: string, mainFont: string): string {
  const parts: string[] = [];
  let inEmoji = false;
  for (const ch of text) {                       // for..of 按码位遍历，正确处理代理对
    const e = isEmoji(ch.codePointAt(0)!);
    if (e && !inEmoji) { parts.push(`{\\fn${EMOJI_FONT}}`); inEmoji = true; }
    else if (!e && inEmoji) { parts.push(`{\\fn${mainFont}}`); inEmoji = false; }
    parts.push(ch);
  }
  if (inEmoji) parts.push(`{\\fn${mainFont}}`);
  return parts.join("");
}
