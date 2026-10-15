import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinkFallbackCount, linkOrCopy, resetLinkFallbackState, type LinkFs } from "./link-or-copy.js";

const exdevFs = (copies: string[], renames: string[][] = []): LinkFs => ({
  linkSync: () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); },
  copyFileSync: (_s, d) => { copies.push(d); },
  renameSync: (s, d) => { renames.push([s, d]); },
  statSync: () => ({ size: 2_000_000_000 }),
});

const exdev = (): Error => Object.assign(new Error("cross-device"), { code: "EXDEV" });

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
    const renames: string[][] = [];
    const onFallback = vi.fn();
    const warn = vi.fn();
    expect(linkOrCopy("/s/a", "/d/a", { fs: exdevFs(copies, renames), root: "r1", warn, onFallback })).toBe("copy");
    // 复制落**临时名**,再由 rename 原子替换目标(直接写目标名会留下「写了一半的最终名」)。
    expect(copies).toEqual(["/d/.a.part"]);
    expect(renames).toEqual([["/d/.a.part", "/d/a"]]);
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

  it("目标已存在(续跑/陈旧产物):原子替换,不整文件复制、不误报回落", () => {
    const dir = mkdtempSync(join(tmpdir(), "loc-"));
    writeFileSync(join(dir, "a"), "new");
    writeFileSync(join(dir, "b"), "old");
    const warn = vi.fn();
    expect(linkOrCopy(join(dir, "a"), join(dir, "b"), { root: "r1", warn })).toBe("link");
    expect(readFileSync(join(dir, "b"), "utf8")).toBe("new");
    expect(statSync(join(dir, "a")).ino).toBe(statSync(join(dir, "b")).ino);
    expect(existsSync(join(dir, "a"))).toBe(true);
    expect(existsSync(join(dir, ".b.part"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(getLinkFallbackCount("r1")).toBe(0);
  });

  it("同一 inode 重复调用(续跑/601 重试):幂等返回,不留临时名、不误报回落", () => {
    const dir = mkdtempSync(join(tmpdir(), "loc-"));
    writeFileSync(join(dir, "a"), "same");
    const warn = vi.fn();
    expect(linkOrCopy(join(dir, "a"), join(dir, "b"), { root: "r1", warn })).toBe("link");
    // 第二次(等价「续跑再走一遍」):b 已经是 a 的硬链接 → 必须什么都不做。
    // 若照旧 link+rename,同 inode 之间 rename 是空操作 → 临时名会永久留下(清理按扩展名扫不到 = 泄漏)。
    expect(linkOrCopy(join(dir, "a"), join(dir, "b"), { root: "r1", warn })).toBe("link");
    expect(readdirSync(dir).sort()).toEqual(["a", "b"]);
    expect(statSync(join(dir, "b")).nlink).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    expect(getLinkFallbackCount("r1")).toBe(0);
  });

  it("替换中途失败:目标保持原样,不留半写状态", () => {
    const dir = mkdtempSync(join(tmpdir(), "loc-"));
    writeFileSync(join(dir, "a"), "new");
    writeFileSync(join(dir, "b"), "old");
    const failing: LinkFs = {
      linkSync: () => { throw exdev(); },
      copyFileSync: () => { throw new Error("ENOSPC"); },
      statSync: () => ({ size: 0 }),
    };
    expect(() => linkOrCopy(join(dir, "a"), join(dir, "b"), { fs: failing, root: "r1", warn: () => {} })).toThrow("ENOSPC");
    expect(readFileSync(join(dir, "b"), "utf8")).toBe("old");
    expect(existsSync(join(dir, ".b.part"))).toBe(false);
  });

  it("复制也失败时照常抛出", () => {
    const fs: LinkFs = { ...exdevFs([]), copyFileSync: () => { throw new Error("ENOSPC"); } };
    expect(() => linkOrCopy("/s/a", "/d/a", { fs, root: "r1", warn: () => {} })).toThrow("ENOSPC");
  });
});
