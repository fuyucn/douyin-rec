import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  spawn: (...a: unknown[]) => spawnMock(...a),
  spawnSync: vi.fn(() => ({ status: 0, stderr: "" })),
}));
import { buildMesioArgs, FILE_WATCH_MS, listOwnSegments, mesioEngine, ownSegmentBytes, startMesioProgressWatch } from "./mesio.js";

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
    const watch = startMesioProgressWatch(dir, "mine", mark);
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
      watch.finish();
    }
  });

  it("listOwnSegments:只认 {nameBase}_NNN.flv,按段号排序,别的前缀/无段号/其它扩展名不算", () => {
    put("mine_001.flv", 40);
    put("mine_000.flv", 10);
    put("mine_notes.flv", 99);           // no numeric tail
    put("mineX_000.flv", 1000);          // prefix must include the trailing underscore
    put("mine_000.xml", 1000);
    put("other_000.flv", 500);           // another task in the same directory
    expect(listOwnSegments(dir, "mine")?.map((s) => [s.name, s.index])).toEqual([
      ["mine_000.flv", 0],
      ["mine_001.flv", 1],
    ]);
    expect(listOwnSegments(join(dir, "nope"), "mine")).toBeNull();
  });

  // #566: mesio rolls its own files and only the first one used to reach onSegment. Every later
  // segment was therefore invisible to rolling upload / in-place remux, which then left the rest on disk.
  it("新段(段号>=1)只上报一次;首段/别的前缀/其它扩展名不上报", () => {
    vi.useFakeTimers();
    put("mine_000.flv", 10);
    const seen: string[] = [];
    const mark = vi.fn();
    const watch = startMesioProgressWatch(dir, "mine", mark, (p) => seen.push(p));
    try {
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(seen).toEqual([]); // index 0 stays with the recorder's spawn-time report

      put("mine_001.flv", 0);  // rolled: reported as soon as the file appears, before it has data
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(seen).toEqual([join(dir, "mine_001.flv")]);

      put("mine_001.flv", 10);
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(seen).toHaveLength(1); // a growing already-reported segment is not a new one

      put("mineX_001.flv", 10);
      put("mine_extra_001.flv", 10); // another session whose base shares our prefix
      put("other_001.flv", 10);
      put("mine_001.xml", 10);
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(seen).toHaveLength(1); // foreign prefix / extension never reaches onSegment

      put("mine_002.flv", 0);
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(seen).toHaveLength(2);
    } finally {
      watch.finish();
    }
  });

  // #566: the old baseline was a monotonic total. Once a sealed segment was deleted (rolling upload /
  // in-place remux), the next segment had to out-grow the OLD peak before progress was reported again,
  // so the 60s stall watchdog killed a healthy recording. Per-file deltas fix that.
  it("删掉已封口段后,剩余段增长仍刷新进度", () => {
    vi.useFakeTimers();
    put("mine_000.flv", 100);
    const mark = vi.fn();
    const watch = startMesioProgressWatch(dir, "mine", mark);
    try {
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(mark).toHaveBeenCalledTimes(1); // baseline = 100

      unlinkSync(join(dir, "mine_000.flv")); // rolling/remux deleted the sealed segment
      put("mine_001.flv", 80);               // total 80 < old peak 100: the old code stayed silent
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(mark).toHaveBeenCalledTimes(2);
    } finally {
      watch.finish();
    }
  });

  it("finish() 末扫补报轮询间隔内出现的新段,且只报一次", () => {
    vi.useFakeTimers();
    put("mine_000.flv", 100);
    const seen: string[] = [];
    const mark = vi.fn();
    const watch = startMesioProgressWatch(dir, "mine", mark, (p) => seen.push(p));
    vi.advanceTimersByTime(FILE_WATCH_MS);
    put("mine_001.flv", 5); // appeared after the last tick; a stop now must not miss the final segment
    watch.finish();
    expect(seen).toEqual([join(dir, "mine_001.flv")]);
    expect(mark).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(FILE_WATCH_MS);
    expect(seen).toHaveLength(1); // timer cleared by finish()
  });

  it("onSegment 抛错不打断看门狗(录制优先),且错误经 onHookError 可见", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const errors: unknown[] = [];
    const mark = vi.fn();
    const watch = startMesioProgressWatch(
      dir,
      "mine",
      mark,
      (p) => { seen.push(p); throw new Error("boom"); },
      (e) => errors.push(e),
    );
    try {
      put("mine_001.flv", 1);
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(seen).toHaveLength(1);
      expect(errors).toHaveLength(1);
      put("mine_002.flv", 1);
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(seen).toHaveLength(2); // the interval survived the throwing hook
      expect(errors).toHaveLength(2);
      expect(mark).toHaveBeenCalled();
    } finally {
      watch.finish();
    }
  });

  it("空 nameBase:同目录别人的段只算进度、绝不上报", () => {
    vi.useFakeTimers();
    put("a_000.flv", 10);
    const seen: string[] = [];
    const mark = vi.fn();
    const watch = startMesioProgressWatch(dir, "", mark, (p) => seen.push(p));
    try {
      vi.advanceTimersByTime(FILE_WATCH_MS);
      put("a_001.flv", 10);
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(seen).toEqual([]); // cannot prove these are ours, so never feed the recorder's hooks
      expect(mark).toHaveBeenCalledTimes(2);
    } finally {
      watch.finish();
    }
  });

  it("前一拍仍在长的新段,下一拍确认前段稳定后才上报", () => {
    vi.useFakeTimers();
    put("mine_000.flv", 100);
    const seen: string[] = [];
    const watch = startMesioProgressWatch(dir, "mine", vi.fn(), (p) => seen.push(p));
    try {
      vi.advanceTimersByTime(FILE_WATCH_MS); // baseline: 100
      put("mine_000.flv", 150);              // predecessor grew since the last scan (may still be writing)
      put("mine_001.flv", 10);
      vi.advanceTimersByTime(FILE_WATCH_MS);
      expect(seen).toEqual([]); // not proven sealed yet
      vi.advanceTimersByTime(FILE_WATCH_MS); // predecessor unchanged for a full scan now
      expect(seen).toEqual([join(dir, "mine_001.flv")]);
    } finally {
      watch.finish();
    }
  });

  it("spawn 接线:新段走 onSegment,cleanup 停表", () => {
    vi.useFakeTimers();
    const proc = new EventEmitter() as unknown as { stderr: EventEmitter; kill: () => void };
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    spawnMock.mockReturnValue(proc);
    put("probe_000.flv", 10);
    const seen: string[] = [];
    const marks = vi.fn();
    const r = mesioEngine.spawn({
      url: "https://stream.invalid/x.flv",
      dir,
      nameBase: "probe",
      segSec: 15,
      onSegment: (p) => seen.push(p),
      markProgress: marks,
      pushStderr: () => {},
    });
    vi.advanceTimersByTime(FILE_WATCH_MS);
    put("probe_001.flv", 5);
    vi.advanceTimersByTime(FILE_WATCH_MS);
    expect(seen).toEqual([join(dir, "probe_001.flv")]);
    expect(marks).toHaveBeenCalled();
    r.cleanup?.();
    put("probe_002.flv", 5);
    vi.advanceTimersByTime(FILE_WATCH_MS);
    expect(seen).toHaveLength(1); // cleanup cleared the interval
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
