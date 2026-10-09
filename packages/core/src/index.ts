// @drec/core — 共享契约:接口/类型 + 配置 + 引擎/平台注册表。
export * from "./types.js";
export * from "./config.js";
export * from "./engine.js";
export * from "./platform.js";
export * from "./notify.js";
export * from "./api-types.js";
export * from "./log.js";
export * from "./job-abort.js";
export * from "./title-template.js";
export * from "./upload-contract.js";
export * from "./worker-contract.js";
// 能力门控纯函数(worker.capabilities ⊇ rule.requires)。放 core 而非 orchestrator:
// app(L4)的「本机抑制」也要用它,而 app 不能依赖 orchestrator(L4.5)——单一真理源在 core。
export * from "./capabilities.js";
export * from "./hub-ledger-contract.js";
export * from "./hub-flow.js";
