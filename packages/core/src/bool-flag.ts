/**
 * bool-flag.ts — the single vocabulary for boolean command-line flags (issue #472).
 *
 * Before this there were four partial copies, and `--danmu no` fell through to "on" because that one
 * only recognised none/0/off/false. Every flag now goes through one of the two parsers in this
 * file:
 * - `parseBoolFlag` (lenient, `--danmu` only): missing/blank → the call site's default; unknown
 *   words still mean "on" — a pre-#472 behaviour kept on purpose for that one switch;
 * - `parseStrictBoolFlag` (strict, the upload switches `--rolling-upload` / `--stream-upload` and
 *   the stored rolling-queue setting): missing/blank → the call site's default (off for both
 *   upload switches); the off words no/n/false/0/off/none → off, the on words yes/y/true/1/on →
 *   on, matching ignores case and surrounding whitespace; any other value → `{ok:false, error}`
 *   naming the flag and quoting the raw value. Callers print that error and `process.exit(2)`
 *   before any side effect. The upload switches never fall back to "on" — only the lenient
 *   `--danmu` parser treats unknown values as "on".
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
 *
 * This lenient unknown-→-"on" rule does NOT apply to the upload switches (`--rolling-upload` /
 * `--stream-upload`): they go through `parseStrictBoolFlag`, which fails on unknown values
 * instead of enabling an upload path on a typo.
 */
export function parseBoolFlag(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  const s = v.trim().toLowerCase();
  if (!s) return def;
  if (OFF_VALUES.has(s)) return false;
  if (ON_VALUES.has(s)) return true;
  return true;
}

/**
 * Result of the strict parser: either a parsed boolean, or an explicit failure naming the
 * offending flag and quoting the raw value. A failure carries no `value` key.
 */
export type StrictBoolFlagResult = { ok: true; value: boolean } | { ok: false; error: string };

/**
 * Strict parse of a boolean flag value, shared by every call site that must not silently enable a
 * path on a typo (the upload switches: `record` in the CLI, `task add/edit`, and the stored
 * rolling-queue setting).
 *
 * - `undefined` or blank (after trim) → `{ok:true, value:def}`;
 * - off word → `false`, on word → `true` (matching ignores case and surrounding whitespace, same
 *   vocabulary as `parseBoolFlag` — no separate word list here);
 * - anything else → `{ok:false, error}` with a message that names the flag, quotes the raw value
 *   as typed (not trimmed, original case) and lists the valid vocabulary. The message format is
 *   identical to the one `record` already prints, so all call sites stay in parity.
 *
 * Never throws; a failure result has no `value` key. `parseBoolFlag` is untouched (lenient).
 */
export function parseStrictBoolFlag(flagName: string, v: string | undefined, def: boolean): StrictBoolFlagResult {
  if (v === undefined) return { ok: true, value: def };
  const s = v.trim().toLowerCase();
  if (!s) return { ok: true, value: def };
  if (OFF_VALUES.has(s)) return { ok: true, value: false };
  if (ON_VALUES.has(s)) return { ok: true, value: true };
  return {
    ok: false,
    error: `${flagName} 取值无效: "${v}"(可用 0/1、on/off、yes/no、true/false)`,
  };
}
