// issue #223: writeFileAtomicSync — atomic replace via unique temp + rename, never deletes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, linkSync, mkdirSync, statSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLockSync, writeFileAtomicSync } from "@drec/core";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "atomic-write-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tmpLeft = (): string[] => readdirSync(dir).filter((n) => n.endsWith(".tmp")).sort();
const tmpRe = (base: string): RegExp => new RegExp(`^${base.replace(/\./g, "\\.")}\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`);

describe("writeFileAtomicSync", () => {
  it("mode applies to the new file, also when replacing a wider-permission target", () => {
    const f = join(dir, "cred.json");
    writeFileSync(f, "old", { mode: 0o644 });
    writeFileAtomicSync(f, "secret", { mode: 0o600 });
    expect(readFileSync(f, "utf-8")).toBe("secret");
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("replaces the inode instead of writing in place: a hard link keeps the old content", () => {
    const f = join(dir, "a.session.json");
    writeFileSync(f, "old");
    linkSync(f, `${f}.lnk`);
    writeFileAtomicSync(f, "new");
    expect(readFileSync(f, "utf-8")).toBe("new");
    expect(readFileSync(`${f}.lnk`, "utf-8")).toBe("old");
  });

  it("creates a missing target and leaves no temp file after success", () => {
    const f = join(dir, "b.json");
    writeFileAtomicSync(f, "{\"x\":1}");
    expect(readFileSync(f, "utf-8")).toBe("{\"x\":1}");
    expect(tmpLeft()).toEqual([]);
  });

  it("missing parent directory: throws and creates nothing", () => {
    expect(() => writeFileAtomicSync(join(dir, "nope", "c.json"), "x")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rename failure leaves exactly one uniquely named temp file (no delete; swept as scratch)", () => {
    const f = join(dir, "d.json");
    mkdirSync(f);
    expect(() => writeFileAtomicSync(f, "x")).toThrow();
    const left = tmpLeft();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(tmpRe("d.json"));
    expect(readFileSync(join(dir, left[0]!), "utf-8")).toBe("x");
  });

  it("two failing writers never share a temp name", () => {
    const f = join(dir, "e.json");
    mkdirSync(f);
    expect(() => writeFileAtomicSync(f, "1")).toThrow();
    expect(() => writeFileAtomicSync(f, "2")).toThrow();
    const left = tmpLeft();
    expect(left).toHaveLength(2);
    expect(new Set(left).size).toBe(2);
    expect(existsSync(f)).toBe(true);
  });
});

describe("withFileLockSync (two sidecar writers: the recorder and the queue processor)", () => {
  const file = (): string => { const f = join(dir, "s.rolling.json"); writeFileSync(f, "{}"); return f; };

  it("is exclusive, bounded, and takes over an owner-less stale lock", () => {
    const f = file();
    const lock = f + ".lock";
    writeFileSync(lock, "");
    // A fresh lock held by someone else: bounded wait, then a clear failure (never a silent overwrite).
    expect(() => withFileLockSync(f, () => 1, { timeoutMs: 20 })).toThrow(/lock busy/);
    // An abandoned lock (killed writer) is taken over instead of wedging the session.
    const old = Date.now() - 60_000;
    utimesSync(lock, new Date(old), new Date(old));
    expect(withFileLockSync(f, () => 2, { timeoutMs: 20, staleMs: 1_000 })).toBe(2);
    expect(existsSync(lock)).toBe(false);
    // Not re-entrant: a nested acquire of the same file waits (proves mutual exclusion).
    expect(() => withFileLockSync(f, () => withFileLockSync(f, () => 1, { timeoutMs: 10 }), { timeoutMs: 50 }))
      .toThrow(/lock busy/);
    expect(existsSync(lock)).toBe(false);
  });

  it("NEVER steals a live holder, even when the lock is older than the stale window", () => {
    const f = file();
    const lock = f + ".lock";
    // Our own pid is alive: two writers on one sidecar would lose bv/confirmed, so a timeout is the
    // only acceptable outcome even though the lock looks old.
    writeFileSync(lock, String(process.pid) + ".deadbeef");
    const old = Date.now() - 600_000;
    utimesSync(lock, new Date(old), new Date(old));
    expect(() => withFileLockSync(f, () => 1, { timeoutMs: 60, staleMs: 10 })).toThrow(/lock busy/);
    expect(readFileSync(lock, "utf-8")).toBe(String(process.pid) + ".deadbeef"); // untouched
    unlinkSync(lock);
  });

  it("a leaked lock whose pid was reused (alive but unrelated) fails closed instead of stealing", () => {
    const f = file();
    const lock = f + ".lock";
    writeFileSync(lock, "424242.deadbeef"); // "reused" pid: alive by injection
    utimesSync(lock, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    expect(() => withFileLockSync(f, () => 1, { timeoutMs: 40, staleMs: 10, isHolderAlive: () => true }))
      .toThrow(/lock busy/);
    expect(readFileSync(lock, "utf-8")).toBe("424242.deadbeef");
    unlinkSync(lock);
  });

  it("a slow write in a LIVE process longer than staleMs is not taken over (second waiter fails)", async () => {
    const f = file();
    const lock = f + ".lock";
    // The child holds the lock with its own live pid for ~500ms, well beyond staleMs.
    const script =
      "const fs=require('fs');" +
      "fs.writeFileSync(process.argv[1], process.pid + '.abcdef012345');" +
      "process.stdout.write('ready');" +
      "setTimeout(function(){}, 5000);";
    const child = spawn(process.execPath, ["-e", script, lock], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
    });
    try {
      const started = Date.now();
      expect(() => withFileLockSync(f, () => 1, { timeoutMs: 300, staleMs: 50 })).toThrow(/lock busy/);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(readFileSync(lock, "utf-8")).toContain(String(child.pid)); // untouched: no second writer
    } finally {
      child.kill();
      await new Promise((resolve) => child.on("exit", resolve));
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  });

  it("a FRESH lock is never stolen, and the lock file records pid + instance token", () => {
    const f = file();
    const lock = f + ".lock";
    let content = "";
    expect(withFileLockSync(f, () => { content = readFileSync(lock, "utf-8"); return 3; }, { timeoutMs: 200 })).toBe(3);
    const [pidPart, tokenPart] = content.split(".");
    expect(Number(pidPart)).toBe(process.pid);
    expect(tokenPart).toMatch(/^[0-9a-f]{12}$/);
    // Fresh lock held by someone else => bounded wait, no steal.
    writeFileSync(lock, String(process.pid) + ".abcdef012345");
    expect(() => withFileLockSync(f, () => 1, { timeoutMs: 30 })).toThrow(/lock busy/);
    expect(readFileSync(lock, "utf-8")).toBe(String(process.pid) + ".abcdef012345"); // untouched
    unlinkSync(lock);
  });

  it("waits out a slow live writer that releases inside the budget (lock timeout is honored, no steal)", async () => {
    const f = file();
    const lock = f + ".lock";
    writeFileSync(lock, String(process.pid) + ".abcdef012345");
    // A separate live process holds the lock and releases it after ~150ms.
    const child = spawn(process.execPath, [
      "-e", "setTimeout(function(){try{require('fs').unlinkSync(process.argv[1])}catch(e){}},150)", lock,
    ], { stdio: "ignore" });
    try {
      const started = Date.now();
      expect(withFileLockSync(f, () => 1, { timeoutMs: 5_000 })).toBe(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(100); // it really waited, not stole
    } finally {
      await new Promise((resolve) => child.on("exit", resolve));
    }
  });

  it("takes over a dead holder immediately (no need to wait out the stale window)", () => {
    const f = file();
    const lock = f + ".lock";
    writeFileSync(lock, "424242");
    expect(withFileLockSync(f, () => 7, { timeoutMs: 50, staleMs: 600_000, isHolderAlive: () => false })).toBe(7);
    expect(existsSync(lock)).toBe(false);
  });

  it("exactly one winner when several waiters race for the same stale lock", () => {
    const f = file();
    const lock = f + ".lock";
    writeFileSync(lock, "424242"); // dead holder => stale right away
    let depth = 0;
    let maxDepth = 0;
    const enter = (): void => { depth += 1; maxDepth = Math.max(maxDepth, depth); };
    const leave = (): void => { depth -= 1; };
    withFileLockSync(f, () => {
      enter();
      try {
        // Every other waiter (same tick) must time out while the winner holds the lock.
        for (let i = 0; i < 3; i += 1) {
          expect(() => withFileLockSync(f, () => { enter(); try { return 1; } finally { leave(); } },
            { timeoutMs: 10, staleMs: 600_000, isHolderAlive: (pid) => pid === process.pid })).toThrow(/lock busy/);
        }
      } finally { leave(); }
    }, { timeoutMs: 200, staleMs: 0, isHolderAlive: () => false });
    expect(maxDepth).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });
});
