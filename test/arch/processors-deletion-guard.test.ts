// plan 046 PR2 will make cleanup-part the only queue processor allowed to delete.
// PR1 pins the CURRENT deletion sites as text anchors (refactor-safe: no line numbers). A new
// deletion call in any processors source, or the loss of one pinned site, must fail this guard.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "packages", "processors", "src");
// Call-site tokens only (import lines are skipped): sync + promise variants of unlink/rm/rmdir.
const DELETION_RE = /\b(?:unlinkSync|unlink|rmSync|rm\(|fs\.rm|rimraf|rmdirSync|rmdir)\b/;

/** Pinned sites as normalized call text prefixes; each must match exactly one scanned line. */
const PINNED: ReadonlyArray<{ file: string; call: string }> = [
  { file: "biliup.ts", call: "rmSync(dst, { force: true });" },
  { file: "remux.ts", call: "try { rmSync(p, { force: true }); } catch" },
  { file: "remux.ts", call: "try { rmSync(src); }" },
];

const normalize = (line: string): string => line.trim().replace(/\s+/g, " ");

function scanDeletionSites(): Array<{ file: string; call: string }> {
  const hits: Array<{ file: string; call: string }> = [];
  for (const name of readdirSync(SRC).filter((f) => f.endsWith(".ts")).sort()) {
    for (const raw of readFileSync(join(SRC, name), "utf8").split("\n")) {
      if (/^\s*import\b/.test(raw)) continue;
      if (!DELETION_RE.test(raw)) continue;
      hits.push({ file: name, call: normalize(raw) });
    }
  }
  return hits;
}

describe("processors deletion skeleton", () => {
  it("the deletion sites are exactly the pinned whitelist (text anchors, no line numbers)", () => {
    const unmatched = scanDeletionSites();
    const missing: string[] = [];
    for (const p of PINNED) {
      const i = unmatched.findIndex((h) => h.file === p.file && (h.call === p.call || h.call.startsWith(p.call)));
      if (i < 0) missing.push(p.file + ": " + p.call);
      else unmatched.splice(i, 1);
    }
    expect(missing, "a pinned deletion site disappeared or changed beyond recognition").toEqual([]);
    expect(unmatched, "a new deletion call outside the pinned whitelist").toEqual([]);
  });
});
