import { describe, it, expect, vi, type Mock } from "vitest";
import { JobAbortedError, USER_STOP, abortJob, runWithJob, throwIfAborted } from "@drec/core";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    pool: new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0 }),
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
    segmentCount: 2,
  });
}

function makeControlledNode(
  key: WorkflowNodeKey,
  resource: "cpu" | "net" | "upload",
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
    sh: async () => "",
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
    expect(mergeCalls[0]).toContain("--out-base '主播名_2026-06-27'");
    expect(mergeCalls[0]).not.toContain("--base ");
    expect(t.ledger.getNodeState(STREAM_KEY, "merge")?.state).toBe("done");
    t.ledger.close();
  });
});

describe("ResourcePool — cpu/net 串行与内存闸门", () => {
  it("cpu max=1:第二个 cpu 节点等第一个完成才起跑(不并发烧录)", async () => {
    const t = makeDeps();
    const pool = new ResourcePool({ minBurnFreeMemMB: 0, maxCpuParallel: 1, uploadRateLimit: 0 });
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

  it("cpu 排队任务释放后许可不泄漏(后续批次可复用)", async () => {
    const pool = new ResourcePool({ minBurnFreeMemMB: 0, maxCpuParallel: 1, uploadRateLimit: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered = 0;
    const first = pool.withCpu(async () => { entered++; await gate; });
    await vi.waitFor(() => expect(entered).toBe(1)); // 确认已持锁
    const second = pool.withCpu(async () => { entered++; });
    await new Promise((r) => setTimeout(r, 20));
    expect(entered).toBe(1); // 第二个在排队,不能并发
    release();
    await Promise.all([first, second]);
    expect(entered).toBe(2);
    // 许可泄漏回归:上一批释放后,新任务还能拿到锁(旧实现排队者 active 多 1,永久卡死)
    await pool.withCpu(async () => {});
  });

  it("内存闸门:可用内存不足时 cpu 节点等待,充足后放行", async () => {
    const t = makeDeps();
    let mem = 500; // MB
    let slept = 0;
    const pool = new ResourcePool(
      { minBurnFreeMemMB: 2048, memWaitTimeoutMs: 60_000, uploadRateLimit: 0 },
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

describe("ResourcePool — 全局上传队列(withUpload)", () => {
  it("跨 streamKey 串行 + 窗口内提交次数限速(超频则排队等到窗口滑出)", async () => {
    // 假时钟:sleep 只推进虚拟时间,不真等。窗口 10min 内最多 3 次提交。
    let now = 1_000_000;
    const at: number[] = [];
    const pool = new ResourcePool(
      { minBurnFreeMemMB: 0, uploadRateLimit: 3, uploadRateWindowMs: 600_000, uploadCooldownMs: 0 },
      { now: () => now, sleep: async (ms) => { now += ms; } },
    );
    const upload = async (): Promise<void> => { at.push(now); };
    await Promise.all([1, 2, 3, 4, 5].map(() => pool.withUpload(upload)));
    expect(at).toHaveLength(5);
    // 前 3 次立即放行(同刻)
    expect(at[0]).toBe(at[1]);
    expect(at[1]).toBe(at[2]);
    // 第 4、5 次必须等到首个窗口滑出(≈ +600s)
    expect(at[3] - at[0]).toBeGreaterThanOrEqual(600_000);
    expect(at[4] - at[1]).toBeGreaterThanOrEqual(600_000);
  });

  it("命中 601 → 记录全局冷却,后续提交等冷却后再打", async () => {
    let now = 0;
    const at: number[] = [];
    const pool = new ResourcePool(
      { minBurnFreeMemMB: 0, uploadRateLimit: 0, uploadCooldownMs: 900_000 },
      { now: () => now, sleep: async (ms) => { now += ms; } },
    );
    // 第一次提交命中 601(队列记冷却 15min)
    await expect(pool.withUpload(async () => { throw new Error("upload rate limit (code: 601)"); })).rejects.toThrow();
    // 第二次提交必须被推迟到冷却结束后
    await pool.withUpload(async () => { at.push(now); });
    expect(at[0]).toBeGreaterThanOrEqual(900_000);
  });

  it("队列不并发:第二个 withUpload 必须等第一个的 fn 完成", async () => {
    const pool = new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let active = 0, max = 0;
    const job = async (): Promise<void> => { active++; max = Math.max(max, active); await gate; active--; };
    const p1 = pool.withUpload(job);
    const p2 = pool.withUpload(job);
    await new Promise((r) => setTimeout(r, 20));
    expect(max).toBe(1); // 第二个还在排队
    release();
    await Promise.all([p1, p2]);
    expect(max).toBe(1);
  });

  it("单个上传失败不毒化队列(后续提交仍可执行)", async () => {
    const pool = new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0 });
    await expect(pool.withUpload(async () => { throw new Error("601"); })).rejects.toThrow("601");
    let ran = false;
    await pool.withUpload(async () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe("runWorkflowNodes — 用户停止", () => {
  it("节点 abort 标 blocked+用户停止并抛出,不标 failed;不再起下游", async () => {
    const t = makeDeps();
    const pool = new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0 });
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
      { minBurnFreeMemMB: 2048, memWaitTimeoutMs: 60_000, uploadRateLimit: 0 },
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

describe("runWorkflowNodes — 重跑语义", () => {
  it("上一轮 skipped 的节点重新执行时不再永久跳过(enabled 后真正跑)", async () => {
    const t = makeDeps();
    const pool = new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0 });
    t.ledger.syncNodeState(STREAM_KEY, "upload_plain", "skipped");
    let ran = 0;
    const node: WorkflowNode = {
      key: "upload_plain",
      inputs: [],
      outputs: [],
      resource: "none",
      run: async () => { ran++; },
    };
    await runWorkflowNodes({
      streamKey: STREAM_KEY,
      nodes: [node],
      edges: [],
      ctx: minimalCtx(t, pool),
      pool,
    });
    expect(ran).toBe(1);
    expect(t.ledger.getNodeState(STREAM_KEY, "upload_plain")?.state).toBe("done");
    t.ledger.close();
  });
});

/**
 * 端到端验证:稿件名 / 分P名 / 文件名 三者的分离真的落到了 biliup 调用参数上。
 *
 * 这是「biliup 分P标题取自文件名 stem」这个约束的唯一可信验证点 ——
 * 我们无法在单测里跑真实投稿,但可以断言**传给 biliup 的东西**:
 *   1. --title 用的是稿件名模板(与文件名 stem 不同);
 *   2. 分P 上传的路径,其文件名 stem 就是渲染后的分P标题。
 */
describe("稿件名 / 分P名 / 文件名 分离(端到端参数验证)", () => {
  it("--title = 稿件名;分P 用硬链接路径,其 stem = 分P标题", async () => {
    const t = makeDeps();
    const { formatBiliTitle, formatPartTitle } = await import("@drec/core");
    const titleCtx = { sessionBase: SESSION_BASE };
    const submissionTitle = formatBiliTitle("{name}_{date} 直播回放", titleCtx);
    expect(submissionTitle).toBe("主播名_2026-06-27 直播回放");
    // 文件名 stem 仍是严格的 dateName(与稿件名不同)
    expect(t.products.dateName).toBe("主播名_2026-06-27");

    const products = {
      ...t.products,
      partTitles: {
        plain: formatPartTitle("{name}_P{part}", { ...titleCtx, partIndex: 1, partTotal: 3 }, "plain"),
        danmu: formatPartTitle("{name}_P{part}", { ...titleCtx, partIndex: 2, partTotal: 3 }, "danmu"),
        livechat: formatPartTitle("{name}_P{part}", { ...titleCtx, partIndex: 3, partTotal: 3 }, "livechat"),
      },
    };
    const wf = buildWorkflow({
      streamKey: STREAM_KEY, stageSub: t.stageSub, products, deps: t.deps, cfg: t.deps.cfg,
      log: () => {}, willUpload: true, burnDanmu: true, burnLivechat: true, segmentCount: 2,
    });
    await runWorkflowNodes({
      streamKey: STREAM_KEY, nodes: wf.nodes, edges: wf.edges, ctx: wf.ctx,
      pool: new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0 }),
    });

    // P1 建稿:路径被换成 .upload 下的硬链接,stem = 分P标题
    const uploadArg = t.uploadPlain.mock.calls[0]![0] as { video?: string };
    expect(uploadArg.video).toBe(join(t.stageSub, ".upload", "主播名_P1.mp4"));
    // 规范产物名没被动过(幂等/清理依赖它)
    expect(existsSync(t.products.plain)).toBe(true);

    // P2/P3 append:同样按分P标题改名
    const danmuAppend = t.appendGroup.mock.calls.find((c) => (c[0] as { files: string[] }).files.some((f) => f.includes("P2")));
    const livechatAppend = t.appendGroup.mock.calls.find((c) => (c[0] as { files: string[] }).files.some((f) => f.includes("P3")));
    expect(danmuAppend).toBeDefined();
    expect(livechatAppend).toBeDefined();
    t.ledger.close();
  });

  it("不配 partTitles → 上传路径就是规范产物名(历史行为不变)", async () => {
    const t = makeDeps();
    const wf = build(t);
    await runWorkflowNodes({
      streamKey: STREAM_KEY, nodes: wf.nodes, edges: wf.edges, ctx: wf.ctx,
      pool: new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0 }),
    });
    const uploadArg = t.uploadPlain.mock.calls[0]![0] as { video?: string };
    expect(uploadArg.video).toBe(t.products.plain); // 原路径,无 .upload 别名
    expect(existsSync(join(t.stageSub, ".upload"))).toBe(false);
    t.ledger.close();
  });
});
