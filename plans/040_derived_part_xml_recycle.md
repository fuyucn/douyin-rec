# 040 派生分P弹幕 xml 的回收与总 xml 区分(issue #84)

## Goal

分段模式(「合并分段」关闭)从会话总 xml 派生的每分P弹幕 xml,要能**只回收派生文件**,总 xml 与最后一份弹幕永不受影响;
并消除「派生文件与会话级 xml 按命名规则无法区分」的隐患。属删除类,先方案后实现。

## 现状(2026-10-18 核对,含设计审查第 1 轮订正)

- 派生:`segment-pipeline.ts` `derivePartDanmuXml` 写 `<stageSub>/{dateName}_{NNN}.xml`(`derivePartXmlPath` + `segmentStem`),
  普通 `writeFileSync`、已存在即跳过(不校验内容)。`dateName` 来自标题模板。
- **命名冲突(真实,条件取决于模板)**:core 把 `_\d{3,}` 当分段后缀。
  - 缺省模板 `{name}_{date}`:派生基名 `X_日期` 与 stage 里 stamped 会话 xml 不同;只有同一 stageSub 跑过合并模式
    (`{dateName}.xml` = 合并模式 plainXml)才同基名。
  - **`{name}_{datetime}` 类模板**:`dateName` = 最早会话 S1 的 stamped 基名,所有派生(含切自 S2… 的)都叫 `S1_NNN.xml`,
    `sessionBaseOf` = S1,`segmentIndexOf` ≥ 0。
- **已存在的风险(与回收无关,需先修)**:
  1. `app/orphan-cleanup.ts`:「别处有非空副本」索引按基名、跨 `recordings/` 与 `stage/` 全局。datetime 模板 + S1 弹幕为空 +
     S2 有弹幕 → 非空派生把 S1 记为「有非空副本」→ stage 与节点源的空 `S1.xml` 都被判可删(**最后一份**)。
     派生只在 `stageAfterDone` 关时留存,而此时 stage 副本也留存 —— 可达。
  2. `orchestrator/session-plan.ts` `deriveStageProducts` 取目录里第一个 `.xml` 作 `xmlArg`;单节点重跑(cli)经
     `workflow.ts` `copyFileSync(xmlArg, plainXml)` 可能把总 xml 覆盖成某一分P的切片,烧录随之错位。
     缺省模板下 `X_日期_000.xml` 排在 `X_日期_09-30-00.xml` 之前;ext4 readdir 顺序不定。
  3. `post-process/concat.ts` `groupSessions`:datetime 模板下派生被当作 S1 的逐段 xml(`merge --indir`、web merge 消费);
     只有人把 merge 指向 stage 目录才触发。
- 回收:`stageAfterDone` 开时 `clean_stage` 通配删 stage 子目录全部 `.xml|.ass`(`segment-pipeline.ts` 两处、`pipeline.ts` 一处),
  合法但不区分;关时派生永久留存。同一 stageSub 之后以合并模式 + `stageAfterDone` 重跑时会被通配删。

## 设计

### 选项 R(建议):派生文件改名,结构上区分

新派生写成 `{dateName}_{NNN}.derived.xml`:`sessionBaseOf` 得 `…_NNN.derived`(无分段后缀),`segmentIndexOf` = -1,
`stampedSessionBaseOf` 不匹配 → 上面风险 1–3 对新文件**结构性消失**,无需逐个消费点打补丁。
- 代价:派生 xml 不再与分P mp4 同 stem(按同名自动挂弹幕的播放器需手动选);功能说明与实验开关文案同步改。
- 需核对新后缀不命中 `isAtomicTempName` / `.part` 等 scratch 规则(有用例)。
- 旧名派生文件(改名前已产出):不改名、不自动删;风险 1–3 对它们按选项 M 的「消费点排除」补丁处理(只认清单或结构判定)。

### 选项 M:保持命名,靠清单 + 逐个消费点排除

- 清单写入顺序(防崩溃留下未登记文件):内存渲染 → 哈希 → **先原子追加清单条目** → 写 tmp → rename。
  文件已存在但未登记(含清单之前的旧场):重新渲染比对哈希,一致才补登记;不一致 = 非派生,按总 xml 保护。
- 风险 1–3 的三个消费点各自排除清单内文件,并各有回归用例。

### 共同部分(两选项都要)

- 清单:每 stageSub **固定一个** `.derived-xml.json`(`{v:1, files:[{name, sourceXml, window, bytes, sha256}]}`,原子写);
  条目对应文件已不在 → 容忍并清掉条目;`clean_stage` 删除时一并删清单。
- 判定函数放 **core**(纯 node:fs,无业务依赖),orphan-cleanup(app)与 orchestrator 共用,不破坏分层。
- 回收 `recycleDerivedPartXml(stageSub)`:只删「清单内 + 哈希一致」的文件;拒删名单按**精确名**定义:
  `segmentIndexOf < 0` 的名字(选项 M 下)、`{dateName}.xml`、各会话 stamped xml 名;同名的旧逐段源 `{sessionBase}_NNN.xml`
  被重新拉取覆盖后哈希不符 → 保护(有用例)。
- 触发点:先做维护页「清理」单列一类(默认 dryRun,确认后删,写审计日志);「收口时自动回收」暂不做。

## Global Constraints

- 总 xml(stage 副本与节点源)与最后一份弹幕永不进入派生回收集;判不出来一律保留。
- 删除只在 stage 子目录内;`recordings/` 不涉及。
- 清单缺失 / 损坏 → 视为「没有派生文件」,不回收。

## Tasks

- [ ] T0 先修既有风险(不删任何文件):选项 R = 改名 + 旧名文件在 orphan-cleanup / deriveStageProducts / groupSessions 中排除;
      选项 M = 清单写入顺序 + 三处排除。验收:datetime 模板 + 两会话 + S1 空弹幕 + S2 非空 → 两份空 `S1.xml` 都保留;
      单节点重跑 `xmlArg` 永不选派生;`groupSessions` 不收派生。
- [ ] T1 清单 + core 判定函数。验收:幂等、哈希不符视为非派生、清单损坏不抛、条目文件缺失被容忍。
- [ ] T2 回收(维护页一类,dryRun + 审计)。验收:派生开启 → 关闭 → 回收,总 xml 存在且字节不变;清单外 / 哈希不符 / 拒删名单不动。
- T0、T2 涉及弹幕保护与删除:`needs-decision` + Opus 复审 + `pr-risk-scan`。

## 另记(不在本计划)

- orphan-cleanup 的基名索引不区分目录:同主播同日的另一场也会被当作「别处副本」证据。单独开票。

## 待拍板

- 选项 R(改名,建议)还是 M(保持同 stem)。
- T0 是否先于回收单独上线(建议是:它修的是现存的「最后一份」风险)。
