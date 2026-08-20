import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

/** 用户点停止:ledger / UI 固定文案。不可改,reconciler 靠它区分 failed 自动重试。 */
export const USER_STOP = "用户停止";

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
