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
import { tryNodeSideUpload } from "../../packages/orchestrator/src/node-side-upload.js";
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
    logStep: vi.fn(),
    setState: vi.fn(),
    syncNodeState: vi.fn(),
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
      logStep: vi.fn(),
      setState: vi.fn(),
      syncNodeState: vi.fn(),
      markFailed: vi.fn(),
      markDone: vi.fn(),
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
      logStep: vi.fn(),
      setState: vi.fn(),
      syncNodeState: vi.fn(),
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
