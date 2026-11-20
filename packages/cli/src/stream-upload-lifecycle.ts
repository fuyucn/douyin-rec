import { noteRecorderDraining, noteRecorderSignal, zeroDiskStreamKey } from "@drec/core";
import {
  LiveUploadReporter, createZeroDiskReporter, enqueueLivePumpPending, makeNodeSubmitGate,
  resolveDbPath, syncDbPathFor, type EnqueueLivePumpResult,
} from "@drec/app";
import { recordStreamUpload } from "@drec/orchestrator";
import type { LivePumpHandoffReceipt, RunLivePumpResult } from "@drec/zero-upload";
import { livePumpHandoffReceipt } from "./live-pump-handoff.js";
import { isUploadPendingResult } from "./live-pump-exit.js";
import { reportStreamUploadLedgerResult } from "./stream-upload-ledger-report.js";
import type { PreparedStreamUpload } from "./stream-upload-setup.js";

type ReceiptReporter = ReturnType<typeof createZeroDiskReporter>;

function installSignals() {
  const abort = new AbortController();
  // SIGUSR2 must be handled before the pump starts: the default exit 159 cuts the in-flight part.
  // stopGraceful already marks the child expected and would falsely report a completed drain.
  const drain = new AbortController();
  const stop = (signal: string): void => {
    console.log("[直播直传] 收到 " + signal + ",停止录制并中止当前分 P");
    noteRecorderSignal(signal);
    abort.abort();
  };
  const onInt = (): void => stop("SIGINT");
  const onTerm = (): void => stop("SIGTERM");
  const onDrain = (): void => {
    if (drain.signal.aborted) return;
    noteRecorderDraining();
    drain.abort();
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("SIGUSR2", onDrain);
  return {
    signal: abort.signal, drainSignal: drain.signal,
    dispose: (): void => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.off("SIGUSR2", onDrain);
    },
  };
}

async function handoff(ctx: PreparedStreamUpload, statePath: string): Promise<LivePumpHandoffReceipt> {
  let queued: EnqueueLivePumpResult;
  try {
    const { options, streamMeta, uploadCookies } = ctx;
    queued = enqueueLivePumpPending({
      statePath, cookiesPath: uploadCookies,
      ...(options.taskId !== undefined && /^\d+$/.test(options.taskId)
        ? { taskId: Number(options.taskId) } : {}),
      ...(streamMeta.seasonSectionId ? { seasonSectionId: streamMeta.seasonSectionId } : {}),
      log: console.log,
    });
  } catch (error) {
    console.error("[直播直传] 待补上传入队异常(保留 spool,交回上传待补流程重试): " +
      String((error as Error)?.message ?? error));
    return livePumpHandoffReceipt(undefined, error);
  }
  const receipt = livePumpHandoffReceipt(queued);
  if (receipt.status === "owned") {
    console.log("[直播直传] 待补上传已交给节点队列: 新入队 " + queued.queued +
      ",已在队 " + queued.already + ",不可入队 " + queued.failed);
  } else {
    console.error("[直播直传] 待补分 P 未全部接管(" + receipt.status + ",保留 spool): " + receipt.detail);
  }
  return receipt;
}

async function reportResult(
  ctx: PreparedStreamUpload, reporter: ReceiptReporter | undefined,
  res: RunLivePumpResult, startMs: number,
): Promise<void> {
  const notify = (message: string) => ctx.notifier.notify({ kind: "error", stage: "直播直传", message });
  const parts = res.segments.filter((part) => !part.uploadError).length;
  if (reporter) {
    const result = reporter.finish({
      ok: res.ok, segments: parts,
      ...(res.bvid ? { bvid: res.bvid } : {}), ...(res.error ? { error: res.error } : {}),
      ...(res.lostParts ? { lostParts: res.lostParts } : {}),
      ...(res.unknownParts ? { unknownParts: res.unknownParts } : {}),
    });
    if (result.receiptError) {
      console.error("[直播直传] ⚠️ " + result.receiptError);
      await notify(result.receiptError).catch(() => {});
    } else if (result.receiptWritten) {
      console.log("[直播直传] 回执已写入,等待 master 拉取并记台账: " + res.bvid);
    }
    return;
  }
  if (!res.ok || !res.bvid) return;
  if (res.lostParts) console.log("[直播直传] ⚠️ 本场有 " + res.lostParts +
    " 个分 P 在停止时丢失,其余已入稿,照常记台账");
  const result = recordStreamUpload({
    syncDbPath: syncDbPathFor(resolveDbPath()),
    streamKey: zeroDiskStreamKey(ctx.platform.id, ctx.roomSlug, startMs),
    bvid: res.bvid, parts, startMs,
  });
  await reportStreamUploadLedgerResult(result, { log: console.log, notify });
}

function logResult(res: RunLivePumpResult): void {
  if (res.ok && res.outcome === "idle") {
    console.log("[直播直传] 本次未录到分 P(等待中被停止,或开播后立即断流),正常退出");
  } else if (res.ok && res.outcome === "no-stream") {
    console.error("[直播直传] 本场没有上传任何分 P(取不到流),按失败退出并交由调度重试");
  } else if (!res.ok && res.error) {
    console.error("[直播直传] 本场以失败收尾: " + res.error);
  }
}

/** Own signals and reporting for one run; dispose before the CLI exits. */
export function createStreamUploadLifecycle(ctx: PreparedStreamUpload) {
  const key = { platform: ctx.platform.id, roomSlug: ctx.roomSlug };
  const liveReporter = new LiveUploadReporter(key);
  const reporter = ctx.delivery ? createZeroDiskReporter(key) : undefined;
  reporter?.running();
  const submitGate = ctx.delivery
    ? makeNodeSubmitGate({ cookiesPath: ctx.uploadCookies, log: console.log }) : undefined;
  const signals = installSignals();
  const enqueue = (statePath: string) => handoff(ctx, statePath);
  return {
    ...signals, reporter: liveReporter, submitGate, onHandoff: enqueue,
    onPartConfirmed: (info: { count: number; bvid?: string }) => reporter?.partConfirmed(info),
    finish: async (res: RunLivePumpResult, startMs: number): Promise<number> => {
      console.log("[直播直传] " + JSON.stringify(res));
      await reportResult(ctx, reporter, res, startMs);
      if (isUploadPendingResult(res)) {
        await enqueue(res.statePath);
        console.error("[直播直传] 上传待补(保留 spool,稍后重试): " + (res.error ?? "upload pending"));
        liveReporter.event({ at: Date.now(), kind: "run_end", outcome: "failed",
          ...(res.error ? { message: res.error } : {}) });
        return 75;
      }
      const clean = res.ok && res.outcome !== "no-stream";
      const stopped = signals.signal.aborted || signals.drainSignal.aborted;
      liveReporter.event({ at: Date.now(), kind: "run_end",
        outcome: clean ? "finished" : stopped ? "stopped" : "failed",
        ...(res.error ? { message: res.error } : {}) });
      logResult(res);
      return clean ? 0 : 1;
    },
    failed: (error: unknown): number => {
      const message = String((error as Error)?.message ?? error);
      console.error("[直播直传] 失败: " + message);
      liveReporter.event({ at: Date.now(), kind: "run_end", outcome: "failed", message });
      reporter?.failed(message);
      return 1;
    },
  };
}
