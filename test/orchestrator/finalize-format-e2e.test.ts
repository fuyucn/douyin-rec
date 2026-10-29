/**
 * plans/036 T9b:派发 → 真实节点执行体(handleEnqueue + 任务表)→ 真实 remux 处理器 → groupSessionsInDir 仍认得该会话。
 * 节点目录与 stage 目录各一例;stage 目录在数据根外(N3)仍可入队。ffprobe/ffmpeg 用注入的假实现(与 node-remux 测试同口径)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetProcessors, registerProcessor, type ProcessContext, type ProcessJob } from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { makeRemuxProcessor, type MediaProbe } from "@drec/processors";
import { groupSessionsInDir } from "@drec/post-process";
import { handleEnqueue, handleProcStatus } from "../../packages/app/src/node-enqueue.js";
import { dispatchSurvivorRemux, parseFollowups, planSurvivorRemux, pollFollowups, STAGE_TARGET } from "../../packages/orchestrator/src/finalize-format.js";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import type { NodeRecording } from "../../packages/orchestrator/src/transport.js";

const KEY = "douyin:room1:2026-06-27";
const BASE = "主播名_2026-06-27_08-00-00";
let root: string, nodeDir: string, stageRoot: string, stageSub: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ff-e2e-root-"));
  nodeDir = join(root, "recordings", "主播"); mkdirSync(nodeDir, { recursive: true });
  stageRoot = mkdtempSync(join(tmpdir(), "ff-e2e-stage-")); // 数据根外
  stageSub = join(stageRoot, "douyin_room1_2026-06-27"); mkdirSync(stageSub, { recursive: true });
  _resetProcessors();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(stageRoot, { recursive: true, force: true }); _resetProcessors(); });

const probe = async (p: string): Promise<MediaProbe> => {
  const dur = Number(/dur=(\d+)/.exec(readFileSync(p, "utf-8"))?.[1] ?? 0);
  return { durationSec: dur, hasVideo: true, spanSec: dur, packets: dur > 0 ? 100 : 0 };
};
const proc = () => makeRemuxProcessor({
  remux: async (src, tmp) => { writeFileSync(tmp, readFileSync(src)); },
  probe, freeBytes: () => 1e12,
});
const ctx: ProcessContext = { signal: new AbortController().signal, assertLease() {}, markProgress() {}, log() {}, alert() {} };

function put(dir: string, name: string, body = "dur=60"): string { const p = join(dir, name); writeFileSync(p, body); return p; }

describe("T9b 端到端:派发 → 节点任务表 → 处理器 → 会话仍可分组", () => {
  it("节点目录:转成 mkv 后 groupSessionsInDir 仍认领该会话;边车写了 nodeFormat;从未把边车/xml 当输入", async () => {
    registerProcessor(proc());
    const ts = put(nodeDir, `${BASE}_000.ts`);
    put(nodeDir, `${BASE}.xml`, "<i/>");
    const sidecar = put(nodeDir, `${BASE}.session.json`, JSON.stringify({ roomSlug: "room1", platform: "douyin" }));
    const rec: NodeRecording = {
      roomSlug: "room1", platform: "douyin", sessionBase: BASE, tsFiles: [ts], xmlPath: join(nodeDir, `${BASE}.xml`),
      sessionJsonPath: sidecar, durationSec: 60, startMs: 1, endMs: 2, totalGapSec: 0,
    };
    const ledger = new SyncLedger(join(root, "t.db")); ledger.upsertPending(KEY); ledger.markDone(KEY, "BV1");
    const plan = planSurvivorRemux({
      streamKey: KEY, outputFormat: "mkv", cleanup: {}, members: [{ workerId: "node-1", rec }], stageSub: join(stageSub, "none"),
      stagePulled: true, hasStageProc: true,
    });
    const transports = new Map([["node-1", {
      id: "node-1",
      enqueue: async (req: Parameters<typeof handleEnqueue>[1]) => handleEnqueue(root, req, { taskOutDirs: [], stageDir: null }),
      procStatus: async (ids: string[]) => handleProcStatus(root, ids),
    } as never]]);
    const fu = await dispatchSurvivorRemux({ streamKey: KEY, plan, transports, ledger, log: () => {} });
    expect(fu!.items).toHaveLength(1);
    expect(fu!.items[0].state).toBe("pending");

    // 节点 runner 取该 job 执行(这里直接调处理器 run,与 runner 同一入口)
    const store = new ProcQueueStore(procQueueDbPath(root));
    const row = store.get(fu!.items[0].jobId)!;
    expect(row.inputs).toEqual([realpathSync(ts)]); // 任务表里存真实路径(realpath)
    expect(row.inputs.some((i) => /session\.json|\.xml$/.test(i))).toBe(false);
    const job: ProcessJob = { ...row } as ProcessJob;
    const res = await proc().run(job, ctx);
    expect(res.outputs).toEqual([join(realpathSync(nodeDir), `${BASE}_000.mkv`)]);
    store.close();

    const names = readdirSync(nodeDir);
    expect(names).not.toContain(`${BASE}_000.ts`);
    expect(names).toContain(`${BASE}.xml`);          // xml 不动
    expect(JSON.parse(readFileSync(sidecar, "utf-8"))).toMatchObject({ roomSlug: "room1", nodeFormat: "mkv" }); // 原字段保留
    expect(groupSessionsInDir(nodeDir)[BASE]?.ts).toEqual([`${BASE}_000.mkv`]);
    ledger.close();
  });

  it("stage 目录(在数据根外):stage 副本派到本机入队成功(N3);转换后 groupSessionsInDir 仍认领;三分 P 成品原样", async () => {
    registerProcessor(proc());
    put(stageSub, `${BASE}_000.ts`);
    put(stageSub, `${BASE}.session.json`, JSON.stringify({ roomSlug: "room1" }));
    put(stageSub, "主播名_2026-06-27.mp4", "dur=60");
    put(stageSub, "主播名_2026-06-27_danmu.mp4", "dur=60");
    const rec: NodeRecording = {
      roomSlug: "room1", platform: "douyin", sessionBase: BASE, tsFiles: [`/rec/${BASE}_000.ts`], sessionJsonPath: `/rec/${BASE}.session.json`,
      durationSec: 60, startMs: 1, endMs: 2, totalGapSec: 0,
    };
    const ledger = new SyncLedger(join(root, "t.db")); ledger.upsertPending(KEY); ledger.markDone(KEY, "BV1");
    const plan = planSurvivorRemux({
      streamKey: KEY, outputFormat: "mkv", cleanup: { sourceAfterDone: true }, members: [{ workerId: "node-1", rec }], stageSub,
      stagePulled: true, hasStageProc: true,
    });
    expect(plan.jobs.map((j) => j.target)).toEqual([STAGE_TARGET]);
    const stageProc = {
      enqueue: (req: Parameters<typeof handleEnqueue>[1]) => handleEnqueue(root, req, { taskOutDirs: [], stageDir }),
      procStatus: (ids: string[]) => handleProcStatus(root, ids),
    };
    const stageDir = stageRoot; // hub.config 的 stageDir:数据根外
    const fu = await dispatchSurvivorRemux({ streamKey: KEY, plan, transports: new Map(), stageProc, ledger, log: () => {} });
    expect(fu!.items).toHaveLength(1);
    expect(fu!.items[0].state).toBe("pending"); // 数据根外的 stageDir 仍受理
    expect(fu!.notes).toEqual([]);

    const store = new ProcQueueStore(procQueueDbPath(root));
    const row = store.get(fu!.items[0].jobId)!;
    await proc().run({ ...row } as ProcessJob, ctx);
    store.close();

    const names = readdirSync(stageSub).sort();
    expect(names).toContain(`${BASE}_000.mkv`);
    expect(names).not.toContain(`${BASE}_000.ts`);
    expect(names).toContain("主播名_2026-06-27.mp4");        // 三分 P 成品不转
    expect(names).toContain("主播名_2026-06-27_danmu.mp4");
    expect(groupSessionsInDir(stageSub)[BASE]?.ts).toEqual([`${BASE}_000.mkv`]);

    // 回执轮询:节点任务表里该 job 仍 pending(这里没跑 runner)→ leaseAlive=false → 首次只记起点
    await pollFollowups({ ledger, transports: new Map(), stageProc, now: () => 1 });
    expect(parseFollowups(ledger.getFollowups(KEY))!.items[0].idleSince).toBe(1);
    expect(existsSync(stageSub)).toBe(true);
    ledger.close();
  });
});
