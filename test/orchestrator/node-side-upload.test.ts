/**
 * node-side-upload.test.ts — 节点侧上传下发的 spec 必须带**完整渲染上下文**。
 *
 * 回归背景(自审发现的静默缺陷):`NodeSideUploadArgs.earliest` 曾被声明为
 * `{ rec: { n?: string; ... } }` 并读 `o.earliest?.rec.n`,但真实字段是
 * `NodeRecording.sessionBase`。因为 `n?` 是可选的,`undefined` 不报错 →
 * `sessionBase` 永远不下发 → 节点侧退回「用文件名推 base」渲染 `{title}` / `{HH}-{mm}-{ss}`,
 * 与 master 常规路径的稿件标题产生漂移。故这里把三个渲染字段钉死。
 */
import { describe, it, expect, vi } from "vitest";
import { tryNodeSideUpload, errBrief, estimateNodeUploadTimeoutMs, sumUploadBytes, NODE_UPLOAD_MIN_TIMEOUT_MS, NODE_UPLOAD_MAX_TIMEOUT_MS } from "../../packages/orchestrator/src/node-side-upload.js";
import type { PipelineCfg } from "../../packages/orchestrator/src/pipeline.js";

const cfg = {
  stageDir: "/stage",
  uploadMode: "upload",
  steps: { nodeSideUpload: true },
  uploadMeta: { titleTemplate: "{title}_{date}", submissionTitleTemplate: "{title}_{date}" },
} as unknown as PipelineCfg;

/** 最小 ledger 替身:本用例只关心「下发什么」,不关心状态机。 */
function fakeLedger() {
  return {
    get: () => ({ bv: "" }),
    getUploadPlan: () => null,
    logStep: vi.fn(),
    setState: vi.fn(),
    syncNodeState: vi.fn(),
    getNodeState: vi.fn(() => null),
    markFailed: vi.fn(),
    markDone: vi.fn(),
  } as never;
}

function fakeTransport() {
  return {
    nodeCapabilities: async () => ({ biliup: "/usr/local/bin/biliup", cookies: true, diskFreeGB: 100 }),
    nodePipeline: vi.fn(async (spec: unknown) => {
      captured = spec as Record<string, unknown>;
      return { ok: true, bv: "BV1TEST" };
    }),
    cleanup: vi.fn(async () => {}),
  };
}

let captured: Record<string, unknown> | undefined;

/** deps 只需要 transports(收尾删源走 cleanupSourcesShared)+ 可选 rmStage。 */
function fakeDeps(transport: { id?: string }, rmStage = vi.fn(async () => {})): never {
  return { transports: new Map([[transport.id ?? "w1", transport]]), rmStage } as never;
}

describe("tryNodeSideUpload 下发 spec", () => {
  it("sessionBase / liveTitle / startMs 来自 earliest.rec(节点侧渲染与 master 同源)", async () => {
    captured = undefined;
    const t = fakeTransport();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg,
      winner: { workerId: "w1", rec: { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" } },
      winnerMembers: [{ workerId: "w1", rec: { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" } }],
      transport: t as never,
      ledger: fakeLedger(),
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
      earliest: { rec: { sessionBase: "Lilt_2026-10-12_05-18-36", startMs: 1750000000000, title: "开播啦" } },
      broadcastStartMs: 1749999999999,
    });

    expect(result).toEqual({ state: "done", bv: "BV1TEST" });
    expect(captured.sessionBase).toBe("Lilt_2026-10-12_05-18-36");
    expect(captured.liveTitle).toBe("开播啦");
    expect(captured.startMs).toBe(1750000000000);
    // 上传三件套必须随 spec 下发,否则节点侧会以默认(公开/带水印)上传。
    expect(captured.uploadMode).toBe("upload");
    expect(captured.xmlPath).toBe("/r/a.xml");
  });

  it("earliest 缺失 → startMs 回落 broadcastStartMs,sessionBase 留空(节点侧自推)", async () => {
    captured = undefined;
    const t = fakeTransport();
    await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg,
      winner: { workerId: "w1", rec: { tsFiles: ["/r/a.ts"] } },
      winnerMembers: [{ workerId: "w1", rec: { tsFiles: ["/r/a.ts"] } }],
      transport: t as never,
      ledger: fakeLedger(),
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
      broadcastStartMs: 1749999999999,
    });
    expect(captured.sessionBase).toBeUndefined();
    expect(captured.startMs).toBe(1749999999999);
  });
});

/**
 * 节点侧上传**提前 return**,master 常规路径的 `cleanupSources()` 根本走不到 ⇒ 节点上的
 * 原始 .ts 永远没人删(线上实测泄漏:VPS2 `recordings/Lilt` 的源段一直留着)。
 * 故收尾必须在 node-side-upload 自己补一次,且必须与 master **共用同一删源实现**。
 */
describe("tryNodeSideUpload 收尾删源(与 master 共用 cleanupSourcesShared)", () => {
  const rec = { tsFiles: ["/r/a.ts", "/r/b.ts"], xmlPath: "/r/a.xml" };
  const baseCfg = {
    ...cfg,
    cleanup: { sourceAfterDone: true, stageAfterDone: true },
  } as unknown as PipelineCfg;

  it("成功 → 删 winner 节点的源 .ts;stageAfterDone=true → .xml 保留(最后一份)", async () => {
    const t = fakeTransport();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: baseCfg,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: fakeLedger(),
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(result).toEqual({ state: "done", bv: "BV1TEST" });
    expect(t.cleanup).toHaveBeenCalledTimes(1);
    const paths = t.cleanup.mock.calls[0]![0] as string[];
    expect(paths).toEqual(["/r/a.ts", "/r/b.ts"]);
    // 关键:.xml 绝不能出现在删除清单里(节点源 xml 是最后一份)。
    expect(paths).not.toContain("/r/a.xml");
  });

  it("stageAfterDone=false → 节点源 .xml **仍然保留**(节点侧从不把 xml 复制进 stage,它恒为最后一份)", async () => {
    // 常规路径的 xmlKeepRule("node", false)=true 成立的前提是「stage 里有 pull 来的 xml 副本」;
    // 节点侧没有 pull ⇒ 照搬该规则会删掉唯一副本 = 弹幕永久丢失。
    const t = fakeTransport();
    await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: { ...cfg, cleanup: { sourceAfterDone: true, stageAfterDone: false } } as unknown as PipelineCfg,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: fakeLedger(),
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    const paths = t.cleanup.mock.calls[0]![0] as string[];
    expect(paths).toEqual(["/r/a.ts", "/r/b.ts"]);
    expect(paths).not.toContain("/r/a.xml");
  });

  it("sourceAfterDone 关(默认)→ 一个文件都不删", async () => {
    const t = fakeTransport();
    await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: { ...cfg, cleanup: { stageAfterDone: true } } as unknown as PipelineCfg,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: fakeLedger(),
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(t.cleanup).not.toHaveBeenCalled();
  });
});

/**
 * 「假失败」修复(自审发现的线上缺陷):`_node-pipeline` 是**长命令**,ssh 可能在节点跑完
 * 上传之后才断开/超时(实测 `rc=255`、`rc=1`),而此时节点上的稿件**其实已经建好**
 * (private + 多分 P)。旧实现只在 catch / `!result.ok` 里无条件 `markFailed` →
 *   ① master 记 needs_manual/failed(UI 与台账误报);
 *   ② 收尾删源**永不执行** ⇒ 落败节点与 winner 的源 .ts 永久泄漏(实测 VPS1 Lilt 4 个 .ts 残留)。
 * 修复:失败路径统一收口 `handleNodeFailure` —— 先**回读节点落盘结果文件**(权威),
 * 只有确实没成才按失败处理;已成功则收口 done + 走与成功路径同一份 cleanupSourcesShared。
 *
 * 这里把四种回读结果钉死,防止将来又把「ssh 非零 = 失败」写回去。
 */
describe("tryNodeSideUpload 失败收口(回读节点落盘结果,区分假失败)", () => {
  const rec = { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" };
  const cfgUpload = { ...cfg, cleanup: { sourceAfterDone: true, stageAfterDone: true } } as unknown as PipelineCfg;

  /** 节点侧命令抛错(ssh 断线),但落盘结果文件为 `nodeResult`。 */
  function sshFailTransport(nodeResult: unknown, cleanup = vi.fn(async () => {})) {
    return {
      nodeCapabilities: async () => ({ biliup: "/biliup", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => { throw new Error("ssh: remote command exited with rc=255"); }),
      nodeResult: vi.fn(async () => nodeResult),
      cleanup,
    };
  }

  function fakeLedgerSpy() {
    return {
      get: () => ({ bv: "" }),
      getUploadPlan: () => null,
      logStep: vi.fn(),
      setState: vi.fn(),
      syncNodeState: vi.fn(),
      getNodeState: vi.fn(() => null),
      markFailed: vi.fn(),
      markDone: vi.fn(),
      setBv: vi.fn(),
    };
  }

  it("ssh rc≠0 但节点落盘 done+bv → 收口 done(不 markFailed)+ 执行删源", async () => {
    const t = sshFailTransport({ phase: "done", ok: true, bv: "BV1REAL", atMs: 1 });
    const ledger = fakeLedgerSpy();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(result).toEqual({ state: "done", bv: "BV1REAL" });
    expect(ledger.markDone).toHaveBeenCalledWith("douyin:123:2026-10-12", "BV1REAL");
    expect(ledger.markFailed).not.toHaveBeenCalled();
    expect(t.cleanup).toHaveBeenCalledTimes(1); // 假失败也必须删源,否则永久泄漏
    expect((t.cleanup.mock.calls[0]![0] as string[])).toEqual(["/r/a.ts"]);
  });

  it("phase=uploading(命令跑了但没写终态)→ needs_manual,绝不重传、不删源", async () => {
    const t = sshFailTransport({ phase: "uploading", ok: false, atMs: 1 });
    const ledger = fakeLedgerSpy();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(result).toEqual({ state: "needs_manual", bv: undefined });
    // reconciler 的自动重试闸门看 sync_node_states(getFailedNodes)→ 必须写这行。
    expect(ledger.syncNodeState).toHaveBeenCalledWith("douyin:123:2026-10-12", "upload_plain", "failed", expect.anything());
    expect(ledger.markFailed).not.toHaveBeenCalled();
    expect(t.cleanup).not.toHaveBeenCalled(); // 结果不确定 → 保住源给人工
  });

  it("#25②:uploading 带 bv + 进度(被杀时回读)→ needs_manual,BV 记进台账,说明里带已确认分 P 数", async () => {
    const t = sshFailTransport({ phase: "uploading", ok: false, bv: "BV1KILLED", confirmedParts: 1, intentPart: 2, atMs: 1 });
    const ledger = fakeLedgerSpy();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(result).toEqual({ state: "needs_manual", bv: "BV1KILLED" });
    expect(ledger.setBv).toHaveBeenCalledWith("douyin:123:2026-10-12", "BV1KILLED");
    const err = String((ledger.setState.mock.calls.at(-1) as unknown[])[2] && ((ledger.setState.mock.calls.at(-1) as unknown[])[2] as { error: string }).error);
    expect(err).toContain("已确认 1 个分 P");
    expect(err).toContain("第 2 个追加结果未知");
    expect(t.cleanup).not.toHaveBeenCalled(); // 仍不删源、不重传
  });

  it("#25②:uploading 无 bv(旧 bundle / 建稿前被杀)→ 不写 setBv(向后兼容)", async () => {
    const t = sshFailTransport({ phase: "uploading", ok: false, atMs: 1 });
    const ledger = fakeLedgerSpy();
    await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(ledger.setBv).not.toHaveBeenCalled();
  });

  it("phase=done 但无 bv(建稿证据不全)→ needs_manual,不删源", async () => {
    const t = sshFailTransport({ phase: "done", ok: true, atMs: 1 });
    const ledger = fakeLedgerSpy();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(result!.state).toBe("needs_manual");
    expect(ledger.markFailed).not.toHaveBeenCalled();
    expect(t.cleanup).not.toHaveBeenCalled();
  });

  it("phase=failed 且带 bv(建稿后 append 失败)→ needs_manual,绝不自动重传", async () => {
    const t = sshFailTransport({ phase: "failed", ok: false, bv: "BV1PARTIAL", error: "append 失败", atMs: 1 });
    const ledger = fakeLedgerSpy();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(result).toEqual({ state: "needs_manual", bv: "BV1PARTIAL" });
    expect(ledger.markFailed).not.toHaveBeenCalled();
  });

  it("节点无结果文件(确实没成)→ 原失败路径 failed + 记不安全重试标记", async () => {
    const t = sshFailTransport(null);
    const ledger = fakeLedgerSpy();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(result).toEqual({ state: "failed" });
    expect(ledger.markFailed).toHaveBeenCalledTimes(1);
    // 节点名必须与 reconciler 的 UNSAFE_RETRY_NODES 同名,否则会「failed + 自动重试」= 重复投稿。
    expect(ledger.syncNodeState).toHaveBeenCalledWith("douyin:123:2026-10-12", "upload_plain", "failed", expect.anything());
    expect(t.cleanup).not.toHaveBeenCalled();
  });

  it("nodeResult 回读自身抛错 → 保守按「确认没成」处理(不抛、不静默成功)", async () => {
    const t = {
      nodeCapabilities: async () => ({ biliup: "/biliup", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => { throw new Error("ssh rc=255"); }),
      nodeResult: vi.fn(async () => { throw new Error("ssh 也断了"); }),
      cleanup: vi.fn(async () => {}),
    };
    const ledger = fakeLedgerSpy();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(result).toEqual({ state: "failed" });
    expect(ledger.markFailed).toHaveBeenCalledTimes(1);
  });

  it("!result.ok(节点命令正常返回失败)但落盘 done+bv → 同样收口 done(两条失败分支共用收口)", async () => {
    const t = {
      nodeCapabilities: async () => ({ biliup: "/biliup", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => ({ ok: false, error: "回传阶段断线" })),
      nodeResult: vi.fn(async () => ({ phase: "done", ok: true, bv: "BV1REAL2", atMs: 1 })),
      cleanup: vi.fn(async () => {}),
    };
    const ledger = fakeLedgerSpy();
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t),
    });
    expect(result).toEqual({ state: "done", bv: "BV1REAL2" });
    expect(ledger.markFailed).not.toHaveBeenCalled();
    expect(t.cleanup).toHaveBeenCalledTimes(1);
  });
});

/**
 * 回归(issue #12):节点侧上传的台账埋点必须用**独立步骤名 `node_upload`**,不是历史的 `pull`。
 *
 * `pull` 的语义是「rsync 把录像回传 master」;节点侧是**本地 remux + 上传(无回传)** —— 记成 pull
 * 会让队列页/台账误报「还在回传录像」。这里把「节点侧路径 ≠ pull」钉死,防止将来又写回去。
 * (常规 pull 回 master 的路径在 pipeline.ts 里仍写 pull,不在此文件,故不受影响。)
 */
describe("节点侧上传台账步骤名 = node_upload(非 pull)", () => {
  const rec = { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" };
  const cfgUpload = { ...cfg, cleanup: { sourceAfterDone: true, stageAfterDone: true } } as unknown as PipelineCfg;

  /** 可断言调用参数的 ledger 替身(与 fakeLedger 同形,但不 as never,便于读 mock.calls)。 */
  function spyLedger() {
    return {
      get: () => ({ bv: "" }),
      getUploadPlan: () => null,
      logStep: vi.fn(),
      setState: vi.fn(),
      syncNodeState: vi.fn(),
      getNodeState: vi.fn(() => null),
      markFailed: vi.fn(),
      markDone: vi.fn(),
    };
  }

  async function run(ledger: ReturnType<typeof spyLedger>, t: unknown) {
    return tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t as { id?: string }),
    });
  }

  it("成功路径:logStep 只出现 node_upload,绝不出现 pull;节点表记 node_upload running→done", async () => {
    const t = fakeTransport();
    const ledger = spyLedger();
    const result = await run(ledger, t);
    expect(result).toEqual({ state: "done", bv: "BV1TEST" });
    const steps = ledger.logStep.mock.calls.map((c) => c[1]);
    expect(steps).toContain("node_upload");
    expect(steps).not.toContain("pull");
    // 队列页「当前节点」取自 nodeStates 的 running/done 节点 → 必须也记成 node_upload,
    // 否则会回落到 stateToNode("syncing")="pull"(旧误报来源)。
    const nodeUploadStates = ledger.syncNodeState.mock.calls.filter((c) => c[1] === "node_upload").map((c) => c[2]);
    expect(nodeUploadStates).toContain("running");
    expect(nodeUploadStates).toContain("done");
  });

  it("失败路径(确认没成 → failed):步骤名仍是 node_upload,绝不出现 pull", async () => {
    const t = {
      nodeCapabilities: async () => ({ biliup: "/biliup", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => { throw new Error("ssh: rc=255"); }),
      nodeResult: vi.fn(async () => null),
      cleanup: vi.fn(async () => {}),
    };
    const ledger = spyLedger();
    const result = await run(ledger, t);
    expect(result).toEqual({ state: "failed" });
    const steps = ledger.logStep.mock.calls.map((c) => c[1]);
    expect(steps).toContain("node_upload");
    expect(steps).not.toContain("pull");
    // 失败也要在节点表标 node_upload(failed),让队列页显示「节点本地上传 失败」而非 pull。
    expect(ledger.syncNodeState.mock.calls).toContainEqual([
      "douyin:123:2026-10-12", "node_upload", "failed", expect.anything(),
    ]);
  });

  it("假失败回读确认成功 → 步骤名 node_upload(done),节点表 node_upload 收口 done", async () => {
    const t = {
      nodeCapabilities: async () => ({ biliup: "/biliup", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => { throw new Error("ssh: rc=255"); }),
      nodeResult: vi.fn(async () => ({ phase: "done", ok: true, bv: "BV1REAL", atMs: 1 })),
      cleanup: vi.fn(async () => {}),
    };
    const ledger = spyLedger();
    const result = await run(ledger, t);
    expect(result).toEqual({ state: "done", bv: "BV1REAL" });
    const steps = ledger.logStep.mock.calls.map((c) => c[1]);
    expect(steps).not.toContain("pull");
    expect(ledger.syncNodeState.mock.calls).toContainEqual(["douyin:123:2026-10-12", "node_upload", "done"]);
  });
});


/**
 * issue #2 A1/A2：节点已接管(started)但执行体可能仍在跑 → master 必须**先终止再回读**，
 * 并据「能否确认终止」分流：确认停了 → failed(真没建稿、允许人工安全重投)；
 * 无法确认(旧 bundle 无 `_node-abort` / 不可达)→ needs_manual(可能稍后偷偷建稿,禁自动重试)。
 * 这钉死「台账说 failed、节点却仍在建稿」的静默分裂已被关闭。
 */
describe("issue #2:started + 主动终止节点执行体(A1 尽早落盘 + A2 收口)", () => {
  const rec = { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" };
  const cfgUpload = { ...cfg, cleanup: { sourceAfterDone: true, stageAfterDone: true } } as unknown as PipelineCfg;

  // 本 describe 自带的替身(上层 describe 的 sshFailTransport/fakeLedgerSpy 是其块内作用域,不可复用)。
  function sshFail(nodeResult: unknown, cleanup = vi.fn(async () => {})) {
    return {
      nodeCapabilities: async () => ({ biliup: "/biliup", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => { throw new Error("ssh: remote command exited with rc=255"); }),
      nodeResult: vi.fn(async () => nodeResult),
      cleanup,
    };
  }
  function ledgerSpy() {
    return {
      get: () => ({ bv: "" }),
      getUploadPlan: () => null,
      logStep: vi.fn(),
      setState: vi.fn(),
      syncNodeState: vi.fn(),
      getNodeState: vi.fn(() => null),
      markFailed: vi.fn(),
      markDone: vi.fn(),
    };
  }

  async function run(t: unknown, ledger = ledgerSpy()) {
    const result = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: cfgUpload,
      winner: { workerId: "w1", rec },
      winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: () => {},
      deps: fakeDeps(t as { id?: string }),
    });
    return { result, ledger };
  }

  it("started + 已确认终止 → failed(真没建稿、不堆人工)+ **终止调用先于回读**", async () => {
    const order: string[] = [];
    const abort = vi.fn(async () => { order.push("abort"); return { aborted: true }; });
    const nodeResult = vi.fn(async () => { order.push("read"); return { phase: "started", ok: false, atMs: 1 }; });
    const t = { ...sshFail(null), abortNodePipeline: abort, nodeResult };
    const { result, ledger } = await run(t);
    expect(result).toEqual({ state: "failed" });      // 已确认停 → 走「确认没成」,不是 needs_manual
    expect(ledger.markFailed).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("douyin:123:2026-10-12"); // 以 streamKey 定位执行体
    // 关键顺序:先杀后读 —— 否则执行体可能在读完之后又写新阶段/建稿(静默分裂根因)。
    expect(order).toEqual(["abort", "read"]);
    expect(t.cleanup).not.toHaveBeenCalled(); // failed 仍不删源(由 reconciler/人工按既有 failed 语义处理)
  });

  it("started + 无法确认终止(abort=false)→ needs_manual,禁自动重试、不删源", async () => {
    const abort = vi.fn(async () => ({ aborted: false, detail: "非 Linux/权限,读不到 cmdline" }));
    const t = { ...sshFail({ phase: "started", ok: false, atMs: 1 }), abortNodePipeline: abort };
    const { result, ledger } = await run(t);
    expect(result).toEqual({ state: "needs_manual", bv: undefined });
    expect(ledger.markFailed).not.toHaveBeenCalled();
    // reconciler 自动重试闸门看 sync_node_states → 必须写不安全重试标记(禁自动重传)。
    expect(ledger.syncNodeState).toHaveBeenCalledWith("douyin:123:2026-10-12", "upload_plain", "failed", expect.anything());
  });

  it("旧 bundle 无 abortNodePipeline(方法缺失)→ started 保守 needs_manual(绝不假设已停)", async () => {
    const t = sshFail({ phase: "started", ok: false, atMs: 1 }); // 不含 abortNodePipeline
    expect("abortNodePipeline" in t).toBe(false);
    const { result, ledger } = await run(t);
    expect(result!.state).toBe("needs_manual");
    expect(ledger.markFailed).not.toHaveBeenCalled();
  });

  it("abortNodePipeline 抛错 → **不掩盖原始失败原因**(errMsg 仍是失败记录)", async () => {
    const abort = vi.fn(async () => { throw new Error("ssh 也断了"); });
    const t = { ...sshFail({ phase: "uploading", ok: false, atMs: 1 }), abortNodePipeline: abort };
    const { result, ledger } = await run(t);
    // uploading 本身就 needs_manual;abort 抛错被吞,不改变判定、不把异常上抛。
    expect(result!.state).toBe("needs_manual");
    // 原始 ssh 失败原因仍进了 markFailed 路径?不 —— uploading→needs_manual 用 setState/notify,
    // 关键是 handleNodeFailure 没有因 abort 抛错而整体 reject。result 正常返回即证明未掩盖。
    expect(ledger.setState).toHaveBeenCalled();
  });

  it("无落盘(null)+ 已确认终止 → 原失败路径 failed(无 started 可区分,保持既有行为)", async () => {
    const abort = vi.fn(async () => ({ aborted: true }));
    const t = { ...sshFail(null), abortNodePipeline: abort };
    const { result, ledger } = await run(t);
    expect(result).toEqual({ state: "failed" });
    expect(ledger.markFailed).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("douyin:123:2026-10-12"); // 终态失败一律先尝试终止
  });
});

// issue #91:建稿护栏——done 场(收尾补跑重入)不转人工、不告警;告警必须与台账状态一致。
describe("tryNodeSideUpload 已建稿护栏(issue #91)", () => {
  const run = (ledger: unknown, notify: () => void) => {
    const t = fakeTransport();
    return tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg,
      winner: { workerId: "w1", rec: { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" } },
      winnerMembers: [{ workerId: "w1", rec: { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" } }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify,
      deps: fakeDeps(t),
    }).then((r) => ({ r, t }));
  };

  it("本场已 done:返回 done,不 setState、不通知、不下发节点侧上传", async () => {
    const setState = vi.fn(() => false);
    const notify = vi.fn();
    const { r, t } = await run({ get: () => ({ bv: "BV1X", state: "done" }), setState }, notify);
    expect(r).toEqual({ state: "done", bv: "BV1X" });
    expect(setState).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(t.nodePipeline).not.toHaveBeenCalled();
  });

  it("未 done 且已建稿:转人工并通知一次(不放宽重复投稿保护)", async () => {
    const setState = vi.fn(() => true);
    const notify = vi.fn();
    const { r, t } = await run({ get: () => ({ bv: "BV1X", state: "syncing" }), setState }, notify);
    expect(r).toEqual({ state: "needs_manual", bv: "BV1X" });
    expect(setState).toHaveBeenCalledWith("douyin:123:2026-10-12", "needs_manual", expect.anything());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(t.nodePipeline).not.toHaveBeenCalled();
  });

  it("状态转换被台账拒绝(并发下已被改走):不通知,避免告警与台账不一致", async () => {
    const notify = vi.fn();
    await run({ get: () => ({ bv: "BV1X", state: "syncing" }), setState: () => false }, notify);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("tryNodeSideUpload 成功收尾(issue #92)", () => {
  it("节点侧上传成功(返回 ok)→ 立刻按配置删节点源;节点侧无 sync_parts 基线,不排旁路校验", async () => {
    const ledger = { get: () => ({ bv: "" }), getUploadPlan: () => null, logStep: vi.fn(), setState: vi.fn(), syncNodeState: vi.fn(), getNodeState: () => null, markFailed: vi.fn(), markDone: vi.fn(), doneParts: () => new Set<number>() };
    const t = fakeTransport();
    const scheduled: number[] = [];
    const deps = {
      transports: new Map([["w1", t]]), rmStage: vi.fn(async () => {}),
      countParts: async () => 1,
      scheduleSideCheck: (_fn: () => void, ms: number) => { scheduled.push(ms); },
    };
    const r = await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12",
      cfg: { ...cfg, cleanup: { sourceAfterDone: true } } as never,
      winner: { workerId: "w1", rec: { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" } },
      winnerMembers: [{ workerId: "w1", rec: { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" } }],
      transport: t as never,
      ledger: ledger as never,
      jlog: () => {},
      notify: vi.fn(),
      deps: deps as never,
    });
    expect(r?.state).toBe("done");
    expect(t.cleanup).toHaveBeenCalled();     // 返回码 0 即成功:立刻按配置删源
    expect(scheduled).toEqual([]);            // 无基线,回读无从比对,不排
  });
});

describe("estimateNodeUploadTimeoutMs(issue #25 ①:超时按字节估算)", () => {
  const MIN = 30 * 60_000;
  it("字节数未知 / 非法 → 回落下限 30 分钟(旧 bundle 清单不带字节数)", () => {
    for (const v of [undefined, 0, -5, NaN, Infinity]) expect(estimateNodeUploadTimeoutMs(v as number)).toBe(MIN);
    expect(NODE_UPLOAD_MIN_TIMEOUT_MS).toBe(MIN);
  });
  it("小场次不低于下限", () => {
    expect(estimateNodeUploadTimeoutMs(10e6)).toBe(MIN);
  });
  it("线上出事的 2.4GB 多分 P 场次:预算 ≥ 60 分钟(固定 30 分钟必被杀)", () => {
    expect(estimateNodeUploadTimeoutMs(2.4e9)).toBeGreaterThanOrEqual(60 * 60_000);
  });
  it("预算随字节单调增长,并封顶 6 小时", () => {
    expect(estimateNodeUploadTimeoutMs(1.5e9)).toBeGreaterThan(estimateNodeUploadTimeoutMs(1e9));
    expect(estimateNodeUploadTimeoutMs(2.4e9)).toBe(NODE_UPLOAD_MAX_TIMEOUT_MS); // 0.1MB/s 口径下 2.4GB 已触顶
    expect(estimateNodeUploadTimeoutMs(1e12)).toBe(NODE_UPLOAD_MAX_TIMEOUT_MS);
    expect(NODE_UPLOAD_MAX_TIMEOUT_MS).toBe(6 * 3_600_000);
  });
});

describe("tryNodeSideUpload 按字节估算的超时下发给 transport", () => {
  async function run(totalBytes: number | undefined) {
    const t = {
      nodeCapabilities: async () => ({ biliup: "/b", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => ({ ok: true, bv: "BV1T" })),
      cleanup: vi.fn(async () => {}),
    };
    const rec = { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml", ...(totalBytes != null ? { totalBytes } : {}) };
    await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12", cfg, winner: { workerId: "w1", rec }, winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never, ledger: fakeLedger(), jlog: () => {}, notify: () => {}, deps: fakeDeps(t),
    });
    return t.nodePipeline;
  }
  it("带字节数 → timeoutMs 按估算;不带 → 下限", async () => {
    const big = await run(2.4e9);
    expect(big).toHaveBeenCalledWith(expect.anything(), { timeoutMs: estimateNodeUploadTimeoutMs(2.4e9) });
    const unknown = await run(undefined);
    expect(unknown).toHaveBeenCalledWith(expect.anything(), { timeoutMs: 30 * 60_000 });
  });
});

describe("errBrief:失败原因保留末尾、去掉 known_hosts 噪声", () => {
  const warn = "Warning: Permanently added 'h' (ED25519) to the list of known hosts.\r\n";
  it("去掉 known_hosts 提示与 \\r,换行合并", () => {
    expect(errBrief(`ssh rc=1: ${warn}[node-pipeline] a\n[node-pipeline] b`)).toBe("ssh rc=1: [node-pipeline] a | [node-pipeline] b");
  });
  it("过长保留**末尾**(真正的报错在末尾),并以省略号标记", () => {
    const long = `${warn}${"开头噪声 ".repeat(100)}\nffmpeg 失败: 真正的原因`;
    const r = errBrief(long, 60);
    expect(r.startsWith("…")).toBe(true);
    expect(r.endsWith("ffmpeg 失败: 真正的原因")).toBe(true);
    expect(r.length).toBeLessThanOrEqual(61);
  });
  it("短文本原样返回", () => {
    expect(errBrief("rc=255")).toBe("rc=255");
  });
});

describe("节点侧失败原因写进台账时保留末尾", () => {
  it("ssh 报错很长:markFailed 收到的是带真正原因的末尾,而不是开头噪声", async () => {
    const long = "ssh rc=1: Warning: Permanently added 'h' (ED25519) to the list of known hosts.\r\n" + "[node-pipeline] 起手日志 ".repeat(40) + "\nffmpeg 失败: Invalid data found";
    const t = {
      nodeCapabilities: async () => ({ biliup: "/b", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => { throw new Error(long); }),
      readNodeResult: vi.fn(async () => null),
      cleanup: vi.fn(async () => {}),
    };
    const ledger = { get: () => ({ bv: "" }), getUploadPlan: () => null, logStep: vi.fn(), setState: vi.fn(), syncNodeState: vi.fn(), markFailed: vi.fn(), markDone: vi.fn(), setBv: vi.fn() };
    const rec = { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" };
    await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12", cfg, winner: { workerId: "w1", rec }, winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never, ledger: ledger as never, jlog: () => {}, notify: () => {}, deps: fakeDeps(t),
    });
    const msg = String(ledger.markFailed.mock.calls[0]?.[1] ?? "");
    expect(msg).toContain("ffmpeg 失败: Invalid data found");
    expect(msg).not.toContain("Permanently added");
  });
});

describe("issue #202:预算按胜出方全部会话字节求和", () => {
  it("sumUploadBytes:累加已知会话;非法/缺失忽略;全部未知 → undefined", () => {
    expect(sumUploadBytes([{ rec: { totalBytes: 443e6 } }, { rec: { totalBytes: 300e6 } }])).toBe(743e6);
    expect(sumUploadBytes([{ rec: { totalBytes: 443e6 } }, { rec: {} }, { rec: { totalBytes: NaN } }, { rec: { totalBytes: -1 } }])).toBe(443e6);
    expect(sumUploadBytes([{ rec: {} }])).toBeUndefined();
    expect(sumUploadBytes([])).toBeUndefined();
  });

  it("同节点并发抢带宽到实测下界 0.1MB/s 时,743MB 的预算仍够传完", () => {
    expect(estimateNodeUploadTimeoutMs(743e6)).toBeGreaterThan(743e6 / 100_000 * 1000);
  });

  async function runWith(winnerMembers: { workerId: string; rec: Record<string, unknown> }[], members?: typeof winnerMembers) {
    const t = {
      nodeCapabilities: async () => ({ biliup: "/b", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => ({ ok: true, bv: "BV1T" })),
      cleanup: vi.fn(async () => {}),
    };
    await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12", cfg, winner: winnerMembers[0] as never, winnerMembers: winnerMembers as never, members: members as never,
      transport: t as never, ledger: fakeLedger(), jlog: () => {}, notify: () => {}, deps: fakeDeps(t),
    });
    return t.nodePipeline;
  }

  it("两个会话 P1+P2 → timeoutMs 按两者之和(而不是只看第一会话)", async () => {
    const m = [
      { workerId: "w1", rec: { tsFiles: ["/r/a.ts"], totalBytes: 443e6 } },
      { workerId: "w1", rec: { tsFiles: ["/r/b.ts"], totalBytes: 300e6 } },
    ];
    const call = await runWith(m);
    expect(call).toHaveBeenCalledWith(expect.anything(), { timeoutMs: estimateNodeUploadTimeoutMs(743e6) });
    expect(estimateNodeUploadTimeoutMs(743e6)).toBeGreaterThan(estimateNodeUploadTimeoutMs(443e6));
  });

  it("落败节点的字节不计入预算(它们不上传)", async () => {
    const win = [{ workerId: "w1", rec: { tsFiles: ["/r/a.ts"], totalBytes: 443e6 } }];
    const loser = { workerId: "w2", rec: { tsFiles: ["/q/a.ts"], totalBytes: 9e9 } };
    const call = await runWith(win, [...win, loser]);
    expect(call).toHaveBeenCalledWith(expect.anything(), { timeoutMs: estimateNodeUploadTimeoutMs(443e6) });
  });
});

describe("issue #202:needs_manual 保留原始失败原因", () => {
  it("ssh 超时(带节点 stderr 末尾)+ 回读 uploading → error 同时含原始失败与「结果不确定」", async () => {
    const t = {
      nodeCapabilities: async () => ({ biliup: "/b", cookies: true, diskFreeGB: 100 }),
      nodePipeline: vi.fn(async () => { throw new Error("ssh 超时 1800000ms 被杀: h -- node | 节点 stderr 末尾: biliup 上传分块停滞"); }),
      nodeResult: vi.fn(async () => ({ phase: "uploading", ok: false, atMs: 1 })),
      cleanup: vi.fn(async () => {}),
    };
    const ledger = { get: () => ({ bv: "" }), getUploadPlan: () => null, logStep: vi.fn(), setState: vi.fn(), syncNodeState: vi.fn(), markFailed: vi.fn(), markDone: vi.fn(), setBv: vi.fn() };
    const rec = { tsFiles: ["/r/a.ts"], xmlPath: "/r/a.xml" };
    await tryNodeSideUpload({
      streamKey: "douyin:123:2026-10-12", cfg, winner: { workerId: "w1", rec }, winnerMembers: [{ workerId: "w1", rec }],
      transport: t as never, ledger: ledger as never, jlog: () => {}, notify: () => {}, deps: fakeDeps(t),
    });
    const err = (ledger.setState.mock.calls.at(-1) as unknown[])[2] as { error: string };
    expect(err.error).toContain("结果未知");
    expect(err.error).toContain("biliup 上传分块停滞");
    expect(err.error).toContain("已禁止自动重试");
    // 首条台账步骤也不再取开头噪声
    const steps = ledger.logStep.mock.calls.map((c) => String(c[3] ?? ""));
    expect(steps.some((d) => d.includes("biliup 上传分块停滞"))).toBe(true);
  });
});
