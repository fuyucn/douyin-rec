/**
 * bool-flag.ts — the single vocabulary for boolean command-line flags (issue #472).
 *
 * Before this there were four partial copies, and `--danmu no` fell through to "on" because that one
 * only recognised none/0/off/false. Every flag now goes through this parser.
 */

/** Values that mean "off" (case-insensitive, trimmed). */
const OFF_VALUES = new Set(["no", "n", "false", "0", "off", "none"]);
/** Values that mean "on" (case-insensitive, trimmed). */
const ON_VALUES = new Set(["yes", "y", "true", "1", "on"]);

/**
 * Parse a boolean flag value.
 *
 * - `undefined` or an empty/blank string → `def` (each call site keeps its own default);
 * - one of the off values → `false`; one of the on values → `true`;
 * - anything else → `true`. This is unchanged from every pre-#472 site: a bare `--flag` or a
 *   legacy provider name has always meant "on", and silently flipping that would be a behaviour
 *   change nobody asked for.
 */
export function parseBoolFlag(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  const s = v.trim().toLowerCase();
  if (!s) return def;
  if (OFF_VALUES.has(s)) return false;
  if (ON_VALUES.has(s)) return true;
  return true;
}
