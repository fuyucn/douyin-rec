# Observability 拆包设计(logs + notification)

> 状态:设计稿,待评审 → 通过后转 writing-plans 出实现计划。
> 日期:2026-07-05。范围:**档 1**(只做 observability;upload/login/web 等其余拆分留后续)。

## 目标

把 **logs + notification** 的**实现**从 `app`(4888 行的杂物抽屉)抽进独立包 `@drec/observability`,
确立一个可复用的模式,供后续拆 upload/login/web 等沿用。核心诉求(用户原话提炼):

1. **CLI 是统一接口 / 组合根(host)**:通知/日志怎么送出去,由 CLI 侧装配。
2. **各能力包自带"发什么 + 怎么路由"的代码**:录制侧在 `manager`,hub 侧在 `orchestrator`——不堆在 app/cli。
3. **hub 是热插拔的附加服务**:只在 `--hub` 时装配;不在场时录制照常发通知。
4. **不同 package 有不同的代码**:app 不再拥有通知/日志基建,只是众多消费方之一。

## 决定性约束:两个运行时上下文

改动必须尊重现有进程拓扑(否则落不了地):

- **录制子进程**(`node dist/douyin-rec.mjs record …`,TaskManager 每任务 spawn):独立 OS 进程,
  现在**自己直发** Discord webhook;父进程另靠 recWatch 轮询 `isRecording` 补发 recordStart/recordEnd 到 EventCenter。
- **serve 进程**:daemon + web + EventCenter +(可选)hub 同进程;hub 由 `startHub` 在此进程内**条件启动**。

## 架构:B 做组装,A 做分发

两者回答不同问题,合起来用:

- **组装(B)**:serve/CLI 作 host,录制管理侧常驻、hub 仅 `--hub` 时装配(`startHub` 已是雏形)。
  每个模块自带 emit + 路由代码,host 注入 sink。
- **分发(A)**:serve 进程内一条薄总线(`EventCenter` 正名),模块 publish,sink 订阅,CLI 侧配置。
- **子进程边界(本轮决定)**:录制子进程**保持自发**(最小改动)。stdout-IPC 统一进总线 = 将来选项(见「非目标」)。

### 端口(接口)—— 放 `core`(契约层,不新增下游依赖)

```ts
// core/notify.ts —— 已存在,不动
export type NotifyEvent = /* recordStart | recordEnd | recordReconnect | mergeDone | burnDone | uploadDone | error */;
export interface Notifier { notify(e: NotifyEvent): Promise<void>; }

// core/logger.ts —— 新增
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
```

manager(录制)、orchestrator(hub)**只依赖 core 的这两个接口**,靠 CLI 注入实现,不 import observability
→ 不新增反向依赖,层级不破。

### 适配器(实现)—— 新包 `@drec/observability`(从 app 搬入)

- **总线(A 的分发)**:`EventCenter`(环形缓冲 + 扇出到 notifier)+ `AppEvent` 类型。← app/events.ts
- **Notifier 实现**:`DiscordNotifier`、`NullNotifier`、`makeNotifier(webhook)`、`formatMessage(e)`。← app/notify/
- **Logger 实现**(新):
  - `ConsoleLogger`:包 console.log/warn/error(带前缀)。
  - `TaskRingLogger`:每任务日志环形缓冲(web tail 用)。← app/task-logs.ts 重构成 Logger
  - `FileLogger(path)`:追加到文件(job.log 用),写失败静默。
  - `composite(...loggers)`:扇出到多个 Logger(如 console + ring)。

### 层级

`@drec/observability` 只依赖 `core` → 排在 core 之上、其余之下(记 **L0.5**)。
被 `app`(L4)、`cli`(L5)依赖;`manager`(L3)、`orchestrator`(L4.5)**不** import 它(只吃 core 接口)。
`test/arch/layering.test.ts` 的 RANKS 加一条 `observability`(紧接 core 之后)。

## 数据流(改造后)

**录制子进程**(自发,不变):record 子命令用 `makeNotifier(webhook)`(现从 observability)构 Notifier → 直发 Discord。
日志走 `ConsoleLogger` → stdout(父进程照旧解析 `[主播]`/`@@DREC_ALERT@@` 标记补发)。

**serve 进程**:
- host(cli-task serve action)构造:`EventCenter`(总线)+ `makeNotifier`(全局兜底 webhook)+ `ConsoleLogger`。
- 录制管理侧(recWatch 观察器)publish recordStart/recordEnd 到 EventCenter。
- **hub(仅 --hub)**:CLI 把 `notify:(e)=>eventCenter.emit(e)` 和一个 **run 级 `Logger` 工厂**
  `makeRunLogger(streamKey) => FileLogger(<stage>/<key>/job.log)` 注入 orchestrator。
  → pipeline 的 job.log 从直接 `appendFileSync` 改为**经注入的 `Logger`**(这是「hub 通过接口分发日志、
  实现由 CLI 装配」的关键示范)。hub 的"发什么/写什么"仍在 orchestrator,"怎么落盘"在 observability。
- web 层从 EventCenter 读事件(GET /api/events)、从 TaskRingLogger 读任务日志尾部——依赖从 app 内部改指向 observability。

## 具体搬迁清单

| 从 | 到 | 备注 |
|---|---|---|
| `app/notify/discord.ts` | `observability/notifier/discord.ts` | 原样 |
| `app/notify/notifier.ts`(makeNotifier/NullNotifier/formatMessage) | `observability/notifier/index.ts` | 原样;`Notifier`/`NotifyEvent` 仍 re-export 自 core |
| `app/events.ts`(EventCenter/AppEvent) | `observability/bus.ts` | 原样 |
| `app/task-logs.ts`(环形缓冲) | `observability/logger/ring.ts` | 重构成实现 `Logger` |
| (新) | `observability/logger/{console,file,composite}.ts` | 新增 |
| (新) | `core/logger.ts` | `Logger` 接口 |

- `app/index.ts`:删除对上述的本地导出,改从 `@drec/observability` re-export(保持 cli 现有 import 不断)。
- `orchestrator/pipeline.ts`:`jlog` 改为用注入的 `Logger`(`PipelineDeps` 加 `makeRunLogger?(streamKey): Logger`,
  缺省回退当前 appendFileSync 行为以兼容测试)。
- `cli/cli.ts` + `app/cli-task.ts`:构造 sink 的地方改从 observability import;hub 注入 `makeRunLogger`。

## 错误处理

- Logger 实现(尤其 FileLogger)**写失败静默**——日志/通知绝不反噬主流程(现有 jlog 已是此约定)。
- Notifier 失败:EventCenter 现有行为保留(本地事件永远入缓冲;webhook 失败不阻塞)。

## 测试

- observability 包内就近单测:`bus.test.ts`(EventCenter 扇出/游标)、`ring.test.ts`(环形缓冲截断)、
  `file.test.ts`(FileLogger 追加 + 写失败静默)、`notifier.test.ts`(formatMessage/makeNotifier 选择)。
  这些多为**从 app 现有测试平移**(EventCenter 等已有测试)。
- orchestrator `pipeline.test.ts`:补一条「注入 makeRunLogger → job.log 内容经该 Logger 写入」。
- `layering.test.ts`:新增 observability rank 断言。
- 全量 `pnpm test` + `pnpm typecheck` 绿;`pnpm bundle` 成功(observability 打进单文件产物)。

## 非目标(本轮不做)

- **不拆** upload / login / web / store / daemon / task-manager(留后续档 2;本轮只立 observability 样板)。
- **不做** 录制子进程的 stdout-IPC 统一进总线(保持子进程自发;将来若要"一处看全所有事件"再做)。
- **不上**完整插件注册表(才 2 个模块,借 B 的"host 条件装配 + 模块自持代码"精神即可,不建注册中心)。
- **不改** 任何用户可见行为 / 通知文案 / API 契约(纯内部重构 + 一个 core 新接口)。

## 验收标准

1. `app` 不再包含 notify/、events.ts、task-logs.ts;这些在 `@drec/observability`。
2. `manager`、`orchestrator` 不 import `@drec/observability`(只 core 接口 + 注入)。
3. hub 的 job.log 经注入的 `Logger` 写入(实现由 CLI 装配),pipeline 不再直接 `appendFileSync`。
4. 通知/日志的**用户可见行为不变**(Discord 文案、web 事件流、任务日志尾、job.log 内容一致)。
5. 全量测试 + typecheck + bundle 绿;layering 守护通过。
