import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const assets = join(__dirname, "../../packages/web/src/assets/modes");
const kinds = ["archive", "bilibili", "zero-disk", "segment", "merge", "node", "split", "danmu"];

describe("final mode SVG assets", () => {
  for (const kind of kinds) {
    it(kind + " is a standalone theme-aware vector without external content", () => {
      const source = readFileSync(join(assets, kind + ".svg"), "utf8");
      expect(source).toMatch(/<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(source).toContain('viewBox="0 0 24 24"');
      expect(source).toContain('stroke="currentColor"');
      expect(source).toContain('fill="none"');
      expect(source).toMatch(/<(path|rect)\b/);
      expect(source).toMatch(/<\/svg>\s*$/);
      expect(source).not.toMatch(/<(script|image|foreignObject|animate)\b|\son\w+=|href=|url\(/i);
    });
  }

  it("pins the referenced mode-<kind> group id in every asset", () => {
    for (const kind of kinds) {
      const source = readFileSync(join(assets, kind + ".svg"), "utf8");
      expect(source).toContain(`id="mode-${kind}"`);
    }
  });

  it("keeps all eight marks distinct", () => {
    const artwork = kinds.map(kind => readFileSync(join(assets, kind + ".svg"), "utf8").replace(/id="[^"]*"/g, ""));
    expect(new Set(artwork).size).toBe(kinds.length);
  });
});
