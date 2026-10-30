// @drec/app — 有状态服务层(db/store/任务调度/web)+ 通知/上传/主播名解析。
// cli 从这里取命令构造器与工具;app 内部模块互引保持相对。
export { buildTaskCommand, buildCookieCommand, resolveHubConfigJson, resolveHubConfig } from "./cli-task.js";
// `task serve` 的运行时装配(T-22 第 4 步):命令定义在 cli,装配在 app。
export { runServe } from "./serve.js";
export type { ServeOpts, ServeDeps } from "./serve.js";
export type { HubStarter } from "./cli-task.js";
export { TaskStore } from "./store.js";
export { resolveTaskCookies } from "./store.js";
export { sweepOrphanSpools, ORPHAN_SPOOL_GRACE_MS } from "./live-pump-spool.js";
export { NotifyOutbox, type OutboxEvent } from "./notify-outbox.js";
export { resolveTaskStreamCookies } from "./stream-cookies.js";
export type { Task } from "./store.js";
export { listNodeTasks, applyRemoteTasks } from "./task-sync.js";
export type { ApplyTasksResult } from "./task-sync.js";
// 文件版 hub 任务配置(<root>/config/hub/{roomSlug}.json):cli reconciler + api 用。
export * as hubStore from "./hub-store.js";
export type { HubRule } from "./hub-store.js";
// 文件版 worker(录制节点)配置(hub.config.json 的 workers 数组):cli reconciler + api 用。
export * as workerStore from "./worker-store.js";
export type { WorkerConfig } from "./worker-store.js";
export { listHubJobs, readHubJobLog, jobLogPath, jobLogPaths, hubStageDir, hubLogsDir, buildQueueView, latestRunPerRoom } from "./hub-jobs.js";
export type { HubJobView, HubJobEvent, BuildQueueOpts, LatestRunPerRoom } from "./hub-jobs.js";
export { procQueueDbPath } from "./paths.js";
export { handleEnqueue, handleProcStatus, nodeAllowedRoots, assertJobInvariantsReal, realpathDeep, decodeJobIds, encodeJobIds, remoteEnqueueKinds, handleProcCancel } from "./node-enqueue.js";
export { drecRoot, rootHubDir, rootHubConfig, rootStageDir, rootLogsDir, rootOutputLayoutPath, readOutputLayout, rootOutputDir, rootBiliupCookies, DEFAULT_ROOT, ensureNodeIdentity, rootNodeIdentityPath } from "./paths.js";
export type { NodeIdentity } from "./paths.js";
export { rootConfigDir } from "./paths.js";
export { resolveDbPath } from "./db.js";
export { readManagedState, writeManagedState, clearManagedState, MANAGED_STATE_FILE } from "./managed-state.js";
export type { ManagedState } from "./managed-state.js";
export {
  desiredFingerprint, nextExpectedVersion, expectedVersionKey, syncErrorKey,
  readExpectedVersion, recordExpectedVersion, recordSyncError, readSyncError, withMasterReceipt,
} from "./sync-receipt.js";
export type { ExpectedVersionState, ReceiptSettings } from "./sync-receipt.js";
export { parseApplyTasksPayload, applyTasksPayload } from "./apply-payload.js";
export type { ApplyTasksPayload } from "./apply-payload.js";
export { applyTimezone, applyTimezoneFromDb, dbPathForDataRoot, syncDbPathFor, effectiveTimezone, isValidTimezone, DEFAULT_TIMEZONE } from "./timezone.js";
/** 应用版本号({root package.json version}-{commit6},由 pnpm bundle 注入;非打包环境回落 dev)。 */
export { APP_VERSION } from "./version.js";
export { makeNewBroadcastGate, checkNewBroadcastAdmission, volumeFreeBytes, effectiveHubConfig, effectiveHubConfigPath, makeManualStartAdmit } from "./disk-gate.js";
export type { NewBroadcastGateOpts } from "./disk-gate.js";
export { makeNotifier, NullNotifier, formatMessage } from "@drec/observability";
export {
  DEFAULT_WEBHOOK_TOGGLES,
  resolveWebhookToggles,
  shouldSendWebhook,
  webhookTogglesFromEnv,
  WEBHOOK_TOGGLES_ENV,
} from "@drec/observability";
export type { NotifKey, NotifWebhookToggles } from "@drec/observability";
export { upload, checkBiliup, DEFAULT_COOKIES, uploadThenAppend, uploadThenAppendGroups, uploadPlain, appendGroup, countVideoParts, buildAppendArgs, buildUploadArgs, parseBV } from "./upload/biliup.js";
export type { UploadOpts } from "./upload/biliup.js";
export { fetchAnchorName, resolveShortUrl } from "./anchor.js";
// 节点侧上传(experimental,见 plans/027):_node-pipeline / _node-capabilities 的节点侧执行体。
export {
  runNodeSidePipeline, probeNodeCapabilities, listNodeProducts, openNodeUploadGate, openNodeUploadSlot, resolveUploadAccountKey,
  planGroups, splitGroupsBySession, prepareNodeUploadAlias, nodeStageCleanupTargets,
  readNodeResult, nodeResultPath,
  abortNodeExecutor, isExecutorCmdline, nodeExecutorPidPath, readNodeExecutorPid,
} from "./node-pipeline.js";
export type { NodeUploadGateOpts } from "./node-pipeline.js";
// 边录边传(T-33,见 plans/031):录制端「封口段上传 → 确认后删该段源」的执行体 + 钩子工厂。
export { RollingUploader, makeRollingUploadHookFactory, resolveRollingUploadMeta } from "./rolling-upload.js";
export { resolveStreamUploadMeta, resolveStreamUploadTitle, resolveStreamPartTitle } from "./rolling-upload.js";
export { refreshLocalRollingEffective, rollingSpecFields } from "./rolling-effective.js";
// Zero-disk on a side node (issue #331): node preflight / status + receipt files / master-side delivery object builder.
export {
  zeroDiskNodePreflight, resolveNodeUploadCredential, writeZeroDiskStatus, writeZeroDiskReceipt, buildZeroDiskReport,
  buildZeroDiskDelivery, zeroDiskStreamMeta, planZeroDiskSpec, createZeroDiskReporter, zeroDiskNodeDir, ZERO_DISK_RECEIPT_TTL_MS, preflightManagedZeroDiskTask, makeNodeSubmitGate,
} from "./zero-disk-node.js";
export type { ZeroDiskPreflight, ZeroDiskDeliveryBuild, ZeroDiskCredentialSource } from "./zero-disk-node.js";
export { LiveUploadReporter } from "./live-upload-reporter.js";
export { readLiveUploadFile, liveUploadPath, pruneLiveFiles } from "./zero-disk-node.js";
export type { LiveFile } from "./zero-disk-node.js";
export type { RollingUploaderOpts } from "./rolling-upload.js";
// 节点侧原地替换容器(issue #137 第 2/2):封口后 remux + 校验 + 删原文件 + 崩溃接管 + 唯一判定点。
export { RemuxQueue, type RemuxQueueLike, type RemuxWaitOutcome } from "./remux-queue.js";
export { makeNodeRemuxHookFactory, recoverNodeRemux, recoverNodeRemuxInBackground, convertSegmentInPlace, resolveNodeOutputFormat, shouldConvertAtSeal, nodeOutputFormatLock, verifyRemuxed, NODE_REMUX_TMP_SUFFIX } from "./node-remux.js";
