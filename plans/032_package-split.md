# 032 — 包拆分与架构整理

> 状态：设计稿，未开始实现。设计见 [docs/architecture-package-split.md](../docs/architecture-package-split.md)。
> 台账：待 accept 后由记账会话在 `TODO.md` 登记 `T-N`，本文件不改 `TODO.md`。
> 与 `plans/031_rolling_segment_upload.md` 的关系：031 决定「何时可删源」的不变量与执行体；本计划只调整它的归属与判定入口，**不放宽 031 的任何不变量**。

## Goal

录制侧只负责录制；合并/烧录/上传/清理/选优/台账归 hub 侧；rolling upload 成为 hub 规则 `pipeline.upload.mode = "rolling"` 的策略，录制端只读 master 下发的派生字段。

## Architecture

- 新增 `@drec/uploader`（rank 0.8）；post-process 升至 0.2 并依赖 core；orchestrator 降至 2.5。
- core 新增：会话命名、sidecar 类型、`SegmentSink`、`resolveRollingPolicy`。
- manager 通用化为 `SegmentSink`；旧名保留别名一个版本。
- 详见设计文档第 2 节。

## Global Constraints

- 基线 `feat/hub-optimization`；禁止向 `main` 提交、开 PR 或合并。
- 每步一个 PR，可单独回滚；DB 列保留，读取时迁移，不做破坏性迁移。
- 涉及上传/删源判定的步骤（S3、S4、S6、S9、S10）合并前须人确认；不部署。
- 新增字段须能被旧节点包忽略；旧字段继续携带有效值。
- 每步过验证门：`pnpm test`、`pnpm typecheck`；动前端加 `cd packages/web && pnpm build`；动运行时产物加 `pnpm bundle`。
- 修改 `RANKS` 后跑 `pnpm arch:gen` 与 `pnpm arch:check`。
- 文档与 issue 过 `python3 scripts/issue-guard.py`。

## Tasks

- [ ] S1 会话命名收口到 core（7 处改引用 + 表驱动测试 + 防重复守护）——低风险
- [ ] S2 manager 通用化为 `SegmentSink`；sidecar 类型入 core——低风险
- [ ] S5 抽出 `@drec/uploader` 并登记 `RANKS`——低风险
- [ ] S7 拆分 cli 入口 的 hub 装配为模块——低风险
- [ ] S3 `resolveRollingPolicy` 成为唯一判定，下发 `rollingEffective`——**危险类，需人确认**
- [ ] S4 规则 `mode="rolling"` + 读取时迁移 + API/UI 迁移——**危险类，需人确认**
- [ ] S6 node-pipeline 与 rolling 执行体搬入 orchestrator；调整 `RANKS`；侧向隔离测试——中风险，部署前人确认
- [ ] S8 hub 状态存储搬入 orchestrator；`normalizeRoom` 入 core——中风险
- [ ] S9 master 下发 `rollingUploadMeta`，录制端不再读规则文件——中风险，需能力门控
- [ ] S10（可选）孤儿清理搬迁 / 分段事件化——**危险类，建议另立 issue**

## 依赖顺序

S1、S2、S5、S7 可并行先行；S3 → S4 → S9；S6 依赖 S3、S5；S8 依赖 S1。
