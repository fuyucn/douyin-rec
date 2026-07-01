// @drec/app — 有状态服务层(db/store/任务调度/web)+ 通知/上传/主播名解析。
// cli 从这里取命令构造器与工具;app 内部模块互引保持相对。
export { buildTaskCommand, buildCookieCommand } from "./cli-task.js";
export type { HubStarter } from "./cli-task.js";
export { TaskStore } from "./store.js";
export type { Task } from "./store.js";
// 文件版 hub 任务配置(<root>/config/hub/{roomSlug}.json):cli reconciler + api 用。
export * as hubStore from "./hub-store.js";
export type { HubRule } from "./hub-store.js";
export { rootHubDir, rootHubConfig, rootStageDir, rootOutputDir, DEFAULT_ROOT } from "./paths.js";
export { applyTimezone, isValidTimezone, DEFAULT_TIMEZONE } from "./timezone.js";
export { makeNotifier, NullNotifier, formatMessage } from "./notify/notifier.js";
export { upload, checkBiliup, DEFAULT_COOKIES, uploadThenAppend, uploadThenAppendGroups, uploadPlain, appendGroup, buildAppendArgs, buildUploadArgs, parseBV } from "./upload/biliup.js";
export type { UploadOpts } from "./upload/biliup.js";
export { fetchAnchorName, resolveShortUrl } from "./anchor.js";
