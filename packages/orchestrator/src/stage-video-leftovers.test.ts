import { afterEach, describe, expect, it } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageVideoLeftovers } from "./pipeline.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const mk = (): string => (dir = mkdtempSync(path.join(tmpdir(), "stage-leftovers-")));
const names = (ps: string[]): string[] => ps.map((p) => path.basename(p)).sort();

describe("stageVideoLeftovers(#60)", () => {
  it("只返回 .ts/.flv/.mp4 与 .work/.upload;xml/ass/session.json/job.log 与未知目录一律不碰", () => {
    const d = mk();
    for (const f of ["a.ts", "b.FLV", "c.mp4", "a.xml", "a.ass", "a.session.json", "job.log", ".drec-node-result.json", "note.txt"]) writeFileSync(path.join(d, f), "x");
    mkdirSync(path.join(d, ".work")); writeFileSync(path.join(d, ".work", "000.mp4"), "x");
    mkdirSync(path.join(d, ".upload"));
    mkdirSync(path.join(d, "other")); writeFileSync(path.join(d, "other", "keep.mp4"), "x");
    expect(names(stageVideoLeftovers(d))).toEqual([".upload", ".work", "a.ts", "b.FLV", "c.mp4"]);
  });

  it("目录不存在 / 空目录 → 空数组,不抛错", () => {
    const d = mk();
    expect(stageVideoLeftovers(d)).toEqual([]);
    expect(stageVideoLeftovers(path.join(d, "missing"))).toEqual([]);
  });

  it("硬链接:删 stage 副本只摘链接,节点源仍在;符号链接目录不被跟随", () => {
    const d = mk();
    const src = path.join(d, "node.ts"); writeFileSync(src, "payload");
    const stage = path.join(d, "stage"); mkdirSync(stage);
    linkSync(src, path.join(stage, "node.ts"));
    const outside = path.join(d, "outside"); mkdirSync(outside); writeFileSync(path.join(outside, "x.mp4"), "x");
    symlinkSync(outside, path.join(stage, ".work"));
    for (const p of stageVideoLeftovers(stage)) rmSync(p, { recursive: true, force: true });
    expect(existsSync(src)).toBe(true);
    expect(existsSync(path.join(outside, "x.mp4"))).toBe(true);
    expect(stageVideoLeftovers(stage)).toEqual([]);
  });
});
