import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
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
 * Defaults. A lock only guards a small JSON read-modify-write (milliseconds), so a lock older than a few
 * seconds is abandoned - even when its pid happens to be alive again (pid reuse) or was leaked before a
 * crash. Keep stale < timeout: a waiter that is still inside its budget always gets its turn, and the
 * total blocking wait stays short (it holds the recorder/serve thread synchronously).
 */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 3_000;
/** Identifies this process instance inside the lock file (pid alone is reused by the OS). */
const LOCK_TOKEN = randomBytes(6).toString("hex");

function defaultHolderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM"; // exists but not ours
  }
}

/** Holder pid from the lock file (<pid>.<instance token>); plain <pid> from older builds; 0 when unreadable. */
function lockHolderPid(text: string): number {
  const m = /^(\d+)/.exec(text);
  return m ? Number(m[1]) : 0;
}

/** Who holds the lock, and is it still worth waiting for? */
function lockState(lock: string, staleMs: number, alive: (pid: number) => boolean): "live" | "stale" | "gone" {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(lock, "utf-8").trim();
    mtimeMs = statSync(lock).mtimeMs;
  } catch {
    return "gone"; // released between open() and this read: retry immediately
  }
  const pid = lockHolderPid(text);
  const aged = Date.now() - mtimeMs > staleMs;
  // Dead holder => abandoned at once. A live pid with an aged lock is either a leaked lock or a reused
  // pid: the real holder only ever holds for milliseconds, so age wins over "pid looks alive".
  if (pid > 0 && !alive(pid)) return "stale";
  return aged ? "stale" : "live";
}

/**
 * Take over an abandoned lock without ever deleting a live one: move it to a unique name first
 * (atomic), re-check the holder, and only unlink when it is still abandoned. A lock refreshed by a
 * live holder in the meantime is moved back instead of being dropped (no TOCTOU deletion).
 */
function takeOverStaleLock(lock: string, staleMs: number, alive: (pid: number) => boolean): boolean {
  const grab = lock + ".stale." + process.pid + "." + randomBytes(4).toString("hex");
  try { renameSync(lock, grab); } catch { return false; } // somebody else won the race: just retry
  try {
    const text = readFileSync(grab, "utf-8").trim();
    const pid = lockHolderPid(text);
    const abandoned = (pid > 0 && !alive(pid)) || Date.now() - statSync(grab).mtimeMs > staleMs;
    if (abandoned) { unlinkSync(grab); return true; }
    try { if (!existsSync(lock)) renameSync(grab, lock); } catch { /* stray file, harmless */ }
    return false;
  } catch {
    try { unlinkSync(grab); } catch { /* best-effort */ }
    return true;
  }
}

/**
 * Run the callback while holding the exclusive cross-process lock <file>.lock (O_EXCL create).
 *
 * Why: two processes own one sidecar (the recorder's persist() and the queue processor's merge).
 * A plain read-modify-write in both loses whichever update lands between the other's read and the
 * atomic rename. Both writers therefore wrap their read+write in this lock.
 *
 * Waiting is bounded by timeoutMs and then throws: callers treat a lock failure like any other
 * sidecar write failure (alert, keep sources). An abandoned lock is taken over after staleMs, or
 * immediately when the recorded holder pid is dead. A live pid alone never protects a lock forever:
 * the holder only holds for milliseconds, so age is the authoritative signal (covers pid reuse and
 * locks leaked by a crash). staleMs < timeoutMs so a waiter that is still inside its budget always
 * gets its turn, and the deadline is checked in every retry branch (a persistent stat error cannot spin).
 */
export function withFileLockSync<T>(
  file: string, fn: () => T,
  opts: { timeoutMs?: number; staleMs?: number; isHolderAlive?: (pid: number) => boolean } = {},
): T {
  const lock = file + ".lock";
  const timeoutMs = Math.max(0, opts.timeoutMs ?? LOCK_TIMEOUT_MS);
  const staleMs = Math.max(1, opts.staleMs ?? LOCK_STALE_MS);
  const alive = opts.isHolderAlive ?? defaultHolderAlive;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lock, "wx", 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      const state = lockState(lock, staleMs, alive);
      if (state === "gone") {
        // Released between our open() and the read: retry at once, but never past the deadline.
        if (Date.now() >= deadline) throw new Error("file lock busy: " + lock);
        continue;
      }
      if (state === "stale" && takeOverStaleLock(lock, staleMs, alive)) continue;
      if (Date.now() >= deadline) throw new Error("file lock busy: " + lock);
      sleepSync(5);
      continue;
    }
    try {
      writeSync(fd, String(process.pid) + "." + LOCK_TOKEN, null, "utf-8");
      return fn();
    } finally {
      try { closeSync(fd); } catch { /* best-effort */ }
      try { unlinkSync(lock); } catch { /* best-effort */ }
    }
  }
}
