import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLockSync, writeFileAtomicSync, type HubResources, type WorkerConfig } from "@drec/core";

export interface HubConfigFile {
  workerSeq?: number;
  workers?: WorkerConfig[];
  tenants?: WorkerConfig[];
  resources?: Partial<HubResources>;
  [key: string]: unknown;
}

export function parseHubConfig(text: string): HubConfigFile {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON 根必须是对象");
  }
  return parsed as HubConfigFile;
}

/** 写入底稿仅在明确缺失时默认为空;损坏或不可读必须拒绝原子替换。 */
function readConfigForWrite(path: string): HubConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`无法读取 hub 配置 ${path} (${code})`, { cause: error });
  }

  try {
    return parseHubConfig(text);
  } catch (error) {
    throw new Error(`hub 配置无效 ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** 两个 store 共用 <path>.lock;仅在持锁时读取底稿、修改并提交。省略 next 表示不落盘。 */
export function mutateHubConfig<T>(
  path: string,
  mutate: (cfg: HubConfigFile) => { result: T; next?: HubConfigFile },
): T {
  mkdirSync(dirname(path), { recursive: true });
  // 禁止自动接管:core 的陈旧锁 rename 可能挪走另一个进程刚拿到的锁。
  // 进程异常退出留下锁时明确报 busy,由操作员确认无写者后清理。
  return withFileLockSync(path, () => {
    const { result, next } = mutate(readConfigForWrite(path));
    if (next !== undefined) writeFileAtomicSync(path, JSON.stringify(next, null, 2) + "\n");
    return result;
  }, { timeoutMs: 1_000, staleMs: Infinity, isHolderAlive: () => true });
}
