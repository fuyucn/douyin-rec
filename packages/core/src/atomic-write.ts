import { closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
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

/** Blocking sleep (short lock waits only). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding the exclusive cross-process lock `<file>.lock` (O_EXCL create).
 *
 * Why: two processes own one sidecar (the recorder's persist() and the queue processor's merge).
 * A plain read-modify-write in both loses whichever update lands between the other's read and the
 * atomic rename. Both writers therefore wrap their read+write in this lock.
 *
 * A lock older than `staleMs` is assumed abandoned (writer crashed) and taken over, so a killed
 * process can never wedge a session. Waiting is bounded by `timeoutMs` and then throws: callers
 * treat a lock failure like any other sidecar write failure (alert, keep sources).
 */
export function withFileLockSync<T>(file: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const lock = file + ".lock";
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 2_000);
  const staleMs = Math.max(1, opts.staleMs ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lock, "wx", 0o644);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) { unlinkSync(lock); continue; }
      } catch {
        continue; // the holder released it between open and stat: retry immediately
      }
      if (Date.now() >= deadline) throw new Error("file lock busy: " + lock);
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
    try { unlinkSync(lock); } catch { /* best-effort */ }
  }
}
