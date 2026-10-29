// plans/036 T9a:远端入队通道 —— 节点侧 `_enqueue` / `_proc-status` 执行体 + capabilities + Transport(ssh / local)。
// 任务表是真 sqlite(临时目录);ssh 的 `run` 用进程内「假节点」调同一执行体,验证编解码往返。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetProcessors, assertJobInvariants, decodeEnqueue, jobIdOf, registerProcessor, type EnqueueRequest, type ProcessJob,
} from "@drec/core";
import { ProcQueueStore, fileTagOf, procQueueDbPath } from "@drec/proc-queue";
import { remuxProcessor, remuxTargetPath } from "@drec/processors";
import {
  assertJobInvariantsReal, decodeJobIds, handleEnqueue, handleProcStatus, nodeAllowedRoots,
} from "../../packages/app/src/node-enqueue.js";
import { SshTransport } from "../../packages/orchestrator/src/transport-ssh.js";
import { LocalTransport } from "../../packages/orchestrator/src/transport-local.js";
import { ProcUnsupported, getTransport, _resetTransports } from "../../packages/orchestrator/src/transport.js";
import { registerBuiltinTransports } from "../../packages/orchestrator/src/index.js";

let root: string, rec: string, outside: string;
const stores: ProcQueueStore[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "node-enqueue-"));
  rec = join(root, "recordings", "主播"); mkdirSync(rec, { recursive: true });
  outside = mkdtempSync(join(tmpdir(), "node-enqueue-out-"));
  _resetProcessors();
  registerProcessor(remuxProcessor);
});
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  _resetProcessors();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const store = (): ProcQueueStore => { const s = new ProcQueueStore(procQueueDbPath(root)); stores.push(s); return s; };
const file = (dir: string, name: string, body = "x"): string => { const p = join(dir, name); writeFileSync(p, body); return p; };
const mkJob = (input: string, over: Partial<ProcessJob> = {}, gen = 1): ProcessJob => {
  const key = over.logicalKey ?? "task1:a.ts@";
  return {
    jobId: jobIdOf("remux", key, gen), kind: "remux", logicalKey: key, generation: gen,
    inputs: [input], outputs: [remuxTargetPath(input, "mkv")], params: { format: "mkv" }, replaceInputs: true,
    owner: { taskId: 1 }, createdAt: 1, ...over,
  };
};
const req = (...jobs: ProcessJob[]): EnqueueRequest => ({ v: 1, jobs });
const opts = (extra: { stageDir?: string | null } = {}) => ({ taskOutDirs: [], stageDir: null, ...extra });

describe("_enqueue:路径白名单", () => {
  it("数据根内 recordings 下的路径受理", () => {
    const r = handleEnqueue(root, req(mkJob(file(rec, "a.ts"))), opts());
    expect(r.results[0].state).toBe("pending");
    expect(r.results[0].jobId).toMatch(/^remux:task1:a\.ts@\d+-1#g1$/);
  });

  it("数据根外且不在 allowedRoots 的路径被拒", () => {
    const r = handleEnqueue(root, req(mkJob(file(outside, "a.ts"))), opts());
    expect(r.results[0]).toMatchObject({ state: "rejected" });
    expect(r.results[0].error).toMatch(/allowedRoots/);
    expect(store().list()).toHaveLength(0);
  });

  it("stageDir 在数据根外时仍可入队(N3);未配置该 stageDir 则被拒", () => {
    const p = file(outside, "a.ts");
    expect(handleEnqueue(root, req(mkJob(p)), opts({ stageDir: outside })).results[0].state).toBe("pending");
    rmSync(procQueueDbPath(root), { force: true });
    expect(handleEnqueue(root, req(mkJob(p)), opts()).results[0].state).toBe("rejected");
  });

  it("任务自带 outDir(数据根外)进 allowedRoots", () => {
    const roots = nodeAllowedRoots(root, { taskOutDirs: [outside], stageDir: null });
    expect(roots).toContain(outside);
    expect(roots).toContain(join(root, "stage"));
  });

  it('allowedRoots 排除文件系统根("/" 与相对路径不放行)', () => {
    const roots = nodeAllowedRoots(root, { taskOutDirs: ["/", "rel/dir"], stageDir: "/" });
    expect(roots).not.toContain("/");
    expect(roots.every((r) => r.startsWith("/"))).toBe(true);
    expect(roots.some((r) => r.endsWith("rel/dir"))).toBe(false);
  });

  it("单个 job 被拒不影响同批其余 job", () => {
    const r = handleEnqueue(root, req(mkJob(file(outside, "bad.ts"), { logicalKey: "task1:bad.ts@" }), mkJob(file(rec, "ok.ts"), { logicalKey: "task1:ok.ts@" })), opts());
    expect(r.results.map((x) => x.state)).toEqual(["rejected", "pending"]);
  });
});

describe("_enqueue:符号链接逃逸(realpath)", () => {
  const link = (): string => { const l = join(rec, "link"); symlinkSync(outside, l); return l; };

  it("core 的纯字符串口径放行链接下的路径(口径钉死)—— 节点侧 realpath 兜底", () => {
    const l = link();
    const j = mkJob(file(outside, "e.ts"), { inputs: [join(l, "e.ts")], outputs: [join(l, "e.mkv")] });
    expect(() => assertJobInvariants(j, { allowedRoots: [join(root, "recordings")] })).not.toThrow();
    expect(() => assertJobInvariantsReal(j, [join(root, "recordings")])).toThrow(/allowedRoots/);
  });

  it("<root>/link -> 根外 目录下的输入被拒", () => {
    const l = link();
    file(outside, "e.ts");
    const r = handleEnqueue(root, req(mkJob(join(l, "e.ts"))), opts());
    expect(r.results[0]).toMatchObject({ state: "rejected" });
    expect(r.results[0].error).toMatch(/allowedRoots/);
    expect(store().list()).toHaveLength(0);
  });

  it("文件本身是指向根外的符号链接被拒", () => {
    const target = file(outside, "real.ts");
    const fl = join(rec, "fl.ts"); symlinkSync(target, fl);
    expect(handleEnqueue(root, req(mkJob(fl)), opts()).results[0].state).toBe("rejected");
  });

  it("输入合法但 outputs 经链接逃逸(目标尚不存在)被拒", () => {
    const l = link();
    const j = mkJob(file(rec, "a.ts"), { outputs: [join(l, "sub", "a.mkv")] });
    expect(handleEnqueue(root, req(j), opts()).results[0].state).toBe("rejected");
  });

  it("allowedRoot 自身是符号链接(如 macOS /tmp)时,真实路径仍受理", () => {
    const realRoot = mkdtempSync(join(tmpdir(), "node-enqueue-real-"));
    try {
      const viaLink = join(tmpdir(), `node-enqueue-lnk-${process.pid}`);
      symlinkSync(realRoot, viaLink);
      try {
        const p = file(realRoot, "a.ts");
        expect(handleEnqueue(root, req(mkJob(p)), opts({ stageDir: viaLink })).results[0].state).toBe("pending");
      } finally { rmSync(viaLink, { force: true }); }
    } finally { rmSync(realRoot, { recursive: true, force: true }); }
  });
});

describe("_enqueue:受理范围", () => {
  it("非 remux kind 被拒", () => {
    const p = file(rec, "a.mp4");
    const key = "final:s:plain:a.mp4@";
    const j: ProcessJob = { ...mkJob(p), kind: "merge", logicalKey: key, jobId: jobIdOf("merge", key, 1), params: {} };
    expect(handleEnqueue(root, req(j), opts()).results[0]).toMatchObject({ state: "rejected", error: expect.stringContaining("remote enqueue does not accept") });
  });

  it("处理器 validate 不过(params.format 非法)被拒", () => {
    const r = handleEnqueue(root, req(mkJob(file(rec, "a.ts"), { params: { format: "avi" } })), opts());
    expect(r.results[0].state).toBe("rejected");
  });

  it("xml 进 replaceInputs 被拒(契约层仍生效)", () => {
    const r = handleEnqueue(root, req(mkJob(file(rec, "a.xml"))), opts());
    expect(r.results[0].state).toBe("rejected");
  });
});

describe("_enqueue:回执语义", () => {
  const finishDone = (jobId: string, outputs: string[]): void => {
    const s = store();
    s.acquireLease("remux", "A", { pid: process.pid });
    const c = s.claim({ kinds: ["remux"], owner: "A" })!;
    expect(c.jobId).toBe(jobId);
    expect(s.finish(jobId, "A", { state: "done", outputs })).toBe(true);
  };

  it("stale 回执附 nextGeneration,且等于节点 store 的下一代(N1)", () => {
    const input = file(rec, "a.ts");
    const j = mkJob(input);
    const first = handleEnqueue(root, req(j), opts()).results[0];
    const out = file(rec, "a.mkv");
    finishDone(first.jobId, [out]);
    rmSync(out); // 产物不在了
    const again = handleEnqueue(root, req(j), opts()).results[0];
    expect(again.state).toBe("stale");
    expect(again.jobId).toBe(first.jobId);
    expect(again.nextGeneration).toBe(2);
    expect(again.nextGeneration).toBe(store().nextGeneration("remux", "task1:a.ts@" + fileTagOf(input)));
  });

  it("以 stale 回执的 nextGeneration 重发 → 受理为新一代 pending", () => {
    const input = file(rec, "a.ts");
    const first = handleEnqueue(root, req(mkJob(input)), opts()).results[0];
    const out = file(rec, "a.mkv");
    finishDone(first.jobId, [out]); rmSync(out);
    const stale = handleEnqueue(root, req(mkJob(input)), opts()).results[0];
    const resend = handleEnqueue(root, req(mkJob(input, {}, stale.nextGeneration)), opts()).results[0];
    expect(resend.state).toBe("pending");
    expect(resend.jobId).toMatch(/#g2$/);
  });

  it("remux done 后原输入已被替换删除,同键再入队 → rejected(不是 stale,不重试)", () => {
    const input = file(rec, "a.ts");
    const j = mkJob(input);
    const first = handleEnqueue(root, req(j), opts()).results[0];
    const out = file(rec, "a.mkv");
    finishDone(first.jobId, [out]);
    rmSync(input); // 转换完成,原文件被删
    const again = handleEnqueue(root, req(j), opts()).results[0];
    expect(again.state).toBe("rejected");
    expect(again.error).toMatch(/stat/);
    expect(again.nextGeneration).toBeUndefined();
  });

  it("同键重复入队幂等(pending 原样回报,不新增行)", () => {
    const input = file(rec, "a.ts");
    handleEnqueue(root, req(mkJob(input)), opts());
    expect(handleEnqueue(root, req(mkJob(input)), opts()).results[0].state).toBe("pending");
    expect(store().list()).toHaveLength(1);
  });

  it("fileTag 用 bigint:> 2^53 的 inode 字符串精确(N8)", () => {
    const big = (1n << 60n) + 1n;
    const fake = (() => ({ ino: big, size: 7n })) as unknown as typeof import("node:fs").statSync;
    // 期望值用表达式拼出,不写裸长数字(隐私检查会把长数字当房间号)
    expect(fileTagOf("/x", fake)).toBe(`${big}-7`);
    // 受理回执里的 jobId 带的就是 fileTagOf 同口径(真实 stat)
    const input = file(rec, "a.ts", "abc");
    expect(handleEnqueue(root, req(mkJob(input)), opts()).results[0].jobId).toContain(`@${fileTagOf(input)}#g1`);
  });
});

describe("_proc-status", () => {
  it("库不存在 → []", () => {
    expect(handleProcStatus(root, ["remux:x#g1"])).toEqual([]);
  });

  it("回执含 state / leaseAlive / error;未知 jobId 不出现", () => {
    const input = file(rec, "a.ts");
    const id = handleEnqueue(root, req(mkJob(input)), opts()).results[0].jobId;
    expect(handleProcStatus(root, [id, "remux:nope@1-1#g1"])).toEqual([{ jobId: id, state: "pending", leaseAlive: false, attempts: 0, notBefore: null, heartbeatAt: null }]);
    const s = store();
    s.acquireLease("remux", "A", { pid: process.pid });
    const c = s.claim({ kinds: ["remux"], owner: "A" })!;
    s.finish(c.jobId, "A", { state: "failed", error: "boom" });
    expect(handleProcStatus(root, [id])).toEqual([{ jobId: id, state: "failed", error: "boom", leaseAlive: true, attempts: 1, notBefore: null, heartbeatAt: expect.any(Number) }]);
  });

  it("jobIds 编解码往返;非法 base64 / 非数组抛错", () => {
    const ids = ["remux:房间 a@1-2#g1", "remux:b#g2"];
    expect(decodeJobIds(Buffer.from(JSON.stringify(ids)).toString("base64"))).toEqual(ids);
    expect(() => decodeJobIds("!!!")).toThrow();
    expect(() => decodeJobIds(Buffer.from('{"a":1}').toString("base64"))).toThrow(/数组/);
  });
});

/** 进程内「假节点」:把 ssh argv 路由到同一执行体(等价于节点上跑 `_enqueue` / `_proc-status`)。 */
const fakeNodeRun = (dataRoot: string, o = opts()) => async (argv: string[]): Promise<string> => {
  const [, , cmd, , b64] = argv[0].split(" ");
  if (cmd === "_enqueue") return JSON.stringify(handleEnqueue(dataRoot, decodeEnqueue(b64), o)) + "\n";
  if (cmd === "_proc-status") return JSON.stringify({ receipts: handleProcStatus(dataRoot, decodeJobIds(b64)) }) + "\n";
  if (cmd === "_node-capabilities") return JSON.stringify({ biliup: true, cookies: true, diskFreeGB: 9, cjkFonts: false, processors: ["remux"] }) + "\n";
  throw new Error(`error: unknown command '${cmd}'`);
};

describe("Transport:ssh / local 往返一致", () => {
  const ssh = (run: (argv: string[]) => Promise<string>) => new SshTransport({ id: "vps", host: "h", dataRoot: root, run });
  const local = (o = opts()) => new LocalTransport({
    id: "local", recordingsDir: join(root, "recordings"), taskRooms: {}, ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
    enqueue: (r) => handleEnqueue(root, r, o), procStatus: (ids) => handleProcStatus(root, ids),
  });

  it("两种 transport 对同一请求给出同样的回执与状态", async () => {
    const input = file(rec, "a.ts");
    const bad = file(outside, "b.ts");
    const request = req(mkJob(input), mkJob(bad, { logicalKey: "task1:b.ts@" }));
    const viaSsh = await ssh(fakeNodeRun(root)).enqueue!(request);
    rmSync(procQueueDbPath(root), { force: true });
    const viaLocal = await local().enqueue!(request);
    expect(viaSsh).toEqual(viaLocal);
    expect(viaSsh.results.map((r) => r.state)).toEqual(["pending", "rejected"]);
    const ids = viaSsh.results.map((r) => r.jobId);
    expect(await ssh(fakeNodeRun(root)).procStatus!(ids)).toEqual(await local().procStatus!(ids));
    expect(await local().procStatus!(ids)).toEqual([{ jobId: ids[0], state: "pending", leaseAlive: false, attempts: 0, notBefore: null, heartbeatAt: null }]);
  });

  it("旧 bundle(未知命令)→ ProcUnsupported;可达性错误不被误映射", async () => {
    const old = ssh(async () => { throw new Error("error: unknown command '_enqueue'"); });
    await expect(old.enqueue!(req(mkJob(file(rec, "a.ts"))))).rejects.toBeInstanceOf(ProcUnsupported);
    const oldStatus = ssh(async () => { throw new Error("error: unknown command '_proc-status'"); });
    await expect(oldStatus.procStatus!(["remux:x#g1"])).rejects.toBeInstanceOf(ProcUnsupported);
    const down = ssh(async () => { throw new Error("ssh: connect to host h port 22: Connection refused"); });
    const e = await down.enqueue!(req(mkJob(file(rec, "c.ts")))).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ProcUnsupported);
  });

  it("本机未注入 → ProcUnsupported", async () => {
    const t = new LocalTransport({ id: "l", recordingsDir: root, taskRooms: {}, ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }) });
    await expect(t.enqueue!(req())).rejects.toBeInstanceOf(ProcUnsupported);
    await expect(t.procStatus!([])).rejects.toBeInstanceOf(ProcUnsupported);
  });

  it("节点返回 {error} → 抛错(不静默当空回执)", async () => {
    const t = ssh(async () => JSON.stringify({ error: "库打不开" }));
    await expect(t.enqueue!(req())).rejects.toThrow(/库打不开/);
    await expect(t.procStatus!([])).rejects.toThrow(/库打不开/);
  });
});

describe("_node-capabilities.processors", () => {
  it("ssh nodeCapabilities 透传 processors;旧节点缺字段保持 undefined", async () => {
    const t = new SshTransport({ id: "v", host: "h", dataRoot: root, run: fakeNodeRun(root) });
    expect((await t.nodeCapabilities!()).processors).toEqual(["remux"]);
    const oldT = new SshTransport({ id: "v", host: "h", dataRoot: root, run: async () => JSON.stringify({ biliup: true, cookies: true, diskFreeGB: 1 }) });
    const caps = await oldT.nodeCapabilities!();
    expect(caps.processors).toBeUndefined();
    expect("processors" in caps).toBe(false);
  });

  it("existsSync 守卫:本测试不依赖仓库根", () => {
    expect(existsSync(root)).toBe(true);
  });
});

describe("assertJobInvariantsReal:结构预检先于 realpath", () => {
  it("相对路径不会被 realpath 按 cwd 解成绝对而放行", () => {
    const j = mkJob(file(rec, "a.ts"), { inputs: ["recordings/a.ts"] });
    expect(() => assertJobInvariantsReal(j, [join(root, "recordings")])).toThrow(/绝对路径/);
  });
});

describe("registerBuiltinTransports.procChannel", () => {
  afterEach(() => _resetTransports());

  it("local worker 经 cfg.dataRoot 解析任务表(库路径 = procQueueDbPath(cfg.dataRoot))", async () => {
    registerBuiltinTransports({
      ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
      procChannel: { enqueue: (dr, r) => handleEnqueue(dr, r, opts()), procStatus: handleProcStatus },
    });
    const t = getTransport({ id: "local", kind: "local", dataRoot: root } as never);
    const r = await t.enqueue!(req(mkJob(file(rec, "a.ts"))));
    expect(r.results[0].state).toBe("pending");
    expect(existsSync(procQueueDbPath(root))).toBe(true);
    expect((await t.procStatus!([r.results[0].jobId]))[0].state).toBe("pending");
  });

  it("未注入 procChannel → ProcUnsupported", async () => {
    registerBuiltinTransports({ ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }) });
    const t = getTransport({ id: "local", kind: "local", dataRoot: root } as never);
    await expect(t.enqueue!(req())).rejects.toBeInstanceOf(ProcUnsupported);
  });
});
