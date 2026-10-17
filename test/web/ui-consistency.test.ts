/**
 * ui-consistency.test.ts — two cheap guards for UI drift (issue #194):
 *  1. the zh dictionary uses one vocabulary (主控 / 节点 / 转封装), not a mix with master / worker / remux;
 *  2. no emoji glyphs (⚠ ⏳) in components — they render differently per OS; use the lucide icons.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "packages", "web", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(p)) out.push(p);
  }
  return out;
}

describe("zh vocabulary", () => {
  const src = readFileSync(join(SRC, "lib", "i18n.tsx"), "utf-8").split("\n");
  const zhStart = src.findIndex((l) => /^\s{2}zh\s*:\s*\{/.test(l));
  const enStart = src.findIndex((l) => /^\s{2}en\s*:\s*\{/.test(l));

  it("finds both dictionaries", () => {
    expect(zhStart).toBeGreaterThan(0);
    expect(enStart).toBeGreaterThan(zhStart);
  });

  it("no master / worker / remux inside zh string values (placeholders like {worker} are fine)", () => {
    const bad: string[] = [];
    src.slice(zhStart, enStart).forEach((line, i) => {
      for (const m of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
        const text = m[0].replace(/\{[^}]*\}/g, "");
        if (/(?<![\w])(master|workers?|remux)(?![\w])/i.test(text)) bad.push(`${zhStart + i + 1}: ${m[0].slice(0, 60)}`);
      }
    });
    expect(bad).toEqual([]);
  });
});

describe("no emoji glyphs in UI code", () => {
  it("⚠ / ⏳ appear only in the log-level regex, never in components", () => {
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      if (f.endsWith(`${join("lib", "logLevel.ts")}`)) continue; // classifies log lines that contain ⚠
      if (/[⚠⏳]/.test(readFileSync(f, "utf-8"))) hits.push(f.slice(SRC.length + 1));
    }
    expect(hits).toEqual([]);
  });
});
