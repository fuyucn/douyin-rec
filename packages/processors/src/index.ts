// @drec/processors — 后处理处理器实现(plans/036 §2.2)。入口只做导出;加处理器 = 一个模块 + providers-register 一行。
export * from "./remux.js";
export { uploadPrepProcessor, produceStageParts, splitGroupsBySession, tryDirectTsLink, type PrepPart, type PrepSpec } from "./upload-prep.js";
export * from "./run-biliup.js";
// 0 落盘流式直传已拆到 @drec/zero-upload(upos-stream / live-pump)。这里只做 re-export,
// 让既有 `@drec/processors` 导入方(app 的 upload/biliup、零散调用点)保持不变;
// 新代码请直接依赖 @drec/zero-upload。
export * from "@drec/zero-upload";
export * from "./archive-lookup.js";
export { isSameChild, probeChild, type ChildFingerprint } from "@drec/core";
export * from "./biliup.js";
export * from "./biliup-progress.js";
