/**
 * issue #137(第 1/2):后处理产物容器随 outputFormat —— 合并路径 / 分段路径 / session-plan / stage 清理识别。
 * 默认(缺省 / original)必须与现状逐字一致(mp4);存档选 mkv 才换容器;投稿一律强制 mp4。
 */
import { describe, it, expect, vi, type Mock } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotifyEvent } from "@drec/core";
import { runPipeline, stageVideoLeftovers, type PipelineCfg, type PipelineDeps } from "../../packages/orchestrator/src/pipeline.js";
import { ResourcePool } from "../../packages/orchestrator/src/workflow.js";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { deriveSegmentPlan, deriveStageProducts, segWorkPath, withOutputStem } from "../../packages/orchestrator/src/session-plan.js";
import type { Broadcast } from "../../packages/orchestrator/src/identity.js";
import type { NodeRecording, Transport } from "../../packages/orchestrator/src/transport.js";

const STREAM_KEY = "douyin:test-room:2026-06-27";
const SUB = "douyin_test-room_2026-06-27";
const STEM = "主播名_2026-06-27";

const rec = (tsFiles: string[]): NodeRecording => ({
  roomSlug: "test-room", platform: "douyin", sessionBase: "主播名_2026-06-27_08-00-00",
  tsFiles, xmlPath: "/remote/danmu.xml", durationSec: 3600,
  startMs: Date.now() - 3_600_000, endMs: Date.now(), totalGapSec: 0,
});
const broadcast = (tsFiles: string[]): Broadcast => ({
  streamKey: STREAM_KEY, platform: "douyin", roomSlug: "test-room", startMs: Date.now() - 3_600_000,
  members: [{ workerId: "node-1", rec: rec(tsFiles) }],
});
const transport = (): Transport => ({
  id: "node-1",
  listInventory: vi.fn().mockResolvedValue({ workerId: "node-1", recordings: [] }),
  isDone: vi.fn().mockResolvedValue(true),
  pull: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(true),
  cleanup: vi.fn().mockResolvedValue(undefined),
});

/** 模拟 CLI:merge 按 --format 产 .mkv/.mp4;burn 按 --video 的扩展名产同容器的 _danmu/_livechat。 */
function makeDeps(cfgOver: Partial<PipelineCfg>) {
  const stageDir = mkdtempSync(join(tmpdir(), "of-stage-"));
  const stageSub = join(stageDir, SUB);
  const sh = vi.fn<(cmd: string) => Promise<void>>().mockImplementation(async (cmd) => {
    mkdirSync(stageSub, { recursive: true });
    if (cmd.includes(" merge ")) {
      const ext = /--format\s+(\w+)/.exec(cmd)?.[1] ?? "mp4";
      const stem = /--out-base\s+'([^']+)'/.exec(cmd)?.[1] ?? STEM;
      writeFileSync(join(stageSub, "src.ts"), "x");
      writeFileSync(join(stageSub, "danmu.xml"), "x");
      writeFileSync(join(stageSub, `${stem}.${ext}`), "x");
      writeFileSync(join(stageSub, `${stem}.xml`), "x");
    } else if (cmd.includes("--style ")) {
      const video = /--video\s+(\S+)/.exec(cmd)?.[1] ?? "";
      const style = cmd.includes("--style livechat") ? "livechat" : "danmu";
      writeFileSync(video.replace(/(\.[^./]+)$/, `_${style}$1`), "x");
    }
  });
  const cfg: PipelineCfg = {
    cleanMaxGapSec: 30, stageDir, cookies: "/tmp/cookies.json", uploadMode: "stage",
    uploadMeta: { tag: "t", tid: 21, desc: "d" }, ...cfgOver,
  };
  const deps = {
    transports: new Map([["node-1", transport()]]),
    ledger: new SyncLedger(join(mkdtempSync(join(tmpdir(), "of-ledger-")), "t.db")),
    sh,
    uploadPlain: vi.fn<(o: { video?: string }) => Promise<string>>().mockResolvedValue("BV1"),
    appendGroup: vi.fn().mockResolvedValue(undefined),
    pool: new ResourcePool({ minBurnFreeMemMB: 0, maxCpuParallel: 1, maxNetParallel: 1, uploadRateLimit: 0 }),
    splitForUpload: async (p: string) => [p],
    notify: vi.fn<(e: NotifyEvent) => void>(),
    sleep: async () => {},
    cfg,
  } as unknown as PipelineDeps & { sh: Mock; uploadPlain: Mock; ledger: SyncLedger };
  return { deps, stageSub, stageDir, cmds: (): string[] => sh.mock.calls.map((c) => c[0]) };
}

describe("合并路径产物容器", () => {
  it("回归:缺省(无 outputFormat)→ merge 命令不带 --format,产物仍是 mp4", async () => {
    const { deps, stageSub, cmds } = makeDeps({});
    const b = broadcast(["/remote/a.ts", "/remote/b.ts"]);
    deps.ledger.upsertPending(b.streamKey);
    const r = await runPipeline(b, deps);
    expect(r.state).toBe("needs_manual");
    const merge = cmds().find((c) => c.includes(" merge "))!;
    expect(merge).not.toContain("--format");
    expect(readdirSync(stageSub).filter((f) => /\.(mp4|mkv)$/.test(f)).sort())
      .toEqual([`${STEM}.mp4`, `${STEM}_danmu.mp4`, `${STEM}_livechat.mp4`]);
    deps.ledger.close();
  });

  it("original 与缺省完全一致", async () => {
    const { deps, cmds } = makeDeps({ outputFormat: "original" });
    const b = broadcast(["/remote/a.ts"]);
    deps.ledger.upsertPending(b.streamKey);
    await runPipeline(b, deps);
    expect(cmds().find((c) => c.includes(" merge "))).not.toContain("--format");
    deps.ledger.close();
  });

  it("存档 + mkv:merge 带 --format mkv,合并片 / danmu / livechat 全是 .mkv,无 mp4 并存", async () => {
    const { deps, stageSub, cmds } = makeDeps({ outputFormat: "mkv" });
    const b = broadcast(["/remote/a.ts", "/remote/b.ts"]);
    deps.ledger.upsertPending(b.streamKey);
    const r = await runPipeline(b, deps);
    expect(r.state).toBe("needs_manual");
    expect(cmds().find((c) => c.includes(" merge "))).toContain("--format mkv");
    const burns = cmds().filter((c) => c.includes("--style "));
    expect(burns).toHaveLength(2);
    for (const c of burns) expect(c).toContain(`--video ${join(stageSub, `${STEM}.mkv`)}`);
    const vids = readdirSync(stageSub).filter((f) => /\.(mp4|mkv)$/.test(f)).sort();
    expect(vids).toEqual([`${STEM}.mkv`, `${STEM}_danmu.mkv`, `${STEM}_livechat.mkv`]);
    deps.ledger.close();
  });

  it("投稿(upload)即使选了 mkv 也强制 mp4:merge 不带 --format,上传的是 .mp4", async () => {
    const { deps, cmds } = makeDeps({ outputFormat: "mkv", uploadMode: "upload" });
    const b = broadcast(["/remote/a.ts"]);
    deps.ledger.upsertPending(b.streamKey);
    const r = await runPipeline(b, deps);
    expect(r.state).toBe("done");
    expect(cmds().find((c) => c.includes(" merge "))).not.toContain("--format");
    const video = (deps.uploadPlain.mock.calls[0]![0] as { video: string }).video;
    expect(video.endsWith(".mp4")).toBe(true);
    for (const c of (deps.appendGroup.mock.calls as Array<[{ files: string[] }]>).flatMap((x) => x[0].files)) {
      expect(c.endsWith(".mp4")).toBe(true);
    }
    deps.ledger.close();
  });
});

describe("分段路径产物容器(mergeSegments=false,存档)", () => {
  function segDeps(cfgOver: Partial<PipelineCfg>) {
    const h = makeDeps({ steps: { mergeSegments: false }, ...cfgOver });
    const remuxOuts: string[] = [];
    const burnOuts: string[] = [];
    Object.assign(h.deps, {
      remuxSegment: async (_s: string, out: string) => { remuxOuts.push(out); mkdirSync(join(out, ".."), { recursive: true }); writeFileSync(out, "x"); },
      segmentDuration: async () => 60,
      burnSegment: async ({ out }: { out: string }) => { burnOuts.push(out); writeFileSync(out, "x"); },
      rmStage: vi.fn().mockResolvedValue(undefined),
    });
    mkdirSync(h.stageSub, { recursive: true });
    for (const f of ["s_000.ts", "s_001.ts", "danmu.xml"]) writeFileSync(join(h.stageSub, f), "x");
    return { ...h, remuxOuts, burnOuts };
  }
  const SEG_BC = (): Broadcast => broadcast(["/remote/s_000.ts", "/remote/s_001.ts"]);

  it("回归:缺省 → 逐段 remux 与分 P 都是 .mp4,烧录为 _000_danmu.mp4", async () => {
    const h = segDeps({});
    h.deps.ledger.upsertPending(STREAM_KEY);
    const r = await runPipeline(SEG_BC(), h.deps);
    expect(r.state).toBe("needs_manual");
    expect(h.remuxOuts.every((p) => p.endsWith(".mp4"))).toBe(true);
    const top = readdirSync(h.stageSub).filter((f) => /\.(mp4|mkv)$/.test(f)).sort();
    expect(top).toEqual(["000", "001"].flatMap((n) => [`${STEM}_${n}.mp4`, `${STEM}_${n}_danmu.mp4`, `${STEM}_${n}_livechat.mp4`]));
    h.deps.ledger.close();
  });

  it("存档 + mkv:remux 中间产物与分 P / 烧录产物全部 .mkv,remux 目标走 mkv 扩展名", async () => {
    const h = segDeps({ outputFormat: "mkv" });
    h.deps.ledger.upsertPending(STREAM_KEY);
    const r = await runPipeline(SEG_BC(), h.deps);
    expect(r.state).toBe("needs_manual");
    expect(h.remuxOuts.length).toBeGreaterThan(0);
    expect(h.remuxOuts.every((p) => p.endsWith(".mkv"))).toBe(true);
    const top = readdirSync(h.stageSub).filter((f) => /\.(mp4|mkv)$/.test(f)).sort();
    expect(top).toEqual(["000", "001"].flatMap((n) => [`${STEM}_${n}.mkv`, `${STEM}_${n}_danmu.mkv`, `${STEM}_${n}_livechat.mkv`]));
    expect(h.burnOuts.every((p) => p.endsWith(".mkv"))).toBe(true);
    h.deps.ledger.close();
  });

  it("投稿(upload)+ mkv:强制 mp4,分 P 上传的都是 .mp4", async () => {
    const h = segDeps({ outputFormat: "mkv", uploadMode: "upload" });
    h.deps.ledger.upsertPending(STREAM_KEY);
    const r = await runPipeline(SEG_BC(), h.deps);
    expect(r.state).toBe("done");
    expect(h.remuxOuts.every((p) => p.endsWith(".mp4"))).toBe(true);
    expect(((h.deps.uploadPlain.mock.calls[0]![0] as { video: string }).video).endsWith(".mp4")).toBe(true);
    h.deps.ledger.close();
  });
});

describe("session-plan 按容器推导", () => {
  const mk = (names: string[]): string => {
    const d = mkdtempSync(join(tmpdir(), "of-plan-"));
    for (const n of names) writeFileSync(join(d, n), "x");
    return d;
  };
  it("deriveStageProducts:默认 mp4 不变;mkv 只认 .mkv 产物", () => {
    const d = mk([`${STEM}.mkv`, `${STEM}_danmu.mkv`, "x.xml"]);
    expect(deriveStageProducts(d)).toBeNull(); // 默认按 mp4 找:目录里只有 mkv 产物 → 不当作已有产物
    const p = deriveStageProducts(d, "mkv")!;
    expect(p.dateName).toBe(STEM);
    expect(p.plain).toBe(`${d}/${STEM}.mkv`);
    expect(p.danmuMp4).toBe(`${d}/${STEM}_danmu.mkv`);
    expect(p.livechatMp4).toBe(`${d}/${STEM}_livechat.mkv`);
    rmSync(d, { recursive: true });
  });
  it("withOutputStem 沿用传入产物的容器扩展名", () => {
    const d = mk([`${STEM}.mkv`]);
    const p = withOutputStem(deriveStageProducts(d, "mkv")!, "新名");
    expect(p.plain).toBe(`${d}/新名.mkv`);
    expect(p.danmuMp4).toBe(`${d}/新名_danmu.mkv`);
    rmSync(d, { recursive: true });
  });
  it("segWorkPath / deriveSegmentPlan:按生效容器;换格式后旧容器残留不当分 P", () => {
    expect(segWorkPath("/s", 3)).toBe("/s/.work/003.mp4");
    expect(segWorkPath("/s", 3, "mkv")).toBe("/s/.work/003.mkv");
    const d = mk([`${STEM}_000.mkv`, `${STEM}_001.mp4`, `${STEM}_000_danmu.mkv`]);
    const plan = deriveSegmentPlan(d, undefined, "mkv")!;
    expect(plan.parts.map((x) => x.plain.split("/").pop())).toEqual([`${STEM}_000.mkv`]);
    expect(plan.parts[0]!.danmu.endsWith("_000_danmu.mkv")).toBe(true);
    expect(deriveSegmentPlan(d)!.parts.map((x) => x.plain.split("/").pop())).toEqual([`${STEM}_001.mp4`]);
    rmSync(d, { recursive: true });
  });
});

describe("stage 视频类清理识别 mkv(删除类:不漏删也不误删)", () => {
  it("stageVideoLeftovers:返回 .mkv(与 ts/flv/mp4 同类);xml/ass/json/log 与其它文件不碰", () => {
    const d = mkdtempSync(join(tmpdir(), "of-left-"));
    for (const f of ["a.mkv", "b.MKV", "c.mp4", "d.ts", "e.flv", "a.xml", "a.ass", "a.session.json", "job.log", "notes.txt", "x.mkv.bak"]) writeFileSync(join(d, f), "x");
    const got = stageVideoLeftovers(d).map((p) => p.split("/").pop()).sort();
    expect(got).toEqual(["a.mkv", "b.MKV", "c.mp4", "d.ts", "e.flv"]);
    expect(existsSync(join(d, "a.xml"))).toBe(true);
    rmSync(d, { recursive: true });
  });
});
