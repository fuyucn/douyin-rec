// @drec/core — 共享契约:接口/类型 + 配置 + 引擎/平台注册表。
export * from "./types.js";
export * from "./config.js";
export * from "./engine.js";
export * from "./platform.js";
export * from "./notify.js";
export * from "./notify-context.js";
export * from "./api-types.js";
export * from "./task-redact.js";
export * from "./log.js";
export * from "./atomic-name.js";
export * from "./atomic-write.js";
export * from "./link-or-copy.js";
export * from "./job-abort.js";
export * from "./title-template.js";
export * from "./upload-contract.js";
export * from "./worker-contract.js";
// 能力门控纯函数(worker.capabilities ⊇ rule.requires)。放 core 而非 orchestrator:
// app(L4)的「本机抑制」也要用它,而 app 不能依赖 orchestrator(L4.5)——单一真理源在 core。
export * from "./capabilities.js";
export * from "./hub-ledger-contract.js";
export * from "./hub-flow.js";
// Same-broadcast gap rule (issue #292): the one tolerance for clustering and the reconnect wait.
export * from "./broadcast-window.js";
// 上传配额闸门(冷却 + 滑动窗口)唯一判定实现:master ResourcePool(L4.5)与节点侧上传(L4)共用。
export * from "./upload-gate.js";
export * from "./upload-slot.js";
// 边录边传(T-33):封口判定 / 水位闸门 / 删源证据(唯一真理源,app L4 与 orchestrator L4.5 共用)。
export * from "./rolling.js";
// 会话基名 / 段号(issue #50):全仓唯一实现,守护测试禁止第二份同类正则。
export * from "./session-name.js";
// 磁盘水位(GB)解析口径:daemon / reconciler / 节点侧上传闸门 / cli 共用(issue #38)。
export * from "./disk-watermark.js";
export * from "./ttl-memo.js";
export * from "./redact-log.js";
// 边录边传生效判定(issue #40):规则 mode=rolling + 旧 task 开关迁移 + 单节点闸门;仅 master 调用。
export * from "./rolling-policy.js";
export * from "./zero-disk-policy.js";
// 实验性功能注册表(issue #43):纯数据,仅驱动 Web 徽标/文案,不参与任何行为判定。
export * from "./experimental.js";
// 输出格式(issue #137):白名单 + 容器注册表 + effectiveStageFormat(唯一真理源)。
export * from "./output-format.js";
// 后处理处理器契约 + 注册表 + jobId + 任务状态机(plans/036 T1;纯新增、无调用方)。
export * from "./processor.js";
// 收尾后留存清单(plans/036 T8):xml/ass「不删最后一份」+ 源分段/成品/边车副本归属的唯一判定。
export * from "./survivors.js";
export * from "./child-identity.js";
