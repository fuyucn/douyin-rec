import { describe, it, expect, vi, type Mock } from "vitest";
import { JobAbortedError, USER_STOP, abortJob, runWithJob, throwIfAborted } from "@drec/core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkflow,
  runWorkflowNodes,
  ResourcePool,
  type NodeRunContext,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeKey,
} from "./workflow.js";
import { SyncLedger } from "./ledger.js";
import type { PipelineDeps } from "./pipeline.js";

const STREAM_KEY = "douyin:test-room:2026-06-27";
const DATE_NAME = "主播名_2026-06-27";
const SESSION_BASE = `${DATE_NAME}_08-00-00`;

function freshLedger(): SyncLedger {
  return new SyncLedger(join(mkdtempSync(join(tmpdir(), "workflow-test-")), "test.db"));
}

interface TestDeps {
  deps: PipelineDeps;
  ledger: SyncLedger;
  stageDir: string;
  stageSub: string;
  products: {
    dateName: string;
    sessionBase: string;
    sessionBases: string[];
    plain: string;
    danmuMp4: string;
    livechatMp4: string;
    plainXml: string;
    xmlArg: string;
  };
  sh: Mock<(cmd: string) => Promise<void>>;
  uploadPlain: Mock<(plain: { video?: string; public?: boolean }) => Promise<string>>;
  appendGroup: Mock<(o: { bv: string; files: string[]; cookies: string; public: boolean }) => Promise<void>>;
}

function makeDeps(overrides: Partial<PipelineDeps> = {}): TestDeps {
  const ledger = freshLedger();
  const stageDir = mkdtempSync(join(tmpdir(), "workflow-stage-"));
  const stageSub = join(stageDir, "douyin_test-room_2026-06-27");
  mkdirSync(stageSub, { recursive: true });
  writeFileSync(join(stageSub, "src.ts"), "x");
  writeFileSync(join(stageSub, "danmu.xml"), "x");
  const products = {
    dateName: DATE_NAME,
    sessionBase: SESSION_BASE,
    sessionBases: [SESSION_BASE],
    plain: join(stageSub, `${DATE_NAME}.mp4`),
    danmuMp4: join(stageSub, `${DATE_NAME}_danmu.mp4`),
    livechatMp4: join(stageSub, `${DATE_NAME}_livechat.mp4`),
    plainXml: join(stageSub, `${DATE_NAME}.xml`),
    xmlArg: join(stageSub, "danmu.xml"),
  };
  const sh = vi.fn<(cmd: string) => Promise<void>>().mockImplementation(async (cmd: string) => {
    if (cmd.includes(" merge ")) {
      writeFileSync(products.plain, "x");
      writeFileSync(products.plainXml, "x");
    } else if (cmd.includes("--style danmu")) {
      writeFileSync(products.danmuMp4, "x");
    } else if (cmd.includes("--style livechat")) {
      writeFileSync(products.livechatMp4, "x");
    }
  });
  const uploadPlain = vi.fn(async () => "BV123");
  const appendGroup = vi.fn(async () => {});
  const cfg = {
    cleanMaxGapSec: 30,
    stageDir,
    cookies: "/tmp/cookies.json",
    uploadMode: "upload" as const,
    uploadMeta: { tag: "直播录像", tid: 21, desc: "直播录像" },
  };
  const deps: PipelineDeps = {
    transports: new Map(),
    ledger,
    sh,
    uploadPlain,
    appendGroup,
    pool: new ResourcePool({ minBurnFreeMemMB: 0 }),
    splitForUpload: async (mp4: string) => [mp4],
    notify: vi.fn(),
    cfg,
    ...overrides,
  };
  return { deps, ledger, stageDir, stageSub, products, sh, uploadPlain, appendGroup };
}

function build(t: TestDeps, opts: { burnDanmu?: boolean; burnLivechat?: boolean; willUpload?: boolean } = {}): Workflow {
  return buildWorkflow({
    streamKey: STREAM_KEY,
    stageSub: t.stageSub,
    products: t.products,
    deps: t.deps,
    cfg: t.deps.cfg,
    log: () => {},
    willUpload: opts.willUpload ?? true,
    burnDanmu: opts.burnDanmu ?? true,
    burnLivechat: opts.burnLivechat ?? true,
    mergeSegments: 2,
  });
}

function makeControlledNode(
  key: WorkflowNodeKey,
  resource: "cpu" | "net",
  events: Array<{ key: string; at: "start" | "end"; ts: number }>,
  active: { n: number; max: number },
): WorkflowNode {
  return {
    key,
    inputs: [],
    outputs: [],
    resource,
    run: async () => {
      events.push({ key, at: "start", ts: Date.now() });
      active.n++;
      active.max = Math.max(active.max, active.n);
      await new Promise<void>((r) => setTimeout(r, 10));
      active.n--;
      events.push({ key, at: "end", ts: Date.now() });
    },
  };
}

function minimalCtx(t: TestDeps, pool: ResourcePool): NodeRunContext {
  return {
    streamKey: STREAM_KEY,
    stageSub: t.stageSub,
    products: t.products,
    ledger: t.ledger,
    deps: t.deps,
    cfg: t.deps.cfg,
    log: () => {},
    sh: async () => {},
    get: () => undefined,
    set: () => {},
    stepDetail: () => undefined,
  };
}

describe("runWorkflowNodes — 安全阀与分支隔离", () => {
  it("P1 上传失败 → 兄弟 burn 轨照常完成;append 被 blocked 不悬挂", async () => {
    const t = makeDeps();
    t.uploadPlain.mockRejectedValue(new Error("network down"));
    const workflow = build(t);

    const r = await runWorkflowNodes({
      streamKey: STREAM_KEY,
      nodes: workflow.nodes,
      edges: workflow.edges,
      ctx: workflow.ctx,
      pool: t.deps.pool!,
    });

    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(["upload_plain"]);
    expect(r.blocked.sort()).toEqual(["append_danmu", "append_livechat"]);
    // 兄弟 burn 轨没有被 P1 失败取消
    const shCalls = t.sh.mock.calls.map((c) => c[0] as string);
    expect(shCalls.some((c) => c.includes("--style danmu"))).toBe(true);
    expect(shCalls.some((c) => c.includes("--style livechat"))).toBe(true);
    expect(t.uploadPlain).toHaveBeenCalledTimes(1);
    expect(t.appendGroup).not.toHaveBeenCalled();
    expect(t.ledger.getNodeState(STREAM_KEY, "merge")?.state).toBe("done");
    expect(t.ledger.getNodeState(STREAM_KEY, "burn_danmu")?.state).toBe("done");
    expect(t.ledger.getNodeState(STREAM_KEY, "burn_livechat")?.state).toBe("done");
    expect(t.ledger.getNodeState(STREAM_KEY, "upload_plain")?.state).toBe("failed");
    expect(t.ledger.getNodeState(STREAM_KEY, "append_danmu")?.state).toBe("blocked");
    t.ledger.close();
  });

  it("forceRetry 单节点续跑:merge/burn 幂等跳过,只重传 P1,blocked append 自动恢复且 P2→P3 串行", async () => {
    const t = makeDeps();
    t.uploadPlain.mockRejectedValueOnce(new Error("network down"));
    const workflow = build(t);
    const r1 = await runWorkflowNodes({
      streamKey: STREAM_KEY,
      nodes: workflow.nodes,
      edges: workflow.edges,
      ctx: workflow.ctx,
      pool: t.deps.pool!,
    });
    expect(r1.failed).toEqual(["upload_plain"]);

    // 第二次:只 force upload_plain;merge/burn 已 done → 绝不再跑
    const r2 = await runWorkflowNodes({
      streamKey: STREAM_KEY,
      nodes: workflow.nodes,
      edges: workflow.edges,
      ctx: workflow.ctx,
      pool: t.deps.pool!,
      forceRetry: new Set<WorkflowNodeKey>(["upload_plain"]),
    });
    expect(r2.ok).toBe(true);
    expect(r2.failed).toEqual([]);
    expect(r2.blocked).toEqual([]);
    expect(t.uploadPlain).toHaveBeenCalledTimes(2); // 失败 1 次 + 重跑 1 次
    const shCalls = t.sh.mock.calls.map((c) => c[0] as string);
    expect(shCalls.filter((c) => c.includes(" merge "))).toHaveLength(1); // merge 不重跑
    expect(shCalls.filter((c) => c.includes("--style danmu"))).toHaveLength(1);
    expect(shCalls.filter((c) => c.includes("--style livechat"))).toHaveLength(1);
    const appended = t.appendGroup.mock.calls.map((c) => c[0].files[0] as string);
    expect(appended).toHaveLength(2);
    expect(appended[0]).toContain("_danmu");
    expect(appended[1]).toContain("_livechat");
    for (const k of ["merge", "burn_danmu", "burn_livechat", "upload_plain", "append_danmu", "append_livechat"] as const) {
      expect(t.ledger.getNodeState(STREAM_KEY, k)?.state).toBe("done");
    }
    t.ledger.close();
  });
});

describe("buildWorkflow — 断流重连多会话合并", () => {
  it("sessionBases > 1 → merge 用 --merge-sessions,产出合并 plain.xml", async () => {
    const t = makeDeps();
    t.products.sessionBases = [SESSION_BASE, `${DATE_NAME}_08-02-00`];
    const workflow = build(t);

    const r = await runWorkflowNodes({
      streamKey: STREAM_KEY,
      nodes: workflow.nodes,
      edges: workflow.edges,
      ctx: workflow.ctx,
      pool: t.deps.pool!,
    });

    expect(r.ok).toBe(true);
    const mergeCalls = t.sh.mock.calls.map((c) => c[0] as string).filter((cmd) => cmd.includes(" merge "));
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]).toContain("--merge-sessions");
    expect(mergeCalls[0]).not.toContain("--base ");
    expect(t.ledger.getNodeState(STREAM_KEY, "merge")?.state).toBe("done");
    t.ledger.close();
  });
});

describe("ResourcePool — cpu/net 串行与内存闸门", () => {
  it("cpu max=1:第二个 cpu 节点等第一个完成才起跑(不并发烧录)", async () => {
    const t = makeDeps();
    const pool = new ResourcePool({ minBurnFreeMemMB: 0, maxCpuParallel: 1 });
    const events: Array<{ key: string; at: "start" | "end"; ts: number }> = [];
    const active = { n: 0, max: 0 };
    const nodes = [
      makeControlledNode("merge", "cpu", events, active),
      makeControlledNode("burn_danmu", "cpu", events, active),
    ];

    await runWorkflowNodes({
      streamKey: STREAM_KEY,
      nodes,
      edges: [["merge", "burn_danmu"]],
      ctx: minimalCtx(t, pool),
      pool,
    });
    expect(active.max).toBe(1); // 绝无两个 cpu 节点同时执行
    expect(events.map((e) => `${e.key}:${e.at}`)).toEqual(["merge:start", "merge:end", "burn_danmu:start", "burn_danmu:end"]);
    t.ledger.close();
  });

  it("内存闸门:可用内存不足时 cpu 节点等待,充足后放行", async () => {
    const t = makeDeps();
    let mem = 500; // MB
    let slept = 0;
    const pool = new ResourcePool(
      { minBurnFreeMemMB: 2048, memWaitTimeoutMs: 60_000 },
      {
        sleep: async (ms) => { slept += ms; mem = 4096; },
        freeMemMB: () => mem,
      },
    );
    const events: Array<{ key: string; at: "start" | "end"; ts: number }> = [];
    const active = { n: 0, max: 0 };
    const nodes = [
      makeControlledNode("merge", "cpu", events, active),
      makeControlledNode("burn_danmu", "cpu", events, active),
    ];

    await runWorkflowNodes({
      streamKey: STREAM_KEY,
      nodes,
      edges: [["merge", "burn_danmu"]],
      ctx: minimalCtx(t, pool),
      pool,
    });
    expect(slept).toBeGreaterThan(0); // 等过内存
    expect(active.max).toBe(1);
    t.ledger.close();
  });
});

describe("runWorkflowNodes — 用户停止", () => {
  it("节点 abort 标 blocked+用户停止并抛出,不标 failed;不再起下游", async () => {
    const t = makeDeps();
    const pool = new ResourcePool({ minBurnFreeMemMB: 0 });
    const started: string[] = [];
    const merge: WorkflowNode = {
      key: "merge",
      inputs: [],
      outputs: [],
      resource: "none",
      run: async () => {
        started.push("merge");
        abortJob(STREAM_KEY);
        throwIfAborted();
      },
    };
    const burn: WorkflowNode = {
      key: "burn_danmu",
      inputs: [],
      outputs: [],
      resource: "none",
      run: async () => { started.push("burn"); },
    };
    await expect(runWithJob(STREAM_KEY, () => runWorkflowNodes({
      streamKey: STREAM_KEY,
      nodes: [merge, burn],
      edges: [["merge", "burn_danmu"]],
      ctx: minimalCtx(t, pool),
      pool,
    }))).rejects.toBeInstanceOf(JobAbortedError);
    expect(started).toEqual(["merge"]);
    expect(t.ledger.getNodeState(STREAM_KEY, "merge")?.state).toBe("blocked");
    expect(t.ledger.getNodeState(STREAM_KEY, "merge")?.error).toBe(USER_STOP);
    t.ledger.close();
  });

  it("内存闸门等待中 abort → 立刻抛,不标 failed", async () => {
    const t = makeDeps();
    const pool = new ResourcePool(
      { minBurnFreeMemMB: 2048, memWaitTimeoutMs: 60_000 },
      { sleep: async () => { abortJob(STREAM_KEY); }, freeMemMB: () => 100 },
    );
    const node: WorkflowNode = {
      key: "merge", inputs: [], outputs: [], resource: "cpu",
      run: async () => { throw new Error("should not run"); },
    };
    await expect(runWithJob(STREAM_KEY, () => runWorkflowNodes({
      streamKey: STREAM_KEY,
      nodes: [node],
      edges: [],
      ctx: minimalCtx(t, pool),
      pool,
    }))).rejects.toBeInstanceOf(JobAbortedError);
    expect(t.ledger.getNodeState(STREAM_KEY, "merge")?.state).toBe("blocked");
    expect(t.ledger.getNodeState(STREAM_KEY, "merge")?.error).toBe(USER_STOP);
    t.ledger.close();
  });
});
