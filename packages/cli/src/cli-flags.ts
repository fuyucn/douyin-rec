/**
 * cli-flags.ts — CLI-only boolean flags that need a name (issue #472).
 *
 * Kept out of `cli.ts` because that module runs `program.parseAsync` on import, so nothing there can
 * be unit-tested. The vocabulary itself lives in core (`parseBoolFlag`).
 */
import { parseBoolFlag } from "@drec/core";

/**
 * Result of the strict upload-switch parsers: either a parsed boolean, or an explicit failure
 * naming the offending flag and value. Never throws; never falls back to "on".
 */
export type UploadFlagResult = { ok: true; value: boolean } | { ok: false; error: string };

/**
 * On-vocabulary for the upload switches, mirroring `packages/core/src/bool-flag.ts` (the off side
 * is reused from core itself, so only this list can drift — the consistency test pins it).
 */
const UPLOAD_ON_VALUES = new Set(["yes", "y", "true", "1", "on"]);

/**
 * Shared strict parser for `--rolling-upload` / `--stream-upload`.
 *
 * Blank input keeps the current default (both switches are off today). Off detection reuses core
 * (`parseBoolFlag(s, true) === false`) so the off list is never duplicated here. Any other value is
 * an explicit failure — unlike `parseDanmuFlag`, an unknown word must not quietly switch on an
 * upload path.
 */
function parseStrictUploadFlag(flagName: string, v: string | undefined): UploadFlagResult {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return { ok: true, value: false };
  if (parseBoolFlag(v, true) === false) return { ok: true, value: false };
  if (UPLOAD_ON_VALUES.has(s)) return { ok: true, value: true };
  return {
    ok: false,
    error: `${flagName} 取值无效: "${v}"(可用 0/1、on/off、yes/no、true/false)`,
  };
}

/**
 * `--danmu` switch. Absent/blank = on (the historical default); no/n/false/0/off/none = off;
 * anything else (including an old provider name) = on.
 */
export function parseDanmuFlag(v: string | undefined): boolean {
  return parseBoolFlag(v, true);
}

/**
 * `--rolling-upload` (边录边传) switch, parsed strictly. Absent/blank = off (the current default);
 * no/n/false/0/off/none = off; yes/y/true/1/on = on; anything else = failure.
 *
 * Strict on purpose: `--danmu` tolerates unknown values as "on", but an upload path must never be
 * silently enabled by a typo (e.g. `--rolling-upload enble`).
 */
export function parseRollingUploadFlag(v: string | undefined): UploadFlagResult {
  return parseStrictUploadFlag("--rolling-upload", v);
}

/**
 * `--stream-upload` (直播直传) switch, parsed strictly. Absent/blank = off (the current default);
 * no/n/false/0/off/none = off; yes/y/true/1/on = on; anything else = failure.
 *
 * Strict on purpose, same as `--rolling-upload`: an upload path must not be quietly switched on by
 * an unrecognized value the way the lenient `--danmu` parser would.
 */
export function parseStreamUploadFlag(v: string | undefined): UploadFlagResult {
  return parseStrictUploadFlag("--stream-upload", v);
}

/**
 * `--stream-upload-spool none` is retired (issue #537): a live upload without a local fallback
 * loses the whole part when the upload fails. Reject it whenever it is *explicitly* given — not
 * only when `--stream-upload 1` is present on the same command line, because a lone `none` would
 * otherwise be silently ignored and the operator would think the flag took effect.
 */
export function rejectsNoSpoolFlag(spool: string | undefined): boolean {
  return typeof spool === "string" && spool.trim().toLowerCase() === "none";
}
