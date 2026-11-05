import { describe, it, expect, vi } from "vitest";
import {
  findRecentArchive,
  listAllArchives,
  parseArchiveList,
  parseArchiveShow,
  durationMatches,
  looseTitleKey,
} from "../../packages/processors/src/archive-lookup.js";

const ESC = String.fromCharCode(27);
const NOW = 1_800_000_000_000;
const page = (rows: unknown[]) => JSON.stringify({ code: 0, data: { list: rows } });
const hit = (bv: string, title: string, duration: number, ctime = Math.floor(NOW / 1000)) => ({ bvid: bv, title, duration, ctime });
const logLine = (text: string) => "2026-11-05T12:00:00 " + ESC + "[32m INFO " + ESC + "[0m biliup_cli::uploader: " + text;
const listLine = (bv: string, title: string, state: string) => bv + "\t" + title + "\t" + state;
const showOut = (bv: string, title: string, duration: number, ctime: number) =>
  logLine("show " + bv) + "\n" + JSON.stringify({ archive: { bvid: bv, title, ctime, duration, pages: [{ cid: 1 }] } });
const quiet = () => undefined;

describe("archive lookup across all states (plan 038 T07)", () => {
  it("queries all three states; a failure is unknown (never treated as no archive)", async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv.includes("--not-pubed")) throw new Error("boom");
      return page([hit("BV" + "1".repeat(10), "x", 60)]);
    });
    expect(await findRecentArchive("c", "x", 60, { run, log: quiet })).toBe("unknown");
  });

  it("a published archive (not in is-pubing) is also found -> yes", async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv[0] === "show") return showOut("BV" + "2".repeat(10), "same title", 3600, Math.floor(NOW / 1000));
      if (argv.includes("--pubed")) return page([hit("BV" + "2".repeat(10), "same title", 3600)]);
      return page([]);
    });
    expect(await findRecentArchive("c", "same title", 3600, { run, now: () => NOW, trustNo: true })).toBe("yes");
  });

  it("same title but different duration -> unknown; no same title -> no with explicit trust", async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv[0] === "show") return showOut("BV" + "3".repeat(10), "t", 10, Math.floor(NOW / 1000));
      return argv.includes("--pubed") ? page([hit("BV" + "3".repeat(10), "t", 10)]) : page([]);
    });
    expect(await findRecentArchive("c", "t", 3600, { run, now: () => NOW, trustNo: true })).toBe("unknown");
    expect(await findRecentArchive("c", "other", 3600, { run, now: () => NOW, trustNo: true })).toBe("no");
  });

  it("a title rewritten by the server (emoji / full-width dropped) is unknown, never no", async () => {
    const stored = "主播A_2026-10-18";
    const run = vi.fn(async (argv: string[]) => {
      if (argv[0] === "show") return showOut("BV" + "5".repeat(10), stored, 3600, Math.floor(NOW / 1000));
      return argv.includes("--pubed") ? page([hit("BV" + "5".repeat(10), stored, 3600)]) : page([]);
    });
    expect(await findRecentArchive("c", "主播\u{1F338}Ａ_2026-10-18", 3600, { run, now: () => NOW, trustNo: true })).toBe("unknown");
    expect(await findRecentArchive("c", "主播B_2026-10-18", 3600, { run, now: () => NOW, trustNo: true })).toBe("no");
    expect(await findRecentArchive("c", stored, 3600, { run, now: () => NOW, trustNo: true })).toBe("yes");
  });

  it("a stale loose-only title is still unknown when trustNo is enabled", async () => {
    const stored = "主播A_2026-10-18";
    const run = vi.fn(async () => page([hit("BV" + "6".repeat(10), stored, 3600, 1)]));
    expect(await findRecentArchive("c", "主播\u{1F338}Ａ_2026-10-18", 3600, {
      run,
      now: () => NOW,
      trustNo: true,
    })).toBe("unknown");
  });

  it("looseTitleKey keeps letters and digits only, NFKC and case-folded", () => {
    expect(looseTitleKey("Ａｂ\u{1F338} 1.2")).toBe("ab12");
    expect(looseTitleKey("\u{1F338}\u{1F338}")).toBe("");
  });

  it("union de-duplicates; rows with an invalid BVID are dropped; bad JSON -> null", async () => {
    const dup = [hit("BV" + "4".repeat(10), "a", 60)];
    const run = vi.fn(async () => page([...dup, { bvid: "nope", title: "x" }]));
    expect(await listAllArchives("c", { run })).toHaveLength(1);
    const bad = vi.fn(async () => "not json");
    expect(await listAllArchives("c", { run: bad, log: quiet })).toBeNull();
    expect(parseArchiveList("[]")).toEqual([]);
  });

  it("durationMatches uses max(60s, 2%)", () => {
    expect(durationMatches({ bv: "x", title: "t", durationSec: 100 }, 120)).toBe(true);
    expect(durationMatches({ bv: "x", title: "t", durationSec: 100 }, 200)).toBe(false);
  });
});

describe("real biliup output (issue #507)", () => {
  const matchingBv = "BV1xxxxxxxxx"; // issue-guard: allow (fake BV fixture)
  const otherBv = "BV1yyyyyyyyy"; // issue-guard: allow (fake BV fixture)
  const title = "测试标题 2026-11-05";
  const realList = (rows: string[]) => [logLine("user: 测试账号"), ...rows].join("\n") + "\n";

  it("parses ANSI-log-prefixed tab-separated rows and ignores the log line", () => {
    const out = realList([
      listLine(matchingBv, title, "开放浏览"),
      listLine(otherBv, "另一个 标题", "审核中"),
    ]);
    expect(parseArchiveList(out)).toEqual([
      { bv: matchingBv, title },
      { bv: otherBv, title: "另一个 标题" },
    ]);
    expect(parseArchiveList(realList([]))).toEqual([]);
    expect(parseArchiveList(logLine("user: 测试账号") + "\n")).toEqual([]);
  });

  it("parses show output with a log prefix and tolerates missing optional fields", () => {
    const out = showOut(matchingBv, title, 3600, Math.floor(NOW / 1000));
    expect(parseArchiveShow(out)).toMatchObject({ bv: matchingBv, title, durationSec: 3600, parts: 1 });
    expect(parseArchiveShow(logLine("show") + "\n" + JSON.stringify({ archive: { bvid: matchingBv, title } }))).toMatchObject({ bv: matchingBv, title });
    expect(parseArchiveShow("no json here")).toBeNull();
  });

  it("finds a real-format archive by exact title, duration and creation window", async () => {
    const run = vi.fn(async (argv: string[]) => argv[0] === "show"
      ? showOut(matchingBv, title, 3600, Math.floor(NOW / 1000) - 60)
      : argv.includes("--pubed")
        ? realList([listLine(matchingBv, title, "开放浏览")])
        : realList([]));
    expect(await findRecentArchive("c", title, 3600, { run, now: () => NOW })).toBe("yes");
    expect(run.mock.calls.filter((call) => call[0][0] === "show")).toHaveLength(1);
  });

  it("real-format absence is no with trustNo=true, unknown by default with an explicit proof log", async () => {
    const run = vi.fn(async () => realList([listLine(otherBv, "另一个 标题", "开放浏览")]));
    expect(await findRecentArchive("c", title, 3600, { run, now: () => NOW, trustNo: true, log: quiet })).toBe("no");
    const log = vi.fn();
    expect(await findRecentArchive("c", title, 3600, { run, now: () => NOW, log })).toBe("unknown");
    expect(log).toHaveBeenCalledWith("proof would be: no(未启用)");
    expect(run.mock.calls.filter((call) => call[0][0] === "show")).toHaveLength(0);
  });

  it("an exact title outside the window, mismatched duration or stale creation time stays unknown", async () => {
    const base = async (argv: string[]) => argv[0] === "show"
      ? showOut(matchingBv, title, 3600, Math.floor((NOW - 49 * 3600_000) / 1000))
      : realList([listLine(matchingBv, title, "开放浏览")]);
    expect(await findRecentArchive("c", title, 3600, { run: base, now: () => NOW })).toBe("unknown");
    const wrongDuration = async (argv: string[]) => argv[0] === "show"
      ? showOut(matchingBv, title, 10, Math.floor(NOW / 1000))
      : realList([listLine(matchingBv, title, "开放浏览")]);
    expect(await findRecentArchive("c", title, 3600, { run: wrongDuration, now: () => NOW })).toBe("unknown");
    const future = async (argv: string[]) => argv[0] === "show"
      ? showOut(matchingBv, title, 3600, Math.floor(NOW / 1000) + 3600)
      : realList([listLine(matchingBv, title, "开放浏览")]);
    expect(await findRecentArchive("c", title, 3600, { run: future, now: () => NOW })).toBe("unknown");
  });

  it("logs unrecognized list output and show failures instead of silently returning unknown", async () => {
    const listLog = vi.fn();
    expect(await findRecentArchive("c", title, 3600, {
      run: async () => "unexpected output",
      log: listLog,
    })).toBe("unknown");
    expect(listLog).toHaveBeenCalledWith(expect.stringContaining("no recognized archive structure"));
    const showLog = vi.fn();
    const failingShow = vi.fn(async (argv: string[]) => {
      if (argv[0] === "show") throw new Error("show timeout");
      return realList([listLine(matchingBv, title, "开放浏览")]);
    });
    expect(await findRecentArchive("c", title, 3600, {
      run: failingShow,
      log: showLog,
    })).toBe("unknown");
    expect(showLog).toHaveBeenCalledWith(expect.stringContaining("show failed"));
  });

  it("deduplicates repeated BVIDs, bounds show calls and keeps titles with spaces", async () => {
    const titleWithSpaces = "测试 标题 with spaces";
    const run = vi.fn(async (argv: string[]) => {
      if (argv[0] === "show") return showOut(matchingBv, titleWithSpaces, 3600, Math.floor(NOW / 1000));
      return realList([
        listLine(matchingBv, titleWithSpaces, "开放浏览"),
        listLine(matchingBv, titleWithSpaces, "开放浏览"),
      ]);
    });
    expect(await listAllArchives("c", { run })).toHaveLength(1);
    expect(await findRecentArchive("c", titleWithSpaces, 3600, { run, now: () => NOW })).toBe("yes");
    expect(run.mock.calls.filter((call) => call[0][0] === "show")).toHaveLength(1);
    const many = Array.from({ length: 6 }, (_, index) => "BV1" + String(index).padStart(9, "0")); // issue-guard: allow (fake BV fixtures)
    const bounded = vi.fn(async (argv: string[]) => {
      if (argv[0] === "show") return showOut(argv[1]!, title, 3600, Math.floor(NOW / 1000));
      return realList(many.map((bv) => listLine(bv, title, "开放浏览")));
    });
    expect(await findRecentArchive("c", title, 3600, { run: bounded, now: () => NOW })).toBe("yes");
    expect(bounded.mock.calls.filter((call) => call[0][0] === "show")).toHaveLength(3);
  });

  it("a title containing an extra tab is never parsed as a three-column archive row", async () => {
    expect(parseArchiveList(realList([matchingBv + "\t" + title + "\textra\t开放浏览"]))).toBeNull();
    const run = vi.fn(async () => realList([matchingBv + "\t" + title + "\textra\t开放浏览"]));
    expect(await findRecentArchive("c", title, 3600, { run, log: quiet })).toBe("unknown");
  });

  it("empty and log-only output are known empty lists; unrecognizable text is logged", async () => {
    const logs: string[] = [];
    const log = (message: string): void => { logs.push(message); };
    expect(await findRecentArchive("c", title, 3600, { run: async () => "", trustNo: true, log })).toBe("no");
    expect(await findRecentArchive("c", title, 3600, { run: async () => logLine("user: 测试账号") + "\n", trustNo: true, log })).toBe("no");
    expect(await findRecentArchive("c", title, 3600, { run: async () => "unexpected text", log })).toBe("unknown");
    expect(logs.some((message) => message.includes("no recognized archive structure"))).toBe(true);
  });

  it("show output with a mismatched BVID or title is not positive proof", async () => {
    const mismatched = vi.fn(async (argv: string[]) => argv[0] === "show"
      ? showOut(otherBv, "另一个 标题", 3600, Math.floor(NOW / 1000))
      : realList([listLine(matchingBv, title, "开放浏览")]));
    expect(await findRecentArchive("c", title, 3600, { run: mismatched, now: () => NOW, log: quiet })).toBe("unknown");
  });
});
