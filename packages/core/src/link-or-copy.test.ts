import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinkFallbackCount, linkOrCopy, resetLinkFallbackState, type LinkFs } from "./link-or-copy.js";

const exdevFs = (copies: string[]): LinkFs => ({
  linkSync: () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); },
  copyFileSync: (_s, d) => { copies.push(d); },
  statSync: () => ({ size: 2_000_000_000 }),
});

describe("linkOrCopy", () => {
  beforeEach(() => resetLinkFallbackState());

  it("硬链接成功:返回 link,不回落、不计数", () => {
    const dir = mkdtempSync(join(tmpdir(), "loc-"));
    writeFileSync(join(dir, "a"), "hello");
    const warn = vi.fn();
    expect(linkOrCopy(join(dir, "a"), join(dir, "b"), { root: "r1", warn })).toBe("link");
    expect(statSync(join(dir, "a")).ino).toBe(statSync(join(dir, "b")).ino);
    expect(warn).not.toHaveBeenCalled();
    expect(getLinkFallbackCount("r1")).toBe(0);
  });

  it("模拟 EXDEV:回落复制,回调带错误码与字节数", () => {
    const copies: string[] = [];
    const onFallback = vi.fn();
    const warn = vi.fn();
    expect(linkOrCopy("/s/a", "/d/a", { fs: exdevFs(copies), root: "r1", warn, onFallback })).toBe("copy");
    expect(copies).toEqual(["/d/a"]);
    expect(onFallback).toHaveBeenCalledWith({ code: "EXDEV", bytes: 2_000_000_000, src: "/s/a", dst: "/d/a" }, 1);
    expect(warn.mock.calls[0][0]).toContain("EXDEV");
  });

  it("同一数据根仅首次提示,之后累计计数;不同数据根各提示一次", () => {
    const warn = vi.fn();
    const fs = exdevFs([]);
    for (let i = 0; i < 3; i++) linkOrCopy("/s/a", `/d/${i}`, { fs, root: "r1", warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getLinkFallbackCount("r1")).toBe(3);
    linkOrCopy("/s/a", "/d/x", { fs, root: "r2", warn });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("目标已存在(调用方未先删):link 失败 EEXIST 回落复制覆盖", () => {
    const dir = mkdtempSync(join(tmpdir(), "loc-"));
    writeFileSync(join(dir, "a"), "new");
    writeFileSync(join(dir, "b"), "old");
    expect(linkOrCopy(join(dir, "a"), join(dir, "b"), { root: "r1", warn: () => {} })).toBe("copy");
    expect(readFileSync(join(dir, "b"), "utf8")).toBe("new");
    expect(existsSync(join(dir, "a"))).toBe(true);
  });

  it("复制也失败时照常抛出", () => {
    const fs: LinkFs = { ...exdevFs([]), copyFileSync: () => { throw new Error("ENOSPC"); } };
    expect(() => linkOrCopy("/s/a", "/d/a", { fs, root: "r1", warn: () => {} })).toThrow("ENOSPC");
  });
});
