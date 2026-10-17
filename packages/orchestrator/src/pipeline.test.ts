import { describe, it, expect, vi, type Mock } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSourcesShared, consecutiveSidecarSkips, xmlKeepRule, runPipeline, SIDECAR_SKIP_PREFIX, SIDECAR_UNKNOWN_PREFIX, type PipelineCfg, type PipelineDeps } from "./pipeline.js";
import { ResourcePool } from "./workflow.js";
import { SyncLedger } from "./ledger.js";
import { closeStageReady, STAGE_READY } from "@drec/core";
import type { Broadcast } from "./identity.js";
import type { NodeRecording, Transport } from "./transport.js";
import type { NotifyEvent } from "@drec/core";

// node:fs 走 spy(默认透传真实实现)—— 只有需要覆盖「硬链接不可用」分支的用例才
// 临时把 linkSync 打桩成抛错;其余用例行为与未 mock 时完全一致。
vi.mock("node:fs", { spy: true });

// 全局 setup 已先于本文件加载 @drec/core(其 node:fs 绑定不受上面的 spy 影响),
// 故「硬链接不可用」改经 linkOrCopy 的注入口(fs)模拟 EXDEV。
const linkFail = vi.hoisted(() => ({ on: false }));
vi.mock("@drec/core", async (orig) => {
  const m = await orig<typeof import("@drec/core")>();
  const fs = await import("node:fs");
  return {
    ...m,
    linkOrCopy: (s: string, d: string, o?: Parameters<typeof m.linkOrCopy>[2]) =>
      m.linkOrCopy(s, d, linkFail.on ? {
        ...o,
        fs: {
          linkSync: () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); },
          copyFileSync: fs.copyFileSync,
          statSync: fs.statSync,
        },
      } : o),
  };
});

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
    // Both real transports implement ping; include it so the sidecar recheck can distinguish
    // "reachable + file gone" (a real deletion) from "unreachable".
    ping: vi.fn().mockResolvedValue(undefined),
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
  // 核验的「重查等 B站 pages 同步」默认 5 次 × 3s 退避(≈45s);测试全局注入 no-op 免真等。
  // (与 append 重试同一注入点;生产走真实 setTimeout。)
  const t1 = makeTransport("node-1");
  const t2 = makeTransport("node-2");
  const transports = new Map([["node-1", t1], ["node-2", t2]]);
  const cfg: PipelineCfg = {
    cleanMaxGapSec: 30,
    stageDir: mkdtempSync(join(tmpdir(), "pipeline-stage-")),
    cookies: "/tmp/cookies.json",
    uploadMode: "upload",
    uploadMeta: { tag: "直播录像", tid: 21, desc: "直播录像" },
    ...(overrides.cfg ?? {}),
  };
  const stageSub = join(cfg.stageDir, "douyin_test-room_2026-06-27");
  const fallbackStem = "主播名_2026-06-27";
  const stemOf = (cmd: string): string => {
    const quoted = /--out-base\s+'([^']+)'/.exec(cmd);
    if (quoted?.[1]) return quoted[1];
    const bare = /--out-base\s+(\S+)/.exec(cmd);
    return bare?.[1] ?? fallbackStem;
  };
  // 模拟 merge/burn 的真实产物,让 workflow 输入/输出安全阀通过(与真实子命令一致)。
  const sh = vi.fn<(cmd: string) => Promise<void>>().mockImplementation(async (cmd: string) => {
    if (cmd.includes(" merge ")) {
      const dateName = stemOf(cmd);
      mkdirSync(stageSub, { recursive: true });
      writeFileSync(join(stageSub, "src.ts"), "x");
      writeFileSync(join(stageSub, "danmu.xml"), "x");
      writeFileSync(join(stageSub, `${dateName}.mp4`), "x");
      writeFileSync(join(stageSub, `${dateName}.xml`), "x");
    } else if (cmd.includes("--style danmu") || cmd.includes("--style livechat")) {
      const video = /--video\s+(\S+)/.exec(cmd)?.[1] ?? "";
      const stem = (video.split("/").pop() ?? fallbackStem).replace(/\.mp4$/i, "");
      const style = cmd.includes("--style livechat") ? "_livechat.mp4" : "_danmu.mp4";
      writeFileSync(join(stageSub, stem + style), "x");
    }
  });
  const uploadPlain = vi.fn<(plain: { video?: string; public?: boolean }) => Promise<string>>().mockResolvedValue("BV123");
  const appendGroup = vi.fn<(o: { bv: string; files: string[]; cookies: string; public: boolean }) => Promise<void>>().mockResolvedValue(undefined);
  const notify = vi.fn<(e: NotifyEvent) => void>();
  // 默认资源池:内存闸门关(本机/CI 空闲内存可能 < 2GB)、cpu/net 各串成一个。
  const pool = new ResourcePool({ minBurnFreeMemMB: 0, maxCpuParallel: 1, maxNetParallel: 1, uploadRateLimit: 0 });

  const base: PipelineDeps = {
    transports,
    ledger,
    sh,
    uploadPlain,
    appendGroup,
    pool,
    // 默认 passthrough(不切);个别用例覆盖以模拟超限切分。
    splitForUpload: async (mp4: string) => [mp4],
    notify,
    cfg,
    // 核验重查(B站 pages 同步)默认 5 次 × 3s 退避 ≈45s;测试统一 no-op 免真等。
    // 个别用例若显式覆盖 sleep 则以覆盖值为准。
    sleep: async () => {},
    ...overrides,
  };
  return base as unknown as TestDeps;
}

// streamKey "douyin:test-room:2026-06-27" → sanitized "douyin_test-room_2026-06-27"
const STREAM_KEY = "douyin:test-room:2026-06-27";

function stageSubOf(deps: TestDeps): string {
  return join(deps.cfg.stageDir, "douyin_test-room_2026-06-27");
}

/** 模拟 merge 子命令的真实产物(源 .ts/.xml + plain.mp4/.xml),喂 workflow 安全阀。 */
function writePlainArtifacts(deps: TestDeps): void {
  const sub = stageSubOf(deps);
  mkdirSync(sub, { recursive: true });
  const dateName = "主播名_2026-06-27";
  writeFileSync(join(sub, "src.ts"), "x");
  writeFileSync(join(sub, "danmu.xml"), "x");
  writeFileSync(join(sub, `${dateName}.mp4`), "x");
  writeFileSync(join(sub, `${dateName}.xml`), "x");
}

describe("runPipeline", () => {
  describe("xmlKeepRule(.xml/.ass 副本不变量:两处不能同时删光)", () => {
    it("保留 stage(stageAfterDone=false):可删节点源 .xml,不删 stage .xml", () => {
      expect(xmlKeepRule("node", false)).toBe(true);   // 节点源可删(副本在 stage)
      expect(xmlKeepRule("stage", false)).toBe(false); // stage 保留 → 不删
    });
    it("清空 stage(stageAfterDone=true):不删节点源 .xml(成最后一份),可删 stage .xml", () => {
      expect(xmlKeepRule("node", true)).toBe(false);   // 节点是最后一份 → 保留
      expect(xmlKeepRule("stage", true)).toBe(true);   // stage 可删
    });
  });

  describe("分段产出(steps.mergeSegments=false)", () => {
    /** 造一个分段模式的 deps:段源文件落在 stage(模拟已 pull),并拦截 remux/burn 调用。 */
    function segmentDeps(): TestDeps {
      const rmStage = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(undefined);
      const deps = makeDeps({
        // 注入 remux/时长/烧录接缝(否则会 spawn 真 ffmpeg)。
        remuxSegment: async (src: string, out: string) => { writeFileSync(out, "x"); },
        segmentDuration: async () => 60,
        burnSegment: async ({ out }: { out: string }) => { writeFileSync(out, "x"); },
        // 拦截 stage 删除(否则真删 tmp 目录里的模拟文件;断言也需要)。
        rmStage,
      });
      // 覆盖 cfg:分段模式 + upload。
      (deps as { cfg: PipelineCfg }).cfg = {
        cleanMaxGapSec: 30,
        stageDir: deps.cfg.stageDir,
        cookies: "/tmp/cookies.json",
        uploadMode: "upload",
        uploadMeta: { tag: "直播录像", tid: 21, desc: "直播录像" },
        steps: { mergeSegments: false },
      };
      const sub = stageSubOf(deps);
      mkdirSync(sub, { recursive: true });
      // 3 个源段 + 会话级 xml(模拟 pull 后的 stage)。
      // xml 名与 makeRec 的 xmlPath(/remote/danmu.xml)一致 → 段窗口可用。
      for (const f of ["s_000.ts", "s_001.ts", "s_002.ts", "danmu.xml"]) writeFileSync(join(sub, f), "x");
      return deps;
    }

    it("不合并:逐段 remux → 多文件 upload 建稿 → 逐组 append(顺序=段序)", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"] }) }]);
      const deps = segmentDeps();
      deps.ledger.upsertPending(broadcast.streamKey);

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("done");
      expect(result.bv).toBe("BV123");
      // 绝不调用 merge 子命令(分段模式的核心:不合并)
      const cmds = (deps.sh as Mock).mock.calls.map((c) => c[0] as string);
      expect(cmds.some((c) => c.includes(" merge "))).toBe(false);
      // P1 单文件建稿(不一次塞多文件):uploadPlain 只收第一段
      expect(deps.uploadPlain).toHaveBeenCalledTimes(1);
      const first = (deps.uploadPlain as Mock).mock.calls[0][0] as { video?: string; videos?: string[] };
      expect(first.video).toContain("_000.mp4"); // 规范上传名
      expect(first.videos).toBeUndefined();
      // 其余 plain 段 append(批大小 5 → 2 段一批);再加两个烧录组各 3 段(danmu/livechat)
      // 共 1(plain 批)+ 2(danmu/livechat,已过滤碎片后各 3 段)批
      const groups = (deps.appendGroup as Mock).mock.calls.map((c) => (c[0] as { files: string[] }).files);
      const flat = groups.flat();
      // 顺序:先 plain 组(_001, _002),再 danmu 组(3),再 livechat 组(3)
      expect(flat.filter((f) => /_\d{3}\.mp4$/.test(f))).toHaveLength(2);
      expect(flat.filter((f) => f.includes("_danmu")).length).toBeGreaterThan(0);
      expect(flat.filter((f) => f.includes("_livechat")).length).toBeGreaterThan(0);
      deps.ledger.close();
    });

    // ── T11/T12 在分段路径上的同口径行为 ────────────────────────────────────────
    describe("分段路径的核验与清理(T11/T12)", () => {
      const SEG_BC = () => makeBroadcast([{
        workerId: "node-1",
        rec: makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"] }),
      }]);

      /** 分段模式 + 删源开启。 */
      function segUploadDeps(overrides: Partial<PipelineDeps> = {}): TestDeps {
        const deps = segmentDeps();
        (deps as { cfg: PipelineCfg }).cfg = {
          ...deps.cfg,
          cleanup: { sourceAfterDone: true },
          ...(overrides.cfg ? { cfg: overrides.cfg } : {}),
        } as PipelineCfg;
        const o = { ...overrides };
        delete o.cfg;
        Object.assign(deps, o);
        return deps;
      }
      async function runSeg(deps: TestDeps) {
        const b = SEG_BC();
        deps.ledger.upsertPending(b.streamKey);
        return runPipeline(b, deps);
      }

      it("核验通过(期望 9 实际 9)→ 删源;分组名沿用既有 append_danmu/append_livechat", async () => {
        const deps = segUploadDeps({ countParts: async () => 9 });
        const r = await runSeg(deps);
        expect(r.state).toBe("done");
        // 向后兼容:分段路径的既有组名(步骤名)必须被核验读到 → 期望算得出 9。
        expect(deps.ledger.doneParts(STREAM_KEY, "append_danmu").size).toBe(3);
        expect(deps.ledger.doneParts(STREAM_KEY, "plain").size).toBe(3);
        expect(deps.ledger.getNodeState(STREAM_KEY, "clean_verify")?.state).toBe("done");
        expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
      });

      it("期望 9 实际 8(回读少)→ 仍 done,**照常删节点源**(issue #92:上传是否成功只看 biliup 返回码)", async () => {
        // 收口时不再同步回读;回读由延迟的旁路校验承担(只记录/告警,不影响清理),见 finalize-verify.test.ts。
        const deps = segUploadDeps({ countParts: async () => 8 });
        const r = await runSeg(deps);
        expect(r.state).toBe("done");
        expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
        expect(deps.ledger.getNodeState(STREAM_KEY, "clean_verify")?.state).toBe("done");
      });

      it("未注入 countParts → 核验关闭,分段路径照常删源(与现状一致)", async () => {
        const deps = segUploadDeps();
        const r = await runSeg(deps);
        expect(r.state).toBe("done");
        expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
      });

      it("countParts=null → 不影响清理:照常删源、clean_verify 记 done(不再留 pending)、job 仍 done", async () => {
        const deps = segUploadDeps({ countParts: async () => null });
        const r = await runSeg(deps);
        expect(r.state).toBe("done");
        expect(deps.ledger.getNodeState(STREAM_KEY, "clean_verify")?.state).toBe("done");
        expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
      });

      it("分段路径 rmStage 抛错 → job 仍 done(不因清理失败变 failed)", async () => {
        const deps = segUploadDeps({
          countParts: async () => 9,
          rmStage: async () => { throw new Error("stage 只读"); },
          cfg: { ...segUploadDeps().cfg, cleanup: { sourceAfterDone: true, stageAfterDone: true } },
        } as Partial<PipelineDeps>);
        const r = await runSeg(deps);
        expect(r.state).toBe("done");
        expect(deps.ledger.get(STREAM_KEY)?.state).toBe("done");
      });
    });

    // ── issue #7:分段模式**派生** per-分P 弹幕 xml(「A 同时存在」附加产物)────────
    describe("per-分P 弹幕 xml 派生(issue #7)", () => {
      const DATE_NAME = "主播名_2026-06-27";
      const SEG_TS = ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"];
      const VST = 1_700_000_000_000;
      /** 会话级 xml:video_start_time=VST;条目相对时间 10/65/70/100s(跨 3 个分P窗口)。 */
      const sessionXml = (): string =>
        `<?xml version="1.0" encoding="utf-8"?>\n<i>\n  <metadata><video_start_time>${VST}</video_start_time></metadata>\n`
        + [
          `<d p="10.000,1,25,16777215,${VST + 10_000},0,9,9,0" user="a">十秒</d>`,
          `<d p="65.000,1,25,16777215,${VST + 65_000},0,8,8,0" user="b">六五</d>`,
          `<d p="70.000,1,25,16777215,${VST + 70_000},0,7,7,0" user="c">七十</d>`,
          `<d p="100.000,1,25,16777215,${VST + 100_000},0,6,6,0" user="d">一百</d>`,
        ].join("\n")
        + "\n</i>\n";
      /** 段时长 60/30/60 → 分P窗口 [0,60) / [60,90) / [90,150)。 */
      const unevenDurations = async (p: string): Promise<number> => (p.includes("s_001") ? 30 : 60);

      it("每个分P落一份 {dateName}_{NNN}.xml,时间轴按该分P窗口重定基(与烧录同一口径)", async () => {
        const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: SEG_TS }) }]);
        const deps = segmentDeps();
        const sub = stageSubOf(deps);
        writeFileSync(join(sub, "danmu.xml"), sessionXml());
        (deps as { segmentDuration: (p: string) => Promise<number> }).segmentDuration = unevenDurations;
        deps.ledger.upsertPending(broadcast.streamKey);

        const result = await runPipeline(broadcast, deps);
        expect(result.state).toBe("done");

        // 派生 xml 与分P mp4 同名 stem(`{base}_NNN.xml` 命名,既有消费点可直接识别)。
        expect(existsSync(join(sub, `${DATE_NAME}_000.mp4`))).toBe(true);
        const p0 = readFileSync(join(sub, `${DATE_NAME}_000.xml`), "utf-8");
        const p1 = readFileSync(join(sub, `${DATE_NAME}_001.xml`), "utf-8");
        const p2 = readFileSync(join(sub, `${DATE_NAME}_002.xml`), "utf-8");
        // P1 窗 [0,60):只有 10s 那条,原样(重定基 -0)。
        expect(p0).toContain(`p="10.000,`);
        expect(p0).toContain("十秒");
        expect(p0).not.toContain("六五");
        // P2 窗 [60,90):65/70 → 重定基 -60 得 5/10;窗口外的 10s/100s 不收。
        expect(p1).toContain(`p="5.000,`);
        expect(p1).toContain(`p="10.000,`);
        expect(p1).toContain("六五");
        expect(p1).toContain("七十");
        expect(p1).not.toContain("十秒");
        expect(p1).not.toContain("一百");
        // P3 窗 [90,150):100s → 重定基 -90 得 10。
        expect(p2).toContain(`p="10.000,`);
        expect(p2).toContain("一百");
        expect(p2).not.toContain("七十");
        // 每份都是结构完整的 biliLive xml(保留 video_start_time、仅一个 </i>)。
        for (const x of [p0, p1, p2]) {
          expect(x).toContain(`<video_start_time>${VST}</video_start_time>`);
          expect((x.match(/<\/i>/g) ?? []).length).toBe(1);
        }
        // 会话级 xml 原样保留(唯一权威源,既有行为未变)。
        expect(readFileSync(join(sub, "danmu.xml"), "utf-8")).toBe(sessionXml());
        deps.ledger.close();
      });

      it("幂等:目标已存在 → 跳过,不覆盖(重跑不产出/不改成错位文件)", async () => {
        const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: SEG_TS }) }]);
        const deps = segmentDeps();
        const sub = stageSubOf(deps);
        writeFileSync(join(sub, "danmu.xml"), sessionXml());
        writeFileSync(join(sub, `${DATE_NAME}_000.xml`), "SENTINEL");
        deps.ledger.upsertPending(broadcast.streamKey);

        await runPipeline(broadcast, deps);

        expect(readFileSync(join(sub, `${DATE_NAME}_000.xml`), "utf-8")).toBe("SENTINEL");
        deps.ledger.close();
      });

      it("时长探测失败 → 该会话整场不派生(不静默产出错位文件)+ 显式告警", async () => {
        const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: SEG_TS }) }]);
        const deps = segmentDeps();
        const sub = stageSubOf(deps);
        writeFileSync(join(sub, "danmu.xml"), sessionXml());
        (deps as { segmentDuration: (p: string) => Promise<number> }).segmentDuration =
          async (p) => { if (p.includes("s_001")) throw new Error("ffprobe 失败"); return 60; };
        deps.ledger.upsertPending(broadcast.streamKey);

        await runPipeline(broadcast, deps);

        for (let i = 0; i < 3; i++) {
          expect(existsSync(join(sub, `${DATE_NAME}_00${i}.xml`))).toBe(false);
        }
        expect((deps.notify as Mock).mock.calls.some((c) => (c[0] as { stage?: string }).stage === "分段派生")).toBe(true);
        deps.ledger.close();
      });
    });

    it("stage 模式:逐段产出落盘待人工,不建稿", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"] }) }]);
      const deps = segmentDeps();
      (deps as { cfg: PipelineCfg }).cfg = { ...deps.cfg, uploadMode: "stage" };
      deps.ledger.upsertPending(broadcast.streamKey);

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("needs_manual");
      expect(deps.uploadPlain).not.toHaveBeenCalled();
      expect(deps.appendGroup).not.toHaveBeenCalled();
      deps.ledger.close();
    });

    it("stage 模式 + sourceAfterDone:只删节点源,**绝不碰 stage**(回归:分P成品即交付物)", async () => {
      const tsFiles = ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"];
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles }) }]);
      const deps = segmentDeps();
      // 未开 stageAfterDone → 保留 stage → 节点源 .ts + .xml 一起删(xml 副本在 stage)。
      (deps as { cfg: PipelineCfg }).cfg = {
        ...deps.cfg, uploadMode: "stage",
        cleanup: { stageSourceAfterMerge: true, sourceAfterDone: true },
      };
      deps.ledger.upsertPending(broadcast.streamKey);

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("needs_manual");
      // 节点源被清(否则 VPS 上源 .ts 永久残留)。
      expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
      const cleaned = (deps.transports.get("node-1")!.cleanup as Mock).mock.calls.flatMap((c) => c[0] as string[]);
      expect(cleaned).toEqual([...tsFiles, "/remote/danmu.xml"]);
      // **关键**:分P模式下 stage 里的文件就是交付物 → 删源时绝不从 stage 删。
      expect(deps.rmStage).not.toHaveBeenCalled();
      deps.ledger.close();
    });

    it("stage 模式 + 无 cleanup:落盘后不动任何文件(不误删)", async () => {
      const tsFiles = ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"];
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles }) }]);
      const deps = segmentDeps();
      // stage 模式且 cleanup 全关 → 只落盘待人工,节点源/stage 源都保留。
      (deps as { cfg: PipelineCfg }).cfg = { ...deps.cfg, uploadMode: "stage" };
      deps.ledger.upsertPending(broadcast.streamKey);

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("needs_manual");
      expect(deps.transports.get("node-1")!.cleanup).not.toHaveBeenCalled();
      expect(deps.rmStage).not.toHaveBeenCalled();
      deps.ledger.close();
    });

    it("stage 模式 + cleanup 全开:只删节点源,stage 完全保留(未上传 → 不删 stage)", async () => {
      const tsFiles = ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"];
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles }) }]);
      const deps = segmentDeps();
      // 复刻真实规则(douyin.27471901912):stage 模式 + 三开关全开。
      (deps as { cfg: PipelineCfg }).cfg = {
        ...deps.cfg, uploadMode: "stage",
        cleanup: { stageSourceAfterMerge: true, sourceAfterDone: true, stageAfterDone: true },
      };
      deps.ledger.upsertPending(broadcast.streamKey);

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("needs_manual");
      // 节点源全删(.ts;stageAfterDone=true → 节点 .xml 保留,那是弹幕源最后一份)。
      expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
      const nodeCleaned = (deps.transports.get("node-1")!.cleanup as Mock).mock.calls.flatMap((c) => c[0] as string[]);
      expect(nodeCleaned).toEqual(tsFiles);
      // **关键**:未上传 → stage 一律不删(即使 stageAfterDone=true 也不清,因为没上传成功)。
      expect(deps.rmStage).not.toHaveBeenCalled();
      deps.ledger.close();
    });

    it("stage 模式落盘必须写 STAGE_READY 作显式标记(空 error 会被队列当异常)", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts", "/remote/s_001.ts"] }) }]);
      const deps = segmentDeps();
      (deps as { cfg: PipelineCfg }).cfg = { ...deps.cfg, uploadMode: "stage" };
      deps.ledger.upsertPending(broadcast.streamKey);
      await runPipeline(broadcast, deps);
      expect(deps.ledger.get(broadcast.streamKey)?.error).toBe(STAGE_READY);
      deps.ledger.close();
    });

    it("stage 模式 + 全碎片:无任何分P产物 → 绝不删源,且 error 不是 STAGE_READY(真事故)", async () => {
      const tsFiles = ["/remote/s_000.ts", "/remote/s_001.ts"];
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles }) }]);
      const deps = segmentDeps();
      (deps as { cfg: PipelineCfg }).cfg = {
        ...deps.cfg, uploadMode: "stage",
        cleanup: { stageSourceAfterMerge: true, sourceAfterDone: true, stageAfterDone: true },
      };
      // 所有段都 < minSegmentSec(2s) → 全判碎片 → uploadParts=[]
      (deps as { segmentDuration: (p: string) => Promise<number> }).segmentDuration = async () => 0.2;
      deps.ledger.upsertPending(broadcast.streamKey);

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("needs_manual");
      // 零产物 → 源和 stage 都不许删(否则「源和副本全删、零成品」)。
      expect(deps.transports.get("node-1")!.cleanup).not.toHaveBeenCalled();
      expect(deps.rmStage).not.toHaveBeenCalled();
      // 零成品是事故,不能被标成「stage 正常收口」而混进中性色收件箱;
      // 更不能退化成空 error(会被判成数据异常且没有原因可显示)。
      const err = deps.ledger.get(broadcast.streamKey)?.error ?? "";
      expect(err).not.toBe(STAGE_READY);
      expect(err.trim()).not.toBe("");
      deps.ledger.close();
    });

    it("分段续跑(已建稿):markDone 后补做删源 + 清 stage 源/.work(回归:续跑曾漏清理)", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts", "/remote/s_001.ts"] }) }]);
      const deps = segmentDeps();
      (deps as { cfg: PipelineCfg }).cfg = {
        ...deps.cfg,
        cleanup: { stageSourceAfterMerge: true, sourceAfterDone: true, stageAfterDone: true },
      };
      deps.ledger.upsertPending(broadcast.streamKey);
      deps.ledger.setState(broadcast.streamKey, "retrying"); // 真实续跑入口:runNow/reconciler 先置 retrying,pipeline 自己再推进
      deps.ledger.setBv(broadcast.streamKey, "BVseg");  // 已建稿 → 走分段续跑

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("done");
      expect(deps.uploadPlain).not.toHaveBeenCalled();  // 绝不重传 P1
      // 续跑 done → 节点源被删。
      expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
      // 且 stage 里拉来的源 .ts 被清(有合并?分P模式不删交付物,但拉来源段副本可清)。
      const stageCleaned = (deps.rmStage as Mock).mock.calls.flatMap((c) => c[0] as string[]);
      expect(stageCleaned.some((p) => /s_00[01]\.ts$/.test(p))).toBe(true);
      deps.ledger.close();
    });

    it("分段 done 场收尾补跑:不 warn 非法转换、台账仍 done、照常补删源(done 是终态)", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts", "/remote/s_001.ts"] }) }]);
      const deps = segmentDeps();
      (deps as { cfg: PipelineCfg }).cfg = { ...deps.cfg, cleanup: { sourceAfterDone: true } };
      deps.ledger.upsertPending(broadcast.streamKey);
      deps.ledger.setBv(broadcast.streamKey, "BVseg");
      deps.ledger.markDone(broadcast.streamKey, "BVseg"); // 已 done,reconciler 补跑收尾
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("done");
      expect(deps.ledger.get(broadcast.streamKey)?.state).toBe("done");
      expect(deps.uploadPlain).not.toHaveBeenCalled();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("[ledger] 拒绝"))).toEqual([]);
      warn.mockRestore();
      deps.ledger.close();
    });

    it("碎片过滤:短于 minSegmentSec 的段不上传(mesio --fix 残片)", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"] }) }]);
      const deps = segmentDeps();
      // 段 1 只有 0.2s(碎片),段 0/2 正常;阈值默认 2s → 段 1 应被跳过
      (deps as { segmentDuration: (p: string) => Promise<number> }).segmentDuration =
        async (p: string) => (p.includes("s_001") ? 0.2 : 60);
      deps.ledger.upsertPending(broadcast.streamKey);

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("done");
      // 产出 2 段(seg000, seg001 —— 碎片跳过后重编号连续),碎片不进任何上传
      const first = (deps.uploadPlain as Mock).mock.calls[0][0] as { video?: string };
      expect(first.video).toContain("_000.mp4"); // 规范上传名
      const allFiles = (deps.appendGroup as Mock).mock.calls.flatMap((c) => (c[0] as { files: string[] }).files);
      // 不应出现第 3 个 plain 段(seg002.mp4);danmu/livechat 也只 2 段
      expect(allFiles.filter((f) => /_\d{3}\.mp4$/.test(f)).length).toBe(1); // 只剩 _001 plain
      deps.ledger.close();
    });

    it("segmentGroupSec:按目标时长聚组,组产物名不与成员段冲突(回归)", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"] }) }]);
      const deps = segmentDeps();
      const merges: Array<{ inputs: string[]; out: string }> = [];
      (deps as { mergeSegments: (i: string[], o: string) => Promise<void> }).mergeSegments =
        async (inputs: string[], out: string) => { merges.push({ inputs, out }); writeFileSync(out, "x"); };
      (deps as { cfg: PipelineCfg }).cfg = { ...deps.cfg, segmentGroupSec: 3600 }; // 3×60s 全并成 1 组
      deps.ledger.upsertPending(broadcast.streamKey);

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("done");
      // 合并确实发生了(而不是被 existsSync 跳过)
      expect(merges).toHaveLength(1);
      expect(merges[0].inputs).toHaveLength(3);
      // 组产物名含 _000(hub 约定),不与成员段 seg000.mp4 同名
      expect(merges[0].out).toMatch(/_000\.mp4$/);
      expect(merges[0].out).not.toContain("_seg");
      // 上传的是合并产物,不是单个成员段
      expect((deps.uploadPlain as Mock).mock.calls[0][0].video).toMatch(/_000\.mp4$/);
      deps.ledger.close();
    });

    it("segmentGroupSec=0(不合并)也产出规范上传名,不泄漏 _seg 内部名", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"] }) }]);
      const deps = segmentDeps(); // 默认 cfg 无 segmentGroupSec → 逐段上传
      deps.ledger.upsertPending(broadcast.streamKey);

      const result = await runPipeline(broadcast, deps);

      expect(result.state).toBe("done");
      const first = (deps.uploadPlain as Mock).mock.calls[0][0] as { video?: string };
      expect(first.video).toMatch(/_000\.mp4$/);
      expect(first.video).not.toContain("_seg");
      const allFiles = (deps.appendGroup as Mock).mock.calls.flatMap((c) => (c[0] as { files: string[] }).files);
      expect(allFiles.some((f) => f.includes("_seg"))).toBe(false);
      deps.ledger.close();
    });

    /**
     * issue #6:中间产物(`.work/<段号>.mp4`)→ 规范上传名(`{dateName}_{NNN}.mp4`)改「同盘硬链接优先」。
     *
     * 改前是真拷贝:同一份数据在 stage 存两遍,上传进行中峰值磁盘翻倍(实测某场 15.5G / 盘 49G)。
     * 两者同在 stage 子目录、同一文件系统 ⇒ 硬链接零额外空间。不可用(跨设备/不支持)时回落复制。
     */
    describe("中间产物 → 规范上传名:同盘硬链接(issue #6)", () => {
      const SEG_TS = ["/remote/s_000.ts", "/remote/s_001.ts", "/remote/s_002.ts"];
      const canonicalOf = (sub: string, i: number): string =>
        join(sub, `主播名_2026-06-27_${String(i).padStart(3, "0")}.mp4`);
      const workOf = (sub: string, i: number): string =>
        join(sub, ".work", `${String(i).padStart(3, "0")}.mp4`);

      it("逐段(单段组)产出与 .work 中间产物**同 inode**(零额外空间)", async () => {
        const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: SEG_TS }) }]);
        const deps = segmentDeps(); // 默认 cfg 无 segmentGroupSec → 全是单段组(走 link 分支)
        deps.ledger.upsertPending(broadcast.streamKey);

        const result = await runPipeline(broadcast, deps);

        expect(result.state).toBe("done");
        const sub = stageSubOf(deps);
        for (let i = 0; i < SEG_TS.length; i++) {
          const canonical = canonicalOf(sub, i);
          const work = workOf(sub, i);
          expect(existsSync(canonical)).toBe(true);
          // 同一 inode = 同一份数据(改前是两个不同 inode 的真副本)。
          expect(statSync(canonical).ino).toBe(statSync(work).ino);
          expect(statSync(canonical).nlink).toBe(2); // .work 与规范名各一个名字
        }
        deps.ledger.close();
      });

      it("linkSync 抛错(跨设备/不支持硬链接)→ 回落复制:内容一致、inode 不同", async () => {
        const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: SEG_TS }) }]);
        const deps = segmentDeps();
        deps.ledger.upsertPending(broadcast.streamKey);
        // 只让「硬链接」这一步失败(其余 fs 调用保持真实,否则测试自身读写也会挂)。
        linkFail.on = true;
        try {
          const result = await runPipeline(broadcast, deps);

          expect(result.state).toBe("done");
          const sub = stageSubOf(deps);
          for (let i = 0; i < SEG_TS.length; i++) {
            const canonical = canonicalOf(sub, i);
            const work = workOf(sub, i);
            expect(existsSync(canonical)).toBe(true);
            expect(statSync(canonical).ino).not.toBe(statSync(work).ino); // 真复制
            expect(readFileSync(canonical, "utf-8")).toBe(readFileSync(work, "utf-8"));
          }
        } finally {
          linkFail.on = false; // 别把打桩泄漏给后面的用例
        }
        deps.ledger.close();
      });

      it("续跑:规范名已存在 → 不重复 remux、不重复 link(硬链接是第二个名字,重跑零成本)", async () => {
        const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0, tsFiles: SEG_TS }) }]);
        const deps = segmentDeps();
        const remux = vi.fn(async (_src: string, out: string) => { writeFileSync(out, "x"); });
        (deps as { remuxSegment: (s: string, o: string) => Promise<void> }).remuxSegment = remux;
        deps.ledger.upsertPending(broadcast.streamKey);
        await runPipeline(broadcast, deps);
        const sub = stageSubOf(deps);
        const inosBefore = SEG_TS.map((_, i) => statSync(canonicalOf(sub, i)).ino);
        expect(remux).toHaveBeenCalledTimes(SEG_TS.length);

        // 「中断重跑」:新账本(无 bv)→ 走完整路径,但 stage 里产物都在 → 必须全部跳过。
        const firstLedger = deps.ledger;
        (deps as { ledger: SyncLedger }).ledger = freshLedger();
        firstLedger.close(); // 旧账本句柄别泄漏(它已落过 bv,本轮不再用)
        deps.ledger.upsertPending(broadcast.streamKey);
        const result = await runPipeline(broadcast, deps);

        expect(result.state).toBe("done");
        expect(remux).toHaveBeenCalledTimes(SEG_TS.length); // 没多 remux 一次(若改成 rename/mv 这里会翻倍)
        for (let i = 0; i < SEG_TS.length; i++) {
          // 规范名与 .work 仍是同一 inode(未被重建成第二份真副本)
          expect(statSync(canonicalOf(sub, i)).ino).toBe(inosBefore[i]);
          expect(statSync(canonicalOf(sub, i)).ino).toBe(statSync(workOf(sub, i)).ino);
        }
        deps.ledger.close();
      });
    });
  });

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
    expect(pullCall[1]).toBe(stageSubOf(deps));

    // sh should be called 3 times: merge + burn danmu + burn livechat
    expect(deps.sh).toHaveBeenCalledTimes(3);
    const shCalls = deps.sh.mock.calls.map((c) => c[0] as string);
    // merge --in uses stageSub
    expect(shCalls[0]).toContain("merge");
    expect(shCalls[0]).toContain(stageSubOf(deps));
    // burn uses files inside stageSub
    expect(shCalls[1]).toContain("burn");
    expect(shCalls[1]).toContain("danmu");
    expect(shCalls[1]).toContain(stageSubOf(deps));
    expect(shCalls[2]).toContain("burn");
    expect(shCalls[2]).toContain("livechat");
    expect(shCalls[2]).toContain(stageSubOf(deps));

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
    expect(uploadDone).toMatchObject({ kind: "uploadDone", bv: "BV123", url: "https://www.bilibili.com/video/BV123" });

    // ledger should end at "done"
    const job = deps.ledger.get(broadcast.streamKey);
    expect(job?.state).toBe("done");
    expect(job?.bv).toBe("BV123");

    deps.ledger.close();
  });

  it("job.log: 每场写专属日志(选优/步骤/终态可复盘)", async () => {
    const { readFileSync, rmSync } = await import("node:fs");
    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) },
      { workerId: "node-2", rec: makeRec({ totalGapSec: 200 }) },
    ]);
    const deps = makeDeps();
    deps.ledger.upsertPending(broadcast.streamKey);
    await runPipeline(broadcast, deps);
    const log = readFileSync(join(stageSubOf(deps), "job.log"), "utf-8");
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

  it("titleTemplate 同时用于 stage stem 和 B 站标题,并锁定 outputStem", async () => {
    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) },
    ]);
    const seed = makeDeps();
    const deps = makeDeps({
      cfg: { ...seed.cfg, uploadMeta: { ...seed.cfg.uploadMeta, titleTemplate: "{name}_{date}_{HHmmss}" } },
    });
    seed.ledger.close();
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("done");
    expect(deps.ledger.get(broadcast.streamKey)?.outputStem).toBe("主播名_2026-06-27_080000");
    const uploaded = (deps.uploadPlain as Mock).mock.calls[0][0] as { title?: string; video?: string };
    expect(uploaded.title).toBe("主播名_2026-06-27_080000");
    expect(uploaded.video).toContain("主播名_2026-06-27_080000.mp4");
    const mergeCmd = deps.sh.mock.calls.map((c) => c[0] as string).find((c) => c.includes(" merge "));
    expect(mergeCmd).toContain("--out-base '主播名_2026-06-27_080000'");
    deps.ledger.close();
  });

  it("场景2b: 同 worker 断流重连多会话(各自无缺口)→ 拉全部分段,一次 merge-sessions 拼整场", async () => {
    // node-1 断流重连成 2 会话(各 gap=0)→ 视为完整录全,自动拼成完整版(不再转人工)。
    const s1 = {
      tsFiles: [
        "/remote/主播名_2026-06-27_08-00-00-PART000.ts",
        "/remote/主播名_2026-06-27_08-00-00-PART001.ts",
      ],
      xmlPath: "/remote/主播名_2026-06-27_08-00-00.xml",
    };
    const s2 = {
      tsFiles: [
        "/remote/主播名_2026-06-27_08-02-00-PART000.ts",
        "/remote/主播名_2026-06-27_08-02-00-PART001.ts",
      ],
      xmlPath: "/remote/主播名_2026-06-27_08-02-00.xml",
    };
    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: makeRec({ sessionBase: "主播名_2026-06-27_08-00-00", durationSec: 1800, totalGapSec: 0, ...s1 }) },
      { workerId: "node-1", rec: makeRec({ sessionBase: "主播名_2026-06-27_08-02-00", durationSec: 3000, totalGapSec: 0, ...s2 }) },
    ]);
    const rmStage = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(undefined);
    const deps = makeDeps({
      rmStage,
      cfg: { ...makeDeps().cfg, cleanup: { stageSourceAfterMerge: true, sourceAfterDone: true } },
    });
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("done");
    // 两个会话的全部 ts + 会话级 xml 拉到 stage(共 6 个文件)
    const pullCall = (deps.transports.get("node-1")!.pull as Mock).mock.calls[0];
    expect(pullCall[0]).toEqual([...s1.tsFiles, s1.xmlPath, ...s2.tsFiles, s2.xmlPath]);
    const shCalls = deps.sh.mock.calls.map((c) => c[0] as string);
    expect(shCalls[0]).toContain("merge --in");
    expect(shCalls[0]).toContain("--merge-sessions");
    // sourceAfterDone + stageSourceAfterMerge(未开 stageAfterDone → 保留 stage)。
    // 新口径:保留 stage 时,节点源 .ts + .xml 一起删(xml 副本在 stage)。
    expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
    const cleaned = (deps.transports.get("node-1")!.cleanup as Mock).mock.calls.flatMap((c) => c[0] as string[]);
    expect(cleaned).toEqual([...s1.tsFiles, s1.xmlPath, ...s2.tsFiles, s2.xmlPath]);
    // 未开 stageAfterDone → 保留 stage → stage 里的 .xml/.ass 不删
    expect(deps.ledger.getNodeState(broadcast.streamKey, "merge")?.state).toBe("done");
    const stageCleaned = rmStage.mock.calls.flatMap((c) => c[0] as string[]);
    expect(stageCleaned).toHaveLength(4); // 只清 4 个 stage 源 .ts
    expect(stageCleaned.every((p) => /\.ts$/.test(p))).toBe(true);
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

  it("场景4b(issue #146): 成员剔除时 exists 抛错 → 仍按缺失剔除,不把整场炸掉", async () => {
    // Transport.exists now throws when it cannot tell (issue #146). Member pruning must keep its own
    // fail-closed `.catch(() => false)`; without it an ssh blip would throw out of runPipeline
    // instead of just dropping that member.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: makeRec({ durationSec: 9999, totalGapSec: 0 }) },
      { workerId: "node-2", rec: makeRec({ durationSec: 3600, totalGapSec: 0 }) },
    ]);
    const deps = makeDeps();
    const t1 = makeTransport("node-1", true);
    (t1.exists as Mock).mockRejectedValue(new Error("ssh rc=255"));
    deps.transports.set("node-1", t1);
    deps.transports.set("node-2", makeTransport("node-2", true));
    deps.ledger.upsertPending(broadcast.streamKey);

    const result = await runPipeline(broadcast, deps);   // 不抛错
    expect(result.state).toBe("done");
    expect(deps.ledger.get(broadcast.streamKey)?.winnerWorker).toBe("node-2");
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
    expect(deps.ledger.get(broadcast.streamKey)?.fails).toBe(1);
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

  describe("并行双轨(拆 pipeline)", () => {
    it("两条 burn DAG 就绪但 cpu max=1 串行:第二条等第一条完成才发命令", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
      const deps = makeDeps();
      const burnResolvers: Array<() => void> = [];
      deps.sh.mockImplementation(async (cmd: string) => {
        if (cmd.includes(" merge ")) { writePlainArtifacts(deps); return; }
        if (cmd.includes("burn")) {
          await new Promise<void>((resolve) => { burnResolvers.push(resolve); });
          const dateName = "主播名_2026-06-27";
          const style = cmd.includes("--style danmu") ? "danmu" : "livechat";
          writeFileSync(join(stageSubOf(deps), `${dateName}_${style}.mp4`), "x");
        }
      });
      deps.ledger.upsertPending(broadcast.streamKey);
      const runPromise = runPipeline(broadcast, deps);
      // 第一条 burn 已发出;第二条还拿不到 cpu 锁,不得同时发命令。
      await vi.waitFor(() => {
        const calls = deps.sh.mock.calls.map((c) => c[0] as string);
        expect(calls.filter((c) => c.includes("burn"))).toHaveLength(1);
      });
      const calls = deps.sh.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes("--style danmu"))).toBe(true);
      expect(calls.some((c) => c.includes("--style livechat"))).toBe(false);
      burnResolvers.shift()!(); // 放行第一条 → 第二条才能起
      await vi.waitFor(() => {
        const calls = deps.sh.mock.calls.map((c) => c[0] as string);
        expect(calls.some((c) => c.includes("--style livechat"))).toBe(true);
      });
      burnResolvers.shift()!();
      const r = await runPromise;
      expect(r.state).toBe("done");
      deps.ledger.close();
    });

    it("append 串行:danmu 组完成后才发起 livechat 组(同稿件并发会撞)", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
      const deps = makeDeps();
      let releaseDanmuAppend: () => void = () => {};
      deps.appendGroup.mockImplementation(async (o: { files: string[] }) => {
        if (o.files[0].includes("_danmu")) {
          return new Promise<void>((resolve) => { releaseDanmuAppend = resolve; });
        }
        return undefined;
      });
      deps.ledger.upsertPending(broadcast.streamKey);
      const runPromise = runPipeline(broadcast, deps);
      await vi.waitFor(() => {
        expect(deps.appendGroup).toHaveBeenCalledTimes(1);
        expect((deps.appendGroup as Mock).mock.calls[0][0].files[0]).toContain("_danmu");
      });
      // danmu append 挂起中 → livechat 不得并发发起
      expect(deps.appendGroup).toHaveBeenCalledTimes(1);
      releaseDanmuAppend();
      const r = await runPromise;
      expect(r.state).toBe("done");
      const appended = (deps.appendGroup as Mock).mock.calls.map((c) => c[0].files.join(","));
      expect(appended[0]).toContain("_danmu");
      expect(appended[1]).toContain("_livechat");
      deps.ledger.close();
    });

    it("P1 上传失败 → 双轨跳过 append,不悬挂,收口 failed", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
      const deps = makeDeps();
      deps.uploadPlain.mockRejectedValue(new Error("network down"));
      deps.ledger.upsertPending(broadcast.streamKey);
      const r = await Promise.race([
        runPipeline(broadcast, deps),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlock timeout")), 3000)),
      ]);
      expect(r.state).toBe("failed");
      expect(deps.appendGroup).not.toHaveBeenCalled();
      expect(deps.ledger.get(broadcast.streamKey)?.state).toBe("failed");
      expect(deps.ledger.get(broadcast.streamKey)?.fails).toBe(1);
      deps.ledger.close();
    });
  });

  it("CLI 单节点重跑的 stage 收口同样必须带 STAGE_READY(issue #188 一轮 High 的回归测试)", () => {
    // 该调用点在 cli.ts 内不可直接 import,断言它委托的唯一收口入口会写 error。
    const writes: Array<{ streamKey: string; state: string; error: string }> = [];
    closeStageReady(
      { setState: (k, st, patch) => { writes.push({ streamKey: k, state: st, error: patch.error }); } },
      "douyin:R:2026-10-01", "stage",
    );
    expect(writes).toEqual([{ streamKey: "douyin:R:2026-10-01", state: "needs_manual", error: STAGE_READY }]);
    // upload 模式没有这条收口路径 → 明确抛错,不静默写空 error。
    expect(() => closeStageReady({ setState: () => {} }, "douyin:R:2026-10-01", "upload")).toThrow();
  });

  it("done 场补跑重烧失败 → needs_manual 的 error 必须非空(空串不得落库,issue #188)", async () => {
    // 重烧失败的节点 error 若是空串,`?? ` 不会回落到默认文案 → 台账里会是一条「没有原因」的待人工。
    const stageDir = mkdtempSync(join(tmpdir(), "reburn-"));
    const deps = makeDeps({ cfg: { ...makeDeps().cfg, stageDir } });
    const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
    deps.ledger.upsertPending(b.streamKey);
    for (const st of ["syncing", "merging", "uploading"] as const) deps.ledger.setState(b.streamKey, st);
    deps.ledger.markDone(b.streamKey, "BVdone");
    const sub = join(stageDir, "douyin_test-room_2026-06-27");
    mkdirSync(sub, { recursive: true });
    for (const f of [".mp4", "_danmu.mp4", "_livechat.mp4"]) writeFileSync(join(sub, "主播名_2026-06-27" + f), "x");
    // 预置一个「failed 的烧录节点」,续跑会先重烧;重烧抛空 message 的错误 → 节点 error 仍是空串。
    deps.ledger.syncNodeState(b.streamKey, "burn_danmu", "failed", { error: "" });
    (deps.sh as Mock).mockImplementation(async () => { throw new Error(""); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runPipeline(b, deps);
    warn.mockRestore();
    expect(r.state).toBe("needs_manual");
    expect((deps.ledger.get(b.streamKey)?.error ?? "").trim()).not.toBe("");
    deps.ledger.close();
  });


  it("合并模式 stage 收口必须写 STAGE_READY(线上噪音主来源,空 error 会被判红灯)", async () => {
    const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
    const deps = makeDeps({ cfg: { ...makeDeps().cfg, uploadMode: "stage" } });
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("needs_manual");
    expect(deps.ledger.get(broadcast.streamKey)?.error).toBe(STAGE_READY);
    deps.ledger.close();
  });

  it("所有节点断流未录全 → 转人工且必须带 error(否则会被渲染成「待上传」而非红灯)", async () => {
    // 单节点但缺口超过阈值 → clean=false → 走「全部断流」中断支。
    const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 4000 }) }]);
    const deps = makeDeps();
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("needs_manual");
    const err = deps.ledger.get(broadcast.streamKey)?.error ?? "";
    expect(err).not.toBe("");
    expect(err).not.toBe(STAGE_READY);
    deps.ledger.close();
  });

  it("场景8(硬约束): 旧规则带 includeXmlAss 也绝不删 .xml(源 xml 与 plain xml 都保留)", async () => {
    const rmStage = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(undefined);
    const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
    // 模拟生产里遗留的规则文件:仍带 includeXmlAss: true(类型已移除,清理逻辑必须忽略它)
    const legacyCleanup = { stageSourceAfterMerge: true, includeXmlAss: true } as unknown as NonNullable<PipelineCfg["cleanup"]>;
    const deps = makeDeps({
      rmStage,
      cfg: { ...makeDeps().cfg, uploadMode: "stage", cleanup: legacyCleanup },
    });
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("needs_manual");
    const stageSub = stageSubOf(deps);
    const PLAIN_XML = join(stageSub, "主播名_2026-06-27.xml");
    const SOURCE_XML = join(stageSub, "danmu.xml"); // basename of /remote/danmu.xml
    // 只删拉来的源 .ts;源 xml / plain xml 产物都不许碰
    const deleted = rmStage.mock.calls.flatMap((c) => c[0]);
    expect(deleted.every((p) => /\.ts$/i.test(p))).toBe(true);
    expect(deleted).not.toContain(SOURCE_XML);
    expect(deleted).not.toContain(PLAIN_XML);
    deps.ledger.close();
  });

  it("场景9(新口径): stageAfterDone 删 mp4 产物 + stage 内 .xml/.ass(节点源保留,不两处删光)", async () => {
    const rmStage = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(undefined);
    const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ totalGapSec: 0 }) }]);
    const cleanup = { stageAfterDone: true } as NonNullable<PipelineCfg["cleanup"]>;
    const deps = makeDeps({
      rmStage,
      cfg: { ...makeDeps().cfg, uploadMode: "upload", cleanup },
    });
    deps.ledger.upsertPending(broadcast.streamKey);
    const result = await runPipeline(broadcast, deps);
    expect(result.state).toBe("done");
    const stageSub = stageSubOf(deps);
    const deleted = rmStage.mock.calls.flatMap((c) => c[0]);
    expect(deleted.some((p) => /\.mp4$/i.test(p))).toBe(true);      // 合成 mp4 照删
    // stageAfterDone=true → 不保留 stage → stage 内 .xml/.ass 一并删(节点源那份保留)
    expect(deleted.some((p) => /\.(xml|ass)$/i.test(p))).toBe(true);
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
      deps.ledger.syncNodeState(b.streamKey, "append_danmu", "done"); // 预置 danmu 已完成
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
      deps.ledger.setState(b.streamKey, "syncing");
      deps.ledger.setState(b.streamKey, "merging");
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

    it("续跑:markDone 后补做删源(回归:续跑曾完全不删节点源 → 残留)", async () => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const stageDir = mkdtempSync(join(tmpdir(), "resume-clean-"));
      const tsFiles = ["/remote/a.ts", "/remote/b.ts"];
      const deps = makeDeps({
        cfg: { ...makeDeps().cfg, stageDir, cleanup: { sourceAfterDone: true, stageSourceAfterMerge: true } },
      });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec({ tsFiles }) }]);
      deps.ledger.upsertPending(b.streamKey);
      deps.ledger.setState(b.streamKey, "syncing");
      deps.ledger.setState(b.streamKey, "merging");
      deps.ledger.setState(b.streamKey, "uploading");
      deps.ledger.setBv(b.streamKey, "BVexisting");
      const dateName = "主播名_2026-06-27";
      const sub = join(stageDir, "douyin_test-room_2026-06-27");
      mkdirSync(sub, { recursive: true });
      for (const suf of [".mp4", "_danmu.mp4", "_livechat.mp4", ".xml"]) writeFileSync(join(sub, dateName + suf), "x");

      const r = await runPipeline(b, deps);

      expect(r).toEqual({ state: "done", bv: "BVexisting" });
      // 续跑到 done → 节点源被删(否则 VPS 上源 .ts 永久残留)。
      expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
      const cleaned = (deps.transports.get("node-1")!.cleanup as Mock).mock.calls.flatMap((c) => c[0] as string[]);
      // 未开 stageAfterDone → 保留 stage → 节点 .xml 一并删(副本在 stage)。
      expect(cleaned).toEqual([...tsFiles, "/remote/danmu.xml"]);
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

    it("Critical: P1 成功后 burn 失败 → bv 已落库,pipeline 收口 failed,重试走续跑绝不重传 P1", async () => {
      const deps = makeDeps();
      // merge 成功、burn 抛错(模拟 P1 已建稿后烧录失败)
      deps.sh.mockImplementation(async (cmd: string) => {
        if (cmd.includes(" merge ")) { writePlainArtifacts(deps); return; }
        if (cmd.includes("burn")) throw new Error("ffmpeg boom");
      });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      const r = await runPipeline(b, deps);
      expect(r.state).toBe("failed");
      expect(deps.ledger.get(b.streamKey)?.fails).toBe(1);
      expect(deps.ledger.get(b.streamKey)?.bv).toBe("BV123"); // P1 成功即落库(即使随后 burn 失败)
      // 模拟 reconciler 重试:同 ledger 再跑 → 有 bv → 续跑分支,绝不重传 P1
      deps.uploadPlain.mockClear();
      const r2 = await runPipeline(b, deps);
      expect(deps.uploadPlain).not.toHaveBeenCalled(); // 防重复稿:绝不再传 P1
      expect(r2.state).toBe("needs_manual");            // stage 无真产物 → 安全阀
      deps.ledger.close();
    });

    it("续跑遇多段组(>1 段)→ needs_manual,不 append(防重复分 P)", async () => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const stageDir = mkdtempSync(join(tmpdir(), "resume-multipart-"));
      const deps = makeDeps({
        cfg: { ...makeDeps().cfg, stageDir },
        splitForUpload: async (mp4: string) => [mp4, mp4 + ".part2"], // 模拟 >16GB 切 2 段
      });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      deps.ledger.setBv(b.streamKey, "BVexisting");
      const dateName = "主播名_2026-06-27";
      const sub = join(stageDir, "douyin_test-room_2026-06-27");
      mkdirSync(sub, { recursive: true });
      for (const suf of [".mp4", "_danmu.mp4", "_livechat.mp4"]) writeFileSync(join(sub, dateName + suf), "x");

      const r = await runPipeline(b, deps);

      expect(r.state).toBe("needs_manual");
      expect(deps.appendGroup).not.toHaveBeenCalled(); // 绝不盲目重传多段组
      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
      deps.ledger.close();
    });
  });

  // 回归(issue #26 review P1):done 场收尾补跑转人工必须 force —— done 无出边,
  // 普通 setState 被白名单拒 → job 仍 done、告警照发、周期补跑反复刷告警。真实 SyncLedger,不 mock。
  describe("resumeAppends:done 场补跑转人工(force)", () => {
    async function doneResume(over: Partial<PipelineDeps>, files: string[]) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const stageDir = mkdtempSync(join(tmpdir(), "resume-done-"));
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, stageDir }, ...over });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      for (const st of ["syncing", "merging", "uploading"] as const) deps.ledger.setState(b.streamKey, st);
      deps.ledger.markDone(b.streamKey, "BVdone");
      const sub = join(stageDir, "douyin_test-room_2026-06-27");
      mkdirSync(sub, { recursive: true });
      for (const f of files) writeFileSync(join(sub, "主播名_2026-06-27" + f), "x");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const r = await runPipeline(b, deps);
      const rejected = warn.mock.calls.filter((c) => String(c[0]).includes("[ledger]"));
      warn.mockRestore();
      return { r, deps, b, rejected };
    }

    it("done + 有稿件编号 + 弹幕产物缺失 → 台账真转 needs_manual,无非法转换 warn,不重传", async () => {
      const { r, deps, b, rejected } = await doneResume({}, [".mp4"]); // 只有 plain,缺 danmu/livechat
      expect(r.state).toBe("needs_manual");
      expect(deps.ledger.get(b.streamKey)?.state).toBe("needs_manual");
      expect(deps.ledger.get(b.streamKey)?.bv).toBe("BVdone");
      expect(rejected).toEqual([]);
      expect(deps.uploadPlain).not.toHaveBeenCalled();
      expect(deps.appendGroup).not.toHaveBeenCalled();
      deps.ledger.close();
    });

    it("done + 多段组 → 台账真转 needs_manual,无非法转换 warn,不 append", async () => {
      const { r, deps, b, rejected } = await doneResume(
        { splitForUpload: async (mp4: string) => [mp4, mp4 + ".part2"] },
        [".mp4", "_danmu.mp4", "_livechat.mp4"],
      );
      expect(r.state).toBe("needs_manual");
      expect(deps.ledger.get(b.streamKey)?.state).toBe("needs_manual");
      expect(rejected).toEqual([]);
      expect(deps.appendGroup).not.toHaveBeenCalled();
      deps.ledger.close();
    });

    it("转人工后不再是 done:ledger 不会被后续 done 守卫当作已完成而重复补跑", async () => {
      const { deps, b } = await doneResume({}, [".mp4"]);
      expect(deps.ledger.get(b.streamKey)?.state).not.toBe("done");
      deps.ledger.close();
    });
  });

  // ── 节点侧上传(experimental,见 plans/027)──────────────────────────────────
  describe("nodeSideUpload", () => {
    /** 给 transport 挂上节点侧能力(默认:支持 + biliup + cookie)。 */
    function withNodePipeline(t: Transport, over: Partial<{
      caps: { biliup: boolean; cookies: boolean; diskFreeGB: number };
      result: { ok: boolean; bv?: string; products?: string[]; error?: string };
      throwOnCall: boolean;
    }> = {}): { nodePipeline: Mock; nodeCapabilities: Mock } {
      const caps = over.caps ?? { biliup: true, cookies: true, diskFreeGB: 50 };
      const result = over.result ?? { ok: true, bv: "BVnode" };
      const nodeCapabilities = vi.fn().mockResolvedValue(caps);
      const nodePipeline = vi.fn().mockImplementation(async () => {
        if (over.throwOnCall) throw new Error("ssh 超时");
        return result;
      });
      (t as Transport).nodeCapabilities = nodeCapabilities;
      (t as Transport).nodePipeline = nodePipeline;
      return { nodePipeline, nodeCapabilities };
    }

    it("stage 模式 + flag on → 必须回落 pull 回 master(产物需落 master,节点侧无收益)", async () => {
      // stage 模式的产物必须出现在 master 的 stage 目录;省回传会让该模式失去意义。
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, uploadMode: "stage", steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t);
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      await runPipeline(b, deps);
      expect(nodePipeline).not.toHaveBeenCalled(); // 绝不走节点侧
      expect(t.pull).toHaveBeenCalled();           // 现状:pull 回 master
      deps.ledger.close();
    });

    it("shouldUseNodeSideUpload:纯判定(全局开关/stage/烧录/未开启)", async () => {
      const { shouldUseNodeSideUpload } = await import("./node-side-upload.js");
      const burnOff = { burnDanmu: false, burnLivechat: false };
      const burnOn = { burnDanmu: true, burnLivechat: false };
      // 未开启
      expect(shouldUseNodeSideUpload({ uploadMode: "upload", steps: {} }, burnOff).ok).toBe(false);
      // stage 模式
      const stageR = shouldUseNodeSideUpload({ uploadMode: "stage", steps: { nodeSideUpload: true } }, burnOff);
      expect(stageR.ok).toBe(false);
      // 需烧录
      expect(shouldUseNodeSideUpload({ uploadMode: "upload", steps: { nodeSideUpload: true } }, burnOn).ok).toBe(false);
      // 全部满足
      expect(shouldUseNodeSideUpload({ uploadMode: "upload", steps: { nodeSideUpload: true } }, burnOff).ok).toBe(true);
    });

    it("diskWatermarkGate:纯判定(低于拦 / 等于高于放行 / 阈值缺失或<=0 关闭)", async () => {
      const { diskWatermarkGate } = await import("./node-side-upload.js");
      // 低于阈值 → 拦下 + 原因字符串(调用方据此写日志,绝不静默)
      const blocked = diskWatermarkGate(3.2, 10);
      expect(blocked.ok).toBe(false);
      expect(blocked.ok === false && blocked.reason).toContain("3.2GB");
      expect(blocked.ok === false && blocked.reason).toContain("10GB");
      // 等于 / 高于 → 放行(边界取「低于」,与 reconciler 的 `freeGB < diskMinGB` 同口径)
      expect(diskWatermarkGate(10, 10).ok).toBe(true);
      expect(diskWatermarkGate(50, 10).ok).toBe(true);
      // 阈值未配置 / <=0 / NaN → 关闭闸门(向后兼容,与 reconciler 看门狗同语义)
      expect(diskWatermarkGate(0.1, undefined).ok).toBe(true);
      expect(diskWatermarkGate(0.1, 0).ok).toBe(true);
      expect(diskWatermarkGate(0.1, -1).ok).toBe(true);
      // 非数字(NaN/字符串)→ 回落默认 10GB(issue #38:不得静默绕过)
      expect(diskWatermarkGate(0.1, Number.NaN).ok).toBe(false);
      expect(diskWatermarkGate(0.1, "abc" as unknown as number).ok).toBe(false);
      expect(diskWatermarkGate(50, "abc" as unknown as number).ok).toBe(true);
      // 读数完全拿不到(旧/自定义 transport 不给该字段)→ 不因磁盘拦,靠 reconciler 看门狗兜底
      expect(diskWatermarkGate(undefined, 10).ok).toBe(true);
      expect(diskWatermarkGate(Number.NaN, 10).ok).toBe(true);
      // 读数为 0(真·盘满,线上实测形态)→ 拦下
      expect(diskWatermarkGate(0, 10).ok).toBe(false);
    });

    it("flag off(默认)→ 行为与现状一致:走 pull 回 master,不调 nodePipeline", async () => {
      const deps = makeDeps();
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t);
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      await runPipeline(b, deps);
      expect(nodePipeline).not.toHaveBeenCalled();
      expect(t.pull).toHaveBeenCalled(); // 现状:仍 pull 回 master
      deps.ledger.close();
    });

    it("flag on + 不烧录 → 节点侧处理,不 pull,markDone 带 BV", async () => {
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t);
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 真实路径由 reconciler 先建行(直接调 runPipeline 需自建)
      const r = await runPipeline(b, deps);
      expect(nodePipeline).toHaveBeenCalledTimes(1);
      expect(t.pull).not.toHaveBeenCalled();           // **关键:没有录像回传**
      expect(r).toEqual({ state: "done", bv: "BVnode" });
      expect(deps.ledger.get(b.streamKey)?.bv).toBe("BVnode");
      deps.ledger.close();
    });

    // issue #91:节点侧上传的 done 场被收尾补跑重入时,不得再撞「已建稿」护栏刷告警。
    describe("done 场收尾补跑(issue #91)", () => {
      const nodeSideCfg = (): Partial<PipelineCfg> => ({
        ...makeDeps().cfg,
        steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false },
        cleanup: { sourceAfterDone: true },
      });
      const doneJob = (deps: TestDeps, key: string): void => {
        deps.ledger.upsertPending(key);
        deps.ledger.setBv(key, "BVdone");
        deps.ledger.markDone(key, "BVdone");
      };

      it("不重新选优/拉回/上传、不转人工、不发告警;台账仍 done,照常补删源", async () => {
        const deps = makeDeps({ cfg: nodeSideCfg() as PipelineCfg });
        const t = deps.transports.get("node-1")!;
        const { nodePipeline } = withNodePipeline(t);
        const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
        doneJob(deps, b.streamKey);

        const r = await runPipeline(b, deps);

        expect(r).toEqual({ state: "done", bv: "BVdone" });
        expect(deps.ledger.get(b.streamKey)?.state).toBe("done");
        expect(nodePipeline).not.toHaveBeenCalled();
        expect(t.pull).not.toHaveBeenCalled();
        expect(deps.uploadPlain).not.toHaveBeenCalled();
        expect(deps.notify.mock.calls.filter((c) => c[0].kind === "error")).toEqual([]);
        expect(t.cleanup).toHaveBeenCalled(); // 收尾删源仍执行
        deps.ledger.close();
      });

      it("补跑删源时保留节点源 .xml(节点侧没有 stage 副本,它是最后一份)", async () => {
        const deps = makeDeps({ cfg: nodeSideCfg() as PipelineCfg });
        const t = deps.transports.get("node-1")!;
        withNodePipeline(t);
        const rec = makeRec();
        const b = makeBroadcast([{ workerId: "node-1", rec }]);
        doneJob(deps, b.streamKey);

        await runPipeline(b, deps);

        const removed = (t.cleanup as Mock).mock.calls.flatMap((c) => c[0] as string[]);
        expect(removed.length).toBeGreaterThan(0);
        expect(removed.some((p) => /\.(xml|ass)$/i.test(p))).toBe(false);
        deps.ledger.close();
      });

      it("分段模式(mergeSegments=false,线上形态)同样:不告警、不重传、保留 xml", async () => {
        const deps = makeDeps({ cfg: { ...nodeSideCfg(), steps: { nodeSideUpload: true, mergeSegments: false, burnDanmu: false, burnLivechat: false } } as PipelineCfg });
        const t = deps.transports.get("node-1")!;
        const { nodePipeline } = withNodePipeline(t);
        const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
        doneJob(deps, b.streamKey);

        const r = await runPipeline(b, deps);

        expect(r).toEqual({ state: "done", bv: "BVdone" });
        expect(nodePipeline).not.toHaveBeenCalled();
        expect(t.pull).not.toHaveBeenCalled();
        expect(deps.notify).not.toHaveBeenCalled();
        const removed = (t.cleanup as Mock).mock.calls.flatMap((c) => c[0] as string[]);
        expect(removed.length).toBeGreaterThan(0);
        expect(removed.some((p) => /\.(xml|ass)$/i.test(p))).toBe(false);
        deps.ledger.close();
      });

      it("首轮走过节点侧、之后规则改成不走节点侧(关开关/开烧录)→ 补跑仍保留节点源 .xml", async () => {
        // 只看当前配置会落到 resumeAppends → finalizeOnly(无 keepNodeXml),在 stageAfterDone=false 时删掉最后一份 xml。
        const deps = makeDeps({ cfg: { ...nodeSideCfg(), steps: { nodeSideUpload: false, burnDanmu: true, burnLivechat: false }, cleanup: { sourceAfterDone: true, stageAfterDone: false } } as PipelineCfg });
        const t = deps.transports.get("node-1")!;
        const { nodePipeline } = withNodePipeline(t);
        const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
        doneJob(deps, b.streamKey);
        deps.ledger.syncNodeState(b.streamKey, "node_upload", "done"); // 首轮确实由节点侧上传

        const r = await runPipeline(b, deps);

        expect(r).toEqual({ state: "done", bv: "BVdone" });
        expect(nodePipeline).not.toHaveBeenCalled();
        expect(t.pull).not.toHaveBeenCalled();
        const removed = (t.cleanup as Mock).mock.calls.flatMap((c) => c[0] as string[]);
        expect(removed.length).toBeGreaterThan(0);
        expect(removed.some((p) => /\.(xml|ass)$/i.test(p))).toBe(false);
        deps.ledger.close();
      });

      it("连续补跑多轮:始终不告警、不改状态(此前每轮刷一条)", async () => {
        const deps = makeDeps({ cfg: nodeSideCfg() as PipelineCfg });
        const t = deps.transports.get("node-1")!;
        withNodePipeline(t);
        const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
        doneJob(deps, b.streamKey);
        for (let i = 0; i < 3; i++) await runPipeline(b, deps);
        expect(deps.notify).not.toHaveBeenCalled();
        expect(deps.ledger.get(b.streamKey)?.state).toBe("done");
        deps.ledger.close();
      });

      it("未 done 但已有 bv(非补跑)→ 护栏照旧转人工并通知(不放宽重复投稿保护)", async () => {
        const deps = makeDeps({ cfg: nodeSideCfg() as PipelineCfg });
        const t = deps.transports.get("node-1")!;
        const { nodePipeline } = withNodePipeline(t);
        const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
        deps.ledger.upsertPending(b.streamKey);
        deps.ledger.setBv(b.streamKey, "BVhalf");

        const r = await runPipeline(b, deps);

        expect(r.state).toBe("needs_manual");
        expect(nodePipeline).not.toHaveBeenCalled();
        expect(deps.ledger.get(b.streamKey)?.state).toBe("needs_manual");
        expect(deps.notify.mock.calls.filter((c) => c[0].kind === "error")).toHaveLength(1);
        deps.ledger.close();
      });
    });

    it("flag on + 要烧录 → 回落现状(pull 回 master),不调 nodePipeline", async () => {
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, steps: { nodeSideUpload: true, burnDanmu: true } } });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t);
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      await runPipeline(b, deps);
      expect(nodePipeline).not.toHaveBeenCalled();
      expect(t.pull).toHaveBeenCalled();
      deps.ledger.close();
    });

    it("flag on 但节点不支持(旧 bundle)→ 回落现状,不静默", async () => {
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } });
      const t = deps.transports.get("node-1")!; // 无 nodePipeline/nodeCapabilities
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      const r = await runPipeline(b, deps);
      expect(t.pull).toHaveBeenCalled();
      // 台账有行后,常规路径在 mock 下能跑通:旧断言 not.toBe("done") 只是因缺行而碰巧成立。
      expect(r).toEqual({ state: "done", bv: "BV123" });
      deps.ledger.close();
    });

    it("flag on 但节点无 biliup(upload 模式)→ 回落现状", async () => {
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t, { caps: { biliup: false, cookies: true, diskFreeGB: 50 } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      await runPipeline(b, deps);
      expect(nodePipeline).not.toHaveBeenCalled();
      expect(t.pull).toHaveBeenCalled();
      deps.ledger.close();
    });

    /**
     * 磁盘水位闸门(issue #8)。节点盘写满时仍走节点侧 → 本地 remux 写盘 ENOSPC → 节点进程非 0
     * 退出 → ssh rc≠0 → 保守转人工(线上实测一整簇)。阈值与 reconciler 看门狗同源(cfg.diskMinGB)。
     */
    function nodeSideDeps(cfgExtra: Partial<PipelineCfg> = {}): { deps: TestDeps; lines: string[] } {
      const lines: string[] = [];
      const deps = makeDeps({
        cfg: { ...makeDeps().cfg, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false }, ...cfgExtra },
        makeRunLogger: () => ({ info: (...a: unknown[]) => lines.push(a.join(" ")), warn: () => {}, error: () => {} }),
      });
      deps.ledger.upsertPending(STREAM_KEY); // 真实路径由 reconciler 先建行(直接调 runPipeline 需自建)
      return { deps, lines };
    }

    it("① 节点剩余磁盘 < 阈值 → 不选节点侧,回落 pull 回 master,并记明回落原因", async () => {
      const { deps, lines } = nodeSideDeps({ diskMinGB: 10 });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t, { caps: { biliup: true, cookies: true, diskFreeGB: 0.5 } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      await runPipeline(b, deps);
      expect(nodePipeline).not.toHaveBeenCalled(); // 绝不走节点侧(盘满会让 remux 写盘 ENOSPC)
      expect(t.pull).toHaveBeenCalled();           // 现状:pull 回 master(节点侧出现前的原有路径)
      // 绝不静默:必须写明「低于阈值」这个原因
      expect(lines.some((l) => l.includes("节点侧上传不可用") && l.includes("0.5GB") && l.includes("阈值 10GB"))).toBe(true);
      deps.ledger.close();
    });

    it("② 剩余磁盘 == 阈值 → 照常节点侧(边界取「低于」才拦,与 reconciler 的 `< diskMinGB` 同口径)", async () => {
      const { deps } = nodeSideDeps({ diskMinGB: 10 });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t, { caps: { biliup: true, cookies: true, diskFreeGB: 10 } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      const r = await runPipeline(b, deps);
      expect(nodePipeline).toHaveBeenCalledTimes(1);
      expect(t.pull).not.toHaveBeenCalled();
      expect(r).toEqual({ state: "done", bv: "BVnode" });
      deps.ledger.close();
    });

    it("② 剩余磁盘 > 阈值 → 照常节点侧", async () => {
      const { deps } = nodeSideDeps({ diskMinGB: 10 });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t, { caps: { biliup: true, cookies: true, diskFreeGB: 50 } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      const r = await runPipeline(b, deps);
      expect(nodePipeline).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ state: "done", bv: "BVnode" });
      deps.ledger.close();
    });

    it("③ 阈值未配置(向后兼容)→ 不因磁盘拦:盘再小也照常节点侧", async () => {
      // 老配置 / 老调用方不带 diskMinGB ⇒ 行为与本次改动前完全一致(闸门关闭)。
      const { deps } = nodeSideDeps(); // 无 diskMinGB
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t, { caps: { biliup: true, cookies: true, diskFreeGB: 0.1 } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      const r = await runPipeline(b, deps);
      expect(nodePipeline).toHaveBeenCalledTimes(1);
      expect(t.pull).not.toHaveBeenCalled();
      expect(r).toEqual({ state: "done", bv: "BVnode" });
      deps.ledger.close();
    });

    it("③ 阈值 <=0(显式关闸,与 reconciler 看门狗同语义)→ 不拦", async () => {
      const { deps } = nodeSideDeps({ diskMinGB: 0 });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t, { caps: { biliup: true, cookies: true, diskFreeGB: 0.1 } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      await runPipeline(b, deps);
      expect(nodePipeline).toHaveBeenCalledTimes(1);
      deps.ledger.close();
    });

    it("③b 磁盘读数缺失(旧/自定义 transport 不给该字段)→ 不因磁盘拦(靠 reconciler 看门狗兜底)", async () => {
      // 拿不到读数 ≠ 盘满:拦下等于把「探测异常」当「盘满」白放弃省回传。与 serve.ts freeBytes 返 null 同口径。
      const { deps } = nodeSideDeps({ diskMinGB: 10 });
      const t = deps.transports.get("node-1")!;
      const caps = { biliup: true, cookies: true } as unknown as { biliup: boolean; cookies: boolean; diskFreeGB: number };
      const { nodePipeline } = withNodePipeline(t, { caps });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      const r = await runPipeline(b, deps);
      expect(nodePipeline).toHaveBeenCalledTimes(1);
      expect(t.pull).not.toHaveBeenCalled();
      expect(r).toEqual({ state: "done", bv: "BVnode" });
      deps.ledger.close();
    });

    it("节点侧执行失败(ok=false)→ 标 failed + 通知,绝不静默", async () => {
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } });
      const t = deps.transports.get("node-1")!;
      withNodePipeline(t, { result: { ok: false, error: "biliup 退出码 1" } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      const r = await runPipeline(b, deps);
      expect(r.state).toBe("failed");
      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
      deps.ledger.close();
    });

    it("节点侧抛错(ssh 失败)→ 标 failed + 通知", async () => {
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } });
      const t = deps.transports.get("node-1")!;
      withNodePipeline(t, { throwOnCall: true });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey); // 直接调 runPipeline 需自建行(真实路径由 reconciler 建)
      const r = await runPipeline(b, deps);
      expect(r.state).toBe("failed");
      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
      deps.ledger.close();
    });

    it("分段模式(mergeSegments=false)+ flag on → 同样走节点侧,不 pull(9 个房间的实际形态)", async () => {
      // 线上 flip 的房间全是「不分段合并(逐段产出)+ 不烧录 + upload」:分段与合并在节点侧
      // 是同一条路(节点自己逐段 remux/聚组),所以绝不能因为 mergeSegments=false 就回落 pull。
      const deps = makeDeps({
        cfg: { ...makeDeps().cfg, uploadMode: "upload", steps: { nodeSideUpload: true, mergeSegments: false, burnDanmu: false, burnLivechat: false } },
      });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t);
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      const r = await runPipeline(b, deps);
      expect(nodePipeline).toHaveBeenCalledTimes(1);
      expect(t.pull).not.toHaveBeenCalled();          // **关键:没有录像回传**
      expect(r).toEqual({ state: "done", bv: "BVnode" });
      deps.ledger.close();
    });

    it("flag on + cleanup.sourceAfterDone → 节点侧成功后必须调 transport.cleanup 删节点源", async () => {
      // 回归:节点侧路径**提前 return**,常规路径的 cleanupSources() 走不到 → 节点上的 .ts
      // 永远没人删(线上实测泄漏)。收尾必须在节点侧这条路上补一次。
      const deps = makeDeps({
        cfg: {
          ...makeDeps().cfg,
          steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false },
          cleanup: { sourceAfterDone: true, stageAfterDone: true },
        },
      });
      const t = deps.transports.get("node-1")!;
      withNodePipeline(t);
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      const r = await runPipeline(b, deps);
      expect(r).toEqual({ state: "done", bv: "BVnode" });
      expect(t.cleanup).toHaveBeenCalledTimes(1);
      const paths = (t.cleanup as Mock).mock.calls[0]![0] as string[];
      expect(paths).toEqual(["/remote/a.ts", "/remote/b.ts"]);
      expect(paths).not.toContain("/remote/danmu.xml"); // stageAfterDone=true → 节点 .xml 是最后一份
      deps.ledger.close();
    });

    it("落败节点的源也要删(收尾按全部在场成员,不只 winner)", async () => {
      // 与常规路径同口径:落败节点那份源同样是冗余副本,不删就永远占磁盘。
      const deps = makeDeps({
        cfg: {
          ...makeDeps().cfg,
          steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false },
          cleanup: { sourceAfterDone: true, stageAfterDone: true },
        },
      });
      const t1 = deps.transports.get("node-1")!;
      const t2 = deps.transports.get("node-2")!;
      withNodePipeline(t1);
      const now = Date.now();
      const b = makeBroadcast([
        // node-1 录满整场(winner);node-2 只录到前半场(落败)
        { workerId: "node-1", rec: makeRec({ startMs: now - 3_600_000, endMs: now }) },
        { workerId: "node-2", rec: makeRec({ startMs: now - 3_600_000, endMs: now - 1_800_000, durationSec: 1800, tsFiles: ["/remote2/c.ts"], xmlPath: "/remote2/danmu.xml" }) },
      ]);
      deps.ledger.upsertPending(b.streamKey);
      const r = await runPipeline(b, deps);
      expect(r).toEqual({ state: "done", bv: "BVnode" });
      expect(t1.cleanup).toHaveBeenCalledTimes(1);
      expect(t2.cleanup).toHaveBeenCalledTimes(1); // 落败节点同样被清
      expect((t2.cleanup as Mock).mock.calls[0]![0]).toEqual(["/remote2/c.ts"]);
      deps.ledger.close();
    });

    it("已建稿(bv 已落库)→ 走节点侧前先拦下,转人工、绝不重复投稿", async () => {
      // 节点侧上传绕过 master 的 append 续跑接缝:若本场已建过稿,再执行一次 = 重复投稿
      // (B站不支持改稿件视频内容,只能删稿重传)。护栏必须挡在**调用节点之前**。
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } });
      const t = deps.transports.get("node-1")!;
      const { nodePipeline } = withNodePipeline(t);
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey);
      deps.ledger.setBv(b.streamKey, "BVold");
      const r = await runPipeline(b, deps);
      expect(nodePipeline).not.toHaveBeenCalled();     // 绝不在已建稿后再执行一次
      expect(t.pull).not.toHaveBeenCalled();           // 也不 pull(源可能在清理中/已清)
      expect(r.state).toBe("needs_manual");
      expect(deps.ledger.get(b.streamKey)?.bv).toBe("BVold");
      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
      deps.ledger.close();
    });
  });

  // ── T11/T12:上传后收尾(产物核验 + 延迟删源 + 清理失败可见)────────────────────
  describe("上传后收尾(T11 产物核验 / T12 清理独立化)", () => {
    const CLEANUP_CFG = { sourceAfterDone: true } as const;

    /** 合并路径跑到 done 的 deps(sourceAfterDone 开启,便于观察删源)。 */
    function uploadDeps(overrides: Partial<PipelineDeps> = {}, cfgExtra: Partial<PipelineCfg> = {}): TestDeps {
      const deps = makeDeps(overrides);
      (deps as { cfg: PipelineCfg }).cfg = { ...deps.cfg, cleanup: CLEANUP_CFG, ...cfgExtra };
      return deps;
    }
    /** pipeline 假定 job 行已由 reconciler 建好;直接调 runPipeline 的用例需先 upsert。 */
    function run(deps: TestDeps, members = [{ workerId: "node-1", rec: makeRec() }]) {
      const b = makeBroadcast(members);
      deps.ledger.upsertPending(b.streamKey, b.startMs);
      return runPipeline(b, deps);
    }

    it("合并路径核验通过(期望 3 实际 3)→ 删源(transport.cleanup 被调)", async () => {
      const deps = uploadDeps({ countParts: async () => 3 });
      const r = await run(deps);
      expect(r.state).toBe("done");
      // 合并路径此前不写 sync_parts → 期望恒 0;现在写了 → 期望 3(P1+danmu+livechat)。
      expect(deps.ledger.doneParts(STREAM_KEY, "plain").size).toBe(1);
      expect(deps.ledger.doneParts(STREAM_KEY, "append_danmu").size).toBe(1);
      expect(deps.ledger.getNodeState(STREAM_KEY, "clean_verify")?.state).toBe("done");
      expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
    });

    it("合并路径 回读少于期望(期望 3 实际 2)→ 仍 done,**照常删节点源**(issue #92)", async () => {
      // 收口不再同步回读;回读在延迟后旁路执行(只记录/告警)。
      const deps = uploadDeps({ countParts: async () => 2 });
      const r = await run(deps);
      expect(r.state).toBe("done");
      expect(r.bv).toBe("BV123");                    // 上传确实成功了
      expect(deps.ledger.get(STREAM_KEY)?.state).toBe("done");
      expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
    });

    it("countParts 返回 null → 不影响清理:照常删源、clean_verify 记 done(不再留 pending)、不转人工", async () => {
      const deps = uploadDeps({ countParts: async () => null });
      const r = await run(deps);
      expect(r.state).toBe("done");                   // 上传成功的事实不被回滚
      expect(deps.ledger.getNodeState(STREAM_KEY, "clean_verify")?.state).toBe("done");
      expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
      expect(deps.ledger.get(STREAM_KEY)?.state).not.toBe("needs_manual");
    });

    it("未注入 countParts → 核验关闭,清理行为与现状一致(照常删源)", async () => {
      const deps = uploadDeps();
      const r = await run(deps);
      expect(r.state).toBe("done");
      expect(deps.ledger.getNodeState(STREAM_KEY, "clean_verify")?.state).toBe("done"); // 走 skipped 分支
      expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
    });

    it("清理失败(transport.cleanup 抛错)→ job 仍 done + clean_source=failed(可补跑)", async () => {
      const t1 = makeTransport("node-1");
      (t1.cleanup as Mock).mockRejectedValue(new Error("磁盘只读"));
      const deps = uploadDeps({ transports: new Map([["node-1", t1]]), countParts: async () => 3 });
      const r = await run(deps);
      expect(r.state).toBe("done");                                            // 终态不被清理失败改写
      expect(deps.ledger.get(STREAM_KEY)?.state).toBe("done");
      expect(deps.ledger.getNodeState(STREAM_KEY, "clean_source")?.state).toBe("failed");
      expect(deps.ledger.getNodeState(STREAM_KEY, "clean_source")?.error).toContain("磁盘只读");
    });

    it("清理重试幂等:文件已不存在时再次清理不报错、clean_source 转 done", async () => {
      const t1 = makeTransport("node-1");
      const deps = uploadDeps({ transports: new Map([["node-1", t1]]), countParts: async () => 3 });
      await run(deps);
      expect(deps.ledger.getNodeState(STREAM_KEY, "clean_source")?.state).not.toBe("failed");
      // 第二次 cleanup 抛「文件已不存在」类错误(rm force 的常见表现)→ 仍如实记账但不炸。
      (t1.cleanup as Mock).mockRejectedValue(new Error("ENOENT: no such file"));
      const out = await cleanupSourcesShared({
        streamKey: STREAM_KEY, ledger: deps.ledger, transports: deps.transports,
        members: [{ workerId: "node-1", rec: makeRec() }], cleanup: CLEANUP_CFG,
        rmStage: async () => {}, log: () => {},
      });
      expect(out.ok).toBe(false);
      expect(out.failed[0].error).toContain("ENOENT");
    });

    it("transport 无 cleanup 能力 → 如实记 failed(不静默:否则磁盘涨了没人知道)", async () => {
      const t1 = makeTransport("node-1");
      delete (t1 as { cleanup?: unknown }).cleanup;
      const deps = uploadDeps({ transports: new Map([["node-1", t1]]), countParts: async () => 3 });
      const r = await run(deps);
      expect(r.state).toBe("done");
      expect(deps.ledger.getNodeState(STREAM_KEY, "clean_source")?.error).toContain("无 cleanup 能力");
    });

    it("已 done 的 job 收尾补跑:stage 产物已清 → **只补清理**,绝不转 needs_manual", async () => {
      // 回归:T12 补跑走 resumeAppends 时,若 stageAfterDone 已把 stage 清空,老逻辑会判
      // 「stage 产物缺失 → 转人工」,把一个**上传早已成功**的 done job 打成 needs_manual
      // (UI 显示待人工,而稿件好好的)。补跑必须只清理。
      const deps = uploadDeps({ countParts: async () => 3 }, { cleanup: { sourceAfterDone: true, stageAfterDone: true } });
      const b = makeBroadcast([{ workerId: "node-1", rec: makeRec() }]);
      deps.ledger.upsertPending(b.streamKey, b.startMs);
      deps.ledger.setBv(b.streamKey, "BV123");
      deps.ledger.markDone(b.streamKey, "BV123");
      deps.ledger.syncNodeState(b.streamKey, "clean_source", "failed", { error: "上一轮磁盘满" });
      // stage 目录里没有产物(已清理)。
      const r = await runPipeline(b, deps);
      expect(r.state).toBe("done");
      expect(deps.ledger.get(b.streamKey)?.state).toBe("done");
      // 补清理真的跑了。
      expect(deps.transports.get("node-1")!.cleanup).toHaveBeenCalled();
      expect(deps.uploadPlain).not.toHaveBeenCalled();   // 绝不重复投稿
    });

    it("stage 清理失败(rmStage 抛错)→ job 仍 done + clean_stage=failed", async () => {
      const deps = uploadDeps({
        countParts: async () => 3,
        rmStage: async () => { throw new Error("stage 挂载掉了"); },
      }, { cleanup: { ...CLEANUP_CFG, stageAfterDone: true } });
      const r = await run(deps);
      expect(r.state).toBe("done");
      expect(deps.ledger.get(STREAM_KEY)?.state).toBe("done");
    });
  });
});

// ── 边录边传(T-33)识别短路:录制节点已自己建稿 → 绝不重复建稿 ─────────────────
describe("runPipeline — 边录边传识别短路", () => {
  it("rolling.bv 存在且无不确定段 → 直接 done,绝不 pull/upload", async () => {
    const rec = makeRec({ totalGapSec: 0, tsFiles: [] }); // 段已被节点删空
    rec.rolling = { bv: "BV1rolling", confirmed: [0, 1], ambiguous: [] };
    const broadcast = makeBroadcast([{ workerId: "node-1", rec }]);
    // 成员「文件已不存在」不被剔除(rolling.bv 且 tsFiles 空 → 预期)。
    const deps = makeDeps();
    deps.transports.get("node-1")!.exists = vi.fn().mockResolvedValue(false);
    deps.ledger.upsertPending(broadcast.streamKey);

    const r = await runPipeline(broadcast, deps);
    expect(r.state).toBe("done");
    expect(r.bv).toBe("BV1rolling");
    expect(deps.uploadPlain).not.toHaveBeenCalled(); // 绝不重复建稿
    expect(deps.sh).not.toHaveBeenCalled();          // 也不该走 merge/burn
  });

  it("rolling.bv 但存在不确定段(ambiguous)→ needs_manual,保留源,不自动重传", async () => {
    const rec = makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts"] });
    rec.rolling = { bv: "BV1rolling2", confirmed: [0], ambiguous: [1] };
    const broadcast = makeBroadcast([{ workerId: "node-2", rec }]);
    const deps = makeDeps();
    deps.ledger.upsertPending(broadcast.streamKey);

    const r = await runPipeline(broadcast, deps);
    expect(r.state).toBe("needs_manual");
    expect(deps.uploadPlain).not.toHaveBeenCalled();
  });

  it("rolling.bv 但磁盘仍剩未确认分段 → needs_manual(不静默 done,防丢片)", async () => {
    const rec = makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_005.ts"] });
    rec.rolling = { bv: "BV1rolling3", confirmed: [0, 1], ambiguous: [] };
    const broadcast = makeBroadcast([{ workerId: "node-1", rec }]);
    const deps = makeDeps();
    deps.transports.get("node-1")!.exists = vi.fn().mockResolvedValue(true);
    deps.ledger.upsertPending(broadcast.streamKey);
    const r = await runPipeline(broadcast, deps);
    expect(r.state).toBe("needs_manual");
    expect(deps.uploadPlain).not.toHaveBeenCalled();
  });

  it("多节点各建稿(BV 不一致)→ needs_manual(防重复稿隐患)", async () => {
    const r1 = makeRec({ totalGapSec: 0, tsFiles: [] });
    r1.rolling = { bv: "BV1aaa", confirmed: [0], ambiguous: [] };
    const r2 = makeRec({ totalGapSec: 0, tsFiles: [] });
    r2.rolling = { bv: "BV1bbb", confirmed: [0], ambiguous: [] };
    const broadcast = makeBroadcast([
      { workerId: "node-1", rec: r1 },
      { workerId: "node-2", rec: r2 },
    ]);
    const deps = makeDeps();
    deps.ledger.upsertPending(broadcast.streamKey);

    const r = await runPipeline(broadcast, deps);
    expect(r.state).toBe("needs_manual");
    expect(deps.uploadPlain).not.toHaveBeenCalled();
  });

  it("无 rolling.bv → 走常规路径(边录边传未启用,行为不变)", async () => {
    const rec = makeRec({ totalGapSec: 0, tsFiles: ["/remote/s_000.ts"] });
    const broadcast = makeBroadcast([{ workerId: "node-1", rec }]);
    const deps = makeDeps();
    // 模拟 merge/burn 产物,让常规 workflow 通过(与既有 runDeps 同口径)。
    const stageSub = join(deps.cfg.stageDir, "douyin_test-room_2026-06-27");
    mkdirSync(stageSub, { recursive: true });
    writeFileSync(join(stageSub, "src.ts"), "x");
    writeFileSync(join(stageSub, "danmu.xml"), "x");
    writeFileSync(join(stageSub, "主播名_2026-06-27.mp4"), "x");
    writeFileSync(join(stageSub, "主播名_2026-06-27.xml"), "x");
    deps.ledger.upsertPending(broadcast.streamKey);
    const r = await runPipeline(broadcast, deps);
    // 常规路径:uploadPlain 被调用(建稿),未触发 rolling 短路。
    expect(deps.uploadPlain).toHaveBeenCalled();
    expect(r.state).toBe("done");
  });

  describe("issue #143:拉取的视频分段必须全被 stage 会话认领", () => {
    const A = "主播名_2026-06-27_08-00-00";
    const B = "主播名_2026-06-27_09-00-00";
    /** 让 pull 把给定文件名真实落进 stage(模拟 rsync/硬链接)。 */
    const pullWrites = (deps: TestDeps, pulledSidecar: { v?: string[] } = {}) => {
      (deps.transports.get("node-1")!.pull as Mock).mockImplementation(async (paths: string[], dir: string) => {
        pulledSidecar.v = paths;
        mkdirSync(dir, { recursive: true });
        for (const p of paths) {
          const name = p.split("/").pop()!;
          writeFileSync(join(dir, name), name.endsWith(".session.json") ? JSON.stringify({ nodeFormat: "mkv" }) : "x");
        }
      });
    };
    const recs = (withSidecar: boolean) => makeRec({
      sessionBase: A,
      tsFiles: [`/remote/${A}.mkv`, `/remote/${B}.ts`],
      xmlPath: undefined,
      ...(withSidecar ? { sessionJsonPath: `/remote/${A}.session.json` } : {}),
    });

    it("带边车:pull 清单含边车且不入清理清单,混合容器全部进合并", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, cleanup: { sourceAfterDone: true } } });
      const seen: { v?: string[] } = {};
      pullWrites(deps, seen);
      deps.ledger.upsertPending(broadcast.streamKey);
      const r = await runPipeline(broadcast, deps);
      expect(seen.v).toContain(`/remote/${A}.session.json`);
      expect(r.state).toBe("done");
      expect(deps.sh.mock.calls.some((c) => String(c[0]).includes(" merge "))).toBe(true);
      // 清理只认 tsFiles:边车绝不当视频删。
      const cleaned = ((deps.transports.get("node-1")!.cleanup as Mock).mock.calls.flat(2)) as string[];
      expect(cleaned.some((p) => p.endsWith(".session.json"))).toBe(false);
      deps.ledger.close();
    });

    it("边车缺失(旧 bundle):mkv 无人认领 → needs_manual + 告警,不 merge、不上传、不删源", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: recs(false) }]);
      const deps = makeDeps({ cfg: { ...makeDeps().cfg, cleanup: { sourceAfterDone: true, stageSourceAfterMerge: true } } });
      pullWrites(deps);
      deps.ledger.upsertPending(broadcast.streamKey);
      const r = await runPipeline(broadcast, deps);
      expect(r.state).toBe("needs_manual");
      expect(deps.sh.mock.calls.some((c) => String(c[0]).includes(" merge "))).toBe(false);
      expect(deps.uploadPlain).not.toHaveBeenCalled();
      expect(deps.transports.get("node-1")!.cleanup).not.toHaveBeenCalled();
      const err = deps.notify.mock.calls.map((c) => c[0] as { kind: string; message?: string }).find((e) => e.kind === "error");
      expect(err?.message).toContain("1 个");
      expect(deps.ledger.get(broadcast.streamKey)?.state).toBe("needs_manual");
      deps.ledger.close();
    });

    // issue #146: sidecar removed between scan and pull -> skip the round, then regroup on rescan.
    const sidecarGone = (deps: TestDeps) => {
      (deps.transports.get("node-1")!.exists as Mock).mockImplementation(async (paths: string[]) => !paths.some((p) => p.endsWith(".session.json")));
    };

    it("issue #146:扫描后边车消失 → 本轮跳过:不 pull、不 failed、不告警;下一轮重扫(边车不再声明)正常收口", async () => {
      const deps = makeDeps();
      sidecarGone(deps);
      pullWrites(deps);
      const first = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(first.streamKey);
      const r1 = await runPipeline(first, deps);
      expect(r1.state).toBe("pending");
      expect(deps.transports.get("node-1")!.pull).not.toHaveBeenCalled();
      expect(deps.ledger.get(first.streamKey)?.state).toBe("pending"); // 仍在 RETRYABLE,不卡在 syncing
      expect(deps.ledger.get(first.streamKey)?.state).not.toBe("failed");
      expect(deps.notify.mock.calls.some((c) => (c[0] as { kind: string }).kind === "error")).toBe(false);
      expect(deps.uploadPlain).not.toHaveBeenCalled();
      expect(deps.transports.get("node-1")!.cleanup).not.toHaveBeenCalled();
      // 下一轮:重扫后本场不再声明边车,分段是原生 .ts → 照常合并上传收口。
      const second = makeBroadcast([{ workerId: "node-1", rec: makeRec({ sessionBase: B, tsFiles: [`/remote/${B}.ts`], xmlPath: undefined }) }]);
      const r2 = await runPipeline(second, deps);
      expect(r2.state).toBe("done");
      expect(deps.ledger.get(first.streamKey)?.state).toBe("done");
      deps.ledger.close();
    });

    it("issue #146:边车消失 → 跳过时必须留痕:job 日志含「会话边车扫描后已消失 … 本轮跳过」,台账 pull 步骤记明原因", async () => {
      const lines: string[] = [];
      const deps = makeDeps({ makeRunLogger: () => ({ info: (...a: unknown[]) => lines.push(a.join(" ")), warn: (...a: unknown[]) => lines.push(a.join(" ")), error: () => {} }) });
      sidecarGone(deps);
      pullWrites(deps);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      await runPipeline(b, deps);
      expect(lines.some((l) => l.includes("会话边车扫描后已消失") && l.includes(`${A}.session.json`) && l.includes("本轮跳过"))).toBe(true);
      const skip = deps.ledger.getSteps(b.streamKey).filter((s) => s.step === "pull");
      expect(skip).toHaveLength(1);
      expect(skip[0].detail).toContain("会话边车扫描后消失");
      expect(deps.ledger.get(b.streamKey)?.state).toBe("pending"); // 标注不改 state
      deps.ledger.close();
    });

    it("issue #146:持续缺失 → 连续跳过 3 轮后第 4 轮转 needs_manual + 告警恰一次(不无限 pending、不删源)", async () => {
      const deps = makeDeps();
      sidecarGone(deps);
      pullWrites(deps);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      for (let i = 0; i < 3; i++) {
        expect((await runPipeline(b, deps)).state).toBe("pending");
        expect(deps.notify.mock.calls.some((c) => (c[0] as { kind: string }).kind === "error")).toBe(false);
      }
      expect((await runPipeline(b, deps)).state).toBe("needs_manual");
      expect(deps.ledger.get(b.streamKey)?.state).toBe("needs_manual");
      const errs = deps.notify.mock.calls.map((c) => c[0] as { kind: string; message?: string }).filter((e) => e.kind === "error");
      expect(errs).toHaveLength(1);
      expect(errs[0].message).toContain("连续 3 轮");
      expect(deps.transports.get("node-1")!.pull).not.toHaveBeenCalled();
      expect(deps.transports.get("node-1")!.cleanup).not.toHaveBeenCalled();
      expect(deps.uploadPlain).not.toHaveBeenCalled();
      deps.ledger.close();
    });

    it("issue #146:跳过后边车恢复并真正 pull → 连续计数清零(之后再跳过从第 1 次起算)", async () => {
      const deps = makeDeps();
      pullWrites(deps);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      const exists = deps.transports.get("node-1")!.exists as Mock;
      exists.mockImplementation(async (paths: string[]) => !paths.some((p) => p.endsWith(".session.json")));
      await runPipeline(b, deps);
      await runPipeline(b, deps);
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(2);
      deps.ledger.logStep(b.streamKey, "pull", "start"); // 一次真实的 pull 开始
      deps.ledger.logStep(b.streamKey, "pull", "done");
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(0);
      deps.ledger.close();
    });

    it("issue #146:winner 有 2 个会话、仅第 2 个会话的边车消失 → 本轮跳过(逐会话复核)", async () => {
      const t0 = Date.now() - 3_600_000;
      const mk = (base: string, start: number, ts: string) => makeRec({
        sessionBase: base, tsFiles: [ts], xmlPath: undefined, startMs: start, endMs: start + 1_800_000,
        durationSec: 1800, sessionJsonPath: `/remote/${base}.session.json`,
      });
      const b = makeBroadcast([
        { workerId: "node-1", rec: mk(A, t0, `/remote/${A}.ts`) },
        { workerId: "node-1", rec: mk(B, t0 + 1_800_000, `/remote/${B}.ts`) },
      ]);
      const deps = makeDeps();
      (deps.transports.get("node-1")!.exists as Mock).mockImplementation(async (paths: string[]) => !paths.some((p) => p.endsWith(`${B}.session.json`)));
      pullWrites(deps);
      deps.ledger.upsertPending(b.streamKey);
      expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(deps.transports.get("node-1")!.pull).not.toHaveBeenCalled();
      deps.ledger.close();
    });

    it("issue #146(已知残余):重扫后无边车的 mkv 对 hub 不可见(groupSessions 不收)→ 只按可见分段收口,不是被未认领门禁拦下", async () => {
      const deps = makeDeps();
      sidecarGone(deps);
      pullWrites(deps);
      const first = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(first.streamKey);
      expect((await runPipeline(first, deps)).state).toBe("pending");
      // 真实重扫:无边车 → mkv 不进清单,只剩原生 .ts。
      const second = makeBroadcast([{ workerId: "node-1", rec: makeRec({ sessionBase: B, tsFiles: [`/remote/${B}.ts`], xmlPath: undefined }) }]);
      expect((await runPipeline(second, deps)).state).toBe("done");
      deps.ledger.close();
    });

    it("issue #146:exists 抛错(探测本身失败)→ 本轮跳过,不 pull、不 failed、不计入上限", async () => {
      const deps = makeDeps();
      (deps.transports.get("node-1")!.exists as Mock).mockImplementation(async (paths: string[]) => {
        if (paths.some((p) => p.endsWith(".session.json"))) throw new Error("ssh down");
        return true;
      });
      pullWrites(deps);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(deps.transports.get("node-1")!.pull).not.toHaveBeenCalled();
      // A failed probe carries no evidence and must not accumulate toward the limit.
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(0);
      expect(deps.ledger.getSteps(b.streamKey).some((s) => s.detail?.startsWith(SIDECAR_UNKNOWN_PREFIX))).toBe(true);
      deps.ledger.close();
    });

    it("issue #146:exists=false 但 ping 失败(节点不可达)→ 跳过且不计入上限,反复抖动也永不转人工", async () => {
      const deps = makeDeps();
      sidecarGone(deps);
      (deps.transports.get("node-1")!.ping as Mock).mockRejectedValue(new Error("ssh 超时"));
      pullWrites(deps);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      // Far more rounds than the limit: a healthy session must never be escalated by a flaky link.
      for (let i = 0; i < 6; i++) expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(0);
      expect(deps.ledger.get(b.streamKey)?.state).toBe("pending");
      expect(deps.notify.mock.calls.some((c) => (c[0] as { kind: string }).kind === "error")).toBe(false);
      expect(deps.transports.get("node-1")!.pull).not.toHaveBeenCalled();
      expect(deps.transports.get("node-1")!.cleanup).not.toHaveBeenCalled();
      deps.ledger.close();
    });

    it("issue #146:确认缺失与不可达交替 → 不可达轮既不计数也不清零(已确认的证据仍然成立)", async () => {
      const deps = makeDeps();
      const ping = deps.transports.get("node-1")!.ping as Mock;
      pullWrites(deps);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      // Round 1: confirmed missing (reachable + file absent).
      sidecarGone(deps);
      expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(1);
      // Round 2: node unreachable - neither counts nor resets.
      ping.mockRejectedValue(new Error("ssh 超时"));
      expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(1);
      // Round 3: reachable again and still missing -> evidence continues, count reaches 2.
      ping.mockResolvedValue(undefined);
      expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(2);
      deps.ledger.close();
    });

    it("issue #146:连续确认缺失满上限后转人工;若中途只有不可达轮,则永不到上限", async () => {
      const deps = makeDeps();
      const ping = deps.transports.get("node-1")!.ping as Mock;
      pullWrites(deps);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      // 2 confirmed + 2 unreachable rounds: unreachable rounds do not advance the count.
      sidecarGone(deps);
      await runPipeline(b, deps);
      await runPipeline(b, deps);
      ping.mockRejectedValue(new Error("ssh 超时"));
      await runPipeline(b, deps);
      await runPipeline(b, deps);
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(2);
      expect(deps.ledger.get(b.streamKey)?.state).toBe("pending");
      // Reachable again -> the 3rd confirmed round hits the limit, the next one escalates.
      ping.mockResolvedValue(undefined);
      expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(3);
      expect((await runPipeline(b, deps)).state).toBe("needs_manual");
      const errs = deps.notify.mock.calls.map((c) => c[0] as { kind: string }).filter((e) => e.kind === "error");
      expect(errs).toHaveLength(1);
      deps.ledger.close();
    });

    it("issue #146:无 ping 能力的 transport 保留旧口径(exists=false 即计入上限)", async () => {
      const deps = makeDeps();
      const tp = deps.transports.get("node-1")!;
      delete (tp as { ping?: unknown }).ping;   // legacy / third-party transport
      sidecarGone(deps);
      pullWrites(deps);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(1);
      deps.ledger.close();
    });

    it("issue #146:已到上限时,一个「无法确认」的轮次不得转人工(只有确认缺失才触发)", async () => {
      const deps = makeDeps();
      const ping = deps.transports.get("node-1")!.ping as Mock;
      sidecarGone(deps);
      pullWrites(deps);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      // Accumulate 3 confirmed-missing rounds (at the limit).
      for (let i = 0; i < 3; i++) expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(3);
      // An unreachable round must not escalate even when the prior count is already at the limit.
      ping.mockRejectedValue(new Error("ssh 超时"));
      expect((await runPipeline(b, deps)).state).toBe("pending");
      expect(deps.ledger.get(b.streamKey)?.state).toBe("pending");
      expect(deps.notify.mock.calls.some((c) => (c[0] as { kind: string }).kind === "error")).toBe(false);
      // Reachable again and still missing -> only now escalate, with exactly one alert.
      ping.mockResolvedValue(undefined);
      expect((await runPipeline(b, deps)).state).toBe("needs_manual");
      const errs = deps.notify.mock.calls.map((c) => c[0] as { kind: string }).filter((e) => e.kind === "error");
      expect(errs).toHaveLength(1);
      deps.ledger.close();
    });

    it("issue #146:混合轮(同节点两会话:一个确认缺失 + 一个探测失败)→ 两种台账标注都写,计数只 +1", async () => {
      const t0 = Date.now() - 3_600_000;
      const mk = (base: string, start: number) => makeRec({
        sessionBase: base, tsFiles: [`/remote/${base}.ts`], xmlPath: undefined, startMs: start, endMs: start + 1_800_000,
        durationSec: 1800, sessionJsonPath: `/remote/${base}.session.json`,
      });
      // winnerMembers = the winner node's own sessions, so both must belong to node-1.
      const b = makeBroadcast([
        { workerId: "node-1", rec: mk(A, t0) },
        { workerId: "node-1", rec: mk(B, t0 + 1_800_000) },
      ]);
      const deps = makeDeps();
      // Session A: reachable, sidecar gone. Session B: the probe itself fails.
      (deps.transports.get("node-1")!.exists as Mock).mockImplementation(async (paths: string[]) => {
        if (paths.some((p) => p.endsWith(`${B}.session.json`))) throw new Error("ssh down");
        return !paths.some((p) => p.endsWith(".session.json"));
      });
      pullWrites(deps);
      deps.ledger.upsertPending(b.streamKey);
      expect((await runPipeline(b, deps)).state).toBe("pending");
      const steps = deps.ledger.getSteps(b.streamKey).filter((s) => s.step === "pull");
      expect(steps.some((s) => s.detail?.startsWith(SIDECAR_SKIP_PREFIX))).toBe(true);
      expect(steps.some((s) => s.detail?.startsWith(SIDECAR_UNKNOWN_PREFIX))).toBe(true);
      expect(consecutiveSidecarSkips(deps.ledger.getSteps(b.streamKey))).toBe(1); // only the confirmed session counts
      deps.ledger.close();
    });

    it("issue #146:边车仍在 → 不影响原路径(pull 含边车、正常完成)", async () => {
      const deps = makeDeps();
      const seen: { v?: string[] } = {};
      pullWrites(deps, seen);
      const b = makeBroadcast([{ workerId: "node-1", rec: recs(true) }]);
      deps.ledger.upsertPending(b.streamKey);
      expect((await runPipeline(b, deps)).state).toBe("done");
      expect(seen.v).toContain(`/remote/${A}.session.json`);
      deps.ledger.close();
    });

    it("旧 bundle 全原生 .ts(无 sessionJsonPath)→ 行为不变,照常完成", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: makeRec({ sessionBase: B, tsFiles: [`/remote/${B}.ts`], xmlPath: undefined }) }]);
      const deps = makeDeps();
      pullWrites(deps);
      deps.ledger.upsertPending(broadcast.streamKey);
      expect((await runPipeline(broadcast, deps)).state).toBe("done");
      deps.ledger.close();
    });

    it("分段模式不套该检查(逐段用显式路径,不经 groupSessions):边车缺失也不转人工", async () => {
      const broadcast = makeBroadcast([{ workerId: "node-1", rec: recs(false) }]);
      const base = makeDeps();
      const deps = makeDeps({ cfg: { ...base.cfg, uploadMode: "stage", steps: { mergeSegments: false } } });
      pullWrites(deps);
      deps.ledger.upsertPending(broadcast.streamKey);
      // 分段模式会真跑 remux(本测试不关心其结果):只断言兜底没拦它。
      await runPipeline(broadcast, deps).catch(() => undefined);
      const err = deps.notify.mock.calls.map((c) => c[0] as { message?: string }).find((e) => e.message?.includes("未被任何会话认领"));
      expect(err).toBeUndefined();
      expect(deps.ledger.get(broadcast.streamKey)?.state).not.toBe("needs_manual");
      deps.ledger.close();
    });
  });
});
