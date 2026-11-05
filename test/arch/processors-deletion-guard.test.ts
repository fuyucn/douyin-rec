// plan 046 PR2 will make cleanup-part the only queue processor allowed to delete.
// PR1 records the current whitelist so adding another deletion site fails immediately.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "packages", "processors", "src");
const ALLOWED_DELETIONS: Record<string, number[]> = {
  "biliup.ts": [117],
  "remux.ts": [231, 375],
};

describe("processors deletion skeleton", () => {
  it("every unlink/rm call is on the explicit existing whitelist", () => {
    const hits: string[] = [];
    for (const name of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
      const lines = readFileSync(join(SRC, name), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*import\b/.test(line)) return;
        if (!/\b(?:unlinkSync|rmSync|rm\(|fs\.rm|rimraf|rmdir)\b/.test(line)) return;
        if (!ALLOWED_DELETIONS[name]?.includes(i + 1)) hits.push(name + ":" + (i + 1) + ": " + line.trim());
      });
    }
    expect(hits).toEqual([]);
  });

  it("future cleanup-part module is the only planned exception", () => {
    expect(readdirSync(SRC)).not.toContain("cleanup-part.ts");
    expect(Object.keys(ALLOWED_DELETIONS).sort()).toEqual(["biliup.ts", "remux.ts"]);
  });
});
