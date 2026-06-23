import { describe, it, expect } from "vitest";
import { buildMesioArgs } from "./mesio.js";

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
