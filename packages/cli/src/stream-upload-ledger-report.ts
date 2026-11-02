/**
 * 直播直传收尾台账写入结果的统一出口(issue #428)。
 *
 * master 本机路径(record 子进程自己写台账)成功与否都落一行日志;**失败时**额外走告警通道
 * (与受管分支的 receiptError 同款:error 事件 → webhook + @@DREC_ALERT@@ + UI)——
 * 稿件已经传上去了,台账没记房间就永远看不到这场结果,只 console.log 是静默失败。
 * notify 必须由调用方 await(收尾后马上 process.exit,fire-and-forget 会被截断)。
 */
import type { RecordStreamUploadResult } from "@drec/orchestrator";

export interface StreamUploadLedgerReportIO {
  log: (m: string) => void;
  notify: (message: string) => Promise<void>;
}

export async function reportStreamUploadLedgerResult(r: RecordStreamUploadResult, io: StreamUploadLedgerReportIO): Promise<void> {
  if (r.ok) {
    io.log(`[直播直传] 台账已记录: ${r.bvid}${r.alreadyTerminal ? "(已是终态,未覆盖)" : ""}`);
    return;
  }
  const message = `[直播直传] ⚠️ 台账记录失败(不影响已上传稿件): ${r.error}`;
  io.log(message);
  await io.notify(message).catch(() => {});
}
