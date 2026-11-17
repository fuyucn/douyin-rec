import type { RollingUploadHook } from "@drec/manager";
import type { PreparedRecord } from "./record-setup.js";

async function rollingOwnership(taskId: number | undefined) {
  if (taskId === undefined) return {};
  const {
    TaskStore, resolveDbPath, rootHubDir, uploadOwnerForTask, enqueueHubOwnedSkip,
    shouldDecideUploadOwner, masterOwnedWithoutRule, enabledHubRuleForTask,
  } = await import("@drec/app");
  const hubMaster = process.env.DOUYIN_REC_HUB_MASTER === "1";
  const db = new TaskStore(resolveDbPath());
  try {
    const task = db.listTasks().find((t) => t.id === taskId);
    if (!task || !shouldDecideUploadOwner(task, hubMaster)) return {};
    const uploadOwner = () => uploadOwnerForTask(task, rootHubDir());
    // Worker nodes legitimately have no local rule; only warn on the hub master.
    if (masterOwnedWithoutRule(uploadOwner(), enabledHubRuleForTask(task, rootHubDir()) !== undefined, hubMaster)) {
      console.error("[rec] ⚠️ hub-owned 房间没有启用中的规则:本场只写 skipped 行,没有 uploader(task=" + String(task.id) + ")");
    }
    type SkippedPart = Omit<Parameters<typeof enqueueHubOwnedSkip>[0], "taskId">;
    return {
      uploadOwner,
      enqueueHubSkipped: (info: SkippedPart) => enqueueHubOwnedSkip({ ...info, taskId: task.id }),
    };
  } finally {
    db.close();
  }
}

/** Resolve ownership before building the hook so master-owned parts are not uploaded twice. */
export async function prepareRollingUpload(ctx: PreparedRecord): Promise<(() => RollingUploadHook) | undefined> {
  if (!ctx.rollingEnabled) return undefined;
  const { makeRollingUploadHookFactory, rollingQueueModeEnabled } = await import("@drec/app");
  const slug = ctx.platform.extractRoomSlug(ctx.roomUrl);
  const ownership = await rollingOwnership(ctx.taskId);
  const makeRolling = makeRollingUploadHookFactory({
    enabled: true, platform: ctx.platform.id, roomSlug: slug,
    queueMode: rollingQueueModeEnabled(),
    ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
    ...ownership, log: (m: string) => console.log(m),
    notify: (message: string) => {
      void ctx.notifier.notify({ kind: "error", stage: "边录边传", message }).catch(() => {});
    },
  });
  console.log(`[rec] 边录边传已开启:每封口一段上传后删该段源(room=${slug})`);
  return makeRolling;
}
