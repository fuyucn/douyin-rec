/**
 * Source guard: the production zero-disk path must keep using the two helpers.
 *
 * These two fixes were once committed on a side branch and never merged, so the deployed
 * build silently regressed (`10011` from Douyin, and the recording credential used for the
 * Bilibili upload). Helper unit tests cannot see whether the CLI still calls them; this
 * guard makes dropping either call a test failure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "packages/cli/src/cli.ts");

/**
 * The `record` stream-upload block only; the hidden `_live-pump` PoC is out of scope.
 *
 * Slice up to the comment that starts the node-remux path immediately after this branch.
 * A fixed indentation (`"\n }"`) is wrong here: the branch closes with four spaces, so it
 * would silently capture ~600 lines including `_live-pump` and constrain unrelated code.
 */
function streamUploadBlock(source: string): string {
  const start = source.indexOf('if (streamUploadEnabled) {');
  expect(start, "找不到 record --stream-upload 分支").toBeGreaterThan(-1);
  const end = source.indexOf("\n    // 节点侧原地替换容器(issue #137)", start);
  expect(end, "找不到 record --stream-upload 分支的结尾").toBeGreaterThan(start);
  const block = source.slice(start, end);
  // Guard the slice itself: these live outside the production zero-disk branch.
  expect(block).not.toContain("_live-pump");
  expect(block).not.toContain("_upos-upload");
  return block;
}

describe("record --stream-upload wiring (zero-disk)", () => {
  const src = readFileSync(CLI, "utf-8");
  const block = streamUploadBlock(src);

  it("normalizes the room before getStream / pump state", () => {
    expect(block).toContain("zeroDiskRoom(platform, o.room)");
    expect(block).toContain("room: pumpRoom");
    expect(block).toContain("livePumpStatePath(opts.outDir, pumpRoom)");
    expect(block).not.toContain("room: o.room");
  });

  it("uses the dedicated upload credential, never the recording cookie file", () => {
    expect(block).toContain("zeroDiskUploadCookie(process.env, rootBiliupCookies())");
    expect(block).toContain("cookiesPath: uploadCookies");
    expect(block).not.toContain("o.cookiesFile ?? process.env.BILIUP_COOKIE");
  });
});
