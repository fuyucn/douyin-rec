/**
 * app/node-enqueue.ts — 节点侧「远端入队通道」(plans/036 §2.4 / T9a):`_enqueue` / `_proc-status` 隐藏命令与
 * 本机 LocalTransport 共用的执行体。**本步无派发方**(T9b 才接),线上行为不变。
 *
 * 安全口径(节点侧,master 传来的路径一律不可信):
 * - 第一期只受理 `kind=remux`;
 * - `assertJobInvariants` 用本节点 `allowedRoots` = 数据根下 `recordings/`、`stage/` + 本节点各任务的输出目录
 *   + 本机 `effectiveHubConfig().stageDir`(可在数据根外,N3);
 * - **realpath 校验**:core 的路径判定是纯字符串、不跟符号链接,`<root>/link -> /etc` 下的路径会放行。
 *   这里把 inputs/outputs 与根都解到真实路径(不存在的路径取「存在的最深祖先 realpath + 余下段」)后再判一次。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  assertJobInvariants, getProcessor, type EnqueueRequest, type EnqueueResponse, type EnqueueResult, type ProcessJob,
  type ProcessReceipt, type Processor,
} from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { effectiveHubConfig } from "./disk-gate.js";
import { TaskStore } from "./store.js";

/** 第一期远端只受理的处理器 kind。 */
export const REMOTE_ENQUEUE_KINDS: readonly string[] = ["remux"];

/** 解析路径到真实路径:存在 → realpath;不存在 → 最深的存在祖先 realpath + 余下段(产物路径可能尚未创建)。 */
export function realpathDeep(p: string): string {
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs; // 到根仍解不开 → 按字面(后续根判定自然拒)
      rest.unshift(basename(cur));
      cur = up;
    }
  }
}

export interface NodeRootsOpts {
  /** 测试注入:各任务输出目录(缺省读节点 db)。 */
  taskOutDirs?: string[];
  /** 测试注入:hub stageDir(缺省读 effectiveHubConfig)。 */
  stageDir?: string | null;
}

function readTaskOutDirs(dataRoot: string): string[] {
  const dbFile = join(dataRoot, "db", "douyin-rec.db");
  if (!existsSync(dbFile)) return [];
  try {
    const store = new TaskStore(dbFile);
    try {
      const fallback = process.env.DOUYIN_REC_OUTPUT ?? join(dataRoot, "recordings");
      return store.listTasks().map((t) => t.outDir ?? fallback);
    } finally {
      store.close();
    }
  } catch {
    return []; // db 打不开 → 只剩固定根(fail-closed 方向:根更少而非更多)
  }
}

function readHubStageDir(): string | null {
  try {
    const eff = effectiveHubConfig();
    const text = eff.json ?? (eff.path && existsSync(eff.path) ? readFileSync(eff.path, "utf-8") : undefined);
    if (!text) return null;
    const dir = (JSON.parse(text) as { stageDir?: unknown }).stageDir;
    return typeof dir === "string" && dir !== "" ? dir : null;
  } catch {
    return null;
  }
}

/** 本节点入队允许根(绝对路径;排除文件系统根,防一条配置放行全盘)。 */
export function nodeAllowedRoots(dataRoot: string, opts: NodeRootsOpts = {}): string[] {
  const root = resolve(dataRoot);
  const stage = opts.stageDir !== undefined ? opts.stageDir : readHubStageDir();
  const cand = [join(root, "recordings"), join(root, "stage"), ...(opts.taskOutDirs ?? readTaskOutDirs(root)), ...(stage ? [stage] : [])];
  const out = new Set<string>();
  for (const c of cand) {
    if (!isAbsolute(c)) continue;
    const r = resolve(c);
    if (dirname(r) === r) continue; // "/" 不算根
    out.add(r);
  }
  return [...out];
}

/**
 * realpath 口径的 `assertJobInvariants`:路径与根都解到真实路径后再判(权威),违反抛错;返回**真实路径版**的 job
 * (入队用它:任务表里存真实路径,也就不会在校验后被换链接指向别处)。
 * 先做一次结构预检(根判定放开为 "/",仅此内部调用):必须在 realpath 之前 —— realpathDeep 会把相对路径按 cwd
 * 解成绝对路径,掩盖「须为绝对路径」。
 */
export function assertJobInvariantsReal(job: ProcessJob, allowedRoots: readonly string[]): ProcessJob {
  assertJobInvariants(job, { allowedRoots: [parse(resolve(".")).root] });
  const real: ProcessJob = {
    ...job,
    inputs: job.inputs.map(realpathDeep),
    ...(job.outputs ? { outputs: job.outputs.map(realpathDeep) } : {}),
  };
  assertJobInvariants(real, { allowedRoots: allowedRoots.map(realpathDeep) });
  return real;
}

export interface HandleEnqueueOpts extends NodeRootsOpts {
  /** 测试注入:处理器查找(缺省走 core 注册表)。 */
  getProcessor?: (kind: string) => Processor | undefined;
  log?: (msg: string) => void;
}

/** `_enqueue` 执行体:逐 job 受理,单个 job 的拒绝不影响其余。库打不开 → 抛错(命令非零退出,派发方当失败)。 */
export function handleEnqueue(dataRoot: string, req: EnqueueRequest, opts: HandleEnqueueOpts = {}): EnqueueResponse {
  const roots = nodeAllowedRoots(dataRoot, opts);
  const lookup = opts.getProcessor ?? getProcessor;
  const store = new ProcQueueStore(procQueueDbPath(dataRoot), { log: opts.log });
  try {
    const results: EnqueueResult[] = req.jobs.map((job) => {
      const reject = (error: string): EnqueueResult => ({ jobId: job.jobId, state: "rejected", error });
      if (!REMOTE_ENQUEUE_KINDS.includes(job.kind)) return reject(`远端不受理 kind=${job.kind}`);
      let real: ProcessJob;
      try {
        real = assertJobInvariantsReal(job, roots);
      } catch (e) {
        return reject((e as Error).message);
      }
      const proc = lookup(job.kind);
      if (!proc) return reject(`节点未注册处理器: ${job.kind}`);
      const why = proc.validate(real);
      if (why) return reject(why);
      // 入队真实路径版 job + 真实路径根:store 内部的字面校验与 realpath 口径一致。
      return store.enqueue(real, { allowedRoots: roots.map(realpathDeep) });
    });
    return { v: 1, results };
  } finally {
    store.close();
  }
}

/** `_proc-status` 执行体:库不存在 → `[]`;未知 jobId 不出现在回执里(派发方据缺席判定)。 */
export function handleProcStatus(dataRoot: string, jobIds: string[]): ProcessReceipt[] {
  const path = procQueueDbPath(dataRoot);
  if (!existsSync(path)) return [];
  let store: ProcQueueStore;
  try {
    store = new ProcQueueStore(path, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const out: ProcessReceipt[] = [];
    for (const id of jobIds) {
      const row = store.get(id);
      if (!row) continue;
      out.push({ jobId: id, state: row.state, ...(row.error ? { error: row.error } : {}), leaseAlive: store.leaseAlive(row.kind) });
    }
    return out;
  } catch {
    return []; // 库存在但未迁移(表缺失)等:视为空
  } finally {
    store.close();
  }
}

/** `_proc-status` 的 base64 参数解码(JSON 字符串数组;非法抛错)。 */
export function decodeJobIds(b64: string): string[] {
  const buf = Buffer.from(b64, "base64");
  if (buf.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) throw new Error("非法 base64");
  const v = JSON.parse(buf.toString("utf8")) as unknown;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error("jobIds 须为字符串数组");
  return v as string[];
}

export function encodeJobIds(ids: string[]): string {
  return Buffer.from(JSON.stringify(ids), "utf8").toString("base64");
}
