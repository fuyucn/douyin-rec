// @drec/observability — logs + notification 实现(端口在 @drec/core:Notifier/ScopedLogger)。
export { makeNotifier, NullNotifier, formatMessage } from "./notifier/index.js";
export { DiscordNotifier } from "./notifier/discord.js";
export type { Notifier, NotifyEvent } from "@drec/core";
export { EventCenter } from "./bus.js";
export type { AppEvent, EventCenterOpts } from "./bus.js";
export { TaskLogStore } from "./logger/ring.js";
export type { TaskLogStoreOpts } from "./logger/ring.js";
export { FileLogger } from "./logger/file.js";
export { composite } from "./logger/composite.js";
