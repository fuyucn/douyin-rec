// plans/036 T3:ProcQueueStore —— 迁移 / 幂等入队 / 租约 / 认领 / 迁移合法性 / gc。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { parseJobId } from "@drec/core";
import { ProcQueueStore, BatchRejected, procQueueDbPath, fileTagOf, GC_RETAIN_MS, LEASE_MS } from "@drec/proc-queue";
import { makeEnv, type Env } from "./helpers.js";

let env: Env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => env.cleanup());

const roots = (): { allowedRoots: string[] } => ({ allowedRoots: [env.root] });
const lease = (s: ProcQueueStore, owner = "A", kind = "fake"): void => {
  expect(s.acquireLease(kind, owner, { pid: process.pid }).acquired).toBe(true);
};

describe("procQueueDbPath", () => {
  it("= <dataRoot>/db/proc-queue.db(纯函数)", () => {
    expect(procQueueDbPath("/data")).toBe("/data/db/proc-queue.db");
  });
});

describe("迁移", () => {
  it("重复首开幂等(同进程多连接;真多进程见 store-multiproc.test.ts):user_version=2、数据不丢、表齐全", () => {
    const s1 = env.open();
    const r = s1.enqueue(env.job("a.ts"), roots());
    expect(r.state).toBe("pending");
    const s2 = env.open(); // 第二个连接再次迁移
    const s3 = env.open();
    expect(s3.get(r.jobId)?.state).toBe("pending");
    const raw = new DatabaseSync(env.dbPath);
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["proc_jobs", "proc_runner_lease", "proc_order_cursor"]));
    raw.close();
    expect(s2.list()).toHaveLength(1);
  });

  it("父目录不存在时自动创建", () => {
    rmSync(join(env.root, "db"), { recursive: true, force: true });
    env.open();
    expect(existsSync(env.dbPath)).toBe(true);
  });
});

describe("enqueue", () => {
  it("同 jobId 二次入队不改 done 行(updatedAt/结果不变)", () => {
    const s = env.open();
    lease(s);
    const job = env.job("a.ts");
    const first = s.enqueue(job, roots());
    const out = env.file("a.mp4");
    const claimed = s.claim({ kinds: ["fake"], owner: "A" })!;
    expect(s.finish(claimed.jobId, "A", { state: "done", outputs: [out] })).toBe(true);
    const before = s.get(first.jobId)!;
    env.clock.t += 5000;
    const again = s.enqueue(job, roots());
    expect(again).toEqual({ jobId: first.jobId, state: "done" });
    expect(s.get(first.jobId)).toEqual(before);
    expect(s.list()).toHaveLength(1);
  });

  it("pending / running 二次入队原样回报现态,不新增行", () => {
    const s = env.open();
    lease(s);
    const job = env.job("a.ts");
    const r = s.enqueue(job, roots());
    expect(s.enqueue(job, roots())).toEqual({ jobId: r.jobId, state: "pending" });
    s.claim({ kinds: ["fake"], owner: "A" });
    expect(s.enqueue(job, roots())).toEqual({ jobId: r.jobId, state: "running" });
    expect(s.list()).toHaveLength(1);
  });

  it("logicalKey 以 @ 结尾 → 回填 ${ino}-${size}(bigint stat),jobId 同步重建", () => {
    const s = env.open();
    const job = env.job("a.ts");
    const r = s.enqueue(job, roots());
    const st = statSync(job.inputs[0], { bigint: true });
    const tag = `${String(st.ino)}-${String(st.size)}`;
    expect(fileTagOf(job.inputs[0])).toBe(tag);
    const parsed = parseJobId(r.jobId)!;
    expect(parsed.logicalKey).toBe(`task1:a.ts@${tag}`);
    expect(s.get(r.jobId)?.logicalKey).toBe(`task1:a.ts@${tag}`);
  });

  it("fileTagOf 用 bigint stat:ino > 2^53 时字符串精确(Number 会丢精度)", () => {
    const big = 2n ** 60n + 1n;
    const fake = ((_p: string, o?: { bigint?: boolean }) =>
      o?.bigint ? { ino: big, size: 5n } : { ino: Number(big), size: 5 }) as unknown as typeof statSync;
    expect(fileTagOf("/whatever", fake)).toBe(`${String(big)}-5`); // 表达式拼装,不写长数字字面量
  });

  it("已带 fileTag 的 logicalKey 原样使用(不重复回填)", () => {
    const s = env.open();
    const job = env.job("a.ts", { logicalKey: "task1:a.ts@7-9" });
    const r = s.enqueue(job, roots());
    expect(parseJobId(r.jobId)?.logicalKey).toBe("task1:a.ts@7-9");
  });

  it("同名文件内容变了(size 不同)→ fileTag 不同 → 新行,不命中旧 done", () => {
    const s = env.open();
    const j1 = env.job("a.ts");
    const r1 = s.enqueue(j1, roots());
    env.file("a.ts", "longer content now");
    const r2 = s.enqueue(env.job("a.ts"), roots());
    expect(r2.jobId).not.toBe(r1.jobId);
    expect(s.list()).toHaveLength(2);
  });

  it("done 但产物已不存在 → stale 且附 nextGeneration;重派 g2 后再 stale → 3", () => {
    const s = env.open();
    lease(s);
    const job = env.job("a.ts");
    const r1 = s.enqueue(job, roots());
    const out = env.file("a.mp4");
    s.claim({ kinds: ["fake"], owner: "A" });
    s.finish(r1.jobId, "A", { state: "done", outputs: [out] });
    expect(s.enqueue(job, roots()).state).toBe("done");
    rmSync(out);
    const stale = s.enqueue(job, roots());
    expect(stale).toEqual({ jobId: r1.jobId, state: "stale", nextGeneration: 2 });
    expect(s.get(r1.jobId)?.state).toBe("done"); // stale 不改行
    // 派发方以 nextGeneration 重发
    const r2 = s.enqueue(env.job("a.ts", { generation: 2 }), roots());
    expect(r2.state).toBe("pending");
    expect(parseJobId(r2.jobId)?.generation).toBe(2);
    expect(s.nextGeneration("fake", parseJobId(r2.jobId)!.logicalKey)).toBe(3);
  });

  it("F4/V6:过期回执的下一代在已有更高 generation(g5)时不得撞号 → 6", () => {
    const s = env.open();
    lease(s);
    const job = env.job("a.ts");
    const r1 = s.enqueue(job, roots());
    const out = env.file("a.mp4");
    s.claim({ kinds: ["fake"], owner: "A" });
    s.finish(r1.jobId, "A", { state: "done", outputs: [out] });
    const r5 = s.enqueue(env.job("a.ts", { generation: 5 }), roots()); // 已存在更高代
    expect(r5.state).toBe("pending");
    rmSync(out);
    const stale = s.enqueue(job, roots()); // g1 产物缺失 → stale
    expect(stale).toMatchObject({ jobId: r1.jobId, state: "stale", nextGeneration: 6 });
  });

  it("nextGeneration:无行 = 1", () => {
    expect(env.open().nextGeneration("fake", "nope")).toBe(1);
  });

  it("inputs[0] stat 失败 → rejected,且不落行", () => {
    const s = env.open();
    const job = env.job("a.ts");
    rmSync(job.inputs[0]);
    const r = s.enqueue(job, roots());
    expect(r.state).toBe("rejected");
    expect(r.error).toMatch(/stat/);
    expect(s.list()).toHaveLength(0);
  });

  it("路径不在 allowedRoots / 空 roots → rejected(fail-closed),不抛不落行", () => {
    const s = env.open();
    const job = env.job("a.ts");
    expect(s.enqueue(job, { allowedRoots: ["/nonexistent-root"] }).state).toBe("rejected");
    expect(s.enqueue(job, { allowedRoots: [] }).state).toBe("rejected");
    expect(s.list()).toHaveLength(0);
  });

  it("replaceInputs 含 xml → rejected(契约层拒绝不可再生文件)", () => {
    const s = env.open();
    const job = env.job("a.xml", { replaceInputs: true });
    const r = s.enqueue(job, roots());
    expect(r.state).toBe("rejected");
    expect(s.list()).toHaveLength(0);
  });

  it("failed / cancelled / uncertain 行再入队不隐式复活 → rejected", () => {
    const s = env.open();
    lease(s);
    const job = env.job("a.ts");
    const r = s.enqueue(job, roots());
    s.claim({ kinds: ["fake"], owner: "A" });
    s.finish(r.jobId, "A", { state: "failed", error: "boom" });
    const again = s.enqueue(job, roots());
    expect(again.state).toBe("rejected");
    expect(s.get(r.jobId)?.state).toBe("failed");
  });
});

describe("租约", () => {
  it("无行抢到;他人存活持有 → 抢不到,requestHandover 置标记,不动 running 行", () => {
    const s = env.open();
    expect(s.acquireLease("fake", "A", { pid: process.pid }).acquired).toBe(true);
    const r = s.acquireLease("fake", "B", { pid: process.pid, requestHandover: true });
    expect(r.acquired).toBe(false);
    expect(s.getLease("fake")?.owner).toBe("A");
    expect(s.getLease("fake")?.handoverRequested).toBe(true);
    expect(s.heartbeat("fake", "A")).toEqual({ ok: true, handoverRequested: true });
  });

  it("不带 requestHandover 时不置标记", () => {
    const s = env.open();
    lease(s);
    s.acquireLease("fake", "B", { pid: process.pid });
    expect(s.getLease("fake")?.handoverRequested).toBe(false);
  });

  it("持有者心跳停 → 过期(30s)后被接管;旧持有者心跳失败(fencing 信号)", () => {
    const s = env.open();
    lease(s, "A");
    env.clock.t += LEASE_MS - 1;
    expect(s.acquireLease("fake", "B", { pid: process.pid }).acquired).toBe(false);
    env.clock.t += 2;
    const r = s.acquireLease("fake", "B", { pid: process.pid });
    expect(r).toMatchObject({ acquired: true, takeover: true });
    expect(s.heartbeat("fake", "A").ok).toBe(false);
    expect(s.leaseValid("fake", "A")).toBe(false);
    expect(s.leaseValid("fake", "B")).toBe(true);
  });

  it("持有者 pid 已死 → 未过期也可提前接管;pid 活着则不行", () => {
    const dead = env.open({ isPidAlive: () => false });
    dead.acquireLease("fake", "A", { pid: 999_999 });
    expect(dead.acquireLease("fake", "B", { pid: process.pid }).acquired).toBe(true);
    const alive = env.open({ isPidAlive: () => true });
    alive.acquireLease("k2", "A", { pid: 999_999 });
    expect(alive.acquireLease("k2", "B", { pid: process.pid }).acquired).toBe(false);
  });

  it("自己重入续约;releaseLease 只删自己的", () => {
    const s = env.open();
    lease(s, "A");
    expect(s.acquireLease("fake", "A", { pid: process.pid })).toMatchObject({ acquired: true, takeover: false });
    expect(s.releaseLease("fake", "B")).toBe(false);
    expect(s.releaseLease("fake", "A")).toBe(true);
    expect(s.getLease("fake")).toBeNull();
  });

  it("leaseAlive:未过期 true / 过期 false", () => {
    const s = env.open();
    lease(s);
    expect(s.leaseAlive("fake")).toBe(true);
    env.clock.t += LEASE_MS + 1;
    expect(s.leaseAlive("fake")).toBe(false);
  });
});

describe("claim", () => {
  it("两连接并发 claim 同一行,只一个成功", () => {
    const a = env.open();
    const b = env.open();
    lease(a, "A");
    a.enqueue(env.job("a.ts"), roots());
    const ra = a.claim({ kinds: ["fake"], owner: "A" });
    const rb = b.claim({ kinds: ["fake"], owner: "A" });
    expect([ra, rb].filter(Boolean)).toHaveLength(1);
    expect(a.list({ state: "running" })).toHaveLength(1);
    expect(a.list({ state: "running" })[0].attempts).toBe(1);
  });

  it("F4/V1:认领事务必须是 IMMEDIATE —— 事务内(accept 回调里)另一连接的写事务被挡在外面", () => {
    const a = env.open();
    const b = env.open({ busyTimeoutMs: 30 });
    lease(a, "A");
    a.enqueue(env.job("a.ts"), roots());
    let bResult: unknown = "未调用";
    a.claim({
      kinds: ["fake"], owner: "A",
      accept: () => {
        // A 的认领事务正持写锁:IMMEDIATE → B 的 BEGIN IMMEDIATE 等不到锁而抛 locked;
        // 若退化成 DEFERRED,A 此刻只持读锁,B 会成功抢走同一行(双认领)。
        try { bResult = b.claim({ kinds: ["fake"], owner: "A" }); } catch (e) { bResult = (e as Error).message; }
        return true;
      },
    });
    expect(String(bResult)).toMatch(/locked|busy/i);
    expect(a.list({ state: "running" })).toHaveLength(1);
    expect(a.list({ state: "running" })[0].attempts).toBe(1);
  });

  it("F5:曾认领过的 pending 行被取消 → 下次 claim 直接落 cancelled(不执行、attempts 不增、不再多算 pending)", () => {
    const s = env.open();
    lease(s, "A");
    const id = s.enqueue(env.job("a.ts"), roots()).jobId;
    s.claim({ kinds: ["fake"], owner: "A" });
    s.releaseForShutdown(id, "A", true); // 关停回退 → pending(everClaimed)
    expect(s.requestCancel(id)).toBe("requested");
    expect(s.active().pending.fake).toBe(1);
    let accepted = 0;
    expect(s.claim({ kinds: ["fake"], owner: "A", accept: () => { accepted++; return true; } })).toBeNull();
    expect(accepted).toBe(0); // 取消行不走准入、不执行
    expect(s.get(id)).toMatchObject({ state: "cancelled", attempts: 0 });
    expect(s.get(id)?.finishedAt).not.toBeNull();
    expect(s.active().pending.fake).toBeUndefined();
  });

  it("F5:被取消的行不挡后面的候选(同次 claim 继续认领下一条)", () => {
    const s = env.open();
    lease(s, "A");
    const r1 = s.enqueue(env.job("a.ts"), roots());
    const r2 = s.enqueue(env.job("b.ts"), roots());
    s.claim({ kinds: ["fake"], owner: "A" });
    s.releaseForShutdown(r1.jobId, "A", true);
    s.requestCancel(r1.jobId);
    expect(s.claim({ kinds: ["fake"], owner: "A" })?.jobId).toBe(r2.jobId);
    expect(s.get(r1.jobId)?.state).toBe("cancelled");
  });

  it("F2:settleOrphan 默认拒绝本持有者名下的行;allowSelf(runner 确认已 fence)才处理", () => {
    const s = env.open();
    lease(s, "A");
    const id = s.enqueue(env.job("a.ts"), roots()).jobId;
    s.claim({ kinds: ["fake"], owner: "A" });
    expect(s.settleOrphan(id, "A", "rerun")).toBe(false);
    expect(s.settleOrphan(id, "A", "rerun", { allowSelf: true })).toBe(true);
    expect(s.get(id)).toMatchObject({ state: "pending", claimedBy: null });
  });

  it("readOnly:只读连接可查、不建库不迁移;写入被拒", () => {
    env.open().acquireLease("fake", "A", { pid: process.pid });
    const ro = env.open({ readOnly: true });
    expect(ro.getLease("fake")?.owner).toBe("A");
    expect(() => ro.releaseLease("fake", "A")).toThrow();
  });

  it("nextGeneration:无行 = 1", () => {
    const s = env.open();
    s.enqueue(env.job("a.ts"), roots());
    expect(s.claim({ kinds: ["fake"], owner: "A" })).toBeNull(); // 无租约
    lease(s, "A");
    expect(s.claim({ kinds: ["fake"], owner: "B" })).toBeNull(); // 租约不是 B 的
    env.clock.t += LEASE_MS + 1;
    expect(s.claim({ kinds: ["fake"], owner: "A" })).toBeNull(); // 过期
  });

  it("按入队序;accept 返回 false 的候选跳过且不改行;kinds 外的 kind 不认领", () => {
    const s = env.open();
    lease(s, "A");
    lease(s, "A", "other");
    const r1 = s.enqueue(env.job("a.ts"), roots());
    env.clock.t += 1;
    const r2 = s.enqueue(env.job("b.ts"), roots());
    s.enqueue(env.job("c.ts", { kind: "other" }), roots());
    const got = s.claim({ kinds: ["fake"], owner: "A", accept: (j) => j.jobId !== r1.jobId });
    expect(got?.jobId).toBe(r2.jobId);
    expect(s.get(r1.jobId)?.state).toBe("pending");
    expect(s.list({ kind: "other" })[0].state).toBe("pending");
  });
});

describe("finish / 状态迁移", () => {
  const runOne = (s: ProcQueueStore): string => {
    lease(s, "A");
    const r = s.enqueue(env.job("a.ts"), roots());
    s.claim({ kinds: ["fake"], owner: "A" });
    return r.jobId;
  };

  it("非持有者 finish 返回 false 且不改行", () => {
    const s = env.open();
    const id = runOne(s);
    expect(s.finish(id, "B", { state: "done", outputs: [] })).toBe(false);
    expect(s.get(id)?.state).toBe("running");
  });

  it("非 running 行 finish 返回 false(done 不能再 failed)", () => {
    const s = env.open();
    const id = runOne(s);
    expect(s.finish(id, "A", { state: "done", outputs: [] })).toBe(true);
    expect(s.finish(id, "A", { state: "failed", error: "x" })).toBe(false);
    expect(s.get(id)?.state).toBe("done");
  });

  it("failed 只经 requeue → pending;retryable=false 拒绝;uncertain 须先 ack", () => {
    const s = env.open();
    const id = runOne(s);
    s.finish(id, "A", { state: "uncertain", error: "?" });
    expect(s.requeue(id)).toBe(false); // uncertain 不能直接 requeue
    expect(s.ackUncertain(id)).toBe(true);
    expect(s.get(id)?.state).toBe("failed");
    expect(s.requeue(id, { retryable: false })).toBe(false);
    expect(s.requeue(id)).toBe(true);
    expect(s.get(id)).toMatchObject({ state: "pending", error: null, claimedBy: null });
    expect(s.ackUncertain(id)).toBe(false); // pending 不能 ack
  });

  it("cancelled 终态不可 requeue", () => {
    const s = env.open();
    const id = runOne(s);
    s.finish(id, "A", { state: "cancelled" });
    expect(s.get(id)?.state).toBe("cancelled");
    expect(s.requeue(id)).toBe(false);
  });
});

describe("取消", () => {
  it("cancelIfUnclaimed:从未认领 → true;已认领 → false", () => {
    const s = env.open();
    lease(s);
    const r1 = s.enqueue(env.job("a.ts"), roots());
    const r2 = s.enqueue(env.job("b.ts"), roots());
    expect(s.cancelIfUnclaimed(r1.jobId)).toBe(true);
    expect(s.get(r1.jobId)?.state).toBe("cancelled");
    s.claim({ kinds: ["fake"], owner: "A" });
    expect(s.cancelIfUnclaimed(r2.jobId)).toBe(false);
    expect(s.get(r2.jobId)?.state).toBe("running");
  });

  it("关停回退成 pending 的行(曾认领)cancelIfUnclaimed 仍为 false", () => {
    const s = env.open();
    lease(s);
    const r = s.enqueue(env.job("a.ts"), roots());
    s.claim({ kinds: ["fake"], owner: "A" });
    expect(s.releaseForShutdown(r.jobId, "A", true)).toBe(true);
    expect(s.get(r.jobId)).toMatchObject({ state: "pending", attempts: 0 });
    expect(s.cancelIfUnclaimed(r.jobId)).toBe(false);
  });

  it("requestCancel:pending 未认领 → cancelled;running → 置标记;终态 noop;标记行不再被认领", () => {
    const s = env.open();
    lease(s);
    const a = s.enqueue(env.job("a.ts"), roots());
    const b = s.enqueue(env.job("b.ts"), roots());
    expect(s.requestCancel(a.jobId)).toBe("cancelled");
    s.claim({ kinds: ["fake"], owner: "A" });
    expect(s.requestCancel(b.jobId)).toBe("requested");
    expect(s.get(b.jobId)?.cancelRequested).toBe(true);
    expect(s.requestCancel(a.jobId)).toBe("noop");
    expect(s.requestCancel("nope")).toBe("noop");
    // 关停回退的曾认领行被请求取消后不再被 claim
    s.releaseForShutdown(b.jobId, "A", true);
    s.requestCancel(b.jobId);
    expect(s.claim({ kinds: ["fake"], owner: "A" })).toBeNull();
  });

  it("releaseForShutdown:非 interruptible 拒绝;非持有者拒绝", () => {
    const s = env.open();
    lease(s);
    const r = s.enqueue(env.job("a.ts"), roots());
    s.claim({ kinds: ["fake"], owner: "A" });
    expect(s.releaseForShutdown(r.jobId, "A", false)).toBe(false);
    expect(s.releaseForShutdown(r.jobId, "B", true)).toBe(false);
    expect(s.get(r.jobId)?.state).toBe("running");
  });
});

describe("settleOrphan 代际 CAS(D1)", () => {
  it("attempts 与快照不一致(已被重新认领)→ 拒写;一致 → 写", () => {
    const s = env.open();
    const id = s.enqueue(env.job("a.ts"), roots()).jobId;
    s.acquireLease("fake", "A");
    s.claim({ kinds: ["fake"], owner: "A" });
    const snap = s.get(id)!;
    expect(snap.attempts).toBe(1);
    expect(s.settleOrphan(id, "A", "rerun", { allowSelf: true, attempts: snap.attempts })).toBe(true);
    s.claim({ kinds: ["fake"], owner: "A" }); // 第 2 轮已被重新认领
    expect(s.get(id)?.attempts).toBe(2);
    expect(s.settleOrphan(id, "A", "rerun", { allowSelf: true, attempts: snap.attempts })).toBe(false);
    expect(s.get(id)?.state).toBe("running");
    expect(s.settleOrphan(id, "A", "rerun", { allowSelf: true, attempts: 2 })).toBe(true);
  });
});

describe("settleOrphan(接管后处置)", () => {
  it("rerun → pending(attempts 保持);done;uncertain;未持租约 / 自己的行拒绝", () => {
    const s = env.open();
    lease(s, "A");
    const ids = ["a.ts", "b.ts", "c.ts"].map((n) => s.enqueue(env.job(n), roots()).jobId);
    for (let i = 0; i < 3; i++) s.claim({ kinds: ["fake"], owner: "A" });
    env.clock.t += LEASE_MS + 1;
    expect(s.settleOrphan(ids[0], "B", "rerun")).toBe(false); // B 还没拿租约
    expect(s.acquireLease("fake", "B", { pid: process.pid }).acquired).toBe(true);
    expect(s.settleOrphan(ids[0], "B", "rerun")).toBe(true);
    expect(s.get(ids[0])).toMatchObject({ state: "pending", attempts: 1, claimedBy: null });
    expect(s.settleOrphan(ids[1], "B", "done")).toBe(true);
    expect(s.get(ids[1])?.state).toBe("done");
    expect(s.settleOrphan(ids[2], "B", "uncertain", { error: "?" })).toBe(true);
    expect(s.get(ids[2])).toMatchObject({ state: "uncertain", error: "?" });
    expect(s.settleOrphan(ids[0], "B", "rerun")).toBe(false); // 已不是 running
  });
});

describe("list / active / gc", () => {
  it("active 计数 running / pending 按 kind;list 过滤", () => {
    const s = env.open();
    lease(s);
    s.enqueue(env.job("a.ts"), roots());
    s.enqueue(env.job("b.ts"), roots());
    s.enqueue(env.job("c.ts", { kind: "other" }), roots());
    s.claim({ kinds: ["fake"], owner: "A" });
    expect(s.active()).toEqual({ running: { fake: 1 }, pending: { fake: 1, other: 1 } });
    expect(s.list({ kind: "other" })).toHaveLength(1);
    expect(s.list({ state: "running" })).toHaveLength(1);
    expect(s.list({ ownerTaskId: 1 })).toHaveLength(3);
    expect(s.list({ ownerTaskId: 2 })).toHaveLength(0);
  });

  it("gc:done/cancelled 超 7 天删;未超不删;failed/uncertain 不自动删", () => {
    const s = env.open();
    lease(s);
    const mk = (n: string): string => s.enqueue(env.job(n), roots()).jobId;
    const [d, c, f, u, fresh] = ["d.ts", "c.ts", "f.ts", "u.ts", "n.ts"].map(mk);
    const take = (id: string, o: Parameters<ProcQueueStore["finish"]>[2]): void => {
      // 精确认领指定行:靠 accept 过滤
      s.claim({ kinds: ["fake"], owner: "A", accept: (j) => j.jobId === id });
      s.finish(id, "A", o);
    };
    take(d, { state: "done", outputs: [] });
    take(c, { state: "cancelled" });
    take(f, { state: "failed", error: "x" });
    take(u, { state: "uncertain", error: "?" });
    env.clock.t += GC_RETAIN_MS - 1000;
    lease(s); // 时钟大跳后续租
    take(fresh, { state: "done", outputs: [] });
    env.clock.t += 2000; // d/c/f/u 已超 7 天,fresh 未超
    expect(s.gc()).toBe(2);
    expect(s.get(d)).toBeNull();
    expect(s.get(c)).toBeNull();
    expect(s.get(f)?.state).toBe("failed");
    expect(s.get(u)?.state).toBe("uncertain");
    expect(s.get(fresh)?.state).toBe("done");
  });

  it("gc purgeFailed 删 failed,uncertain 须先 ack 才删", () => {
    const s = env.open();
    lease(s);
    const f = s.enqueue(env.job("f.ts"), roots()).jobId;
    const u = s.enqueue(env.job("u.ts"), roots()).jobId;
    s.claim({ kinds: ["fake"], owner: "A", accept: (j) => j.jobId === f });
    s.finish(f, "A", { state: "failed", error: "x" });
    s.claim({ kinds: ["fake"], owner: "A", accept: (j) => j.jobId === u });
    s.finish(u, "A", { state: "uncertain", error: "?" });
    expect(s.gc({ purgeFailed: true })).toBe(1);
    expect(s.get(f)).toBeNull();
    expect(s.get(u)?.state).toBe("uncertain");
    s.ackUncertain(u);
    expect(s.gc({ purgeFailed: true })).toBe(1);
    expect(s.get(u)).toBeNull();
  });
});

describe("v1 -> v2 migration (plan 038 T01)", () => {
  it("已有 v1 库补 8 列与 cursor 表;旧行新列读为 null", () => {
    const path = join(env.root, "db", "old.db");
    mkdirSync(dirname(path), { recursive: true });
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE proc_jobs(
      jobId TEXT PRIMARY KEY, kind TEXT NOT NULL, logicalKey TEXT NOT NULL, generation INTEGER NOT NULL,
      state TEXT NOT NULL, inputs TEXT NOT NULL, outputs TEXT, params TEXT NOT NULL, replaceInputs INTEGER NOT NULL,
      ownerTaskId INTEGER, ownerStreamKey TEXT, attempts INTEGER NOT NULL DEFAULT 0, claimedBy TEXT,
      everClaimed INTEGER NOT NULL DEFAULT 0, cancelRequested INTEGER NOT NULL DEFAULT 0, resultOutputs TEXT,
      note TEXT, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, startedAt INTEGER, finishedAt INTEGER);
      CREATE TABLE proc_runner_lease(kind TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL,
        heartbeatAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, handoverRequested INTEGER NOT NULL DEFAULT 0);
      INSERT INTO proc_jobs(jobId,kind,logicalKey,generation,state,inputs,params,replaceInputs,createdAt,updatedAt)
        VALUES('old','remux','k',1,'pending','[]','{}',0,1,1);
      PRAGMA user_version=1;`);
    raw.close();
    const s = new ProcQueueStore(path);
    const cols = new Set((new DatabaseSync(path).prepare("PRAGMA table_info(proc_jobs)").all() as Array<{ name: string }>).map((r) => r.name));
    for (const c of ["notBefore","orderKey","seq","step","bv","childPid","childPidStartedAt","prepJobId"]) expect(cols.has(c)).toBe(true);
    expect(s.get("old")?.orderKey).toBeNull();
    const tables = (new DatabaseSync(path).prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("proc_order_cursor");
    s.close();
  });
});

describe("enqueueBatch and order generation (plan 038 T01)", () => {
  it("任一 rejected → 整批回滚,一条都不落", () => {
    const s = env.open();
    const good = env.job("a.ts");
    const bad = { ...env.job("b.ts"), kind: "biliup", inputs: ["/outside/x.mp4"] } as never;
    expect(() => s.enqueueBatch([good, bad], roots())).toThrow(/违反契约|批量入队被拒/);
    expect(s.list()).toHaveLength(0);
    s.close();
  });

  it("全部合法 → 同事务落库", () => {
    const s = env.open();
    const out = s.enqueueBatch([env.job("a.ts"), env.job("b.ts")], roots());
    expect(out.map((r) => r.state)).toEqual(["pending", "pending"]);
    expect(s.list()).toHaveLength(2);
    s.close();
  });

  it("nextOrderGeneration 按 orderKey 取 MAX+1,不按单行 logicalKey", () => {
    const s = env.open();
    expect(s.nextOrderGeneration("k")).toBe(1);
    const mk = (name: string, order: string, gen: number) =>
      env.job(name, { logicalKey: `${order}:${name}@`, generation: gen, orderKey: order, seq: 1 });
    s.enqueue(mk("a.ts", "k", 1), roots());
    s.enqueue(mk("b.ts", "k", 2), roots());
    s.enqueue(mk("d.ts", "other", 9), roots());
    expect(s.nextOrderGeneration("k")).toBe(3);
    expect(s.nextOrderGeneration("other")).toBe(10);
    s.close();
  });

  it("batch 写入 orderKey/seq/notBefore/prepJobId;fileTag 回填生效", () => {
    const s = env.open();
    const base = env.job("a.ts");
    const out = s.enqueueBatch([{ ...base, orderKey: "k", seq: 1, notBefore: 123, prepJobId: "p1" }], roots());
    const row = s.get(out[0]!.jobId)!;
    expect([row.orderKey, row.seq, row.notBefore, row.prepJobId]).toEqual(["k", 1, 123, "p1"]);
    expect(row.logicalKey).toMatch(/@\d+-\d+$/);
    s.close();
  });

  it("setters:updateStep 只对 running 行;setBv/setChildPid/clearChildPid", () => {
    const s = env.open();
    lease(s, "A", "fake");
    const id = s.enqueue(env.job("a.ts"), roots()).jobId;
    expect(s.updateStep(id, "gate_wait")).toBe(false); // pending
    s.claim({ kinds: ["fake"], owner: "A" });
    expect(s.updateStep(id, "gate_wait")).toBe(true);
    expect(s.get(id)?.step).toBe("gate_wait");
    expect(s.setBv(id, "BV1x")).toBe(true);
    expect(s.setChildPid(id, 123, "start")).toBe(true);
    expect(s.get(id)?.childPid).toBe(123);
    expect(s.clearChildPid(id)).toBe(true);
    expect(s.get(id)?.childPid).toBeNull();
    s.close();
  });
});

describe("batch rollback on a rejected existing row (plan 038 T01)", () => {
  it("同批出现 failed 行 → 抛 BatchRejected,前面已插入的行一并回滚", () => {
    const s = env.open();
    lease(s, "A", "fake");
    const old = env.job("old.ts");
    const first = s.enqueue(old, roots()).jobId;
    s.claim({ kinds: ["fake"], owner: "A" });
    s.finish(first, "A", { state: "failed", error: "boom" });
    expect(() => s.enqueueBatch([env.job("new.ts"), old], roots())).toThrow(BatchRejected);
    expect(s.list()).toHaveLength(1); // only the old failed row
    s.close();
  });
});

describe("batch stale and fileTag failure (plan 038 T01)", () => {
  it("batch 命中 stale → BatchRejected 且整批回滚", () => {
    const s = env.open();
    lease(s, "A", "fake");
    const job = env.job("a.ts");
    const first = s.enqueue(job, roots());
    const doneRow = s.get(first.jobId)!;
    expect(s.claim({ kinds: ["fake"], owner: "A" })?.jobId).toBe(first.jobId);
    s.finish(first.jobId, "A", { state: "done", outputs: [join(env.rec, "missing.mp4")] });
    const sameJob = { ...doneRow, jobId: first.jobId, kind: "fake", inputs: [join(env.rec, "a.ts")] };
    expect(() => s.enqueueBatch([env.job("new.ts"), sameJob as never], roots())).toThrow(BatchRejected);
    expect(s.list()).toHaveLength(1);
    s.close();
  });

  it("batch 中 fileTag stat 失败 → 整批回滚", () => {
    const s = env.open();
    const bad = { ...env.job("x.ts"), inputs: [join(env.rec, "gone.ts")] };
    expect(() => s.enqueueBatch([env.job("ok.ts"), bad], roots())).toThrow(/无法 stat/);
    expect(s.list()).toHaveLength(0);
    s.close();
  });
});
