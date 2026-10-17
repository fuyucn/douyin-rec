import { describe, it, expect, vi } from "vitest";
import { findRecentArchive, listAllArchives, parseArchiveList, durationMatches } from "../../packages/processors/src/archive-lookup.js";

const page = (rows: unknown[]) => JSON.stringify({ code: 0, data: { list: rows } });
const hit = (bv: string, title: string, duration: number, ctime = Math.floor(Date.now() / 1000)) => ({ bvid: bv, title, duration, ctime });

describe("archive lookup across all states (plan 038 T07)", () => {
  it("三状态都查询;失败 → unknown(不能当成没有稿件)", async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv.includes("--not-pubed")) throw new Error("boom");
      return page([hit("BV" + "1".repeat(10), "x", 60)]);
    });
    expect(await findRecentArchive("c", "x", 60, { run })).toBe("unknown");
  });

  it("已过审稿件(不在 is-pubing)也能查到 → yes", async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv.includes("--pubed")) return page([hit("BV" + "2".repeat(10), "same title", 3600)]);
      return page([]);
    });
    expect(await findRecentArchive("c", "same title", 3600, { run })).toBe("yes");
  });

  it("同名但时长不符 → unknown;无同名 → no", async () => {
    const run = vi.fn(async (argv: string[]) => argv.includes("--pubed") ? page([hit("BV" + "3".repeat(10), "t", 10)]) : page([]));
    expect(await findRecentArchive("c", "t", 3600, { run })).toBe("unknown");
    expect(await findRecentArchive("c", "other", 3600, { run })).toBe("no");
  });

  it("union 去重;BVID 非法行被丢弃;坏 JSON → null", async () => {
    const dup = [hit("BV" + "4".repeat(10), "a", 60)];
    const run = vi.fn(async () => page([...dup, { bvid: "nope", title: "x" }]));
    expect(await listAllArchives("c", { run })).toHaveLength(1);
    const bad = vi.fn(async () => "not json");
    expect(await listAllArchives("c", { run: bad })).toBeNull();
    expect(parseArchiveList("[]")).toEqual([]);
  });

  it("durationMatches 用 max(60s, 2%)", () => {
    expect(durationMatches({ bv: "x", title: "t", durationSec: 100 }, 120)).toBe(true);
    expect(durationMatches({ bv: "x", title: "t", durationSec: 100 }, 200)).toBe(false);
  });
});
