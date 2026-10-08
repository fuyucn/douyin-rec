# 027 — 节点侧上传(experimental:不烧录的房间跳过 rsync 回传)

> 状态:**实验功能(feature flag,默认关闭)**。台账条目 `T-18`(见 `TODO.md`)。
> 前置调研见本轮对话:实测 rsync 回传是 pull 步的主要耗时(pull 165s~4198s vs merge 2~128s),
> 而 burn 才是真正吃 CPU 的步(3349s 视频 → 212s,master 11 核;vps2 2 核仅 0.38x 实时)。

## 背景与动机

现状(见 `docs/multi-node-sync.md`):节点只录制,master 收播后
`select → **pull(rsync 回传录像)** → merge → burn → upload`,全部后处理集中在 master。

实测成本(2026-10-08,`GET /api/hub/jobs` 的 steps 配对耗时):

| 步骤 | 典型耗时 | 资源 | 说明 |
|---|---|---|---|
| pull(rsync) | **165s ~ 4198s** | 网络 | 每场把 winner 的 .ts/.xml 拉回 master |
| merge(`-c copy`) | 2 ~ 128s | 磁盘 I/O | 几乎不吃 CPU |
| burn(libx264) | 0 ~ 1927s | **CPU** | 全量重编码,真正瓶颈 |

**关键观察**:9/16 个房间**不烧录**(`burnDanmu=false && burnLivechat=false`),它们的
merge 只是 `-c copy` remux —— **纯 I/O,不吃 CPU**。这类房间完全可以在节点上本地完成
remux + 上传,**省掉整场录像回传**(pull 步)。

而需要烧录的 7 个房间,因为 burn 需要 11 核 + 中文字体 + libass,节点(2 vCPU,~77% steal)
根本烧不动(实测 0.38x 实时),必须维持「回传 master 集中处理」。

## 决策

新增 hub 规则级开关 `pipeline.steps.nodeSideUpload`(boolean,**缺省 false = 旧行为**):

- `false`(默认)= 现状:全部房间 pull 回 master 处理。
- `true` = **实验**:该房间**不烧录 + upload 模式**时,在 winner 节点本地 remux → 节点直接上传 B 站,
  master 只接收元数据(BV 号)。**需要烧录时该开关无效**(回落现状,pull 回 master),
  因为 burn 不能在弱节点上跑。**stage 模式也无效** —— stage 的产物必须落到 master 的
  `stage/` 目录(用户要拿这些文件),省回传会让该模式失去意义;且 stage 不上传,节点侧无任何收益。

**为什么是 feature flag**:改动跨 transport 协议(新增节点侧执行命令)、上传路径
(节点需 biliup + B站 cookie)、错误语义(节点上传失败 = 场级失败)。风险面大,
先在一个房间试,验证稳定后再考虑推广/设为默认。

## 代码隔离与快速开关(kill switch)

实验功能全部逻辑**隔离在 3 个独立文件**,与主线代码解耦,便于快速开关/回退:

| 文件 | 角色 |
|---|---|
| `packages/orchestrator/src/node-side-upload.ts` | master 侧全部逻辑 + **`NODE_SIDE_UPLOAD_ENABLED` kill switch** |
| `packages/app/src/node-pipeline.ts` | 节点侧执行体(remux/聚组/建稿/append) |
| `packages/cli/src/node-pipeline-commands.ts` | 节点侧隐藏子命令 `_node-capabilities` / `_node-pipeline` |

`pipeline.ts` / `cli.ts` 里只保留**最小接线**(一次 import + 一次调用),不掺实验逻辑。

**开关方式**:
- **一键停用**:把 `node-side-upload.ts` 的 `NODE_SIDE_UPLOAD_ENABLED` 改成 `false`
  → 即使规则里开了 `steps.nodeSideUpload` 也一律回落现状(不动任何规则文件/数据库)。
- **彻底移除**:删上述 3 个文件 + `pipeline.ts` 的接线 + `cli.ts` 的 `registerNodePipelineCommands` 调用。

## 约束(硬性)

1. **节点必须具备**:`biliup` 二进制 + B站 `cookies.json` + 足够磁盘(产物要留在节点直到上传完)。
   master 需能探测节点能力(见「改动 · 能力探测」)。缺能力 → 该房间回落现状(pull 回 master),
   并在 job.log 记明原因,**不静默失败**。
2. **烧录房间永不启用**:`burnDanmu || burnLivechat` 为真时开关被忽略。
   **stage 模式永不启用**:产物必须落 master(`uploadMode !== "upload"` 时开关被忽略)。
3. **`mergeSegments=false`(分段上传)也适用**:节点侧逐段 remux → 逐段上传,同样省回传。
4. **水印/可见性/copyright 常量不变**(`biliup.ts` 硬标准),节点上传复用同一套参数构造。
5. **幂等**:节点上传仍是 P1 建稿 → append 分 P;沿用现有「上传类节点不自动重跑」的语义
   (biliup 无幂等,可能已建稿)。

## 架构

### 现状(flag off)

```
master: select → pull(rsync ← winner) → merge → [burn] → uploadPlain → append...
```

### flag on 且不烧录

```
master: select → 通知 winner 节点本地执行(remux → biliup upload → 回报 BV)
                ↑ 只传元数据(无录像回传)
master: 记录 BV → markDone
```

### 关键设计点

1. **谁选优**:仍是 master 的 `selectWinner`(节点无全量视图,选优依赖所有节点清单)。
   master 选出 winner 后,若该房间 flag on 且不烧录 → 走节点侧分支。

2. **怎么让节点执行**:复用现有隐藏子命令模式(`_apply-tasks` / `_inventory` 同一套
   SSH + `node dist/douyin-rec.mjs` 调用),新增:
   ```
   _node-pipeline <dataRoot> <base64-spec>
   ```
   `spec` = `{ streamKey, memberPaths, uploadMode, uploadMeta, cookies, cleanup, titleTemplate... }`。
   节点侧执行 remux(+可选逐段)→ biliup upload/append → 输出 `{ ok, bv, error? }` JSON。

3. **Transport 接口**:`Transport` 增可选方法
   ```ts
   nodePipeline?(spec: NodePipelineSpec): Promise<NodePipelineResult>;
   nodePipelineCapable?(): Promise<{ biliup: boolean; cookies: boolean; diskFreeGB: number }>;
   ```
   无该能力(旧 bundle)→ flag on 的房间也回落现状(向后兼容)。

4. **pipeline 分支**:`runPipeline` 在 select 之后、pull 之前判断:
   ```ts
   if (cfg.steps?.nodeSideUpload && !burnDanmu && !burnLivechat) {
     const cap = await transport.nodePipelineCapable?.();
     if (cap?.biliup && cap.cookies) return await runNodeSidePipeline({...});
     jlog("节点侧上传不可用(缺 biliup/cookies),回落 pull 回 master");
   }
   ```

5. **cookies 传递**:master 把该房间用的 B站 cookie 随 spec 下发(走可信 SSH 通道,与
   `_apply-tasks` 的 cookies 同一路径)。**注意**:节点的 biliup cookie 也可由节点自己配
   (`<dataRoot>/config/biliup/cookies.json`),两者取一 —— 默认用节点本地的,
   master 下发的作为缺失时的兜底(避免 master cookie 落到节点磁盘)。

## 改动清单(估)

### core
- `api-types.ts`:`HubPipelineConfig.steps.nodeSideUpload?: boolean`;新增
  `NodePipelineSpec` / `NodePipelineResult` 类型。

### orchestrator
- `transport.ts`:`Transport.nodePipeline?` + `nodePipelineCapable?`。
- `transport-ssh.ts`:实现 `_node-pipeline` 调用(base64 spec + 解析 JSON 输出)。
- `transport-local.ts`:本机 winner 时直接进程内调用(不绕 SSH)。
- `pipeline.ts`:`runNodeSidePipeline` 分支 + 能力探测 + 回落逻辑。
- `workflow.ts`:节点侧分支的节点集(select → node_upload),复用 `sync_node_states`。

### app
- `upload/biliup.ts`:把「构造 upload/append 参数」抽成**可被节点侧复用的纯函数**
  (现在 `uploadPlain`/`appendGroup` 已经接近,只需确保不依赖 master 专属路径)。
- `paths.ts`:节点 cookie 路径解析(`<root>/config/biliup/cookies.json`)。

### cli
- `cli.ts`:新增隐藏子命令 `_node-pipeline <dataRoot> <base64>`(节点侧执行);
  `_node-capabilities <dataRoot>`(探测 biliup/cookies/磁盘)。

### web
- `HubRuleDialog.tsx`:流水线区加「节点侧上传(实验)」开关 + 说明(仅不烧录房间生效)。
- i18n:中英文案。

### scripts
- `install-worker.sh`:节点侧上传需要 `biliup` → 加 `--with-upload` 选项(装 biliup);
  默认不装(保持 worker 轻量)。

## 验收标准

- [ ] `pnpm test` / `pnpm typecheck` 全绿;新增节点侧分支的 vitest 用例(注入 fake transport)。
- [ ] flag off 时**行为与现状完全一致**(回归用例守护)。
- [ ] flag on + 不烧录:实测一场,`GET /api/hub/jobs` 的该场**无 pull 步**,
      节点本地完成上传,BV 号正确落库。
- [ ] flag on + 烧录:实测回落现状(pull 回 master 烧),job.log 有回落原因。
- [ ] 节点缺 biliup/cookies:回落现状 + job.log 记明,不静默失败。
- [ ] 旧 bundle(无 `_node-pipeline`):flag on 也回落现状,不报错。

## 风险 / 未决

- **节点上传带宽**:vps2 上传走公网出口,可能比 master 慢/不稳。需实测上传耗时对比。
- **B站 cookie 分布**:节点要各自配 cookie(过期需分别维护);或 master 下发(有落盘风险)。
- **磁盘占用**:产物留节点直到上传完;节点磁盘小(49G)需关注清理时机。
- **选优与节点侧耦合**:master 仍要扫全部节点清单做 select,故 `_inventory` 不能省。
- **错误归属**:节点上传失败要能区分「节点不可达」/「biliup 失败」/「cookie 过期」,
  分别决定重试 vs 转人工。
