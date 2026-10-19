// plans/036 T6:封口转换迁到任务表 —— 钩子入队 / 租约宿主规则 / 收尾等待 / 崩溃续跑 / 回落进程内串行链。
// 假 remux / 假 ffprobe 注入(不依赖本机 ffmpeg);任务表是真 sqlite(临时目录)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetProcessors, jobIdOf, registerProcessor, type EnqueueResult, type StageFormat } from "@drec/core";
import { ProcQueueStore } from "@drec/proc-queue";
import { makeRemuxProcessor, remuxTmpPath, remuxTargetPath, type MediaProbe, type NodeRemuxDeps } from "@drec/processors";
import { groupSessionsInDir } from "@drec/post-process";
import { makeNodeRemuxHookFactory } from "../../packages/app/src/node-remux.js";
import { RemuxQueue, type RemuxQueueLike } from "../../packages/app/src/remux-queue.js";

const B = "主播_2026-10-15_21-00-00";
let root: string, dir: string, dbPath: string;
const queues: RemuxQueue[] = [];
const stores: ProcQueueStore[] = [];
let alerts: string[], logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "remux-queue-"));
  dir = join(root, "recordings"); mkdirSync(dir, { recursive: true });
  dbPath = join(root, "db", "proc-queue.db");
  alerts = []; logs = [];
  _resetProcessors();
});
afterEach(async () => {
  for (const q of queues.splice(0)) await q.close().catch(() => {});
  for (const s of stores.splice(0)) s.close();
  _resetProcessors();
  rmSync(root, { recursive: true, force: true });
});

const seg = (n: number, body = "dur=60"): string => { const p = join(dir, `${B}_${String(n).padStart(3, "0")}.ts`); writeFileSync(p, body); return p; };
const store = (): ProcQueueStore => { const s = new ProcQueueStore(dbPath); stores.push(s); return s; };
const videoFiles = (): string[] => readdirSync(dir).filter((n) => /\.(ts|mkv|mp4|drec-remux)$/.test(n)).sort();

const probe = async (p: string): Promise<MediaProbe> => {
  const m = /dur=(\d+)/.exec(readFileSync(p, "utf-8"));
  const dur = m ? Number(m[1]) : 0;
  return { durationSec: dur, hasVideo: true, spanSec: dur, packets: dur ? 100 : 0 };
};
const copyRemux: NonNullable<NodeRemuxDeps["remux"]> = async (src, tmp) => { writeFileSync(tmp, readFileSync(src, "utf-8")); };
const hangRemux: NonNullable<NodeRemuxDeps["remux"]> = (_s, tmp, _f, signal) =>
  new Promise((_, rej) => { writeFileSync(tmp, "partial"); signal?.addEventListener("abort", () => rej(new Error("aborted"))); });
const deps = (over: Partial<NodeRemuxDeps> = {}): NodeRemuxDeps => ({ remux: copyRemux, probe, freeBytes: () => 1e12, ...over });

function openQueue(over: Partial<Parameters<typeof RemuxQueue.open>[0]> = {}): RemuxQueue {
  const q = RemuxQueue.open({
    owner: "room1", outDir: dir, dbPath, alert: (m) => alerts.push(m), log: (m) => logs.push(m),
    diskMinGB: () => 0, tickMs: 20, heartbeatMs: 50, pollMs: 10, ...over,
  });
  if (!q) throw new Error("queue 打不开");
  queues.push(q);
  return q;
}
function hookOf(queue: RemuxQueueLike | null | undefined, over: { budget?: number } & Partial<NodeRemuxDeps> = {}) {
  const { budget, ...d } = over;
  return makeNodeRemuxHookFactory({
    format: "mkv" as StageFormat, owner: "room1", queue, sessionEndBudgetMs: budget,
    alert: (m) => alerts.push(m), log: (m) => logs.push(m), ...deps(), ...d,
  })();
}
const sidecarFormat = (): string | undefined => {
  try { return (JSON.parse(readFileSync(join(dir, `${B}.session.json`), "utf-8")) as { nodeFormat?: string }).nodeFormat; } catch { return undefined; }
};

describe("封口 → 入队", () => {
  it("封口 3 段 → 任务表 3 行 pending(无处理器注册 = 无人执行),边车 nodeFormat 已写、原文件都在", async () => {
    const q = openQueue(); // 未注册 remux 处理器:runner 不抢租约、不执行
    const h = hookOf(q, { budget: 30 });
    const segs = [seg(0), seg(1), seg(2)];
    for (const p of segs) h.onSegment(p);
    await h.onSessionEnd();
    const rows = store().list({ kind: "remux" });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.state === "pending")).toBe(true);
    expect(rows.map((r) => r.inputs[0]).sort()).toEqual(segs);
    expect(rows[0].replaceInputs).toBe(true);
    expect(rows[0].params).toMatchObject({ format: "mkv", owner: "room1" });
    expect(sidecarFormat()).toBe("mkv");
    expect(videoFiles().filter((n) => n.endsWith(".ts"))).toHaveLength(3);
  });

  it("jobId 形如 remux:room<owner>:<basename>@<ino>-<size>#g1(fileTag 由节点回填)", async () => {
    const q = openQueue();
    const p = seg(0);
    const r = q.enqueue(p, "mkv");
    expect(r.jobId).toMatch(/^remux:roomroom1:.+_000\.ts@\d+-\d+#g1$/);
  });

  it("同一段重复上报不重复入队", async () => {
    const q = openQueue();
    const h = hookOf(q, { budget: 30 });
    const a = seg(0), b = seg(1);
    h.onSegment(a); h.onSegment(b); h.onSegment(b);
    await h.onSessionEnd();
    expect(store().list({ kind: "remux" })).toHaveLength(2);
  });

  it("outDir 之外的路径被契约拒(rejected)→ 回落进程内转换", async () => {
    const q = openQueue({ outDir: join(root, "elsewhere") });
    const h = hookOf(q, { budget: 2000 });
    const a = seg(0), b = seg(1);
    h.onSegment(a); h.onSegment(b);
    await h.onSessionEnd();
    expect(videoFiles()).toEqual([`${B}_000.mkv`, `${B}_001.mkv`]);
    expect(store().list({ kind: "remux" })).toHaveLength(0);
  });
});

describe("租约宿主规则(§2.3)", () => {
  it("独立 record 持有:转换由本进程 runner 执行,收尾等本进程入队的行,完成后只剩新容器、无告警", async () => {
    registerProcessor(makeRemuxProcessor(deps()));
    const q = openQueue();
    const h = hookOf(q, { budget: 5000 });
    for (const n of [0, 1, 2]) h.onSegment(seg(n));
    await h.onSessionEnd();
    expect(videoFiles()).toEqual([`${B}_000.mkv`, `${B}_001.mkv`, `${B}_002.mkv`]);
    expect(store().list({ kind: "remux" }).every((r) => r.state === "done")).toBe(true);
    expect(alerts).toEqual([]);
  });

  it("serve 持有 → record 只入队、收尾不等待(不占预算、无超时告警)", async () => {
    registerProcessor(makeRemuxProcessor(deps({ remux: hangRemux })));
    const s = store();
    expect(s.acquireLease("remux", "serve:1:1", { leaseMs: 60_000, requestHandover: false }).acquired).toBe(true);
    const q = openQueue();
    const h = hookOf(q, { budget: 5000 });
    h.onSegment(seg(0)); h.onSegment(seg(1));
    const t0 = Date.now();
    await h.onSessionEnd();
    expect(Date.now() - t0).toBeLessThan(1500); // 远小于 budget
    expect(s.list({ kind: "remux" }).map((r) => r.state)).toEqual(["pending", "pending"]); // record 没抢租约、没执行
    expect(s.getLease("remux")?.owner).toBe("serve:1:1");
    expect(alerts).toEqual([]);
  });

  it("收尾等待超时 → 告警文案不变,未完成行留在表中、原文件保留", async () => {
    registerProcessor(makeRemuxProcessor(deps({ remux: hangRemux })));
    const q = openQueue();
    const h = hookOf(q, { budget: 1000 });
    h.onSegment(seg(0));
    await h.onSessionEnd();
    expect(alerts).toEqual(["会话收尾转 mkv 超过总时限 1s,已放弃转换(原文件保留,留待下次启动接管/人工)"]);
    const rows = store().list({ kind: "remux" });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("running");
    expect(existsSyncTs()).toBe(true);
  });

  it("收尾等待中租约被 serve 接管(handover 完成)→ 立即停等、无超时告警(N5)", async () => {
    registerProcessor(makeRemuxProcessor(deps({ remux: hangRemux })));
    const q = openQueue();
    const h = hookOf(q, { budget: 8000 });
    h.onSegment(seg(0));
    const waiting = h.onSessionEnd();
    const s = store();
    await vi.waitFor(() => expect(s.getLease("remux")).not.toBeNull());
    await vi.waitFor(() => expect(s.list({ kind: "remux" })[0]?.state).toBe("running"));
    const rec = s.getLease("remux")!.owner;
    s.releaseLease("remux", rec); // serve 接手(模拟 handover 完成)
    expect(s.acquireLease("remux", "serve:9:9", { leaseMs: 60_000, requestHandover: false }).acquired).toBe(true);
    const t0 = Date.now();
    await waiting;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(alerts.filter((m) => m.includes("总时限"))).toEqual([]);
  });

  it("serve 启动遇 record 持有 → handoverRequested 置位,record 跑完当前 job 后让出租约", async () => {
    let finish!: () => void;
    const gateP = new Promise<void>((r) => { finish = r; });
    registerProcessor(makeRemuxProcessor(deps({ remux: async (s, t) => { await gateP; writeFileSync(t, readFileSync(s, "utf-8")); } })));
    const q = openQueue();
    q.enqueue(seg(0), "mkv");
    const s = store();
    await vi.waitFor(() => expect(s.list({ kind: "remux" })[0]?.state).toBe("running"));
    const rec = s.getLease("remux")!.owner;
    // serve 的接管请求
    expect(s.acquireLease("remux", "serve:9:9", { leaseMs: 60_000, requestHandover: true }).acquired).toBe(false);
    expect(s.getLease("remux")?.handoverRequested).toBe(true);
    expect(s.getLease("remux")?.owner).toBe(rec); // 不抢正在跑的 job
    finish();
    // "Released or handed to someone else" as one assertion (an `expect(a) || expect(b)` chain
    // never evaluates its right side, so it silently waited for "released" only).
    await vi.waitFor(() => {
      const l = s.getLease("remux");
      expect(l === null || l.owner !== rec, `lease still held by ${l?.owner}`).toBe(true);
    });
    await vi.waitFor(() => expect(s.list({ kind: "remux" })[0]?.state).toBe("done"));
    expect(s.acquireLease("remux", "serve:9:9", { leaseMs: 60_000, requestHandover: true }).acquired).toBe(true);
  });
});

function existsSyncTs(): boolean { return readdirSync(dir).some((n) => n.endsWith(".ts")); }

describe("崩溃续跑 / 关停", () => {
  it("runner 中途关停(abort)→ 行回 pending、tmp 已清、原文件不动;重启后续跑完成,原文件只在校验通过后才删", async () => {
    registerProcessor(makeRemuxProcessor(deps({ remux: hangRemux })));
    const q1 = openQueue();
    const src = seg(0);
    q1.enqueue(src, "mkv");
    const s = store();
    await vi.waitFor(() => expect(s.list({ kind: "remux" })[0]?.state).toBe("running"));
    expect(readdirSync(dir).some((n) => n.endsWith(".drec-remux"))).toBe(true); // 转换进行中:tmp 在
    await q1.close(); // 关停:interruptible → abort
    expect(s.list({ kind: "remux" })[0]?.state).toBe("pending");
    expect(readdirSync(dir).some((n) => n.endsWith(".drec-remux"))).toBe(false);
    expect(existsSyncTs()).toBe(true);

    _resetProcessors();
    let srcExistedDuringRun: boolean | undefined;
    registerProcessor(makeRemuxProcessor(deps({ remux: async (s2, t) => { srcExistedDuringRun = readdirSync(dir).some((n) => n.endsWith(".ts")); writeFileSync(t, readFileSync(s2, "utf-8")); } })));
    openQueue();
    await vi.waitFor(() => expect(s.list({ kind: "remux" })[0]?.state).toBe("done"));
    expect(srcExistedDuringRun).toBe(true); // 转换期间原文件始终在
    expect(videoFiles()).toEqual([`${B}_000.mkv`]);
  });

  it("进程被强杀(行留 running、租约过期、残留 tmp)→ 新持有者接管:删 tmp → 重跑 → 完成", async () => {
    const src = seg(0);
    const s = store();
    const id = s.enqueue(
      { jobId: jobIdOf("remux", `room1:${B}_000.ts@`, 1), kind: "remux", logicalKey: `room1:${B}_000.ts@`, generation: 1, inputs: [src],
        params: { format: "mkv", owner: "room1" }, replaceInputs: true, owner: {}, createdAt: Date.now() },
      { allowedRoots: [dir] },
    ).jobId;
    expect(s.acquireLease("remux", "record:4242:1", { leaseMs: 200, requestHandover: false }).acquired).toBe(true);
    expect(s.claim({ kinds: ["remux"], owner: "record:4242:1" })?.jobId).toBe(id);
    const tmp = remuxTmpPath(remuxTargetPath(src, "mkv"), "room1", 4242);
    writeFileSync(tmp, "partial");
    await new Promise((r) => setTimeout(r, 260)); // 租约过期
    registerProcessor(makeRemuxProcessor(deps()));
    openQueue();
    await vi.waitFor(() => expect(s.get(id)?.state).toBe("done"));
    expect(videoFiles()).toEqual([`${B}_000.mkv`]);
    expect(existsSync(tmp)).toBe(false);
  });
});

describe("store 打不开 / 入队失败 → 回落进程内串行链(稳定版兜底)", () => {
  it("任务表打不开 → open 返回 null 并告警;钩子走旧链,转换照常完成", async () => {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "x"); // 普通文件:其下建目录必失败
    const q = RemuxQueue.open({ owner: "room1", outDir: dir, dbPath: join(blocker, "db", "q.db"), alert: (m) => alerts.push(m), log: (m) => logs.push(m), diskMinGB: () => 0 });
    expect(q).toBeNull();
    expect(alerts.some((m) => m.includes("回落为进程内串行转换"))).toBe(true);
    const h = hookOf(q, { budget: 5000 });
    h.onSegment(seg(0)); h.onSegment(seg(1));
    await h.onSessionEnd();
    expect(videoFiles()).toEqual([`${B}_000.mkv`, `${B}_001.mkv`]);
  });

  it("入队抛错(DB 锁死等)→ 该段回落进程内转换,告警一次,不丢段", async () => {
    const fake: RemuxQueueLike = {
      enqueue: (): EnqueueResult => { throw new Error("database is locked"); },
      waitSettled: async () => "settled",
    };
    const h = hookOf(fake, { budget: 5000 });
    h.onSegment(seg(0)); h.onSegment(seg(1)); h.onSegment(seg(2));
    await h.onSessionEnd();
    expect(videoFiles()).toEqual([`${B}_000.mkv`, `${B}_001.mkv`, `${B}_002.mkv`]);
    expect(alerts.filter((m) => m.includes("入队失败"))).toHaveLength(1);
  });

  it("入队被拒(rejected)→ 回落进程内转换", async () => {
    const fake: RemuxQueueLike = {
      enqueue: (): EnqueueResult => ({ jobId: "x", state: "rejected", error: "路径不在 allowedRoots" }),
      waitSettled: async () => "settled",
    };
    const h = hookOf(fake, { budget: 5000 });
    h.onSegment(seg(0)); h.onSegment(seg(1));
    await h.onSessionEnd();
    expect(videoFiles()).toEqual([`${B}_000.mkv`, `${B}_001.mkv`]);
  });

  it("边车写失败 → 放弃本段(原文件保留 + 告警),不入队也不回落", async () => {
    const calls: string[] = [];
    const fake: RemuxQueueLike = { enqueue: (p): EnqueueResult => { calls.push(p); return { jobId: "x", state: "pending" }; }, waitSettled: async () => "settled" };
    writeFileSync(join(dir, `${B}.session.json`), "{\"sessionBase\":"); // Unparsable sidecar: the strict marker refuses to overwrite it (issue #223)
    const h = hookOf(fake, { budget: 2000 });
    h.onSegment(seg(0)); h.onSegment(seg(1));
    await h.onSessionEnd();
    expect(calls).toEqual([]);
    expect(alerts.some((m) => m.includes("mark-failed"))).toBe(true);
    expect(videoFiles().filter((n) => n.endsWith(".ts"))).toHaveLength(2);
  });
});

describe("入队被拒于已有终态行 → 不回落,只告警(#160 第 4 项)", () => {
  const forceState = (state: string): void => {
    const db = new DatabaseSync(dbPath);
    try { db.prepare("UPDATE proc_jobs SET state=?").run(state); } finally { db.close(); }
  };

  it.each(["uncertain", "failed", "cancelled"])("同段已有 %s 行,再次封口 → 不转换、只告警一次、原文件不动、行不变", async (state) => {
    const q = openQueue(); // 无处理器注册:首次入队后行停在 pending
    const a = seg(0), b = seg(1);
    const h1 = hookOf(q, { budget: 30 });
    h1.onSegment(a); h1.onSegment(b);
    await h1.onSessionEnd();
    expect(store().list({ kind: "remux" })).toHaveLength(2);
    forceState(state);
    alerts.length = 0;
    const remux = vi.fn(copyRemux);
    const h2 = hookOf(q, { budget: 2000, remux });
    h2.onSegment(a); h2.onSegment(a); h2.onSegment(b); // 重复上报同一段不重复告警
    await h2.onSessionEnd();
    expect(remux).not.toHaveBeenCalled();
    expect(videoFiles()).toEqual([`${B}_000.ts`, `${B}_001.ts`]);
    const rows = store().list({ kind: "remux" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === state)).toBe(true);
    const mine = alerts.filter((m) => m.includes("需人工处理"));
    expect(mine).toHaveLength(2); // 每段一条(同一段只一次)
    expect(mine[0]).toContain(`state=${state}`);
    expect(mine[0]).toContain(`${B}_000.ts`);
  });

  it("正常首次入队不受影响:无告警、行 pending", async () => {
    const q = openQueue();
    const h = hookOf(q, { budget: 30 });
    h.onSegment(seg(0)); h.onSegment(seg(1));
    await h.onSessionEnd();
    expect(alerts.filter((m) => m.includes("需人工处理"))).toEqual([]); // 预算 30ms 的超时告警与本断言无关
    expect(store().list({ kind: "remux" }).map((r) => r.state)).toEqual(["pending", "pending"]);
  });

  it("其余拒绝原因(无 existingState,如契约/stat 失败)仍回落进程内转换", async () => {
    const fake: RemuxQueueLike = {
      enqueue: (): EnqueueResult => ({ jobId: "x", state: "rejected", error: "inputs[0] 无法 stat: ENOENT" }),
      waitSettled: async () => "settled",
    };
    const h = hookOf(fake, { budget: 5000 });
    h.onSegment(seg(0)); h.onSegment(seg(1));
    await h.onSessionEnd();
    expect(videoFiles()).toEqual([`${B}_000.mkv`, `${B}_001.mkv`]);
    expect(alerts.filter((m) => m.includes("需人工处理"))).toEqual([]);
  });

  it("store.enqueue 对终态行回 existingState,对契约违规不带", () => {
    const q = openQueue();
    const p = seg(0);
    expect(q.enqueue(p, "mkv").existingState).toBeUndefined();
    forceState("uncertain");
    const r = q.enqueue(p, "mkv");
    expect(r).toMatchObject({ state: "rejected", existingState: "uncertain" });
  });
});

describe("任务标识归属(#160 第 1 项)", () => {
  it("带 taskId:行 owner.taskId 落库、logicalKey 前缀 task<id>", () => {
    const q = openQueue({ taskId: 7 });
    const r = q.enqueue(seg(0), "mkv");
    expect(r.jobId).toMatch(/^remux:task7:.+_000\.ts@\d+-\d+#g1$/);
    const row = store().list({ kind: "remux" })[0];
    expect(row.owner).toMatchObject({ taskId: 7 });
  });

  it("无 taskId:行为不变(room<owner> 前缀、无 owner.taskId)", () => {
    const q = openQueue();
    q.enqueue(seg(0), "mkv");
    const row = store().list({ kind: "remux" })[0];
    expect(row.logicalKey).toMatch(/^roomroom1:/);
    expect(row.owner.taskId).toBeUndefined();
  });
});

describe("混跑:旧 master 扫描期间 tmp 与新文件并存(F14)", () => {
  it("groupSessions 不收 *.drec-remux;转换完成前后原文件那一份仍是唯一源", () => {
    const src = seg(0);
    writeFileSync(join(dir, `${B}.session.json`), JSON.stringify({ sessionBase: B, nodeFormat: "mkv" }));
    writeFileSync(`${join(dir, `${B}_000.mkv`)}.room1-7.drec-remux`, "partial");
    let g = groupSessionsInDir(dir);
    expect(Object.values(g).flatMap((x) => x.ts)).toEqual([`${B}_000.ts`]);
    // rename 之后、删原文件之前:新文件已在(sidecar 声明 mkv)—— tmp 仍不被收
    writeFileSync(join(dir, `${B}_000.mkv`), "dur=60");
    g = groupSessionsInDir(dir);
    const all = Object.values(g).flatMap((x) => x.ts);
    expect(all.some((n) => n.endsWith(".drec-remux"))).toBe(false);
    expect(existsSync(src)).toBe(true);
  });
});
