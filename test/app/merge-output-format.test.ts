/**
 * issue #165:任务页「合成所选」产物容器跟随任务 outputFormat(original → mp4),
 * merge_jobs 记录实际产物路径,老记录可查。
 *
 * 默认用 mergeSessions 测试替身(记录收到的输出路径 + 落占位文件,不依赖本机 ffmpeg);
 * 真实 ffmpeg 可用时另跑一组 ffprobe 读回(不可用整组跳过并标注)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { OutputFormat } from "@drec/core";
import { TaskStore } from "../../packages/app/src/store.js";
import { MergeJobStore } from "../../packages/app/src/merge-jobs.js";
import { makeApi, type ManagerLike } from "../../packages/app/src/web/api.js";

const merged: { out: string; outXml?: string }[] = [];
const useReal = vi.hoisted(() => ({ on: false }));

vi.mock("@drec/post-process", async (orig) => {
  const real = await orig<typeof import("@drec/post-process")>();
  return {
    ...real,
    mergeSessions: async (...args: Parameters<typeof real.mergeSessions>) => {
      if (useReal.on) return real.mergeSessions(...args);
      const [, out, outXml] = args;
      merged.push({ out, outXml });
      writeFileSync(out, "stub");
      if (outXml) writeFileSync(outXml, "<i></i>");
      return { mp4: out, xml: outXml };
    },
  };
});

const B = "主播_2026-10-15_21-00-00";
let root: string;
let store: TaskStore;
let mergeJobs: MergeJobStore;
let api: ReturnType<typeof makeApi>;

beforeEach(() => {
  merged.length = 0;
  useReal.on = false;
  root = mkdtempSync(join(tmpdir(), "mergefmt_"));
  mkdirSync(join(root, "主播"), { recursive: true });
  writeFileSync(join(root, "主播", `${B}.ts`), "");
  writeFileSync(join(root, "主播", `${B}.xml`), "<i></i>");
  store = new TaskStore(":memory:");
  mergeJobs = new MergeJobStore(store.db);
  api = makeApi({ store, manager: { getAnchorName: () => undefined } as unknown as ManagerLike, mergeJobs });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function runMerge(fmt?: OutputFormat): Promise<{ id: string; mp4?: string; xml?: string; state: string }> {
  const t = store.addTask({ room: "111", name: "主播", outDir: root, ...(fmt ? { outputFormat: fmt } : {}) });
  const started = api.startMerge(t.id, { sessions: [B] });
  expect(started.status).toBe(202);
  const id = (started.body as { id: string }).id;
  for (let i = 0; i < 200; i++) {
    const v = mergeJobs.view(id)!;
    if (v.state !== "running") return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("merge job 超时未结束");
}

describe("startMerge 产物扩展名跟随 outputFormat", () => {
  it("mkv → 产物 .mkv,xml 同名,job 记录实际路径", async () => {
    const v = await runMerge("mkv");
    expect(v.state).toBe("done");
    expect(v.mp4).toBe(join(root, "主播", `${B}_merged.mkv`));
    expect(v.xml).toBe(join(root, "主播", `${B}_merged.xml`));
    expect(basename(merged[0].out, ".mkv")).toBe(basename(merged[0].outXml!, ".xml"));
    expect(existsSync(v.mp4!)).toBe(true);
  });

  it("original → mp4;显式 mp4 → mp4", async () => {
    expect((await runMerge("original")).mp4).toBe(join(root, "主播", `${B}_merged.mp4`));
    rmSync(join(root, "主播", `${B}_merged.mp4`), { force: true });
    expect((await runMerge("mp4")).mp4).toBe(join(root, "主播", `${B}_merged.mp4`));
  });

  it("create 时即记入意向路径(含 mkv 扩展名),供重启清理半截", () => {
    const t = store.addTask({ room: "111", name: "主播", outDir: root, outputFormat: "mkv" });
    const r = api.startMerge(t.id, { sessions: [B] }).body as { mp4: string };
    expect(r.mp4.endsWith("_merged.mkv")).toBe(true);
  });

  it("老 merge job(.mp4 记录)仍可经 getMerge 查询", () => {
    store.db.prepare(
      `INSERT INTO merge_jobs (id, taskId, state, sessions, mp4, xml, createdAt) VALUES (?,?,?,?,?,?,?)`,
    ).run("mold-t1", 1, "done", JSON.stringify([B]), "/x/old_merged.mp4", "/x/old_merged.xml", "2026-01-01T00:00:00Z");
    const r = api.getMerge("mold-t1");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: "mold-t1", state: "done", mp4: "/x/old_merged.mp4", xml: "/x/old_merged.xml" });
  });
});

const ok = (cmd: string, args: string[]): boolean => {
  try { return spawnSync(cmd, args, { stdio: "ignore", timeout: 20_000 }).status === 0; } catch { return false; }
};
const HAVE = ok("ffmpeg", ["-version"]) && ok("ffprobe", ["-version"])
  && ok("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5", "-t", "1", "-f", "null", "-"]);
if (!HAVE) console.warn("[merge-output-format] 真实 ffmpeg 组 SKIPPED:本环境 ffmpeg/ffprobe 不可用");

describe.skipIf(!HAVE)("真实 ffmpeg:合成产物可被 ffprobe 读", () => {
  it("mkv 任务 → .mkv 为 matroska,mp4 任务 → .mp4 为 mov/mp4 容器", async () => {
    useReal.on = true;
    const seg = join(root, "主播", `${B}.ts`);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5", "-t", "2", "-c:v", "libx264", "-f", "mpegts", seg]);
    expect(r.status).toBe(0);
    const fmtOf = (p: string): string =>
      spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", p], { encoding: "utf-8" }).stdout.trim();
    const mkv = await runMerge("mkv");
    expect(mkv.state).toBe("done");
    expect(fmtOf(mkv.mp4!)).toContain("matroska");
    expect(existsSync(mkv.xml!)).toBe(true);
    const mp4 = await runMerge("original");
    expect(mp4.state).toBe("done");
    expect(fmtOf(mp4.mp4!)).toContain("mp4");
  });
});
