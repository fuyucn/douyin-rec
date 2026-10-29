/**
 * plans/036 T9b:收尾后留存源分段转格式 —— 规划 / 派发 / 回执轮询。
 * 与 test/orchestrator/finalize-format-pipeline.test.ts(经 runPipeline 的接线)互补。
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnqueueRequest, EnqueueResponse, NotifyEvent, ProcessReceipt } from "@drec/core";
import { parseJobId } from "@drec/core";
import {
  dispatchSurvivorRemux, ENQUEUE_CHUNK, NO_EXECUTOR_WARN_MS, parseFollowups, planSurvivorRemux, pollFollowups, STAGE_TARGET,
  type StageProcChannel,
} from "./finalize-format.js";
import { SyncLedger } from "./ledger.js";
import { ProcUnsupported, type NodeRecording, type Transport } from "./transport.js";

const KEY = "douyin:room1:2026-06-27";
const BASE = "主播名_2026-06-27_08-00-00";
const REC = "/rec";
const side = `${REC}/${BASE}.session.json`;

function rec(over: Partial<NodeRecording> = {}): NodeRecording {
  return {
    roomSlug: "room1", platform: "douyin", sessionBase: BASE,
    tsFiles: [`${REC}/${BASE}_000.ts`, `${REC}/${BASE}_001.ts`], xmlPath: `${REC}/${BASE}.xml`, sessionJsonPath: side,
    durationSec: 100, startMs: 1, endMs: 2, totalGapSec: 0, ...over,
  };
}
const members = (r: NodeRecording = rec(), id = "node-1"): Array<{ workerId: string; rec: NodeRecording }> => [{ workerId: id, rec: r }];

function stageWith(files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "ff-stage-"));
  for (const f of files) writeFileSync(join(d, f), "x");
  return d;
}
const freshLedger = (): SyncLedger => {
  const l = new SyncLedger(join(mkdtempSync(join(tmpdir(), "ff-ledger-")), "t.db"));
  l.upsertPending(KEY);
  l.markDone(KEY, "BV1");
  return l;
};

const plan = (over: Partial<Parameters<typeof planSurvivorRemux>[0]> = {}) =>
  planSurvivorRemux({
    streamKey: KEY, outputFormat: "mkv", cleanup: {}, members: members(), stageSub: stageWith([]),
    stagePulled: true, hasStageProc: true, ...over,
  });

/** enqueue 假实现:默认逐条 pending,回填 `@tag` 为 `7-1`。 */
function fakeEnqueue(handler?: (req: EnqueueRequest, call: number) => EnqueueResponse) {
  let call = 0;
  return vi.fn(async (req: EnqueueRequest): Promise<EnqueueResponse> => {
    call += 1;
    if (handler) return handler(req, call);
    return { v: 1, results: req.jobs.map((j) => ({ jobId: j.jobId.replace(/@#g/, "@7-1#g"), state: "pending" as const })) };
  });
}
function node(id: string, enqueue = fakeEnqueue(), procStatus: Transport["procStatus"] = vi.fn(async () => [])): Transport {
  return { id, enqueue, procStatus } as unknown as Transport;
}
const noop = (): void => {};

describe("planSurvivorRemux:派什么", () => {
  it("原格式 / 未设 → 不派发", () => {
    expect(plan({ outputFormat: "original" }).jobs).toHaveLength(0);
    expect(plan({ outputFormat: undefined }).jobs).toHaveLength(0);
  });

  it("全清理(节点源删 + stage 清空)→ 不派发", () => {
    const stageSub = stageWith([`${BASE}_000.ts`, `${BASE}.session.json`]);
    const p = plan({ cleanup: { sourceAfterDone: true, stageAfterDone: true }, stageSub });
    expect(p.jobs).toHaveLength(0);
    expect(p.notes).toEqual([]);
  });

  it("节点源只删 → stage 副本仍派;stage 只清 scratch(stageSourceAfterMerge)→ 节点源仍派、stage 不派", () => {
    const stageSub = stageWith([`${BASE}_000.ts`, `${BASE}.session.json`]);
    const a = plan({ cleanup: { sourceAfterDone: true }, stageSub });
    expect(a.jobs.map((j) => j.target)).toEqual([STAGE_TARGET]);
    const b = plan({ cleanup: { stageSourceAfterMerge: true }, stageSub });
    expect(b.jobs.map((j) => j.target)).toEqual(["node-1", "node-1"]);
  });

  it("只转容器与所选格式不一致的源分段,不转三分 P / xml / 已是目标容器的文件", () => {
    const stageSub = stageWith([
      `${BASE}_000.ts`, `${BASE}.session.json`,
      "主播名_2026-06-27.mp4", "主播名_2026-06-27_danmu.mp4", "主播名_2026-06-27_livechat.mp4", // 三分 P 成品
      `${BASE}.xml`, "主播名_2026-06-27.ass",
    ]);
    const r = rec({ tsFiles: [`${REC}/${BASE}_000.ts`, `${REC}/${BASE}_001.mkv`, `${REC}/${BASE}_002.flv`, `${REC}/${BASE}.xml`] });
    const p = plan({ members: members(r), stageSub, outputFormat: "mkv" });
    const inputs = p.jobs.flatMap((j) => j.job.inputs).sort();
    expect(inputs).toEqual([`${REC}/${BASE}_000.ts`, `${REC}/${BASE}_002.flv`, join(stageSub, `${BASE}_000.ts`)].sort());
    for (const i of inputs) expect(/\.(ts|flv)$/.test(i)).toBe(true);
    // 目标容器按所选格式
    for (const { job } of p.jobs) expect(job.outputs![0].endsWith(".mkv")).toBe(true);
  });

  it("边车只在 params、绝不进 inputs;replaceInputs 只含视频;jobId 与字段自洽", () => {
    const stageSub = stageWith([`${BASE}_000.ts`, `${BASE}.session.json`]);
    const p = plan({ stageSub });
    expect(p.jobs.length).toBeGreaterThan(0);
    for (const { job } of p.jobs) {
      expect(job.inputs).toHaveLength(1);
      expect(job.inputs.some((i) => /\.session\.json$|\.xml$|\.ass$/.test(i))).toBe(false);
      expect(job.outputs!.some((i) => /\.session\.json$/.test(i))).toBe(false);
      expect(typeof job.params.sidecar).toBe("string");
      expect(String(job.params.sidecar)).toMatch(/\.session\.json$/);
      expect(job.replaceInputs).toBe(true);
      expect(job.params.format).toBe("mkv");
      expect(parseJobId(job.jobId)).toEqual({ kind: "remux", logicalKey: job.logicalKey, generation: 1 });
      expect(job.logicalKey.endsWith("@")).toBe(true); // 节点回填 fileTag
    }
  });

  it("stage 副本缺会话边车 → 跳过并标注(不派)", () => {
    const stageSub = stageWith([`${BASE}_000.ts`]); // 无 .session.json
    const p = plan({ stageSub, cleanup: { sourceAfterDone: true } });
    expect(p.jobs).toHaveLength(0);
    expect(p.notes.some((n) => n.includes("stage 副本缺会话边车"))).toBe(true);
  });

  it("节点源缺边车(inventory 无 sessionJsonPath)→ 该节点跳过并标注", () => {
    const p = plan({ members: members(rec({ sessionJsonPath: undefined })) });
    expect(p.jobs).toHaveLength(0);
    expect(p.notes.some((n) => n.includes("缺会话边车"))).toBe(true);
  });

  it("相对路径 / 边车位置与分段不同目录 → 跳过(不信任)", () => {
    expect(plan({ members: members(rec({ tsFiles: ["rel/a.ts"] })) }).jobs).toHaveLength(0);
    expect(plan({ members: members(rec({ sessionJsonPath: "/elsewhere/x.session.json" })) }).jobs).toHaveLength(0);
  });

  it("边车位置与分段不一致 → 跳过并标注(区别于缺失)", () => {
    const p = plan({ members: members(rec({ sessionJsonPath: "/elsewhere/x.session.json" })) });
    expect(p.jobs).toHaveLength(0);
    expect(p.notes.some((n) => n.includes("位置与分段不一致"))).toBe(true);
  });

  it("边录边传的成员不碰;节点侧上传(stagePulled=false)不派 stage 副本", () => {
    const stageSub = stageWith([`${BASE}_000.ts`, `${BASE}.session.json`]);
    expect(plan({ members: members(rec({ rolling: { bv: "BV9" } })), stageSub, cleanup: { stageAfterDone: false } }).jobs.filter((j) => j.target === "node-1")).toHaveLength(0);
    expect(plan({ stageSub, stagePulled: false }).jobs.some((j) => j.target === STAGE_TARGET)).toBe(false);
  });

  it("本机未注入通道 → stage 副本跳过并标注,节点源照派", () => {
    const stageSub = stageWith([`${BASE}_000.ts`, `${BASE}.session.json`]);
    const p = plan({ stageSub, hasStageProc: false });
    expect(p.jobs.every((j) => j.target === "node-1")).toBe(true);
    expect(p.notes.some((n) => n.includes("本机未注入"))).toBe(true);
  });

  it("多节点同名 stage 副本只算一份", () => {
    const stageSub = stageWith([`${BASE}_000.ts`, `${BASE}.session.json`]);
    const ms = [...members(rec(), "node-1"), ...members(rec(), "node-2")];
    const p = plan({ members: ms, stageSub });
    expect(p.jobs.filter((j) => j.target === STAGE_TARGET)).toHaveLength(1);
  });
});

describe("dispatchSurvivorRemux:派发与记账", () => {
  const run = async (o: {
    plan: ReturnType<typeof plan>; ledger?: SyncLedger; transports?: Map<string, Transport>; stageProc?: StageProcChannel;
  }) => {
    const ledger = o.ledger ?? freshLedger();
    const fu = await dispatchSurvivorRemux({
      streamKey: KEY, plan: o.plan, transports: o.transports ?? new Map(), stageProc: o.stageProc, ledger, log: noop,
    });
    return { ledger, fu };
  };

  it("节点源派到该节点、stage 副本派到本机;回执 jobId(含回填 tag)记入 followups,job 终态不变", async () => {
    const stageSub = stageWith([`${BASE}_000.ts`, `${BASE}.session.json`]);
    const nodeEnq = fakeEnqueue();
    const stageEnq = fakeEnqueue();
    const { ledger, fu } = await run({
      plan: plan({ stageSub }), transports: new Map([["node-1", node("node-1", nodeEnq)]]),
      stageProc: { enqueue: stageEnq, procStatus: async () => [] },
    });
    expect(nodeEnq).toHaveBeenCalledTimes(1);
    expect(stageEnq).toHaveBeenCalledTimes(1);
    expect(nodeEnq.mock.calls[0][0].jobs.every((j) => j.inputs[0].startsWith(REC))).toBe(true);
    expect(stageEnq.mock.calls[0][0].jobs.every((j) => j.inputs[0].startsWith(stageSub))).toBe(true);
    expect(fu!.items.map((i) => i.target).sort()).toEqual([STAGE_TARGET, "node-1", "node-1"]);
    expect(fu!.items.every((i) => i.jobId.includes("@7-1#g1"))).toBe(true);
    expect(parseFollowups(ledger.getFollowups(KEY))!.open).toBe(true);
    expect(ledger.get(KEY)!.state).toBe("done"); // 绝不动终态
  });

  it("每场只派发一次:第二次(done 场收尾补跑重入)不再入队", async () => {
    const enq = fakeEnqueue();
    const t = new Map([["node-1", node("node-1", enq)]]);
    const ledger = freshLedger();
    await run({ plan: plan(), ledger, transports: t });
    await run({ plan: plan(), ledger, transports: t });
    expect(enq).toHaveBeenCalledTimes(1);
  });

  it("旧节点(未知命令 → ProcUnsupported)→ done 不变、标注一次、不抛", async () => {
    const enq = vi.fn(async () => { throw new ProcUnsupported(); });
    const ledger = freshLedger();
    const t = new Map([["node-1", node("node-1", enq as never)]]);
    await run({ plan: plan(), ledger, transports: t });
    await run({ plan: plan(), ledger, transports: t });
    const fu = parseFollowups(ledger.getFollowups(KEY))!;
    expect(fu.items).toHaveLength(0);
    expect(fu.notes.filter((n) => n.includes("不支持处理任务表"))).toHaveLength(1);
    expect(enq).toHaveBeenCalledTimes(1);
    expect(ledger.get(KEY)!.state).toBe("done");
  });

  it("其它入队失败(不可达等)→ 标注、不抛、不改 job 终态;留在 open 集合并告警一次(MAJOR-3)", async () => {
    const enq = vi.fn(async () => { throw new Error("ssh rc=255"); });
    const events: NotifyEvent[] = [];
    const ledger = freshLedger();
    await dispatchSurvivorRemux({
      streamKey: KEY, plan: plan(), transports: new Map([["node-1", node("node-1", enq as never)]]), ledger, log: noop,
      notify: (e) => events.push(e),
    });
    const fu = parseFollowups(ledger.getFollowups(KEY))!;
    expect(fu.notes.some((n) => n.includes("入队失败") && n.includes("ssh rc=255"))).toBe(true);
    expect(fu.open).toBe(true);
    expect(fu.items).toHaveLength(2);
    expect(fu.items.every((i) => i.state === "enqueue-failed" && i.attempts === 1 && i.job)).toBe(true);
    expect(events).toHaveLength(1); // 每节点一次,不按段刷屏
    expect(events[0]).toMatchObject({ kind: "error", stage: "同步" });
    expect(ledger.get(KEY)!.state).toBe("done");
  });

  it("stale 回执 → 以 nextGeneration 重发恰一次;重发的 jobId/generation 用新代", async () => {
    const enq = fakeEnqueue((req, call) => call === 1
      ? { v: 1, results: req.jobs.map((j) => ({ jobId: j.jobId.replace(/@#g/, "@7-1#g"), state: "stale" as const, nextGeneration: 3 })) }
      : { v: 1, results: req.jobs.map((j) => ({ jobId: j.jobId.replace(/@#g/, "@7-1#g"), state: "pending" as const })) });
    const { fu } = await run({ plan: plan(), transports: new Map([["node-1", node("node-1", enq)]]) });
    expect(enq).toHaveBeenCalledTimes(2);
    for (const j of enq.mock.calls[1][0].jobs) {
      expect(j.generation).toBe(3);
      expect(parseJobId(j.jobId)!.generation).toBe(3);
    }
    expect(fu!.items.every((i) => i.generation === 3 && i.state === "pending")).toBe(true);
  });

  it("重发后仍 stale → 终结为 rejected 并标注,不再发(恰好 2 次入队)", async () => {
    const enq = fakeEnqueue((req) => ({ v: 1, results: req.jobs.map((j) => ({ jobId: j.jobId.replace(/@#g/, "@7-1#g"), state: "stale" as const, nextGeneration: 9 })) }));
    const { fu } = await run({ plan: plan(), transports: new Map([["node-1", node("node-1", enq)]]) });
    expect(enq).toHaveBeenCalledTimes(2);
    expect(fu!.items.every((i) => i.state === "rejected")).toBe(true);
  });

  it("rejected 只标注不重试", async () => {
    const enq = fakeEnqueue((req) => ({ v: 1, results: req.jobs.map((j) => ({ jobId: j.jobId, state: "rejected" as const, error: "路径不在 allowedRoots 内" })) }));
    const { fu } = await run({ plan: plan(), transports: new Map([["node-1", node("node-1", enq)]]) });
    expect(enq).toHaveBeenCalledTimes(1);
    expect(fu!.items.every((i) => i.state === "rejected")).toBe(true);
    expect(fu!.notes.some((n) => n.includes("拒绝转格式") && n.includes("allowedRoots"))).toBe(true);
  });

  it("分批:超过 ENQUEUE_CHUNK 的 job 拆成多次入队(base64 走 argv)", async () => {
    const many = Array.from({ length: ENQUEUE_CHUNK + 5 }, (_, i) => `${REC}/${BASE}_${String(i).padStart(3, "0")}.ts`);
    const enq = fakeEnqueue();
    await run({ plan: plan({ members: members(rec({ tsFiles: many })) }), transports: new Map([["node-1", node("node-1", enq)]]) });
    expect(enq).toHaveBeenCalledTimes(2);
    expect(enq.mock.calls[0][0].jobs).toHaveLength(ENQUEUE_CHUNK);
  });

  it("空计划也认领(不再反复重算);节点已不在 hub 配置 → 标注", async () => {
    const ledger = freshLedger();
    await run({ plan: plan({ outputFormat: "mkv", cleanup: { sourceAfterDone: true, stageAfterDone: true } }), ledger });
    expect(parseFollowups(ledger.getFollowups(KEY))).toEqual({ v: 1, open: false, items: [], notes: [] });
    const l2 = freshLedger();
    await run({ plan: plan(), ledger: l2, transports: new Map() });
    expect(parseFollowups(l2.getFollowups(KEY))!.notes.some((n) => n.includes("不在 hub 配置"))).toBe(false); // ProcUnsupported 路径文案
  });
});

describe("入队瞬时失败的退避重入队(MAJOR-3)", () => {
  const T0 = 5_000_000;
  async function seedFailed(enq: ReturnType<typeof vi.fn>, events: NotifyEvent[]) {
    const ledger = freshLedger();
    const ps = vi.fn(async (ids: string[]) => ids.map((jobId) => ({ jobId, state: "pending" as const, leaseAlive: true })));
    const t = node("node-1", enq as never, ps as never);
    const transports = new Map([["node-1", t]]);
    await dispatchSurvivorRemux({ streamKey: KEY, plan: plan(), transports, ledger, log: noop, notify: (e) => events.push(e), now: () => T0 });
    return { ledger, transports };
  }

  it("瞬时失败 → 到期重入队成功:转为 pending 项、不再告警;未到期不重试", async () => {
    let fail = true;
    const enq = vi.fn(async (req: EnqueueRequest): Promise<EnqueueResponse> => {
      if (fail) throw new Error("ssh timeout");
      return { v: 1, results: req.jobs.map((j) => ({ jobId: j.jobId.replace(/@#g/, "@7-1#g"), state: "pending" as const })) };
    });
    const events: NotifyEvent[] = [];
    const { ledger, transports } = await seedFailed(enq, events);
    expect(events).toHaveLength(1);
    await pollFollowups({ ledger, transports, notify: (e) => events.push(e), now: () => T0 + 1_000 }); // 未到 nextAt
    expect(enq).toHaveBeenCalledTimes(1);
    fail = false;
    await pollFollowups({ ledger, transports, notify: (e) => events.push(e), now: () => T0 + 30_000 });
    expect(enq).toHaveBeenCalledTimes(2);
    const fu = parseFollowups(ledger.getFollowups(KEY))!;
    expect(fu.items).toHaveLength(2);
    expect(fu.items.every((i) => i.state === "pending" && !i.job && i.jobId.includes("@7-1#g"))).toBe(true);
    expect(fu.open).toBe(true); // 等回执
    expect(events).toHaveLength(1); // 没有额外告警
    expect(ledger.get(KEY)!.state).toBe("done");
  });

  it("持续失败 → 首次告警一次,重试 3 次(指数退避)后再告警并关闭;不再重试", async () => {
    const enq = vi.fn(async () => { throw new Error("ssh timeout"); });
    const events: NotifyEvent[] = [];
    const { ledger, transports } = await seedFailed(enq, events);
    const poll = (now: number) => pollFollowups({ ledger, transports, notify: (e) => events.push(e), now: () => now });
    await poll(T0 + 30_000);            // 重试 1(退避 30s)→ 失败,下次 +60s
    await poll(T0 + 30_000 + 59_999);   // 未到期
    expect(enq).toHaveBeenCalledTimes(2);
    await poll(T0 + 30_000 + 60_000);   // 重试 2 → 下次 +120s
    await poll(T0 + 90_000 + 120_000);  // 重试 3 → 耗尽
    expect(enq).toHaveBeenCalledTimes(4);
    const fu = parseFollowups(ledger.getFollowups(KEY))!;
    expect(fu.open).toBe(false);
    expect(fu.items.every((i) => i.state === "failed" && !i.job)).toBe(true);
    expect(events).toHaveLength(2); // 首次失败 + 耗尽,各一条(每节点)
    expect(events[1].kind === "error" && events[1].message).toContain("已放弃");
    await poll(T0 + 10_000_000);
    expect(enq).toHaveBeenCalledTimes(4);
    expect(events).toHaveLength(2);
    expect(ledger.get(KEY)!.state).toBe("done");
  });

  it("重试时节点变成不支持(回滚)→ 终结为 rolled-back,不再重试、不告警", async () => {
    let n = 0;
    const enq = vi.fn(async () => { throw n++ === 0 ? new Error("ssh timeout") : new ProcUnsupported(); });
    const events: NotifyEvent[] = [];
    const { ledger, transports } = await seedFailed(enq, events);
    await pollFollowups({ ledger, transports, notify: (e) => events.push(e), now: () => T0 + 30_000 });
    const fu = parseFollowups(ledger.getFollowups(KEY))!;
    expect(fu.open).toBe(false);
    expect(fu.items.every((i) => i.state === "rolled-back")).toBe(true);
    expect(events).toHaveLength(1);
  });
});

describe("pollFollowups:对账轮询回执", () => {
  const T0 = 1_000_000;
  async function seed(procStatus: Transport["procStatus"]) {
    const ledger = freshLedger();
    const enq = fakeEnqueue();
    const t = node("node-1", enq, procStatus);
    const transports = new Map([["node-1", t]]);
    await dispatchSurvivorRemux({ streamKey: KEY, plan: plan(), transports, ledger, log: noop });
    return { ledger, transports, procStatus: t.procStatus as ReturnType<typeof vi.fn> };
  }
  const receipts = (ledger: SyncLedger, state: ProcessReceipt["state"], leaseAlive: boolean): ProcessReceipt[] =>
    parseFollowups(ledger.getFollowups(KEY))!.items.map((i) => ({ jobId: i.jobId, state, leaseAlive }));

  it("pending 且无存活执行者:首次只记起点;≥60s 才告警,且只告警一次;不回落、不重派", async () => {
    const ledger0 = freshLedger(); void ledger0;
    let st: ProcessReceipt["state"] = "pending";
    let ledgerRef!: SyncLedger;
    const ps = vi.fn(async () => receipts(ledgerRef, st, false));
    const s = await seed(ps as never);
    ledgerRef = s.ledger;
    const events: NotifyEvent[] = [];
    const poll = (now: number) => pollFollowups({ ledger: s.ledger, transports: s.transports, notify: (e) => events.push(e), now: () => now });
    await poll(T0);
    expect(events).toHaveLength(0);
    await poll(T0 + NO_EXECUTOR_WARN_MS - 1);
    expect(events).toHaveLength(0);
    await poll(T0 + NO_EXECUTOR_WARN_MS);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error", stage: "同步" });
    await poll(T0 + 10 * NO_EXECUTOR_WARN_MS);
    expect(events).toHaveLength(1); // 只一次
    expect((s.transports.get("node-1")!.enqueue as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1); // 不重派
    expect(s.ledger.get(KEY)!.state).toBe("done");
    st = "done"; // 执行者恢复后自然完成
    await poll(T0 + 11 * NO_EXECUTOR_WARN_MS);
    expect(parseFollowups(s.ledger.getFollowups(KEY))!.open).toBe(false);
  });

  it("60s 阈值钉死字面量(不随常量变):59.999s 不告警、60s 告警(R14)", async () => {
    expect(NO_EXECUTOR_WARN_MS).toBe(60_000);
    let ledgerRef!: SyncLedger;
    const ps = vi.fn(async () => receipts(ledgerRef, "pending", false));
    const s = await seed(ps as never);
    ledgerRef = s.ledger;
    const events: NotifyEvent[] = [];
    const poll = (now: number) => pollFollowups({ ledger: s.ledger, transports: s.transports, notify: (e) => events.push(e), now: () => now });
    await poll(T0);
    await poll(T0 + 59_999);
    expect(events).toHaveLength(0);
    await poll(T0 + 60_000);
    expect(events).toHaveLength(1);
  });

  it("执行者存活(leaseAlive)→ 清掉「无执行者」起点,之后再断也从头计时", async () => {
    let alive = false;
    let ledgerRef!: SyncLedger;
    const ps = vi.fn(async () => receipts(ledgerRef, "pending", alive));
    const s = await seed(ps as never);
    ledgerRef = s.ledger;
    const events: NotifyEvent[] = [];
    const poll = (now: number) => pollFollowups({ ledger: s.ledger, transports: s.transports, notify: (e) => events.push(e), now: () => now });
    await poll(T0);
    alive = true; await poll(T0 + 30_000);
    alive = false; await poll(T0 + 70_000); // 距清零后首次 < 60s
    expect(events).toHaveLength(0);
  });

  it("节点回滚(_proc-status 未知命令 → ProcUnsupported):标注、停止轮询、job 状态不变、不进 needs_manual", async () => {
    const ps = vi.fn(async () => { throw new ProcUnsupported(); });
    const s = await seed(ps as never);
    const events: NotifyEvent[] = [];
    const poll = () => pollFollowups({ ledger: s.ledger, transports: s.transports, notify: (e) => events.push(e), now: () => T0 });
    await poll();
    await poll();
    await poll();
    expect(ps).toHaveBeenCalledTimes(1); // 停止轮询
    const fu = parseFollowups(s.ledger.getFollowups(KEY))!;
    expect(fu.open).toBe(false);
    expect(fu.items.every((i) => i.state === "rolled-back")).toBe(true);
    expect(fu.notes.filter((n) => n.includes("已回滚,留存转格式未执行"))).toHaveLength(1);
    expect(s.ledger.get(KEY)!.state).toBe("done");
    expect(events).toHaveLength(0);
  });

  it("未知 jobId 缺席 → 终结为 missing 并标注(不告警、不重派)", async () => {
    const ps = vi.fn(async () => []);
    const s = await seed(ps as never);
    await pollFollowups({ ledger: s.ledger, transports: s.transports, now: () => T0 });
    const fu = parseFollowups(s.ledger.getFollowups(KEY))!;
    expect(fu.items.every((i) => i.state === "missing")).toBe(true);
    expect(fu.notes.some((n) => n.includes("回执缺席"))).toBe(true);
    expect(fu.open).toBe(false);
  });

  it("节点任务 failed / uncertain → 终结并标注(节点 runner 已自行告警),job 状态不变", async () => {
    let ledgerRef!: SyncLedger;
    const ps = vi.fn(async () => receipts(ledgerRef, "failed", true).map((r) => ({ ...r, error: "校验失败" })));
    const s = await seed(ps as never);
    ledgerRef = s.ledger;
    const events: NotifyEvent[] = [];
    await pollFollowups({ ledger: s.ledger, transports: s.transports, notify: (e) => events.push(e), now: () => T0 });
    const fu = parseFollowups(s.ledger.getFollowups(KEY))!;
    expect(fu.items.every((i) => i.state === "failed")).toBe(true);
    expect(fu.notes.some((n) => n.includes("校验失败"))).toBe(true);
    expect(events).toHaveLength(1); // 每目标一条,不按段刷屏;不静默
    expect(s.ledger.get(KEY)!.state).toBe("done");
  });

  it("暂时不可达 → 本轮跳过、仍开放,下轮继续", async () => {
    let fail = true;
    let ledgerRef!: SyncLedger;
    const ps = vi.fn(async () => { if (fail) throw new Error("ssh rc=255"); return receipts(ledgerRef, "done", true); });
    const s = await seed(ps as never);
    ledgerRef = s.ledger;
    await pollFollowups({ ledger: s.ledger, transports: s.transports, now: () => T0 });
    expect(parseFollowups(s.ledger.getFollowups(KEY))!.open).toBe(true);
    fail = false;
    await pollFollowups({ ledger: s.ledger, transports: s.transports, now: () => T0 });
    expect(parseFollowups(s.ledger.getFollowups(KEY))!.open).toBe(false);
  });

  it("已全部终结的场不再被轮询(open=false 不进 listOpenFollowups)", async () => {
    let ledgerRef!: SyncLedger;
    const ps = vi.fn(async () => receipts(ledgerRef, "done", true));
    const s = await seed(ps as never);
    ledgerRef = s.ledger;
    await pollFollowups({ ledger: s.ledger, transports: s.transports, now: () => T0 });
    await pollFollowups({ ledger: s.ledger, transports: s.transports, now: () => T0 });
    expect(ps).toHaveBeenCalledTimes(1);
    expect(s.ledger.listOpenFollowups()).toHaveLength(0);
  });

  it("stage 目标走本机通道回执", async () => {
    const stageSub = stageWith([`${BASE}_000.ts`, `${BASE}.session.json`]);
    const ledger = freshLedger();
    const stageProcStatus = vi.fn(async (ids: string[]): Promise<ProcessReceipt[]> => ids.map((jobId) => ({ jobId, state: "done" as const, leaseAlive: true })));
    const stageProc: StageProcChannel = { enqueue: fakeEnqueue(), procStatus: stageProcStatus };
    await dispatchSurvivorRemux({ streamKey: KEY, plan: plan({ stageSub, cleanup: { sourceAfterDone: true } }), transports: new Map(), stageProc, ledger, log: noop });
    await pollFollowups({ ledger, transports: new Map(), stageProc, now: () => T0 });
    expect(stageProcStatus).toHaveBeenCalledTimes(1);
    expect(parseFollowups(ledger.getFollowups(KEY))!.open).toBe(false);
  });
});

describe("SyncLedger.followups 列:迁移与闸门", () => {
  it("旧库(无 followups 列)打开后自动补列,老行读为 null;claim 只成功一次;不改 updatedAt", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const p = join(mkdtempSync(join(tmpdir(), "ff-old-")), "old.db");
    const old = new DatabaseSync(p);
    old.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL, winnerTenant TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
    old.prepare("INSERT INTO sync_jobs(streamKey,state,updatedAt) VALUES(?,?,?)").run("old:key:1", "done", 123);
    old.close();
    const l = new SyncLedger(p);
    expect(l.getFollowups("old:key:1")).toBeNull();
    expect(l.get("old:key:1")!.followups ?? null).toBeNull();
    expect(l.claimFollowups("old:key:1", '{"v":1}')).toBe(true);
    expect(l.claimFollowups("old:key:1", '{"v":2}')).toBe(false);
    expect(l.getFollowups("old:key:1")).toBe('{"v":1}');
    l.setFollowups("old:key:1", '{"v":1,"open":true,"items":[],"notes":[]}');
    expect(l.get("old:key:1")!.updatedAt).toBe(123);
    expect(l.listOpenFollowups().map((r) => r.streamKey)).toEqual(["old:key:1"]);
    // 新库再开一次(列已存在)不报错
    l.close();
    expect(() => new SyncLedger(p).close()).not.toThrow();
  });

  it("无此 job 时 claim / set 无副作用", () => {
    const l = new SyncLedger(join(mkdtempSync(join(tmpdir(), "ff-none-")), "t.db"));
    expect(l.claimFollowups("nope", "x")).toBe(false);
    l.setFollowups("nope", "x");
    expect(l.getFollowups("nope")).toBeNull();
    expect(existsSync(tmpdir())).toBe(true);
    mkdirSync(tmpdir(), { recursive: true });
  });
});
