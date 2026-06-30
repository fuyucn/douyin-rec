import { describe, it, expect, vi, type Mock } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline, type PipelineDeps } from "./pipeline.js";
import { SyncLedger } from "./ledger.js";
import type { Broadcast } from "./identity.js";
import type { NodeRecording, Transport } from "./transport.js";
import type { NotifyEvent } from "@drec/core";

function freshLedger(): SyncLedger {
  return new SyncLedger(join(mkdtempSync(join(tmpdir(), "pipeline-test-")), "test.db"));
}

function makeRec(overrides: Partial<NodeRecording> = {}): NodeRecording {
  return {
    roomSlug: "test-room",
    sessionBase: "主播名_2026-06-27_08-00-00",
    tsFiles: ["/remote/a.ts", "/remote/b.ts"],
    xmlPath: "/remote/danmu.xml",
    durationSec: 3600,
    startMs: Date.now() - 3_600_000,
    endMs: Date.now(),
    totalGapSec: 0,
    ...overrides,
  };
}

function makeBroadcast(members: Array<{ tenantId: string; rec: NodeRecording }>): Broadcast {
  return {
    streamKey: "douyin:test-room:2026-06-27",
    roomSlug: "test-room",
    startMs: Date.now() - 3_600_000,
    members,
  };
}

function makeTransport(tenantId: string, exists = true): Transport {
  return {
    id: tenantId,
    listInventory: vi.fn().mockResolvedValue({ tenantId, recordings: [] }),
    isDone: vi.fn().mockResolvedValue(true),
    pull: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(exists),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

type TestDeps = Omit<PipelineDeps, "sh" | "uploadPlain" | "appendGroup" | "notify"> & {
  sh: Mock<(cmd: string) => Promise<void>>;
  uploadPlain: Mock<(plain: { video?: string; public?: boolean }) => Promise<string>>;
  appendGroup: Mock<(o: { bv: string; files: string[]; cookies: string }) => Promise<void>>;
  notify: Mock<(e: NotifyEvent) => void>;
  transports: Map<string, Transport>;
  ledger: SyncLedger;
};

function makeDeps(overrides: Partial<PipelineDeps> = {}): TestDeps {
  const ledger = freshLedger();
  const t1 = makeTransport("node-1");
  const t2 = makeTransport("node-2");
  const transports = new Map([["node-1", t1], ["node-2", t2]]);
  const sh = vi.fn<(cmd: string) => Promise<void>>().mockResolvedValue(undefined);
  const uploadPlain = vi.fn<(plain: { video?: string; public?: boolean }) => Promise<string>>().mockResolvedValue("BV123");
  const appendGroup = vi.fn<(o: { bv: string; files: string[]; cookies: string }) => Promise<void>>().mockResolvedValue(undefined);
  const notify = vi.fn<(e: NotifyEvent) => void>();

  const base: PipelineDeps = {
    transports,
    ledger,
    sh,
    uploadPlain,
    appendGroup,
    // 默认 passthrough(不切);个别用例覆盖以模拟超限切分。
    splitForUpload: async (mp4: string) => [mp4],
    notify,
    cfg: {
      cleanMaxGapSec: 30,
      stageDir: "/tmp/stage",
      cookies: "/tmp/cookies.json",
      uploadMode: "upload",
      uploadMeta: {
        tag: "直播录像",
        tid: 21,
        desc: "直播录像",
      },
    },
    ...overrides,
  };
  return base as unknown as TestDeps;
}

// streamKey "douyin:test-room:2026-06-27" → sanitized "douyin_test-room_2026-06-27"
const STREAM_KEY = "douyin:test-room:2026-06-27";
const STAGE_DIR = "/tmp/stage";
const STAGE_SUB = `${STAGE_DIR}/douyin_test-room_2026-06-27`;

describe("runPipeline", () => {
  it("场景1: 有干净胜者 + auto-private → pull到stageSub, merge/burn×2/upload, ledger=done, bv=BV123", async () => {
    const cleanRec = makeRec({ totalGapSec: 0 });    // winner: totalGapSec=0, coverage=1
    const dirtyRec = makeRec({ totalGapSec: 200 });   // loser: totalGapSec=200

    const broadcast = makeBroadcast([
      { tenantId: "node-1", rec: cleanRec },
      { tenantId: "node-2", rec: dirtyRec },
    ]);

    const deps = makeDeps();
    deps.ledger.upsertPending(broadcast.streamKey);

    const result = await runPipeline(broadcast, deps);

    // Should succeed with BV
    expect(result.state).toBe("done");
    expect(result.bv).toBe("BV123");

    // transport.pull should be called with the stageSub path
    const winnerTransport = deps.transports.get("node-1")!;
    expect(winnerTransport.pull).toHaveBeenCalledTimes(1);
    const pullCall = (winnerTransport.pull as Mock).mock.calls[0];
    expect(pullCall[0]).toEqual(["/remote/a.ts", "/remote/b.ts", "/remote/danmu.xml"]);
    expect(pullCall[1]).toBe(STAGE_SUB);

    // sh should be called 3 times: merge + burn danmu + burn livechat
    expect(deps.sh).toHaveBeenCalledTimes(3);
    const shCalls = deps.sh.mock.calls.map((c) => c[0] as string);
    // merge --in uses stageSub
    expect(shCalls[0]).toContain("merge");
    expect(shCalls[0]).toContain(STAGE_SUB);
    // burn uses files inside stageSub
    expect(shCalls[1]).toContain("burn");
    expect(shCalls[1]).toContain("danmu");
    expect(shCalls[1]).toContain(STAGE_SUB);
    expect(shCalls[2]).toContain("burn");
    expect(shCalls[2]).toContain("livechat");
    expect(shCalls[2]).toContain(STAGE_SUB);

    // 穿插上传:uploadPlain 一次(P1)+ 每逻辑组一条 appendGroup(danmu、livechat 各一,串行)
    expect(deps.uploadPlain).toHaveBeenCalledTimes(1);
    expect((deps.uploadPlain as Mock).mock.calls[0][0].video).toContain(".mp4");
    expect((deps.uploadPlain as Mock).mock.calls[0][0].public).toBe(false); // auto-private → 仅自己可见
    expect(deps.appendGroup).toHaveBeenCalledTimes(2);
    const apCalls = (deps.appendGroup as Mock).mock.calls.map((c) => c[0] as { bv: string; files: string[] });
    expect(apCalls[0].bv).toBe("BV123");
    expect(apCalls[0].files[0]).toContain("_danmu");
    expect(apCalls[1].files[0]).toContain("_livechat");

    // notify should NOT be called with error (clean winner case)
    const errorNotifications = (deps.notify.mock.calls as Array<[NotifyEvent]>)
      .filter(([e]) => e.kind === "error");
    expect(errorNotifications).toHaveLength(0);

    // ledger should end at "done"
    const job = deps.ledger.get(broadcast.streamKey);
    expect(job?.state).toBe("done");
    expect(job?.bv).toBe("BV123");

    deps.ledger.close();
  });

  it("场景2: 都断(无完整 tenant) → 直接中断+通知,**不 pull/不 merge/不删源**, ledger=needs_manual", async () => {
    // 两节点各 1 会话但都断流(gap 200 > 30)→ 无完整 tenant → 直接中断,保留全部源。
    const broadcast = makeBroadcast([
      { tenantId: "node-1", rec: makeRec({ totalGapSec: 200 }) },
      { tenantId: "node-2", rec: makeRec({ totalGapSec: 200 }) },
    ]);

    const deps = makeDeps();
    deps.ledger.upsertPending(broadcast.streamKey);

    const result = await runPipeline(broadcast, deps);

    expect(result.state).toBe("needs_manual");
    expect(result.bv).toBeUndefined();

    // 都断流 → 直接中断:不 pull、不 merge/burn、不上传、**不删任何源**(保护数据)。
    expect(deps.transports.get("node-1")!.pull).not.toHaveBeenCalled();
    expect(deps.transports.get("node-2")!.pull).not.toHaveBeenCalled();
    expect(deps.sh).toHaveBeenCalledTimes(0);
    expect(deps.uploadPlain).toHaveBeenCalledTimes(0);
    expect(deps.transports.get("node-1")!.cleanup).not.toHaveBeenCalled();
    expect(deps.transports.get("node-2")!.cleanup).not.toHaveBeenCalled();

    // notify error「同步」,带「断流」提示
    const errs = (deps.notify.mock.calls as Array<[NotifyEvent]>).filter(([e]) => e.kind === "error");
    expect(errs).toHaveLength(1);
    const [errEvent] = errs[0];
    if (errEvent.kind === "error") {
      expect(errEvent.stage).toBe("同步");
      expect(errEvent.message).toContain("断流");
    }
    expect(deps.ledger.get(broadcast.streamKey)?.state).toBe("needs_manual");
    deps.ledger.close();
  });

  it("场景2b: 同 tenant 断流多会话(无完整 tenant)→ 同样直接中断+保留源", async () => {
    // node-1 断流成 2 会话(各 gap=0),没有完整 tenant → 不 pull/merge,不删源。
    const broadcast = makeBroadcast([
      { tenantId: "node-1", rec: makeRec({ sessionBase: "主播名_2026-06-27_08-00-00", durationSec: 1800, totalGapSec: 0 }) },
      { tenantId: "node-1", rec: makeRec({ sessionBase: "主播名_2026-06-27_08-35-00", durationSec: 3000, totalGapSec: 0 }) },
    ]);
    const deps = makeDeps({ cfg: { ...makeDeps().cfg, cleanup: { sourceAfterDone: true } } });
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("needs_manual");
    expect(deps.sh).toHaveBeenCalledTimes(0);            // 不合并
    expect(deps.uploadPlain).not.toHaveBeenCalled();
    expect(deps.transports.get("node-1")!.cleanup).not.toHaveBeenCalled(); // 即便配了 sourceAfterDone 也不删
    deps.ledger.close();
  });

  it("场景3: danmu 超 16GB → splitForUpload 切 2 段,upload 收到 danmu 组含两 part(#1+#3)", async () => {
    const broadcast = makeBroadcast([{ tenantId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
    const deps = makeDeps({
      // 模拟今天:danmu 超限切 2 段,livechat 不切
      splitForUpload: async (mp4: string) =>
        mp4.includes("_danmu")
          ? [mp4.replace(/\.mp4$/, "_part0.mp4"), mp4.replace(/\.mp4$/, "_part1.mp4")]
          : [mp4],
    });
    deps.ledger.upsertPending(broadcast.streamKey);

    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("done");

    // danmu append 组含两 part、livechat 组 1 段(两条独立 appendGroup)
    const apCalls = (deps.appendGroup as Mock).mock.calls.map((c) => c[0] as { files: string[] });
    expect(apCalls).toHaveLength(2);
    expect(apCalls[0].files).toHaveLength(2);
    expect(apCalls[0].files[0]).toContain("_danmu_part0");
    expect(apCalls[0].files[1]).toContain("_danmu_part1");
    expect(apCalls[1].files).toEqual([expect.stringContaining("_livechat.mp4")]);

    deps.ledger.close();
  });

  it("场景4(#1 剔除缺文件成员): node-1 文件已不在 → 剔除,winner 落到 node-2", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // node-1 时长更长(本应胜),但其文件已不存在(exists=false)→ 应被剔除,winner=node-2
    const broadcast = makeBroadcast([
      { tenantId: "node-1", rec: makeRec({ durationSec: 9999, totalGapSec: 0 }) },
      { tenantId: "node-2", rec: makeRec({ durationSec: 3600, totalGapSec: 0 }) },
    ]);
    const deps = makeDeps();
    deps.transports.set("node-1", makeTransport("node-1", false)); // 文件缺失
    deps.transports.set("node-2", makeTransport("node-2", true));
    deps.ledger.upsertPending(broadcast.streamKey);

    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("done");
    // winner 应是 node-2(node-1 被剔除),pull 在 node-2 上调用
    expect(deps.ledger.get(broadcast.streamKey)?.winnerTenant).toBe("node-2");
    expect(deps.transports.get("node-2")!.pull).toHaveBeenCalledTimes(1);
    expect(deps.transports.get("node-1")!.pull).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    deps.ledger.close();
  });

  it("场景5(#1 全缺失): 所有成员文件都没了 → failed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broadcast = makeBroadcast([{ tenantId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
    const deps = makeDeps();
    deps.transports.set("node-1", makeTransport("node-1", false));
    deps.ledger.upsertPending(broadcast.streamKey);

    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("failed");
    expect(deps.uploadPlain).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    deps.ledger.close();
  });

  it("场景6(步骤开关): burnDanmu=false → 不烧 danmu、danmu 组空不 append,只 livechat", async () => {
    const broadcast = makeBroadcast([{ tenantId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
    const deps = makeDeps({ cfg: { ...makeDeps().cfg, steps: { burnDanmu: false } } });
    deps.ledger.upsertPending(broadcast.streamKey);
    await runPipeline(broadcast, deps);
    const shCalls = deps.sh.mock.calls.map((c) => c[0] as string);
    expect(shCalls.some((c) => c.includes("--style danmu"))).toBe(false);   // 没烧 danmu
    expect(shCalls.some((c) => c.includes("--style livechat"))).toBe(true); // 烧了 livechat
    // danmu 组空 → 不 append;只 livechat 一条 append
    expect(deps.appendGroup).toHaveBeenCalledTimes(1);
    expect((deps.appendGroup as Mock).mock.calls[0][0].files[0]).toContain("_livechat");
    deps.ledger.close();
  });

  // dateName = sessionBase 剥时间戳 = "主播名_2026-06-27";plain xml 产物 = {dateName}.xml
  const PLAIN_XML = `${STAGE_SUB}/主播名_2026-06-27.xml`;
  const SOURCE_XML = `${STAGE_SUB}/danmu.xml`; // basename of /remote/danmu.xml

  it("场景8(plain xml 产物): stageSourceAfterMerge+includeXmlAss 删源 xml 但**保留** plain xml 产物", async () => {
    const rmStage = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(undefined);
    const broadcast = makeBroadcast([{ tenantId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
    // stage-only:合并后清源,但不到 stageAfterDone(产物含 plain xml 留存)
    const deps = makeDeps({
      rmStage,
      cfg: { ...makeDeps().cfg, uploadMode: "stage", cleanup: { stageSourceAfterMerge: true, includeXmlAss: true } },
    });
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("needs_manual");
    // stageSourceAfterMerge 删:拉来的源 .ts + 源 xml(timestamped),但 **不删** plain xml 产物
    const deleted = rmStage.mock.calls.flatMap((c) => c[0]);
    expect(deleted).toContain(SOURCE_XML);          // 源 xml 删
    expect(deleted).not.toContain(PLAIN_XML);        // plain xml 产物保留
    deps.ledger.close();
  });

  it("场景9(plain xml 产物): stageAfterDone+includeXmlAss 上传后才连 plain xml 一并清", async () => {
    const rmStage = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(undefined);
    const broadcast = makeBroadcast([{ tenantId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
    const deps = makeDeps({
      rmStage,
      cfg: { ...makeDeps().cfg, uploadMode: "upload", cleanup: { stageAfterDone: true, includeXmlAss: true } },
    });
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("done");
    const deleted = rmStage.mock.calls.flatMap((c) => c[0]);
    expect(deleted).toContain(PLAIN_XML);            // 上传后清产物含 plain xml
    deps.ledger.close();
  });

  it("场景7(cleanup): sourceAfterDone → done 后各成员 transport.cleanup 被调", async () => {
    const broadcast = makeBroadcast([
      { tenantId: "node-1", rec: makeRec({ totalGapSec: 0 }) },
      { tenantId: "node-2", rec: makeRec({ totalGapSec: 0 }) },
    ]);
    const deps = makeDeps({ cfg: { ...makeDeps().cfg, cleanup: { sourceAfterDone: true } } });
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("done");
    // 两个成员节点的 cleanup 都被调(删源 .ts)
    expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
    expect(deps.transports.get("node-2")!.cleanup).toHaveBeenCalled();
    deps.ledger.close();
  });
});
