/**
 * issue #143:CLI `merge` 在 stage 目录上必须读 session.json 的 nodeFormat,认出节点侧已转换的 .mkv 分段。
 * 判别信号不依赖 ffmpeg:无声明 → 「目录内无会话」(rc=2);有声明 → 越过分组、进入合并(ffmpeg 对空文件报错即可)。
 * 依赖已构建的 dist/douyin-rec.mjs(`pnpm bundle`),未构建则跳过。
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BUNDLE = resolve(__dirname, "../../dist/douyin-rec.mjs");
const BASE = "主播_2026-06-27_08-00-00";
const run = (dir: string) =>
  spawnSync("node", [BUNDLE, "merge", "--in", dir, "--merge-sessions"], { encoding: "utf-8", timeout: 60_000 });

describe.skipIf(!existsSync(BUNDLE))("CLI merge 认节点侧转换分段(issue #143)", () => {
  it("无边车:.mkv 不被认领 → 目录内无会话", () => {
    const d = mkdtempSync(join(tmpdir(), "cli-merge-"));
    writeFileSync(join(d, `${BASE}.mkv`), "");
    const r = run(d);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("目录内无会话");
  });

  it("有边车(nodeFormat=mkv):.mkv 被认领,不再报无会话", () => {
    const d = mkdtempSync(join(tmpdir(), "cli-merge-"));
    writeFileSync(join(d, `${BASE}.mkv`), "");
    writeFileSync(join(d, `${BASE}.session.json`), JSON.stringify({ nodeFormat: "mkv" }));
    const r = run(d);
    expect(r.stderr).not.toContain("目录内无会话");
  });
});
