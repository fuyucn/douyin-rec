import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";

describe("loadConfig", () => {
  it("文件不存在时返回默认值", () => {
    expect(loadConfig("/nonexistent/x.yaml")).toEqual(DEFAULT_CONFIG);
  });
  it("合并 YAML 覆盖默认值", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const f = join(dir, "c.yaml");
    writeFileSync(f, "quality: hd\nrecorder: bililive\noutDir: /tmp/rec\n");
    const c = loadConfig(f);
    expect(c.quality).toBe("hd");
    expect(c.recorder).toBe("bililive");
    expect(c.outDir).toBe("/tmp/rec");
    expect(c.danmu).toBe(DEFAULT_CONFIG.danmu); // 未覆盖项保留默认
  });
});
