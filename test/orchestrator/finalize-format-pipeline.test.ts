/**
 * plans/036 T9b:runPipeline 接线 —— done + 清理之后才对留存源分段派发 remux(fire-and-forget),
 * 处理中途从不转换、不阻塞 done、三分 P 不转、边车不进 inputs。
 */
import { afterEach, describe, it, expect, vi, type Mock } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnqueueRequest, EnqueueResponse, NotifyEvent } from "@drec/core";
import { runPipeline, type PipelineCfg, type PipelineDeps } from "../../packages/orchestrator/src/pipeline.js";
import { ResourcePool } from "../../packages/orchestrator/src/workflow.js";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { _resetFinalizeFormatState, parseFollowups } from "../../packages/orchestrator/src/finalize-format.js";
import type { Broadcast } from "../../packages/orchestrator/src/identity.js";
import type { NodeRecording, Transport } from "../../packages/orchestrator/src/transport.js";

const STREAM_KEY = "douyin:test-room:2026-06-27";
const SUB = "douyin_test-room_2026-06-27";
const STEM = "主播名_2026-06-27";
const BASE = "主播名_2026-06-27_08-00-00";
const REC = "/remote";

const rec = (tsFiles: string[], over: Partial<NodeRecording> = {}): NodeRecording => ({
  roomSlug: "test-room", platform: "douyin", sessionBase: BASE,
  tsFiles, xmlPath: `${REC}/danmu.xml`, sessionJsonPath: `${REC}/${BASE}.session.json`, durationSec: 3600,
  startMs: Date.now() - 3_600_000, endMs: Date.now(), totalGapSec: 0, ...over,
});
const broadcast = (tsFiles: string[], over: Partial<NodeRecording> = {}): Broadcast => ({
  streamKey: STREAM_KEY, platform: "douyin", roomSlug: "test-room", startMs: Date.now() - 3_600_000,
  members: [{ workerId: "node-1", rec: rec(tsFiles, over) }],
});

interface Harness {
  deps: PipelineDeps & { ledger: SyncLedger };
  stageSub: string;
  nodeEnqueue: Mock<(req: EnqueueRequest) => Promise<EnqueueResponse>>;
  stageEnqueue: Mock<(req: EnqueueRequest) => EnqueueResponse>;
  /** 每次 enqueue 发生时观察到的 job 状态 + 已发生的清理调用数(证明「done + 清理之后」)。 */
  seen: Array<{ target: "node" | "stage"; state: string | undefined; cleaned: { node: number; stage: number } }>;
  nodeCleanup: Mock;
  rmStage: Mock;
}

function makeHarness(cfgOver: Partial<PipelineCfg>, o: { finalize?: boolean; hang?: boolean; stageProc?: boolean } = {}): Harness {
  const stageDir = mkdtempSync(join(tmpdir(), "ff-pipe-stage-"));
  const stageSub = join(stageDir, SUB);
  const ledger = new SyncLedger(join(mkdtempSync(join(tmpdir(), "ff-pipe-ledger-")), "t.db"));
  const seen: Harness["seen"] = [];
  const nodeCleanup = vi.fn().mockResolvedValue(undefined);
  const rmStage = vi.fn().mockResolvedValue(undefined);
  const cleaned = (): { node: number; stage: number } => ({ node: nodeCleanup.mock.calls.length, stage: rmStage.mock.calls.length });
  const ok = (req: EnqueueRequest): EnqueueResponse => ({ v: 1, results: req.jobs.map((j) => ({ jobId: j.jobId.replace(/@#g/, "@7-1#g"), state: "pending" as const })) });
  const nodeEnqueue = vi.fn(async (req: EnqueueRequest): Promise<EnqueueResponse> => {
    seen.push({ target: "node", state: ledger.get(STREAM_KEY)?.state, cleaned: cleaned() });
    if (o.hang) return await new Promise<EnqueueResponse>(() => {});
    return ok(req);
  });
  const stageEnqueue = vi.fn((req: EnqueueRequest): EnqueueResponse => {
    seen.push({ target: "stage", state: ledger.get(STREAM_KEY)?.state, cleaned: cleaned() });
    return ok(req);
  });
  const transport = {
    id: "node-1",
    listInventory: vi.fn().mockResolvedValue({ workerId: "node-1", recordings: [] }),
    isDone: vi.fn().mockResolvedValue(true),
    // 模拟 rsync 拉取:源段 + 边车副本进 stage
    pull: vi.fn(async (paths: string[], localDir: string) => {
      mkdirSync(localDir, { recursive: true });
      for (const p of paths) writeFileSync(join(localDir, p.split("/").pop()!), "x");
    }),
    exists: vi.fn().mockResolvedValue(true),
    cleanup: nodeCleanup,
    enqueue: nodeEnqueue,
    procStatus: vi.fn().mockResolvedValue([]),
  } as unknown as Transport;
  const sh = vi.fn<(cmd: string) => Promise<void>>().mockImplementation(async (cmd) => {
    mkdirSync(stageSub, { recursive: true });
    if (cmd.includes(" merge ")) {
      const stem = /--out-base\s+'([^']+)'/.exec(cmd)?.[1] ?? STEM;
      const ext = /--format\s+(\w+)/.exec(cmd)?.[1] ?? "mp4";
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
    cleanMaxGapSec: 30, stageDir, cookies: "/tmp/cookies.json", uploadMode: "upload",
    uploadMeta: { tag: "t", tid: 21, desc: "d" }, ...cfgOver,
  };
  const deps = {
    transports: new Map([["node-1", transport]]), ledger, sh,
    uploadPlain: vi.fn().mockResolvedValue("BV1"), appendGroup: vi.fn().mockResolvedValue(undefined),
    pool: new ResourcePool({ minBurnFreeMemMB: 0, maxCpuParallel: 1, maxNetParallel: 1, uploadRateLimit: 0 }),
    splitForUpload: async (p: string) => [p], rmStage,
    notify: vi.fn<(e: NotifyEvent) => void>(), sleep: async () => {}, cfg,
    ...(o.finalize === false ? {} : {
      finalizeFormat: { ...(o.stageProc === false ? {} : { stageProc: { enqueue: stageEnqueue, procStatus: async () => [] } }) },
    }),
  } as unknown as PipelineDeps & { ledger: SyncLedger };
  return { deps, stageSub, nodeEnqueue, stageEnqueue, seen, nodeCleanup, rmStage };
}

const flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 20)); };
const tsFiles = [`${REC}/${BASE}_000.ts`, `${REC}/${BASE}_001.ts`];

describe("T9b 接线:done + 清理之后才派发", () => {
  afterEach(() => { _resetFinalizeFormatState(); });
  it("上传完成(done)+ stageAfterDone 清理之后,对节点源分段派发 remux;派发时 job 已是 done 且清理已发生", async () => {
    const h = makeHarness({ outputFormat: "mkv", cleanup: { stageAfterDone: true } });
    const b = broadcast(tsFiles);
    h.deps.ledger.upsertPending(STREAM_KEY);
    const r = await runPipeline(b, h.deps);
    expect(r.state).toBe("done");
    await flush();
    expect(h.nodeEnqueue).toHaveBeenCalledTimes(1);
    const jobs = h.nodeEnqueue.mock.calls[0][0].jobs;
    expect(jobs.map((j) => j.inputs[0]).sort()).toEqual(tsFiles);
    for (const j of jobs) {
      expect(j.params).toMatchObject({ format: "mkv", sidecar: `${REC}/${BASE}.session.json` });
      expect(j.inputs.some((i) => /\.session\.json$|\.xml$/.test(i))).toBe(false); // 边车只在 params
    }
    // 处理中途从不转换:派发时刻 job 已 done、stage 清理(stageAfterDone)已经发生
    expect(h.seen[0].state).toBe("done");
    expect(h.seen[0].cleaned.stage).toBeGreaterThan(0);
    expect(r.bv).toBe("BV1");
    const fu = parseFollowups(h.deps.ledger.getFollowups(STREAM_KEY))!;
    expect(fu.items).toHaveLength(2);
    h.deps.ledger.close();
  });

  it("上传仍用 mp4:所选 mkv 不改变投稿产物容器", async () => {
    const h = makeHarness({ outputFormat: "mkv" });
    h.deps.ledger.upsertPending(STREAM_KEY);
    await runPipeline(broadcast(tsFiles), h.deps);
    const video = (h.deps.uploadPlain as Mock).mock.calls[0]![0] as { video: string };
    expect(video.video.endsWith(".mp4")).toBe(true);
    h.deps.ledger.close();
  });

  it("三分 P 成品不转:stage 里的 plain/danmu/livechat/xml 不会出现在任何派发的 inputs 里;stage 源副本派到本机、带边车 params", async () => {
    const h = makeHarness({ outputFormat: "mkv" }); // 不清理:stage 里源段副本 + 边车副本都在
    // 拉取时把边车副本也带进 stage(#143)
    (h.deps.transports.get("node-1")!.pull as Mock).mockImplementation(async (paths: string[], localDir: string) => {
      mkdirSync(localDir, { recursive: true });
      for (const p of paths) writeFileSync(join(localDir, p.split("/").pop()!), "x");
      writeFileSync(join(localDir, `${BASE}.session.json`), "{}");
    });
    h.deps.ledger.upsertPending(STREAM_KEY);
    await runPipeline(broadcast(tsFiles), h.deps);
    await flush();
    const allInputs = [...h.nodeEnqueue.mock.calls, ...h.stageEnqueue.mock.calls].flatMap(([req]) => req.jobs.flatMap((j) => j.inputs));
    expect(allInputs.every((i) => /\.(ts|flv)$/.test(i))).toBe(true);
    expect(readdirSync(h.stageSub).some((f) => /_danmu\.mp4$/.test(f))).toBe(true); // 三分 P 确实在 stage
    expect(h.stageEnqueue).toHaveBeenCalledTimes(1);
    const sj = h.stageEnqueue.mock.calls[0][0].jobs;
    expect(sj.map((j) => j.inputs[0]).sort()).toEqual(tsFiles.map((f) => join(h.stageSub, f.split("/").pop()!)).sort());
    for (const j of sj) expect(String(j.params.sidecar)).toBe(join(h.stageSub, `${BASE}.session.json`));
    h.deps.ledger.close();
  });

  it("不阻塞 done:入队永不返回时 runPipeline 仍立即返回 done(上传路径不受影响)", async () => {
    const h = makeHarness({ outputFormat: "mkv" }, { hang: true });
    h.deps.ledger.upsertPending(STREAM_KEY);
    const r = await Promise.race([
      runPipeline(broadcast(tsFiles), h.deps),
      new Promise<"blocked">((res) => setTimeout(() => res("blocked"), 1500)),
    ]);
    expect(r).not.toBe("blocked");
    expect((r as { state: string }).state).toBe("done");
    expect(h.deps.ledger.get(STREAM_KEY)!.state).toBe("done");
    h.deps.ledger.close();
  });

  it("stage 模式(未 done,needs_manual)→ 不派发:处理中途从不转换", async () => {
    const h = makeHarness({ outputFormat: "mkv", uploadMode: "stage" });
    h.deps.ledger.upsertPending(STREAM_KEY);
    const r = await runPipeline(broadcast(tsFiles), h.deps);
    expect(r.state).toBe("needs_manual");
    await flush();
    expect(h.nodeEnqueue).not.toHaveBeenCalled();
    expect(h.stageEnqueue).not.toHaveBeenCalled();
    expect(h.deps.ledger.getFollowups(STREAM_KEY)).toBeNull();
    h.deps.ledger.close();
  });

  it("original / 未设格式 / 未注入 finalizeFormat → 完全不派发(行为同旧)", async () => {
    for (const [fmt, fin] of [["original", true], [undefined, true], ["mkv", false]] as const) {
      const h = makeHarness({ outputFormat: fmt }, { finalize: fin });
      h.deps.ledger.upsertPending(STREAM_KEY);
      const r = await runPipeline(broadcast(tsFiles), h.deps);
      expect(r.state).toBe("done");
      await flush();
      expect(h.nodeEnqueue).not.toHaveBeenCalled();
      expect(h.deps.ledger.getFollowups(STREAM_KEY)).toBeNull();
      h.deps.ledger.close();
    }
  });

  it("sourceAfterDone + stageAfterDone 全清理 → 不派发(无留存)", async () => {
    const h = makeHarness({ outputFormat: "mkv", cleanup: { sourceAfterDone: true, stageAfterDone: true } });
    h.deps.ledger.upsertPending(STREAM_KEY);
    await runPipeline(broadcast(tsFiles), h.deps);
    await flush();
    expect(h.nodeEnqueue).not.toHaveBeenCalled();
    expect(h.stageEnqueue).not.toHaveBeenCalled();
    h.deps.ledger.close();
  });

  it("节点不支持(旧 bundle)→ done 不变,followups 标注一次", async () => {
    const h = makeHarness({ outputFormat: "mkv", cleanup: { stageAfterDone: true } });
    const { ProcUnsupported } = await import("../../packages/orchestrator/src/transport.js");
    h.nodeEnqueue.mockRejectedValue(new ProcUnsupported());
    h.deps.ledger.upsertPending(STREAM_KEY);
    const r = await runPipeline(broadcast(tsFiles), h.deps);
    expect(r.state).toBe("done");
    await flush();
    expect(h.deps.ledger.get(STREAM_KEY)!.state).toBe("done");
    const fu = parseFollowups(h.deps.ledger.getFollowups(STREAM_KEY))!;
    expect(fu.notes.filter((n) => n.includes("不支持处理任务表"))).toHaveLength(1);
    h.deps.ledger.close();
  });

  it("分段路径(mergeSegments=false)同样在 done + 清理之后派发", async () => {
    const h = makeHarness({ outputFormat: "mkv", steps: { mergeSegments: false }, cleanup: { stageAfterDone: true } });
    Object.assign(h.deps, {
      remuxSegment: async (_s: string, out: string) => { mkdirSync(join(out, ".."), { recursive: true }); writeFileSync(out, "x"); },
      segmentDuration: async () => 60,
      burnSegment: async ({ out }: { out: string }) => { writeFileSync(out, "x"); },
    });
    h.deps.ledger.upsertPending(STREAM_KEY);
    const r = await runPipeline(broadcast(tsFiles), h.deps);
    expect(r.state).toBe("done");
    await flush();
    expect(h.nodeEnqueue).toHaveBeenCalledTimes(1);
    expect(h.seen[0].state).toBe("done");
    expect(h.seen[0].cleaned.stage).toBeGreaterThan(0);
    h.deps.ledger.close();
  });

  it("done 场收尾补跑重入 runPipeline → 不重复派发(每场一次)", async () => {
    const h = makeHarness({ outputFormat: "mkv", cleanup: { stageAfterDone: true } });
    h.deps.ledger.upsertPending(STREAM_KEY);
    await runPipeline(broadcast(tsFiles), h.deps);
    await flush();
    expect(h.nodeEnqueue).toHaveBeenCalledTimes(1);
    await runPipeline(broadcast(tsFiles), h.deps); // 已 done + 已有 bv:走续跑收尾分支
    await flush();
    expect(h.nodeEnqueue).toHaveBeenCalledTimes(1);
    h.deps.ledger.close();
  });
});
