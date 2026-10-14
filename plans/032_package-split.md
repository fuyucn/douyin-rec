# 032 — 包拆分与架构整理

> **部分内容已过期**：执行计划以总票 #49（含评论修订）为准，边传韧性以 #57 为准。S1、S3、S4 已由 #40/#42/#50/#54 完成。
> 状态：设计稿，部分已实现（见任务清单）。设计见 [docs/architecture-package-split.md](../docs/architecture-package-split.md)。
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

- [x] S1 会话命名收口到 core（#50 / #54，≈U1）——已完成
- [ ] S2 manager 通用化为 `SegmentSink`；sidecar 类型入 core——低风险；**待 #57 R2–R5 落地后再做**
- [ ] S5 抽出 `@drec/uploader` 并登记 `RANKS`（≈U4）——低风险
- [ ] S7 拆分 cli 入口 的 hub 装配为模块——低风险
- [x] S3 `resolveRollingPolicy` 成为唯一判定（#40 / #42）——已完成
- [x] S4 规则 `mode="rolling"` + 读取时迁移（#40 / #42）——已完成
- [ ] S6 node-pipeline 与 rolling 执行体搬入 orchestrator（≈U9）——中风险，部署前人确认；**待 #57 R2–R5 落地后再做**
- [ ] S8 hub 状态存储搬入 orchestrator；`normalizeRoom` 入 core——中风险
- [ ] S9 master 下发 `rollingUploadMeta`（≈U8），录制端不再读规则文件——中风险，需能力门控
- [ ] S10（可选）孤儿清理搬迁 / 分段事件化——**危险类**；与 U2/U12 重叠，以 #49 为准

## 依赖顺序

S1、S2、S5、S7 可并行先行；S3 → S4 → S9；S6 依赖 S3、S5；S8 依赖 S1。
（以 #49 修订为准）S1、S3、S4 已完成；S2、S6 待 #57 的 R2–R5 落地后再做。
