// issue #223: writeFileAtomicSync — atomic replace via unique temp + rename, never deletes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomicSync } from "@drec/core";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "atomic-write-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tmpLeft = (): string[] => readdirSync(dir).filter((n) => n.endsWith(".tmp")).sort();
const tmpRe = (base: string): RegExp => new RegExp(`^${base.replace(/\./g, "\\.")}\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`);

describe("writeFileAtomicSync", () => {
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
