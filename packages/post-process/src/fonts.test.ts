import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAssetsFonts } from "./fonts.js";

describe("findAssetsFonts（向上搜 assets/fonts）", () => {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("从深层子目录向上命中 assets/fonts", () => {
    const root = mkdtempSync(join(tmpdir(), "fontsroot-")); made.push(root);
    const fonts = join(root, "assets", "fonts");
    mkdirSync(fonts, { recursive: true });
    // 模拟 bundle 布局(root/dist)与源码布局(root/packages/post-process/src)都能命中
    const fromDist = join(root, "dist");
    const fromSrc = join(root, "packages", "post-process", "src");
    mkdirSync(fromDist, { recursive: true });
    mkdirSync(fromSrc, { recursive: true });
    expect(findAssetsFonts(fromDist)).toBe(fonts);
    expect(findAssetsFonts(fromSrc)).toBe(fonts);
  });

  it("无 assets/fonts → null（不再误返回越界路径）", () => {
    const root = mkdtempSync(join(tmpdir(), "nofonts-")); made.push(root);
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(findAssetsFonts(sub)).toBeNull();
  });
});
