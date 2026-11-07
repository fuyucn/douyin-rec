import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMesioArgs, FILE_WATCH_MS, ownSegmentBytes, startMesioProgressWatch } from "./mesio.js";

describe("mesio 卡死看门狗只统计本会话的分段(issue #474)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mesio-watch-")); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  const put = (name: string, bytes: number): void => { writeFileSync(join(dir, name), Buffer.alloc(bytes)); };

  it("ownSegmentBytes:只累加 {nameBase}_*.flv(多段也算),相似前缀/其它扩展名不算", () => {
    put("mine_000.flv", 100);
    expect(ownSegmentBytes(dir, "mine")).toBe(100);
    put("mine_001.flv", 40);
    expect(ownSegmentBytes(dir, "mine")).toBe(140);      // rolled segment
    put("mineX_000.flv", 1000);                          // prefix must include the trailing underscore
    put("mine_000.xml", 1000);                           // not a segment container
    put("other_000.flv", 500);                           // another task in the same directory
    expect(ownSegmentBytes(dir, "mine")).toBe(140);
  });

  it("ownSegmentBytes:目录不存在 → null;空 nameBase → 回落旧行为(统计全部 .flv)", () => {
    expect(ownSegmentBytes(join(dir, "nope"), "mine")).toBeNull();
    put("a_000.flv", 10);
    put("b_000.flv", 20);
    expect(ownSegmentBytes(dir, "")).toBe(30); // TODO(?) fallback, no nameBase to scope by
  });

  it("进度:同目录其它 .flv 增长不刷新进度;本会话分段增长(含新分段)刷新", () => {
    vi.useFakeTimers();
    put("mine_000.flv", 100);
    const mark = vi.fn();
    const timer = startMesioProgressWatch(dir, "mine", mark);
    try {
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(mark).toHaveBeenCalledTimes(1);       // first reading of our own segment

      put("other_000.flv", 9999);                  // unrelated growth in the same directory
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(mark).toHaveBeenCalledTimes(1);       // must NOT keep the stalled mesio alive

      put("mine_000.flv", 200);                    // our segment grew
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(mark).toHaveBeenCalledTimes(2);

      put("mine_001.flv", 50);                     // a newly rolled segment counts too
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(mark).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(FILE_WATCH_MS);       // no change → no extra progress
      expect(mark).toHaveBeenCalledTimes(3);
    } finally {
      clearInterval(timer);
    }
  });
});

describe("mesio 引擎 argv", () => {
  it("分段:-o dir -n {nameBase}_%i --fix --disable-log-file + -d {segSec}s", () => {
    const args = buildMesioArgs({
      url: "https://cdn/live.flv",
      dir: "/out/anchor",
      nameBase: "anchor_2026-06-20_01-02-03",
      segSec: 1800,
    });
    expect(args[0]).toBe("https://cdn/live.flv");
    expect(args).toEqual(expect.arrayContaining(["-o", "/out/anchor"]));
    expect(args).toEqual(expect.arrayContaining(["-n", "anchor_2026-06-20_01-02-03_%i"]));
    expect(args).toContain("--fix");
    expect(args).toContain("--disable-log-file");
    expect(args).toEqual(expect.arrayContaining(["-d", "1800s"]));
  });

  it("不分段:无 -d", () => {
    const args = buildMesioArgs({ url: "u", dir: "/d", nameBase: "a", segSec: 0 });
    expect(args).not.toContain("-d");
  });

  it("给 headers → 每个头一个 -H 'K: V'(bilibili Referer 防 403)", () => {
    const args = buildMesioArgs({
      url: "u",
      headers: { Referer: "https://live.bilibili.com/", "User-Agent": "UA/1.0" },
      dir: "/d",
      nameBase: "a",
      segSec: 0,
    });
    expect(args).toEqual(expect.arrayContaining(["-H", "Referer: https://live.bilibili.com/"]));
    expect(args).toEqual(expect.arrayContaining(["-H", "User-Agent: UA/1.0"]));
  });
});
