import { decorateRecordEvent, parseOutputFormat, type NotifyEvent, type StageFormat } from "@drec/core";
import type { RollingUploadHook } from "@drec/manager";
import type { PreparedRecord } from "./record-setup.js";

function remuxDependencies(ctx: PreparedRecord) {
  const owner = ctx.platform.extractRoomSlug(ctx.options.room);
  return {
    owner, log: (m: string) => console.log(m),
    alert: (message: string) => {
      const event = decorateRecordEvent({ kind: "error", stage: "转封装", message } as NotifyEvent,
        { taskName: ctx.recording.name, platform: ctx.platform.id, roomSlug: owner });
      void ctx.notifier.notify(event).catch(() => {});
    },
  };
}

async function startRemux(ctx: PreparedRecord, format: StageFormat) {
  const { makeNodeRemuxHookFactory, recoverNodeRemuxInBackground, RemuxQueue } = await import("@drec/app");
  const deps = remuxDependencies(ctx);
  // Legacy temporary files recover in the background; never delay the recording start.
  void recoverNodeRemuxInBackground(ctx.recording.outDir, format, deps);
  const queue = RemuxQueue.open({
    owner: deps.owner, taskId: ctx.taskId, outDir: ctx.recording.outDir,
    alert: deps.alert, log: deps.log,
  });
  if (queue) process.on("exit", () => queue.releaseLeaseSync());
  const makeRolling = makeNodeRemuxHookFactory({ format, ...deps, queue });
  console.log(`[rec] 节点侧输出格式 ${format}:每封口一段入队原地 remux(${queue ? "任务表" : "进程内串行(任务表不可用)"}),校验通过后删原文件`);
  return { makeRolling, close: queue ? () => queue.close() : async () => {} };
}

/** Rolling upload owns source deletion; remux must never compete with it. */
export async function prepareRecordRemux(ctx: PreparedRecord, makeRolling?: () => RollingUploadHook) {
  let format;
  try { format = parseOutputFormat(ctx.options.outputFormat); }
  catch (error) { console.error(`[rec] ${(error as Error).message}`); process.exit(2); }
  if (format === "original") return { makeRolling, close: async () => {} };
  if (makeRolling) {
    console.log(`[rec] 已开启边录边传,忽略 --output-format ${format}(上传后删源,与原地替换互斥)`);
    return { makeRolling, close: async () => {} };
  }
  return startRemux(ctx, format);
}
