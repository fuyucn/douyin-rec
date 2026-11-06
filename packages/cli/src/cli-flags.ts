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
