/**
 * 手动上传的配额接线（issue #596 / 审计 P0-5）。
 *
 * 生产上传（orchestrator 的 ResourcePool、节点侧 node-pipeline、队列处理器、滚动上传）都共用
 * core 的 UploadGate（账号冷却 + 滑动窗口）与本机 UploadSlot；只有 `upload` / `_upos-upload`
 * 两条手动路径绕过了它们。这里提供唯一入口：先等账号配额（冷却/窗口），再拿本机上传槽位，
 * 失败时按限流记冷却；两条手动命令都只能经此提交。
 *
 * 不提供 `--force` 静默绕过：审计 P0-5 要消灭的就是这条旁路。
 */
import { isUploadRateLimited, type UploadGate, type UploadSlot } from "@drec/core";
import { openNodeUploadGate, openNodeUploadSlot, resolveUploadAccountKey } from "@drec/app";

/** 测试注入：给了 deps 就完全按给定 gate/slot 执行，不回落真实装配（避免单测开库）。 */
export interface UploadQuotaDeps {
  gate?: Pick<UploadGate, "awaitSlot" | "recordRateLimit">;
  slot?: UploadSlot | null;
  accountKey?: string;
}

export interface UploadQuotaOpts {
  /** 账号键来自这份 biliup 凭据；与生产同一个键算法。 */
  cookiesPath: string;
  log?: (msg: string) => void;
  /** 等待本机上传槽位的上限；缺省 10 分钟。0 = 只检查一次。 */
  slotWaitMs?: number;
  deps?: UploadQuotaDeps;
}

/**
 * 先账号配额、后本机槽位：等待 30 分钟冷却时**不占**槽位（否则一条冷却把整台节点堵死）。
 * 提交命中 601/21566/21540 时记冷却（跨重启保留），与 `UploadGate.run` 同一语义。
 */
export async function runWithUploadQuota<T>(o: UploadQuotaOpts, fn: () => Promise<T>): Promise<T> {
  const log = o.log ?? ((m: string): void => console.error(m));
  const gate = o.deps ? o.deps.gate! : openNodeUploadGate({ warn: log });
  const accountKey = o.deps?.accountKey ?? resolveUploadAccountKey(o.cookiesPath);
  const slot = o.deps ? (o.deps.slot ?? null) : openNodeUploadSlot({ log });

  log(`检查账号上传配额（冷却 / 滑动窗口）…`);
  await gate.awaitSlot(accountKey);
  log(`账号配额已取得`);

  const waitMs = Math.max(0, o.slotWaitMs ?? 600_000);
  let held = false;
  if (slot) {
    log(`等待本机上传槽位（最长 ${Math.ceil(waitMs / 1000)}s）…`);
    held = await slot.acquire("queue", waitMs);
    if (!held) throw new Error(`本机上传槽位被占用，已等待 ${Math.ceil(waitMs / 1000)}s；本次未上传`);
    log(`已取得本机上传槽位`);
  }

  try {
    return await fn();
  } catch (e) {
    if (isUploadRateLimited(e)) gate.recordRateLimit(accountKey);
    throw e;
  } finally {
    if (held) slot?.release();
    slot?.close();
  }
}
