/**
 * run-now.ts — pure helpers for the "run now" dialog.
 *
 * A submission key is `<platform>:<roomSlug>:<date>` plus an optional `_HHMM`
 * broadcast suffix and an optional `-N` submission suffix. The date itself ends
 * in `-DD`, so stripping `-N` must be anchored to the full broadcast shape.
 */

/** Remove a trailing submission suffix (`-1`, `-2`, ...) from a broadcast key. */
export function submissionBaseKey(key: string): string {
  const m = /^(.+?:\d{4}-\d{2}-\d{2}(?:_\d{4})?)-(\d+)$/.exec(key);
  return m ? m[1] : key;
}

/** Next submission number for a base key: max existing `-N` + 1, else 1. */
export function nextSubmissionNo(baseKey: string, keys: readonly string[]): number {
  const prefix = `${baseKey}-`;
  const max = keys.reduce((acc, key) => {
    const m = /-(\d+)$/.exec(key);
    return m && key.startsWith(prefix) ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return max + 1;
}

/**
 * Resolve the key to send to the server.
 * `newSubmission` adds the next `-N`; resume keeps the selected key unchanged.
 */
export function runNowKey(input: {
  selectedKey: string;
  existingKeys: readonly string[];
  newSubmission: boolean;
}): string {
  if (!input.newSubmission) return input.selectedKey;
  const base = submissionBaseKey(input.selectedKey);
  return `${base}-${nextSubmissionNo(base, input.existingKeys)}`;
}
