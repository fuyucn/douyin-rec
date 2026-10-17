// @drec/processors — 后处理处理器实现(plans/036 §2.2)。入口只做导出;加处理器 = 一个模块 + providers-register 一行。
export * from "./remux.js";
export { uploadPrepProcessor, produceStageParts, splitGroupsBySession, tryDirectTsLink, type PrepPart, type PrepSpec } from "./upload-prep.js";
