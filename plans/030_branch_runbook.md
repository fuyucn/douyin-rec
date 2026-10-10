# 030 分支发版与回滚手册

分支：`feat/hub-optimization`（从 `main` @ `6ed4b4a` 切出）
线上基线：三节点均为 **`0.0.47`**（回滚目标 = 本地 `main` + `pnpm bundle`）

## 为什么回滚是干净的

- `dist/` 被 gitignore → 每个 commit 都能用 `pnpm bundle` **离线重建**（esbuild 无网络依赖）。
- 回滚只动代码：`git checkout main && pnpm bundle` → 部署 → 三节点回到 `0.0.47`。
- `.env` 不入库但文件在 → 重建 docker 不受影响。
- DB 不回滚。030 只做**向后兼容**的迁移（新增表/列），旧代码可读；回滚后保留 DB 即可。

## 发版顺序（每个里程碑独立 commit + 独立部署验证）

| 里程碑 | 任务 | 内容 |
|---|---|---|
| M1 止血 | T1 T2 T3 T11 T12 T13 T14 | 控制面安全阀 / 产物核验 / 清理可重试 / 录制熔断 |
| M2 实时与吞吐 | T4 T5 T6 T7 T8 T15 T19 | SSE / 非阻塞派发 / 冷却持久化 / 并行度 / 节点侧冷却 |
| M3 房间入口(低风险) | T9 T10 T18 | 统一 rooms API + Hub 弹窗内联 + 房间级动作 |
| M4 可选/需确认 | T16 T20 | 版本可见性（按需）/ 完整单页合并（需确认） |

## 部署前 guard（硬性）

```bash
bash scripts/deploy-precheck.sh              # 三节点 recording 必须全为 NONE
bash scripts/auto-deploy.sh --stage all --max-min 5
```

## 回滚步骤

```bash
git checkout main                           # 回到 6ed4b4a
pnpm bundle                                 # 离线重建（0.0.47）
bash scripts/deploy-precheck.sh             # 确认仍空闲
bash scripts/auto-deploy.sh --stage all --max-min 5
# 校验：三节点 grep 版本号应为 0.0.47
```

保留本分支 commit：`git log main..feat/hub-optimization` 可随时取回。

## 验证门（每个任务）

`pnpm test` · `pnpm typecheck` · `pnpm bundle`；动前端加 `cd packages/web && pnpm build`；
动架构跑 `pnpm arch:gen`；每个 `feat|fix` bump `package.json` version。
