import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProbeCache } from "./probe-cache.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const file = (content = "x") => {
  const d = mkdtempSync(join(tmpdir(), "drec-probe-"));
  dirs.push(d);
  const f = join(d, "a.ts");
  writeFileSync(f, content);
  return f;
};

describe("createProbeCache", () => {
  it("same file version → probed once", async () => {
    const probe = vi.fn(async () => 42);
    const cached = createProbeCache(probe);
    const f = file();
    expect(await cached(f)).toBe(42);
    expect(await cached(f)).toBe(42);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("growing file (size / mtime change) → probed again", async () => {
    const probe = vi.fn(async () => 1);
    const cached = createProbeCache(probe);
    const f = file("x");
    await cached(f);
    writeFileSync(f, "xx");
    await cached(f);
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    await cached(f);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("probe failure is not cached", async () => {
    let n = 0;
    const cached = createProbeCache(async () => { if (n++ === 0) throw new Error("busy"); return 7; });
    const f = file();
    await expect(cached(f)).rejects.toThrow("busy");
    expect(await cached(f)).toBe(7);
  });

  it("evicts the least recently used entry past max", async () => {
    const probe = vi.fn(async (p: string) => p);
    const cached = createProbeCache(probe, 1);
    const a = file("a");
    const b = file("b");
    await cached(a);
    await cached(b);
    await cached(a);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("missing file → falls through to the probe", async () => {
    const cached = createProbeCache(async () => "probed");
    expect(await cached(join(tmpdir(), "drec-nope", "x.ts"))).toBe("probed");
  });
});
