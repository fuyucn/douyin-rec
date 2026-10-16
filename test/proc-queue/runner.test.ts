// plans/036 T3:ProcRunner —— 租约 / 心跳 / fencing / 限额 / 磁盘准入 / 接管 recover / 关停 / 快照(假处理器)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { registerProcessor, _resetProcessors, type ProcessContext, type ProcessJob } from "@drec/core";
import { ProcRunner, SimpleSlotLimiter, readProcActive, LEASE_MS, type ProcRunnerOpts } from "@drec/proc-queue";
import { makeEnv, fakeProcessor, gate, type Env } from "./helpers.js";

let env: Env;
let alerts: Array<[number | undefined, string]>;
const runners: ProcRunner[] = [];

beforeEach(() => {
  env = makeEnv();
  alerts = [];
  _resetProcessors();
});
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop().catch(() => {});
  _resetProcessors();
  env.cleanup();
});

const allowed = (): { allowedRoots: string[] } => ({ allowedRoots: [env.root] });
function mkRunner(owner: string, over: Partial<ProcRunnerOpts> = {}): ProcRunner {
  const r = new ProcRunner({
    store: env.open(), owner, diskMinGB: () => 0, alert: (t, m) => alerts.push([t, m]),
    timers: false, abortWaitMs: 200, ...over,
  });
  runners.push(r);
  r.start();
  return r;
}
const stateOf = (id: string): string | undefined => env.open().get(id)?.state;

describe("基本执行", () => {
  it("无注册处理器时空转:tick 不抢租约、不报错;active 有响应", () => {
    const r = mkRunner("A");
    r.tick();
    r.heartbeat();
    expect(env.open().getLease("fake")).toBeNull();
    expect(r.active()).toEqual({ host: true, running: {}, pending: {}, leaseAlive: {} });
  });

  it("claim → run → done;产物入 resultOutputs", async () => {
    registerProcessor(fakeProcessor({ run: async () => ({ outputs: ["/x/out.mp4"], note: "ok" }) }));
    const r = mkRunner("A");
    const s = env.open();
    const { jobId } = s.enqueue(env.job("a.ts"), allowed());
    r.tick();
    await vi.waitFor(() => expect(s.get(jobId)?.state).toBe("done"));
    expect(s.get(jobId)).toMatchObject({ resultOutputs: ["/x/out.mp4"], note: "ok", attempts: 1 });
  });

  it("处理器抛错 → failed + 告警(带 owner.taskId);validate 拒绝 → failed 不 run", async () => {
    const run = vi.fn(async () => { throw new Error("boom"); });
    registerProcessor(fakeProcessor({ run, validate: (j: ProcessJob) => (j.params.bad ? "参数非法" : null) }));
    const r = mkRunner("A", { limiter: new SimpleSlotLimiter(() => 5) });
    const s = env.open();
    const a = s.enqueue(env.job("a.ts"), allowed()).jobId;
    const b = s.enqueue(env.job("b.ts", { params: { bad: true } }), allowed()).jobId;
    r.tick();
    await vi.waitFor(() => expect(s.get(a)?.state).toBe("failed"));
    await vi.waitFor(() => expect(s.get(b)?.state).toBe("failed"));
    expect(s.get(a)?.error).toBe("boom");
    expect(s.get(b)?.error).toMatch(/参数非法/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(alerts.some(([t, m]) => t === 1 && m.includes("boom"))).toBe(true);
  });

  it("active():running/pending/leaseAlive 含已注册 kind(0 值)", async () => {
    const g = gate();
    registerProcessor(fakeProcessor({ run: async () => { await g.promise; return { outputs: [] }; } }));
    registerProcessor(fakeProcessor({ kind: "idle" }));
    const r = mkRunner("A");
    const s = env.open();
    s.enqueue(env.job("a.ts"), allowed());
    s.enqueue(env.job("b.ts"), allowed());
    r.tick();
    expect(r.active()).toEqual({
      host: true, running: { fake: 1, idle: 0 }, pending: { fake: 1, idle: 0 }, leaseAlive: { fake: true, idle: true },
    });
    g.resolve();
  });
});

describe("(resource,lane) 限额", () => {
  it("同通道上限 1:第二个等第一个完成;不同通道互不占槽", async () => {
    const g = gate();
    let live = 0;
    let peak = 0;
    registerProcessor(fakeProcessor({
      run: async () => { live++; peak = Math.max(peak, live); await g.promise; live--; return { outputs: [] }; },
    }));
    registerProcessor(fakeProcessor({ kind: "burn", lane: "burn", run: async () => ({ outputs: [] }) }));
    const r = mkRunner("A");
    const s = env.open();
    const a = s.enqueue(env.job("a.ts"), allowed()).jobId;
    const b = s.enqueue(env.job("b.ts"), allowed()).jobId;
    const c = s.enqueue(env.job("c.ts", { kind: "burn" }), allowed()).jobId;
    r.tick();
    expect(s.get(a)?.state).toBe("running");
    expect(s.get(b)?.state).toBe("pending"); // copy 通道满
    await vi.waitFor(() => expect(s.get(c)?.state).toBe("done")); // burn 通道不被占
    g.resolve();
    await vi.waitFor(() => expect(s.get(a)?.state).toBe("done"));
    r.tick();
    await vi.waitFor(() => expect(s.get(b)?.state).toBe("done"));
    expect(peak).toBe(1);
  });

  it("limiter 上限可调(现读)", () => {
    const lim = new SimpleSlotLimiter(() => 2);
    const a = lim.tryAcquire("cpu", "copy");
    const b = lim.tryAcquire("cpu", "copy");
    expect(a && b).toBeTruthy();
    expect(lim.tryAcquire("cpu", "copy")).toBeNull();
    a!();
    a!(); // 重复释放无副作用
    expect(lim.tryAcquire("cpu", "copy")).toBeTruthy();
    expect(lim.tryAcquire("cpu", "copy")).toBeNull();
  });
});

describe("磁盘准入", () => {
  it("不足 → 保持 pending,按 kind 只告警一次;恢复后执行,再不足可再告警", async () => {
    registerProcessor(fakeProcessor({ estimateDiskBytes: () => 2e9 }));
    let free: number | null = 11e9; // 11 - 2 = 9GB < 10GB 水位
    const r = mkRunner("A", { diskMinGB: () => 10, freeBytes: () => free });
    const s = env.open();
    const a = s.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick(); r.tick(); r.tick();
    expect(s.get(a)?.state).toBe("pending");
    expect(alerts).toHaveLength(1);
    expect(alerts[0][1]).toMatch(/磁盘/);
    free = 13e9; // 13 - 2 = 11 ≥ 10
    r.tick();
    await vi.waitFor(() => expect(s.get(a)?.state).toBe("done"));
    free = 5e9;
    const b = s.enqueue(env.job("b.ts"), allowed()).jobId;
    r.tick();
    expect(s.get(b)?.state).toBe("pending");
    expect(alerts).toHaveLength(2); // 标记已随成功认领清除
  });

  it("diskMinGB=0 关闭;查不到剩余空间 → 放行", async () => {
    registerProcessor(fakeProcessor());
    const r = mkRunner("A", { diskMinGB: () => 0, freeBytes: () => 0 });
    const s = env.open();
    const a = s.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick();
    await vi.waitFor(() => expect(s.get(a)?.state).toBe("done"));
    const r2 = mkRunner("A2", { diskMinGB: () => 10, freeBytes: () => null });
    expect(r2).toBeTruthy();
  });
});

describe("handover(交接)", () => {
  it("serve 请求交接 → 持有者跑完当前 job 后让出租约,serve 再接手", async () => {
    const g = gate();
    registerProcessor(fakeProcessor({ run: async () => { await g.promise; return { outputs: [] }; } }));
    const holder = mkRunner("rec", { requestHandover: false });
    const serve = mkRunner("serve", { requestHandover: true, store: env.open() });
    const s = env.open();
    const id = s.enqueue(env.job("a.ts"), allowed()).jobId;
    holder.tick();
    expect(s.get(id)?.state).toBe("running");
    serve.tick(); // 抢不到,置 handoverRequested,不碰正在跑的 job
    expect(s.getLease("fake")?.owner).toBe("rec");
    expect(s.get(id)).toMatchObject({ state: "running", claimedBy: "rec" });
    holder.heartbeat(); // 发现 handover → 让出中,但 job 还在跑
    expect(s.getLease("fake")?.owner).toBe("rec");
    g.resolve();
    await vi.waitFor(() => expect(s.get(id)?.state).toBe("done"));
    await vi.waitFor(() => expect(s.getLease("fake")).toBeNull()); // 让出
    serve.tick();
    expect(s.getLease("fake")?.owner).toBe("serve");
    // 让出后的持有者在让出期内不再认领新 job
    const id2 = s.enqueue(env.job("b.ts"), allowed()).jobId;
    holder.tick();
    expect(s.get(id2)?.state).toBe("pending"); // 让出后的原持有者不再认领
    serve.tick();
    expect(s.get(id2)).toMatchObject({ state: "running", claimedBy: "serve" });
  });
});

describe("接管 / recover / fencing", () => {
  it("心跳停 → 租约过期被接管;recover=rerun → pending 后由新持有者重跑;旧持有者失租后 assertLease 失败 → 不删 inputs", async () => {
    const stuck = gate();
    const input = env.file("a.ts");
    let aCtx!: ProcessContext;
    let runs = 0;
    registerProcessor(fakeProcessor({
      run: async (job: ProcessJob, ctx: ProcessContext) => {
        runs++;
        if (runs === 1) {
          aCtx = ctx;
          await stuck.promise; // 卡住的旧持有者
          ctx.assertLease(); // 失租 → 抛
          rmSync(job.inputs[0]); // 不可达
        }
        return { outputs: [] };
      },
      recover: async () => "rerun" as const,
    }));
    const a = mkRunner("A");
    const s = env.open();
    const id = s.enqueue(env.job("a.ts"), allowed()).jobId;
    a.tick();
    expect(s.get(id)).toMatchObject({ state: "running", claimedBy: "A" });
    env.clock.t += LEASE_MS + 1; // A 心跳停,租约过期
    const b = mkRunner("B", { store: env.open() });
    b.tick(); // 接管 + recover(异步)
    await vi.waitFor(() => expect(s.get(id)?.state).toBe("done"));
    expect(s.get(id)?.attempts).toBe(2);
    expect(s.getLease("fake")?.owner).toBe("B");
    // A 醒来:心跳失败 → fencing → abort
    a.heartbeat();
    expect(aCtx.signal.aborted).toBe(true);
    stuck.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(input)).toBe(true); // inputs 没被旧持有者删
    expect(s.get(id)?.state).toBe("done"); // 旧持有者收尾不改行
  });

  it("recover=done → 直接 done;recover=uncertain / 抛错 / 未实现 → uncertain + 告警,不自动重跑", async () => {
    const a = mkRunner("A", { limiter: new SimpleSlotLimiter(() => 9) });
    const s = env.open();
    const hang = gate();
    registerProcessor(fakeProcessor({
      run: async () => { await hang.promise; return { outputs: [] }; },
      recover: async (job: ProcessJob) => {
        if (job.inputs[0].endsWith("d.ts")) return "done";
        if (job.inputs[0].endsWith("t.ts")) throw new Error("recover 炸了");
        return "uncertain";
      },
    }));
    const ids = ["d.ts", "u.ts", "t.ts"].map((n) => s.enqueue(env.job(n), allowed()).jobId);
    a.tick();
    expect(s.list({ state: "running" })).toHaveLength(3);
    env.clock.t += LEASE_MS + 1;
    const b = mkRunner("B", { store: env.open(), limiter: new SimpleSlotLimiter(() => 9) });
    b.tick();
    await vi.waitFor(() => expect(s.list({ state: "running", kind: "fake" }).filter((j) => j.claimedBy === "A")).toHaveLength(0));
    expect(s.get(ids[0])?.state).toBe("done");
    expect(s.get(ids[1])?.state).toBe("uncertain");
    expect(s.get(ids[2])).toMatchObject({ state: "uncertain" });
    expect(s.get(ids[2])?.error).toMatch(/recover 异常/);
    expect(alerts.filter(([, m]) => m.includes("需人工确认"))).toHaveLength(2);
    hang.resolve();
  });

  it("处理器没有 recover → uncertain(不猜、不重跑)", async () => {
    const hang = gate();
    registerProcessor(fakeProcessor({ run: async () => { await hang.promise; return { outputs: [] }; } }));
    const a = mkRunner("A");
    const s = env.open();
    const id = s.enqueue(env.job("a.ts"), allowed()).jobId;
    a.tick();
    env.clock.t += LEASE_MS + 1;
    mkRunner("B", { store: env.open() }).tick();
    await vi.waitFor(() => expect(s.get(id)?.state).toBe("uncertain"));
    hang.resolve();
  });

  it("心跳写失败(换人)→ fencing:abort 本进程该 kind 全部 job,不再认领", async () => {
    const hang = gate();
    let sig!: AbortSignal;
    registerProcessor(fakeProcessor({ run: async (_j: ProcessJob, ctx: ProcessContext) => { sig = ctx.signal; await hang.promise; return { outputs: [] }; } }));
    const a = mkRunner("A");
    const s = env.open();
    s.enqueue(env.job("a.ts"), allowed());
    a.tick();
    s.releaseLease("fake", "A"); // 模拟被换人
    s.acquireLease("fake", "B", { pid: process.pid });
    a.heartbeat();
    expect(sig.aborted).toBe(true);
    s.enqueue(env.job("b.ts"), allowed());
    a.tick(); // 已不持有 → 重新尝试抢,B 存活 → 抢不到,不认领
    expect(s.list({ state: "running" }).every((j) => j.claimedBy !== "A" || j.jobId.includes("a.ts"))).toBe(true);
    expect(s.list({ state: "pending" })).toHaveLength(1);
    hang.resolve();
  });
});

describe("故障处理(不静默、不崩)", () => {
  it("心跳连续写失败累计满一个租约时长 → fencing abort;未满不 abort", async () => {
    const hang = gate();
    let sig!: AbortSignal;
    registerProcessor(fakeProcessor({ run: async (_j: ProcessJob, ctx: ProcessContext) => { sig = ctx.signal; await hang.promise; return { outputs: [] }; } }));
    const store = env.open();
    const r = mkRunner("A", { store });
    store.enqueue(env.job("a.ts"), allowed());
    r.tick();
    const real = store.heartbeat.bind(store);
    store.heartbeat = () => { throw new Error("database is locked"); };
    r.heartbeat(); r.heartbeat();
    expect(sig.aborted).toBe(false); // 2×10s < 30s
    r.heartbeat(); // 第 3 次 = 30s ≥ 租约
    expect(sig.aborted).toBe(true);
    store.heartbeat = real;
    hang.resolve();
  });

  it("claim 抛错不泄漏并发槽:下一轮仍可认领", async () => {
    registerProcessor(fakeProcessor());
    const store = env.open();
    const r = mkRunner("A", { store });
    const id = store.enqueue(env.job("a.ts"), allowed()).jobId;
    const real = store.claim.bind(store);
    store.claim = () => { throw new Error("busy"); };
    expect(() => r.tick()).not.toThrow(); // tick 永不抛(兜住并留痕)
    expect(store.get(id)?.state).toBe("pending");
    store.claim = real;
    r.tick();
    await vi.waitFor(() => expect(store.get(id)?.state).toBe("done"));
  });

  it("收尾写表失败 → 告警留痕、不产生未处理 rejection;行留 running 待接管", async () => {
    registerProcessor(fakeProcessor());
    const store = env.open();
    const r = mkRunner("A", { store });
    const id = store.enqueue(env.job("a.ts"), allowed()).jobId;
    store.finish = () => { throw new Error("disk I/O error"); };
    r.tick();
    await vi.waitFor(() => expect(alerts.some(([, m]) => m.includes("收尾异常"))).toBe(true));
    expect(store.get(id)?.state).toBe("running");
  });
});

describe("取消", () => {
  it("requestCancel 对 running 行 → 心跳发现并 abort → cancelled", async () => {
    registerProcessor(fakeProcessor({
      run: (_j: ProcessJob, ctx: ProcessContext) => new Promise((_, rej) => {
        ctx.signal.addEventListener("abort", () => rej(new Error("aborted")));
      }),
    }));
    const r = mkRunner("A");
    const s = env.open();
    const id = s.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick();
    expect(s.requestCancel(id)).toBe("requested");
    r.heartbeat();
    await vi.waitFor(() => expect(s.get(id)?.state).toBe("cancelled"));
  });
});

describe("stop() 关停语义", () => {
  it("interruptible job:abort 回 pending、attempts 不变、tmp 删、inputs 不动;租约行删除;之后不再认领", async () => {
    const tmp = env.file("a.drec-tmp");
    const input = env.file("a.ts");
    registerProcessor(fakeProcessor({
      interruptible: true,
      run: (_j: ProcessJob, ctx: ProcessContext) => new Promise((_, rej) => {
        ctx.signal.addEventListener("abort", () => { rmSync(tmp, { force: true }); rej(new Error("aborted")); });
      }),
    }));
    const r = mkRunner("A");
    const s = env.open();
    const id = s.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick();
    expect(s.get(id)?.attempts).toBe(1);
    await r.stop();
    expect(s.get(id)).toMatchObject({ state: "pending", attempts: 0, claimedBy: null });
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(input)).toBe(true);
    expect(s.getLease("fake")).toBeNull();
    expect(r.active().host).toBe(false);
    r.tick(); // 已停止:不再认领
    expect(s.get(id)?.state).toBe("pending");
  });

  it("处理器无视 abort:超过等待上限后强制回 pending,且其后续 assertLease 失败", async () => {
    const hang = gate();
    let ctxRef!: ProcessContext;
    registerProcessor(fakeProcessor({ run: async (_j: ProcessJob, ctx: ProcessContext) => { ctxRef = ctx; await hang.promise; return { outputs: [] }; } }));
    const r = mkRunner("A", { abortWaitMs: 30 });
    const s = env.open();
    const id = s.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick();
    await r.stop();
    expect(s.get(id)).toMatchObject({ state: "pending", attempts: 0 });
    expect(() => ctxRef.assertLease()).toThrow(/租约已丢/);
    hang.resolve();
  });

  it("非 interruptible:等待到完成再收尾(done),不 abort", async () => {
    const g = gate();
    let aborted = false;
    registerProcessor(fakeProcessor({
      interruptible: false,
      run: async (_j: ProcessJob, ctx: ProcessContext) => {
        ctx.signal.addEventListener("abort", () => { aborted = true; });
        await g.promise;
        return { outputs: [] };
      },
    }));
    const r = mkRunner("A");
    const s = env.open();
    const id = s.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick();
    const stopping = r.stop();
    await new Promise((x) => setTimeout(x, 30));
    expect(s.get(id)?.state).toBe("running"); // 仍在等
    g.resolve();
    await stopping;
    expect(s.get(id)?.state).toBe("done");
    expect(aborted).toBe(false);
    expect(s.getLease("fake")).toBeNull();
  });

  it("非 interruptible 超时:abort,落点走 cancelOutcome(非 biliup → cancelled)+ 告警", async () => {
    registerProcessor(fakeProcessor({
      interruptible: false,
      run: (_j: ProcessJob, ctx: ProcessContext) => new Promise((_, rej) => {
        ctx.signal.addEventListener("abort", () => rej(new Error("aborted")));
      }),
    }));
    const r = mkRunner("A", { shutdownWaitMs: 30 });
    const s = env.open();
    const id = s.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick();
    await r.stop();
    expect(s.get(id)).toMatchObject({ state: "cancelled" });
    expect(alerts.some(([, m]) => m.includes("关停超时"))).toBe(true);
  });

  it("非 interruptible 超时:biliup 类(cancelOutcome hasIntent → uncertain)落 uncertain", async () => {
    registerProcessor(fakeProcessor({
      kind: "biliup", interruptible: false,
      run: (_j: ProcessJob, ctx: ProcessContext) => new Promise((_, rej) => {
        ctx.signal.addEventListener("abort", () => rej(new Error("aborted")));
      }),
    }));
    const r = mkRunner("A", { shutdownWaitMs: 30 });
    const s = env.open();
    const id = s.enqueue(env.job("a.ts", { kind: "biliup", logicalKey: "t:a@" }), allowed()).jobId;
    r.tick();
    await r.stop();
    expect(s.get(id)).toMatchObject({ state: "uncertain" });
  });

  it("重复 stop 安全", async () => {
    const r = mkRunner("A");
    await r.stop();
    await r.stop();
  });
});

describe("readProcActive(_node-status 用,只读)", () => {
  it("库不存在 → 全空且不创建文件;存在 → 计数 + leaseAlive", async () => {
    expect(readProcActive(env.root)).toEqual({ host: false, running: {}, pending: {}, leaseAlive: {} });
    expect(existsSync(env.dbPath)).toBe(false);
    const g = gate();
    registerProcessor(fakeProcessor({ run: async () => { await g.promise; return { outputs: [] }; } }));
    const r = mkRunner("A");
    const s = env.open();
    s.enqueue(env.job("a.ts"), allowed());
    s.enqueue(env.job("b.ts"), allowed());
    r.tick();
    expect(readProcActive(env.root)).toEqual({ host: false, running: { fake: 1 }, pending: { fake: 1 }, leaseAlive: { fake: true } });
    g.resolve();
    writeFileSync(env.rec + "/keep", "");
  });
});

describe("返工(PR #154 审查 F1/F2/F4/F5/F6)", () => {
  it("F1:接管后补跑的 tick 抛错不得逃逸成 unhandled rejection", async () => {
    const seen: unknown[] = [];
    const h = (e: unknown): void => { seen.push(e); };
    process.on("unhandledRejection", h);
    try {
      registerProcessor(fakeProcessor());
      const store = env.open();
      const logs: string[] = [];
      const r = mkRunner("A", { store, log: (m) => logs.push(m) });
      store.claim = () => { throw new Error("database is locked"); };
      expect(() => r.tick()).not.toThrow();
      await new Promise((x) => setTimeout(x, 50)); // 让 recover 后的补跑 tick 跑完
      expect(seen).toEqual([]);
      expect(logs.some((m) => m.includes("认领失败") && m.includes("database is locked"))).toBe(true);
    } finally {
      process.off("unhandledRejection", h);
    }
  });

  it("F1:acquireLease 抛错也不逃逸(tick 不抛、留痕、下一轮恢复)", async () => {
    registerProcessor(fakeProcessor());
    const store = env.open();
    const logs: string[] = [];
    const r = mkRunner("A", { store, log: (m) => logs.push(m) });
    const real = store.acquireLease.bind(store);
    store.acquireLease = () => { throw new Error("database is locked"); };
    expect(() => r.tick()).not.toThrow();
    expect(logs.some((m) => m.includes("抢租约失败"))).toBe(true);
    store.acquireLease = real;
    const id = store.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick();
    await vi.waitFor(() => expect(store.get(id)?.state).toBe("done"));
  });

  it("F2:心跳失败触发 fence → 同一持有者重新拿到租约 → 被 abort 的行必须被恢复处理,不得停在 running", async () => {
    let runs = 0;
    registerProcessor(fakeProcessor({
      run: (_j: ProcessJob, ctx: ProcessContext) => new Promise((res, rej) => {
        runs++;
        if (runs > 1) return res({ outputs: [] });
        ctx.signal.addEventListener("abort", () => rej(new Error("aborted")));
      }),
      recover: async () => "rerun" as const,
    }));
    const store = env.open();
    const r = mkRunner("A", { store });
    const id = store.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick();
    expect(store.get(id)?.state).toBe("running");
    const real = store.heartbeat.bind(store);
    store.heartbeat = () => { throw new Error("database is locked"); };
    r.heartbeat(); r.heartbeat(); r.heartbeat(); // 3×10s ≥ 租约 → fence
    store.heartbeat = real;
    for (let i = 0; i < 10 && store.get(id)?.state !== "done"; i++) {
      await new Promise((x) => setTimeout(x, 20));
      r.tick(); r.heartbeat();
    }
    expect(store.get(id)?.state).toBe("done"); // rerun 后第二次执行完成
    expect(runs).toBe(2);
    expect(r.active().running.fake).toBe(0);
  });

  it("F2:fence 后重获租约、recover=uncertain → 行落 uncertain + 告警(不停 running)", async () => {
    registerProcessor(fakeProcessor({
      run: (_j: ProcessJob, ctx: ProcessContext) => new Promise((_, rej) => {
        ctx.signal.addEventListener("abort", () => rej(new Error("aborted")));
      }),
    })); // 无 recover → uncertain
    const store = env.open();
    const r = mkRunner("A", { store });
    const id = store.enqueue(env.job("a.ts"), allowed()).jobId;
    r.tick();
    const real = store.heartbeat.bind(store);
    store.heartbeat = () => { throw new Error("database is locked"); };
    r.heartbeat(); r.heartbeat(); r.heartbeat();
    store.heartbeat = real;
    await vi.waitFor(() => { r.tick(); expect(store.get(id)?.state).toBe("uncertain"); });
    expect(alerts.some(([, m]) => m.includes("需人工确认"))).toBe(true);
  });

  it("F4/V8:A 停顿 → B 接管 → A 在下次心跳前醒来调 assertLease,必须抛(DB 侧 fencing)", async () => {
    const stuck = gate();
    let aCtx!: ProcessContext;
    let runs = 0;
    registerProcessor(fakeProcessor({
      run: async (_j: ProcessJob, ctx: ProcessContext) => { runs++; if (runs === 1) { aCtx = ctx; await stuck.promise; } return { outputs: [] }; },
      recover: async () => "rerun" as const,
    }));
    const a = mkRunner("A");
    const s = env.open();
    s.enqueue(env.job("a.ts"), allowed());
    a.tick();
    expect(() => aCtx.assertLease()).not.toThrow(); // 停顿前合法
    env.clock.t += LEASE_MS + 1; // A 停顿,租约过期
    mkRunner("B").tick();
    await vi.waitFor(() => expect(s.getLease("fake")?.owner).toBe("B"));
    expect(() => aCtx.assertLease()).toThrow(/租约已丢/); // 没有任何 heartbeat / fence 先行
    stuck.resolve();
  });

  it("F6:磁盘告警在认领写事务之外发出(告警回调里另一连接可立刻写)", () => {
    registerProcessor(fakeProcessor({ estimateDiskBytes: () => 10e9 }));
    const other = env.open({ busyTimeoutMs: 50 });
    const store = env.open();
    let wrote: unknown = null;
    const r = mkRunner("A", {
      store, diskMinGB: () => 5, freeBytes: () => 1e9,
      alert: () => { wrote = other.enqueue(env.job("b.ts", { logicalKey: "t:b@" }), allowed()); }, // 事务内会 locked 抛错
    });
    store.enqueue(env.job("a.ts"), allowed());
    r.tick();
    expect(wrote).toMatchObject({ state: "pending" });
  });

  it("F6:start() 带定时器时先同步跑首个 tick(再建定时器)", () => {
    registerProcessor(fakeProcessor());
    const store = env.open();
    const r = new ProcRunner({
      store, owner: "A", diskMinGB: () => 0, alert: () => {}, tickMs: 3_600_000, heartbeatMs: 3_600_000, gcIntervalMs: 3_600_000,
    });
    runners.push(r);
    r.start();
    expect(store.getLease("fake")?.owner).toBe("A"); // 未等任何定时器
  });

  it("F6:readProcActive 对已存在的库不写(只读连接),未迁移的空文件 → 全空", () => {
    mkdirSync(dirname(env.dbPath), { recursive: true });
    writeFileSync(env.dbPath, ""); // 0 字节(未迁移)
    expect(readProcActive(env.root)).toEqual({ host: false, running: {}, pending: {}, leaseAlive: {} });
    expect(statSync(env.dbPath).size).toBe(0); // 只读:没迁移、没写
    const s = env.open();
    s.acquireLease("fake", "A", { pid: process.pid });
    const dto = readProcActive(env.root);
    expect(dto.leaseAlive.fake).toBe(true);
  });
});
