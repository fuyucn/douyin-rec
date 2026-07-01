import { describe, it, expect } from "vitest";
import { buildRecordArgs } from "../../packages/app/src/process/record-args.js";
import { rootOutputDir } from "../../packages/app/src/paths.js";
import type { Task } from "../../packages/app/src/store.js";

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    room: "12345",
    name: "anchor",
    quality: "origin",
    engine: "ffmpeg",
    danmu: 1,
    segmentSec: 1800,
    cookies: null,
    outDir: null,
    scheduleStart: null,
    scheduleEnd: null,
    status: "stopped",
    useCookie: true,
    createdAt: "2026-06-12T00:00:00.000Z",
    ...over,
  };
}

describe("buildRecordArgs", () => {
  it("maps all base fields with defaults (name present, no cookies, default outDir)", () => {
    expect(buildRecordArgs(mkTask())).toEqual([
      "record",
      "--room",
      "12345",
      "--quality",
      "origin",
      "--engine",
      "ffmpeg",
      "--danmu",
      "1",
      "--out",
      // 无 DOUYIN_REC_ROOT 时的默认值(见 paths.ts DEFAULT_ROOT="./output-data")——用真实解析函数,
      // 不写死字符串,避免默认根改名/改路径时这个断言悄悄漂移。
      rootOutputDir(),
      "--segment",
      "1800",
      "--name",
      "anchor",
    ]);
  });

  it("danmu 0 → --danmu 0 (开关,来源由平台 connectDanmu 决定)", () => {
    const args = buildRecordArgs(mkTask({ danmu: 0 }));
    const i = args.indexOf("--danmu");
    expect(args[i + 1]).toBe("0");
  });

  it("danmu 1 → --danmu 1", () => {
    const args = buildRecordArgs(mkTask({ danmu: 1 }));
    const i = args.indexOf("--danmu");
    expect(args[i + 1]).toBe("1");
  });

  it("appends --name when task.name is set", () => {
    const args = buildRecordArgs(mkTask({ name: "一勺小苏打" }));
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe("一勺小苏打");
  });

  it("omits --name when task.name is null", () => {
    expect(buildRecordArgs(mkTask({ name: null }))).not.toContain("--name");
  });

  it("appends --cookies only when present", () => {
    const args = buildRecordArgs(mkTask({ cookies: "sessionid=abc" }));
    expect(args).toContain("--cookies");
    expect(args[args.indexOf("--cookies") + 1]).toBe("sessionid=abc");
  });

  it("omits --cookies when null", () => {
    expect(buildRecordArgs(mkTask({ cookies: null }))).not.toContain("--cookies");
  });

  it("uses task.outDir when set", () => {
    const args = buildRecordArgs(mkTask({ outDir: "/tmp/rec" }));
    expect(args[args.indexOf("--out") + 1]).toBe("/tmp/rec");
  });

  it("passes engine + quality + segment through", () => {
    const args = buildRecordArgs(
      mkTask({ engine: "mesio", quality: "hd", segmentSec: 0 }),
    );
    expect(args[args.indexOf("--engine") + 1]).toBe("mesio");
    expect(args[args.indexOf("--quality") + 1]).toBe("hd");
    expect(args[args.indexOf("--segment") + 1]).toBe("0");
  });

  it("passes a full URL room through verbatim", () => {
    const args = buildRecordArgs(mkTask({ room: "https://live.douyin.com/999" }));
    expect(args[args.indexOf("--room") + 1]).toBe("https://live.douyin.com/999");
  });
});
