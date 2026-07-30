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
    platform: "douyin",
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

function makeBroadcast(members: Array<{ workerId: string; rec: NodeRecording }>): Broadcast {
  return {
    streamKey: "douyin:test-room:2026-06-27",
    platform: "douyin",
    roomSlug: "test-room",
    startMs: Date.now() - 3_600_000,
    members,
  };
}

function makeTransport(workerId: string, exists = true): Transport {
  return {
    id: workerId,
    listInventory: vi.fn().mockResolvedValue({ workerId, recordings: [] }),
    isDone: vi.fn().mockResolvedValue(true),
    pull: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(exists),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

type TestDeps = Omit<PipelineDeps, "sh" | "uploadPlain" | "appendGroup" | "notify"> & {
  sh: Mock<(cmd: string) => Promise<void>>;
  uploadPlain: Mock<(plain: { video?: string; public?: boolean }) => Promise<string>>;
  appendGroup: Mock<(o: { bv: string; files: string[]; cookies: string; public: boolean }) => Promise<void>>;
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
  const appendGroup = vi.fn<(o: { bv: string; files: string[]; cookies: string; public: boolean }) => Promise<void>>().mockResolvedValue(undefined);
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
  it("makeRunLogger 注入 → job.log 经该 ScopedLogger 写入(不直接 appendFileSync)", async () => {
    const lines: string[] = [];
    const fakeLogger = { info: (...a: unknown[]) => lines.push(a.join(" ")), warn: () => {}, error: () => {} };
    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) },
      { workerId: "node-2", rec: makeRec({ totalGapSec: 200 }) },
    ]);
    const deps = makeDeps({ makeRunLogger: () => fakeLogger });
    deps.ledger.upsertPending(broadcast.streamKey);
    await runPipeline(broadcast, deps);
    expect(lines.some((l) => l.includes("pipeline start"))).toBe(true);
    expect(lines.some((l) => l.includes("选优: winner=node-1"))).toBe(true);
    deps.ledger.close();
  });

  it("场景1: 有干净胜者 + auto-private → pull到stageSub, merge/burn×2/upload, ledger=done, bv=BV123", async () => {
    const cleanRec = makeRec({ totalGapSec: 0 });    // winner: totalGapSec=0, coverage=1
    const dirtyRec = makeRec({ totalGapSec: 200 });   // loser: totalGapSec=200

    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: cleanRec },
      { workerId: "node-2", rec: dirtyRec },
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

    // 成功完成 → 发 uploadDone 通知(BV + 稿件 url),供 hub 任务完成提醒
    const uploadDone = (deps.notify.mock.calls as Array<[NotifyEvent]>)
      .map(([e]) => e)
      .find((e) => e.kind === "uploadDone");
    expect(uploadDone).toEqual({ kind: "uploadDone", bv: "BV123", url: "https://www.bilibili.com/video/BV123" });

    // ledger should end at "done"
    const job = deps.ledger.get(broadcast.streamKey);
    expect(job?.state).toBe("done");
    expect(job?.bv).toBe("BV123");

    deps.ledger.close();
  });

  it("job.log: 每场写专属日志(选优/步骤/终态可复盘)", async () => {
    const { readFileSync, rmSync } = await import("node:fs");
    rmSync(`${STAGE_SUB}/job.log`, { force: true });   // 场景1可能已写过,清掉保证本用例独立
    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) },
      { workerId: "node-2", rec: makeRec({ totalGapSec: 200 }) },
    ]);
    const deps = makeDeps();
    deps.ledger.upsertPending(broadcast.streamKey);
    await runPipeline(broadcast, deps);
    const log = readFileSync(`${STAGE_SUB}/job.log`, "utf-8");
    expect(log).toContain("pipeline start");
    expect(log).toContain("选优: winner=node-1");
    expect(log).toContain("pull 完成");
    expect(log).toContain("P1 上传完成: BV123");
    expect(log).toContain("pipeline end: done bv=BV123");
    deps.ledger.close();
  });

  it("场景2: 都断(无完整 worker) → 直接中断+通知,**不 pull/不 merge/不删源**, ledger=needs_manual", async () => {
    // 两节点各 1 会话但都断流(gap 200 > 30)→ 无完整 worker → 直接中断,保留全部源。
    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: makeRec({ totalGapSec: 200 }) },
      { workerId: "node-2", rec: makeRec({ totalGapSec: 200 }) },
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

  it("场景2b: 同 worker 断流多会话(无完整 worker)→ 同样直接中断+保留源", async () => {
    // node-1 断流成 2 会话(各 gap=0),没有完整 worker → 不 pull/merge,不删源。
    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: makeRec({ sessionBase: "主播名_2026-06-27_08-00-00", durationSec: 1800, totalGapSec: 0 }) },
      { workerId: "node-1", rec: makeRec({ sessionBase: "主播名_2026-06-27_08-35-00", durationSec: 3000, totalGapSec: 0 }) },
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
    const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
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
      { workerId: "node-1", rec: makeRec({ durationSec: 9999, totalGapSec: 0 }) },
      { workerId: "node-2", rec: makeRec({ durationSec: 3600, totalGapSec: 0 }) },
    ]);
    const deps = makeDeps();
    deps.transports.set("node-1", makeTransport("node-1", false)); // 文件缺失
    deps.transports.set("node-2", makeTransport("node-2", true));
    deps.ledger.upsertPending(broadcast.streamKey);

    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("done");
    // winner 应是 node-2(node-1 被剔除),pull 在 node-2 上调用
    expect(deps.ledger.get(broadcast.streamKey)?.winnerWorker).toBe("node-2");
    expect(deps.transports.get("node-2")!.pull).toHaveBeenCalledTimes(1);
    expect(deps.transports.get("node-1")!.pull).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    deps.ledger.close();
  });

  it("场景5(#1 全缺失): 所有成员文件都没了 → failed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
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
    const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
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
    const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
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
    const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
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
      { workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) },
      { workerId: "node-2", rec: makeRec({ totalGapSec: 0 }) },
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

  describe("step detail", () => {
    it("merge/clean steps carry count detail (upload mode)", async () => {
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, uploadMode: "upload", cleanup: { sourceAfterDone: true } } });
      const b = makeBroadcast([
        { workerId: "node-1", rec: makeRec({ tsFiles: ["/r/a.ts", "/r/b.ts", "/r/c.ts", "/r/d.ts"] }) },
      ]);
      deps.ledger.upsertPending(b.streamKey);
      await runPipeline(b, deps);
      const steps = deps.ledger.getSteps(b.streamKey);
      const merge = steps.find((s) => s.step === "merge" && s.phase === "done");
      expect(merge?.detail).toContain("4 段");
      const cleanSrc = steps.find((s) => s.step === "clean_source" && s.phase === "done");
      expect(cleanSrc?.detail).toContain("删 1 节点");
      deps.ledger.close();
    });
  });

  describe("上传重试(主路径)", () => {
    it("P1 上传成功后立即 setBv 落库(append 之前 job.bv 已存在)", async () => {
      const deps = makeDeps();
      deps.appendGroup.mockImplementation(async () => {
        expect(deps.ledger.get(STREAM_KEY)?.bv).toBe("BV123"); // append 时 bv 已落库
      });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      await runPipeline(b, deps);
      expect(deps.ledger.get(STREAM_KEY)?.bv).toBe("BV123");
      deps.ledger.close();
    });

    it("appendGroup 单文件组瞬时失败 → 就地重试后成功(不重传 P1)", async () => {
      const deps = makeDeps({ sleep: async () => {} }); // 注入 noop sleep,免真等退避
      deps.appendGroup
        .mockRejectedValueOnce(new Error("Connection timed out"))
        .mockResolvedValue(undefined);
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      const r = await runPipeline(b, deps);
      expect(deps.uploadPlain).toHaveBeenCalledTimes(1);                    // 绝不重传 P1
      expect(deps.appendGroup.mock.calls.length).toBeGreaterThanOrEqual(2); // 至少重试一次
      expect(r.state).toBe("done");
      deps.ledger.close();
    });

    it("append 循环跳过 isStepDone 已完成的组(续跑幂等基石)", async () => {
      const deps = makeDeps();
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      deps.ledger.logStep(b.streamKey, "append_danmu", "start"); // 预置 danmu 已完成
      deps.ledger.logStep(b.streamKey, "append_danmu", "done");
      await runPipeline(b, deps);
      const appended = deps.appendGroup.mock.calls.map((c) => c[0].files.join(",")).join("|");
      expect(appended).not.toContain("_danmu.mp4"); // 已 done → 跳过
      expect(appended).toContain("_livechat.mp4");  // 只补 livechat
      deps.ledger.close();
    });
  });

  describe("续跑分支(已建稿)", () => {
    it("续跑:job 已有 bv → 跳过 uploadPlain/merge/burn,只补没做完的 append,最后 markDone", async () => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const stageDir = mkdtempSync(join(tmpdir(), "resume-stage-"));
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, stageDir } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      // 预置:已建稿 + danmu 已 append 完
      deps.ledger.upsertPending(b.streamKey);
      deps.ledger.setState(b.streamKey, "uploading");
      deps.ledger.setBv(b.streamKey, "BVexisting");
      deps.ledger.logStep(b.streamKey, "append_danmu", "start");
      deps.ledger.logStep(b.streamKey, "append_danmu", "done");
      // 预置 stage 产物(dateName 由 deriveProducts 从目录反推)
      const dateName = "主播名_2026-06-27";
      const sub = join(stageDir, "douyin_test-room_2026-06-27");
      mkdirSync(sub, { recursive: true });
      for (const suf of [".mp4", "_danmu.mp4", "_livechat.mp4", ".xml"]) writeFileSync(join(sub, dateName + suf), "x");

      const r = await runPipeline(b, deps);

      expect(deps.uploadPlain).not.toHaveBeenCalled();  // 绝不重传 P1(防重核心)
      expect(deps.sh).not.toHaveBeenCalled();           // 不 merge/burn
      const appended = deps.appendGroup.mock.calls.map((c) => c[0].files.join(",")).join("|");
      expect(appended).not.toContain("_danmu.mp4");     // danmu 已 done,跳过
      expect(appended).toContain("_livechat.mp4");      // 只补 livechat
      expect(deps.appendGroup.mock.calls.every((c) => c[0].bv === "BVexisting")).toBe(true);
      expect(r).toEqual({ state: "done", bv: "BVexisting" });
      expect(deps.ledger.get(b.streamKey)?.state).toBe("done");
      deps.ledger.close();
    });

    it("续跑:有 bv 但 stage 产物缺失 → needs_manual + 通知,绝不重传", async () => {
      const stageDir = mkdtempSync(join(tmpdir(), "resume-missing-"));
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, stageDir } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      deps.ledger.setBv(b.streamKey, "BVexisting");
      // 不创建任何 stage 产物文件

      const r = await runPipeline(b, deps);

      expect(deps.uploadPlain).not.toHaveBeenCalled();
      expect(deps.appendGroup).not.toHaveBeenCalled();
      expect(r.state).toBe("needs_manual");
      expect(deps.ledger.get(b.streamKey)?.state).toBe("needs_manual");
      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
      deps.ledger.close();
    });
  });
});
