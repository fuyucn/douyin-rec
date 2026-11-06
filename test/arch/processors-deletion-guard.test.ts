// plan 046 PR2 makes cleanup-part the ONLY queue processor allowed to delete.
// Pinned sites are text anchors (no line numbers: refactors above must not break this). A new
// deletion call anywhere in processors/src — including a new site inside cleanup-part — or the
// loss of a pinned site must fail this guard, so the whitelist is the review gate for deletion.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "packages", "processors", "src");
// Call-shaped only (identifier + "("): comments like "unlink below is irreversible" do not match.
const DELETION_RE = /\b(?:unlinkSync|unlink|rmdirSync|rmdir|rmSync|rimraf|fs\.rm|rm)\s*\(/;

/** The sanctioned deleter (plan 046 §8 risk 3). Any other file must keep only legacy anchors. */
const SANCTIONED_DELETER = "cleanup-part.ts";

/** Pinned sites as normalized call-text prefixes; each must match exactly one scanned line. */
const PINNED: ReadonlyArray<{ file: string; call: string }> = [
  // legacy (pre-plan-046) sites, unchanged until their owners refactor:
  { file: "biliup.ts", call: "rmSync(dst, { force: true });" },
  { file: "remux.ts", call: "try { rmSync(p, { force: true }); } catch" },
  { file: "remux.ts", call: "try { rmSync(src); }" },
  // cleanup-part (plan 046 PR2): the sanctioned deleter — default seam + alias + source order.
  { file: SANCTIONED_DELETER, call: "const unlink = deps.unlink ?? ((p: string): void => { unlinkSync(p); });" },
  { file: SANCTIONED_DELETER, call: "try { unlink(alias); }" },
  { file: SANCTIONED_DELETER, call: "try { unlink(file); }" },
];

const normalize = (line: string): string => line.trim().replace(/\s+/g, " ");

function scanDeletionSites(): Array<{ file: string; call: string }> {
  const hits: Array<{ file: string; call: string }> = [];
  for (const name of readdirSync(SRC).filter((f) => f.endsWith(".ts")).sort()) {
    for (const raw of readFileSync(join(SRC, name), "utf8").split("\n")) {
      if (/^\s*(import|export .*from|\s*\*)/.test(raw)) continue;
      if (!DELETION_RE.test(raw)) continue;
      hits.push({ file: name, call: normalize(raw) });
    }
  }
  return hits;
}

describe("processors deletion guard (plan 046 §8 risk 3)", () => {
  it("every deletion site is pinned; only cleanup-part may delete", () => {
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

  it("the pinned deletions outside cleanup-part are exactly the legacy three", () => {
    const legacy = PINNED.filter((p) => p.file !== SANCTIONED_DELETER).map((p) => p.file);
    expect([...new Set(legacy)].sort()).toEqual(["biliup.ts", "remux.ts"]);
    expect(PINNED.filter((p) => p.file === SANCTIONED_DELETER)).toHaveLength(3);
  });
});
