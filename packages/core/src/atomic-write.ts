import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Write `data` to `file` atomically: a unique temp file in the same directory is written and
 * fsynced, then renamed over the target. Readers see either the old or the new content, never a
 * torn one. The temp name is unique per writer (pid + random), so two processes never share one.
 * Never deletes anything: if a step fails the temp file stays behind; its name ends in `.tmp`,
 * so the maintenance scratch sweep collects it later.
 * `mode` sets the permissions of the new file (e.g. 0o600 for credentials); it is applied when the temp
 * file is created, so the content is never readable with wider permissions.
 */
export function writeFileAtomicSync(file: string, data: string, opts: { mode?: number } = {}): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", opts.mode ?? 0o666);
  try {
    writeSync(fd, data, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
