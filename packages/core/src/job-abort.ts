import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

/** 用户点停止:ledger / UI 固定文案。不可改,reconciler 靠它区分 failed 自动重试。 */
export const USER_STOP = "用户停止";

// STAGE_READY 定义在 hub-ledger-contract(纯模块,前端可引),此处再导出保持既有 import 路径可用。
import { STAGE_READY } from "./hub-ledger-contract.js";
export { STAGE_READY };


/**
 * stage 交付模式正常收口时该写的 `sync_jobs.error`;upload 模式返回空串(该模式不该走这条路径)。
 *
 * 收口到 `needs_manual` 的路径散落在 orchestrator 管线与 CLI 节点重跑,曾经其中一条漏写 error,
 * 于是正常收口被队列判成红灯事故(issue #188)。统一从这里取值,漏写的面就只剩「忘记调用」。
 */
/** 只需 `setState(streamKey, state, patch)` 这一面账的台账(真实 SyncLedger / 测试假账都满足)。 */
export interface StageCompletionLedger {
  setState(streamKey: string, state: "needs_manual", patch: { error: string }): unknown;
}

/**
 * stage 交付模式的收口落账:写 `needs_manual` **并带上显式原因**(issue #188)。
 *
 * 为什么是函数而不是让调用点各写 `setState(..., { error: STAGE_READY })`:
 * 这条收口分散在 orchestrator 的两条管线与 CLI 的单节点重跑三处,历史上其中一处漏写 error,
 * 结果正常收口被队列判成红灯事故。收口只经过这一个入口,漏写的面就只剩「忘记调用」。
 */
export function closeStageReady(ledger: StageCompletionLedger, streamKey: string, uploadMode: string | undefined): void {
  ledger.setState(streamKey, "needs_manual", { error: stageCompletionError(uploadMode) });
}

export function stageCompletionError(uploadMode: string | undefined): string {
  if (uploadMode === "upload") {
    // upload 模式不该走「收口到 needs_manual」这条路径;真走到这里说明上游判断漏了,
    // 不能静默写空 error(会被队列判成数据异常),所以明确抛出来而不是返回 ""。
    throw new Error("stageCompletionError: upload 模式没有 needs_manual 收口路径");
  }
  return STAGE_READY;
}

const KILL_ESCALATE_MS = 2_000;

export class JobAbortedError extends Error {
  override readonly name = "JobAbortedError";
  constructor(message = USER_STOP) {
    super(message);
  }
}

export function isJobAbort(err: unknown): boolean {
  return err instanceof JobAbortedError
    || (err instanceof Error && err.message === USER_STOP);
}

const als = new AsyncLocalStorage<string>();
const live = new Map<string, Set<ChildProcess>>();
const aborted = new Set<string>();
const processGroup = new WeakMap<ChildProcess, boolean>();

export function currentJobKey(): string | undefined {
  return als.getStore();
}

export function isJobLive(key: string): boolean {
  return live.has(key);
}

export function isAborted(key?: string): boolean {
  const k = key ?? currentJobKey();
  return k !== undefined && aborted.has(k);
}

export function throwIfAborted(key?: string): void {
  if (isAborted(key)) throw new JobAbortedError();
}

export function beginJob(key: string): void {
  if (!live.has(key)) live.set(key, new Set());
}

export function endJob(key: string): void {
  live.delete(key);
  aborted.delete(key);
}

/**
 * 停一场正在跑的 job:标 aborted + 杀已登记子进程。
 * 非 live → false,且不留下 aborted 痕迹(否则下次误伤)。
 * 不调用 endJob:管线自己 catch 后收口,sweep/UI 才能看到 needs_manual。
 */
export function abortJob(key: string): boolean {
  const children = live.get(key);
  if (!children) return false;
  aborted.add(key);
  for (const child of [...children]) killChild(child);
  return true;
}

export function registerChild(
  child: ChildProcess,
  opts: { processGroup?: boolean } = {},
): void {
  const key = currentJobKey();
  if (!key) return;
  if (opts.processGroup) processGroup.set(child, true);
  const set = live.get(key);
  if (set) {
    set.add(child);
    const drop = (): void => { set.delete(child); };
    child.once("close", drop);
    child.once("exit", drop);
  }
  if (aborted.has(key)) killChild(child);
}

export async function runWithJob<T>(key: string, fn: () => Promise<T>): Promise<T> {
  beginJob(key);
  try {
    return await als.run(key, fn);
  } finally {
    endJob(key);
  }
}

function killChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null || child.exitCode != null || child.signalCode != null) return;
  const useGroup = processGroup.get(child) === true;
  try {
    if (useGroup) process.kill(-pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* 已死 / 无权限 */ }
  setTimeout(() => {
    if (child.exitCode != null || child.signalCode != null) return;
    try {
      if (useGroup) process.kill(-pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* 已死 */ }
  }, KILL_ESCALATE_MS);
}

/** 仅供测试:清空 ALS 外的 live/aborted 登记。 */
export function _resetJobAbort(): void {
  live.clear();
  aborted.clear();
}
