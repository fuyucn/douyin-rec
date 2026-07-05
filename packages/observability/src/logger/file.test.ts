import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLogger } from "./file.js";
import { composite } from "./composite.js";

describe("FileLogger", () => {
  it("info/warn/error 追加带级别前缀的行到文件(首写自动建目录)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "flog-")), "sub", "job.log");
    const l = new FileLogger(p);
    l.info("hello");
    l.warn("careful");
    l.error("boom");
    const txt = readFileSync(p, "utf-8");
    expect(txt).toContain("INFO hello");
    expect(txt).toContain("WARN careful");
    expect(txt).toContain("ERROR boom");
    expect(txt.trim().split("\n")).toHaveLength(3);
  });
  it("写不了的路径 → 静默不抛(日志绝不反噬主流程)", () => {
    const l = new FileLogger("/nonexistent-root-xyz/deep/job.log");
    expect(() => {
      l.info("x");
      l.error("y");
    }).not.toThrow();
  });
});

describe("composite", () => {
  it("扇出到多个 logger;单个抛错不影响其余", () => {
    const a: string[] = [];
    const good = { info: (m: unknown) => a.push(String(m)), warn: () => {}, error: () => {} };
    const bad = { info: () => { throw new Error("x"); }, warn: () => {}, error: () => {} };
    const c = composite(bad, good);
    expect(() => c.info("hi")).not.toThrow();
    expect(a).toEqual(["hi"]);
  });
});
