// issue #223: writeFileAtomicSync — atomic replace via unique temp + rename, never deletes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, linkSync, mkdirSync, statSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  it("is exclusive, bounded, and takes over a stale lock", () => {
    const f = join(dir, "s.rolling.json");
    writeFileSync(f, "{}");
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
});
