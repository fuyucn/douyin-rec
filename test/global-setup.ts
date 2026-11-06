/**
 * global-setup.ts — build `dist/` once, from the current source, before any test runs.
 *
 * Two things make this a global concern rather than a per-file one:
 *
 *  1. Tests that spawn the real CLI (`test/cli/merge-node-format.test.ts`,
 *     `timezone-standalone.test.ts`, `test/cli/record-spool-flag.test.ts`) must exercise the
 *     code under test, not a stale artifact. CI runs `pnpm test` before `pnpm bundle`, so without
 *     this the dist is either absent (tests silently skip) or left over from a previous build
 *     (a reverted wiring fix would still pass). Deleting it first is what makes "revert the fix
 *     and the test goes red" actually true.
 *
 *  2. It has to happen exactly once per run. A per-file `beforeAll` that deletes `dist/` races the
 *     `describe.skipIf(!existsSync(...))` guards in other files: whether they skip depends on
 *     load order, and a file that already started would fail mid-run when the bundle disappears.
 *     `globalSetup` runs in its own single pass before the workers start.
 *
 * Two vitest processes can overlap on this machine (a full suite plus a targeted run), and both
 * would delete and rebuild the same directory. A lock file keeps that serial: the second runner
 * waits, then rebuilds on top of a complete tree instead of deleting one someone is reading.
 */
import { closeSync, openSync, rmSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

/** Synchronous sleep; globalSetup runs before the event loop has anything else to do. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withBundleLock(lock: string, fn: () => void): void {
  const deadline = Date.now() + 150_000;
  while (true) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`bundle lock timeout: ${lock}`);
      sleepMs(200);
    }
  }
  try {
    fn();
  } finally {
    try { unlinkSync(lock); } catch { /* best effort */ }
  }
}

export default function setup(): void {
  const root = join(__dirname, "..");
  withBundleLock(join(root, ".dist-bundle.lock"), () => {
    rmSync(join(root, "dist"), { recursive: true, force: true });
    // ~200ms locally; the 120s ceiling covers a cold esbuild install on CI.
    execSync("pnpm bundle", { cwd: root, stdio: "pipe", timeout: 120_000 });
  });
}
