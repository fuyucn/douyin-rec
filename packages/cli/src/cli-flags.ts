/**
 * cli-flags.ts — CLI-only boolean flags that need a name (issue #472).
 *
 * Kept out of `cli.ts` because that module runs `program.parseAsync` on import, so nothing there can
 * be unit-tested. The vocabulary itself lives in core (`parseBoolFlag`).
 */
import { parseBoolFlag } from "@drec/core";

/**
 * `--danmu` switch. Absent/blank = on (the historical default); no/n/false/0/off/none = off;
 * anything else (including an old provider name) = on.
 */
export function parseDanmuFlag(v: string | undefined): boolean {
  return parseBoolFlag(v, true);
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
