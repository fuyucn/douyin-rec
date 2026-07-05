# Observability 拆包 实现计划(档1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 logs + notification 的实现从 `app` 抽进新包 `@drec/observability`,core 加 `Logger` 接口,orchestrator 的 job.log 改经注入的 `Logger` 写入,CLI 作组合根装配——不改任何用户可见行为。

**Architecture:** 端口(`Notifier` 已有 / `Logger` 新增)留 `core`;实现(EventCenter/Discord/makeNotifier/formatMessage/环形缓冲 + 新的 Console/File/composite logger)搬进 `@drec/observability`(L0.5,只依赖 core)。`app`/`cli` 依赖它;`manager`/`orchestrator` 只吃 core 接口 + CLI 注入。设计见 `docs/observability-refactor-design.md`。

**Tech Stack:** Node 24 ESM(`.js` import 后缀)、pnpm workspace、TypeScript、vitest、esbuild 单文件打包、node:sqlite。

## Global Constraints

- 分层守护 `test/arch/layering.test.ts`:新包必须在 RANKS 登记;依赖只能向下。`@drec/observability` = **0.5**(core=0 之上)。
- ESM:import 带 `.js` 后缀;包 `"type": "module"`。
- 录制必须跑打包产物 `node dist/douyin-rec.mjs`(sm-crypto interop);observability 经 app/cli import 图被 esbuild 打进单文件,**无独立 build 配置**。
- **不改用户可见行为**:Discord 文案、`GET /api/events` 事件流、任务日志尾(`GET /api/tasks/:id/logs`)、job.log 内容全部保持一致。
- vitest 不能 import douyin-live(sm-crypto);observability 纯 TS 无此依赖,可正常单测。
- 提交规范:`<type>(<scope>): 中文描述`;不加 AI 署名;只 add 本任务相关文件。
- manager / orchestrator **不得** import `@drec/observability`(只 core 接口 + 注入);违反则 layering 失败。

## 文件结构(目标)

```
packages/core/src/logger.ts                    # 新:Logger 接口
packages/observability/
├── package.json                               # 新:@drec/observability,dep @drec/core
├── tsconfig.json                              # 新:extends 根
└── src/
    ├── index.ts                               # 新:统一导出
    ├── bus.ts            (← app/events.ts)     # EventCenter + AppEvent
    ├── notifier/
    │   ├── index.ts      (← app/notify/notifier.ts)  # makeNotifier/NullNotifier/formatMessage
    │   └── discord.ts    (← app/notify/discord.ts)
    └── logger/
        ├── ring.ts       (← app/task-logs.ts)  # TaskLogStore(实现 Logger 语义)
        ├── console.ts     # 新:ConsoleLogger
        ├── file.ts        # 新:FileLogger(job.log)
        └── composite.ts   # 新:composite(...loggers)
```

`app` 删除上述搬走的文件,内部 import 改指 `@drec/observability`;`app/index.ts` 保留 `makeNotifier` 等 re-export(改从 observability 转出,cli 现有 `import { makeNotifier } from "@drec/app"` 不断)。

---

### Task 1: 脚手架 —— core `Logger` 接口 + `@drec/observability` 空包 + 分层登记

**Files:**
- Create: `packages/core/src/logger.ts`
- Modify: `packages/core/src/index.ts`(导出 Logger)
- Create: `packages/observability/package.json`
- Create: `packages/observability/tsconfig.json`
- Create: `packages/observability/src/index.ts`
- Modify: `test/arch/layering.test.ts:23-40`(RANKS 加 observability)
- Modify: `packages/app/package.json` + `packages/cli/package.json`(加 dep)

**Interfaces:**
- Produces: `interface Logger { info(msg: string): void; warn(msg: string): void; error(msg: string): void }`(from `@drec/core`)
- Produces: 包名 `@drec/observability`,`src/index.ts` 为聚合导出(本任务先空)

- [ ] **Step 1: 写 core Logger 接口** `packages/core/src/logger.ts`

```ts
/**
 * 日志端口(port)。实现(Console/File/Ring/composite)在 @drec/observability;
 * 消费方(manager/orchestrator)只依赖本接口,由组合根(CLI)注入实现。
 */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
```

- [ ] **Step 2: core 导出 Logger** —— 在 `packages/core/src/index.ts` 末尾加:

```ts
export type { Logger } from "./logger.js";
```

- [ ] **Step 3: 建 observability 包**

`packages/observability/package.json`(参照 core 的形态):
```json
{
  "name": "@drec/observability",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@drec/core": "workspace:*" }
}
```

`packages/observability/tsconfig.json`(参照其他包,extends 根 tsconfig;若其他包用 `../../tsconfig.base.json` 则一致):
```json
{ "extends": "../../tsconfig.json", "include": ["src"] }
```
> 注:先 `cat packages/core/tsconfig.json` 对齐 extends 路径与 compilerOptions,保持与现有包一致。

`packages/observability/src/index.ts`:
```ts
// @drec/observability — logs + notification 实现(端口在 @drec/core)。
// 后续任务填充:bus / notifier / logger。
export {};
```

- [ ] **Step 4: 分层登记** —— `test/arch/layering.test.ts` 的 RANKS(第 25 行附近 `"@drec/core": 0,` 之后)加:

```ts
  // 0.5 可观测性:logs + notification 实现(端口在 core;被 app/cli 依赖,manager/orchestrator 不依赖)
  "@drec/observability": 0.5,
```

- [ ] **Step 5: app + cli 加依赖** —— `packages/app/package.json` 与 `packages/cli/package.json` 的 `dependencies` 各加一行:

```json
    "@drec/observability": "workspace:*",
```

- [ ] **Step 6: 安装 + 验证脚手架**

Run: `pnpm install && pnpm typecheck && pnpm test -- layering`
Expected: install 成功(新 workspace 包链入);typecheck 无错;layering 测试全绿(observability 已登记、无违规依赖)。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/logger.ts packages/core/src/index.ts packages/observability test/arch/layering.test.ts packages/app/package.json packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(observability): 脚手架空包 + core 加 Logger 接口 + 分层登记(L0.5)"
```

---

### Task 2: 搬 Notifier 实现(discord + makeNotifier/formatMessage)进 observability

**Files:**
- Move: `packages/app/src/notify/discord.ts` → `packages/observability/src/notifier/discord.ts`
- Move: `packages/app/src/notify/notifier.ts` → `packages/observability/src/notifier/index.ts`
- Move test(若有): `packages/app/src/notify/*.test.ts` → `packages/observability/src/notifier/`
- Modify: `packages/observability/src/index.ts`
- Modify: `packages/app/src/index.ts:14`(re-export 改指 observability)
- Modify: app 内引用 `notify/notifier.js` / `notify/discord.js` 的文件(见 Step 3 grep)

**Interfaces:**
- Consumes: `Notifier`, `NotifyEvent`(from `@drec/core`,不变)
- Produces: `makeNotifier(webhook?: string): Notifier`、`NullNotifier`、`formatMessage(e: NotifyEvent): string`、`DiscordNotifier`(from `@drec/observability`)

- [ ] **Step 1: git mv 两个文件**

```bash
mkdir -p packages/observability/src/notifier
git mv packages/app/src/notify/discord.ts packages/observability/src/notifier/discord.ts
git mv packages/app/src/notify/notifier.ts packages/observability/src/notifier/index.ts
# 若存在 notify 的测试文件一并 mv(先 ls packages/app/src/notify/)
```

- [ ] **Step 2: 修 moved 文件内的 import**
  - `notifier/index.ts`:`import { DiscordNotifier } from "./discord.js";` 路径不变(同目录)。`@drec/core` import 不变。
  - `notifier/discord.ts`:`@drec/core` import 不变;无相对 app import 则无需改(若有,改成 core / 报错则贴出让 reviewer 决策)。

- [ ] **Step 3: 找出并改 app 内引用** —— 运行:
```bash
rtk proxy grep -rn 'notify/notifier.js\|notify/discord.js' packages/app/src
```
把命中处的 `from "./notify/notifier.js"` / `from "../notify/notifier.js"` 等改为 `from "@drec/observability"`。

- [ ] **Step 4: observability 导出** —— `packages/observability/src/index.ts`:
```ts
export { makeNotifier, NullNotifier, formatMessage } from "./notifier/index.js";
export { DiscordNotifier } from "./notifier/discord.js";
```

- [ ] **Step 5: app re-export 转出** —— `packages/app/src/index.ts` 第 14 行:
```ts
export { makeNotifier, NullNotifier, formatMessage } from "@drec/observability";
```

- [ ] **Step 6: 验证**

Run: `pnpm typecheck && pnpm test && pnpm bundle`
Expected: typecheck 无错;全量测试绿(notifier 测试若已 mv 则在 observability 下跑);bundle 成功。

- [ ] **Step 7: Commit**

```bash
git add -A packages/app/src packages/observability/src
git commit -m "refactor(observability): Notifier 实现(discord/makeNotifier/formatMessage)从 app 搬入"
```

---

### Task 3: 搬 EventCenter(总线)进 observability

**Files:**
- Move: `packages/app/src/events.ts` → `packages/observability/src/bus.ts`
- Move test(若有): `test/app/*event*` 或就近 → 随文件
- Modify: `packages/observability/src/index.ts`
- Modify: app 内 import `events.js` 的文件(cli-task.ts、web/api.ts、web/server.ts)

**Interfaces:**
- Consumes: `NotifyEvent`, `Notifier`(core,不变)
- Produces: `EventCenter`、`AppEvent`、`EventCenterOpts`(from `@drec/observability`)

- [ ] **Step 1: git mv**
```bash
git mv packages/app/src/events.ts packages/observability/src/bus.ts
```

- [ ] **Step 2: moved 文件 import 检查** —— `bus.ts` 只 `import type { NotifyEvent, Notifier } from "@drec/core";`,不变。

- [ ] **Step 3: 找出并改 app 引用**
```bash
rtk proxy grep -rn '"\.\./events.js"\|"\./events.js"\|from ".*events\.js"' packages/app/src
```
命中处(cli-task.ts / web/api.ts / web/server.ts)改为 `from "@drec/observability"`。

- [ ] **Step 4: observability 导出追加** —— `src/index.ts` 加:
```ts
export { EventCenter } from "./bus.js";
export type { AppEvent, EventCenterOpts } from "./bus.js";
```

- [ ] **Step 5: app 若在 index.ts 导出过 EventCenter/AppEvent 则改指 observability**(先 grep `packages/app/src/index.ts`;当前只导出 makeNotifier,故大概率无需改)。

- [ ] **Step 6: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿(EventCenter 相关测试在其新位置跑)。若 `test/app/` 下有 EventCenter 集成测试引用旧路径 `@drec/app` 的 EventCenter,改为从 `@drec/observability` import。

- [ ] **Step 7: Commit**

```bash
git add -A packages/app/src packages/observability/src test/
git commit -m "refactor(observability): EventCenter(事件总线)从 app 搬入(bus.ts)"
```

---

### Task 4: 搬环形缓冲 + 新增 Console/File/composite Logger

**Files:**
- Move: `packages/app/src/task-logs.ts` → `packages/observability/src/logger/ring.ts`
- Create: `packages/observability/src/logger/console.ts`
- Create: `packages/observability/src/logger/file.ts`
- Create: `packages/observability/src/logger/composite.ts`
- Create: `packages/observability/src/logger/file.test.ts`
- Create: `packages/observability/src/logger/console.test.ts`
- Modify: `packages/observability/src/index.ts`
- Modify: `packages/app/src/task-manager.ts`(import `task-logs.js` → `@drec/observability`)+ web 层引用

**Interfaces:**
- Consumes: `Logger`(from `@drec/core`)
- Produces: `TaskLogStore`(不变签名:`append/get/clear`)、`ConsoleLogger`(实现 `Logger`)、`FileLogger(path: string)`(实现 `Logger`)、`composite(...loggers: Logger[]): Logger`(from `@drec/observability`)

- [ ] **Step 1: git mv 环形缓冲**
```bash
mkdir -p packages/observability/src/logger
git mv packages/app/src/task-logs.ts packages/observability/src/logger/ring.ts
```
(TaskLogStore 保持 append/get/clear 不变;它服务 web 任务日志尾,不改行为。)

- [ ] **Step 2: 写 FileLogger 失败测试** `packages/observability/src/logger/file.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLogger } from "./file.js";

describe("FileLogger", () => {
  it("info/warn/error 追加带级别前缀的行到文件", () => {
    const p = join(mkdtempSync(join(tmpdir(), "flog-")), "job.log");
    const l = new FileLogger(p);
    l.info("hello");
    l.warn("careful");
    l.error("boom");
    const txt = readFileSync(p, "utf-8");
    expect(txt).toContain("hello");
    expect(txt).toContain("careful");
    expect(txt).toContain("boom");
    expect(txt.trim().split("\n")).toHaveLength(3);
  });
  it("写不了的路径 → 静默不抛(日志绝不反噬主流程)", () => {
    const l = new FileLogger("/nonexistent-dir-xyz/deep/job.log");
    expect(() => { l.info("x"); l.error("y"); }).not.toThrow();
  });
});
```

- [ ] **Step 3: 跑测试确认失败** → `pnpm test -- logger/file`,FAIL(模块不存在)。

- [ ] **Step 4: 实现三个 Logger** —— `file.ts`:

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "@drec/core";

/** 追加到文件的 Logger(job.log 用)。首写建目录;写失败静默(日志绝不反噬主流程)。 */
export class FileLogger implements Logger {
  private dirReady = false;
  constructor(private readonly path: string) {}
  private write(level: string, msg: string): void {
    try {
      if (!this.dirReady) { mkdirSync(dirname(this.path), { recursive: true }); this.dirReady = true; }
      appendFileSync(this.path, `[${new Date().toISOString()}] ${level} ${msg}\n`, "utf-8");
    } catch { /* 忽略 */ }
  }
  info(m: string): void { this.write("INFO", m); }
  warn(m: string): void { this.write("WARN", m); }
  error(m: string): void { this.write("ERROR", m); }
}
```

`console.ts`:
```ts
import type { Logger } from "@drec/core";

/** 控制台 Logger,可选前缀(如 "[hub]")。error→console.error,warn→console.warn,余 console.log。 */
export class ConsoleLogger implements Logger {
  constructor(private readonly prefix = "") {}
  private p(m: string): string { return this.prefix ? `${this.prefix} ${m}` : m; }
  info(m: string): void { console.log(this.p(m)); }
  warn(m: string): void { console.warn(this.p(m)); }
  error(m: string): void { console.error(this.p(m)); }
}
```

`composite.ts`:
```ts
import type { Logger } from "@drec/core";

/** 把一条日志扇出到多个 Logger(如 console + file)。任一实现抛错不影响其余。 */
export function composite(...loggers: Logger[]): Logger {
  const fan = (fn: (l: Logger) => void): void => { for (const l of loggers) { try { fn(l); } catch { /* 忽略 */ } } };
  return {
    info: (m) => fan((l) => l.info(m)),
    warn: (m) => fan((l) => l.warn(m)),
    error: (m) => fan((l) => l.error(m)),
  };
}
```

- [ ] **Step 5: console 测试** `console.test.ts`(断言前缀 + 路由到对应 console 方法,用 vi.spyOn):
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { ConsoleLogger } from "./console.js";
afterEach(() => vi.restoreAllMocks());
describe("ConsoleLogger", () => {
  it("带前缀,error/warn 走对应 console 方法", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const l = new ConsoleLogger("[hub]");
    l.info("a"); l.error("b");
    expect(log).toHaveBeenCalledWith("[hub] a");
    expect(err).toHaveBeenCalledWith("[hub] b");
  });
});
```

- [ ] **Step 6: observability 导出** —— `src/index.ts` 加:
```ts
export { TaskLogStore } from "./logger/ring.js";
export type { TaskLogStoreOpts } from "./logger/ring.js";
export { ConsoleLogger } from "./logger/console.js";
export { FileLogger } from "./logger/file.js";
export { composite } from "./logger/composite.js";
```

- [ ] **Step 7: 改 app 引用** —— grep + 改:
```bash
rtk proxy grep -rn 'task-logs.js\|TaskLogStore' packages/app/src
```
`task-manager.ts` 及 web 层的 `from ".../task-logs.js"` → `from "@drec/observability"`。

- [ ] **Step 8: 验证**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿(含新 file/console 测试 + 平移的 ring 测试若有)。

- [ ] **Step 9: Commit**

```bash
git add -A packages/app/src packages/observability/src
git commit -m "refactor(observability): 环形缓冲搬入 + 新增 Console/File/composite Logger"
```

---

### Task 5: orchestrator job.log 改经注入的 Logger(核心示范)

**Files:**
- Modify: `packages/orchestrator/src/pipeline.ts`(`PipelineDeps` 加 `makeRunLogger?`;`makeJobLog`/`jlog` 改用它)
- Modify: `packages/orchestrator/src/pipeline.test.ts`(补注入 Logger 断言)
- Modify: `packages/cli/src/cli.ts`(hubStarter 注入 `makeRunLogger` = observability 的 FileLogger 工厂)

**Interfaces:**
- Consumes: `Logger`(from `@drec/core`)、`FileLogger`(from `@drec/observability`,仅 cli 用)
- Produces: `PipelineDeps.makeRunLogger?(streamKey: string): Logger`(缺省 = 现有 appendFileSync 行为,兼容旧测试)

- [ ] **Step 1: 看现状** —— `pipeline.ts` 现有 `makeJobLog(stageSub)` 用 `appendFileSync` 直写 `<stageSub>/job.log`,`jlog(msg)` 加 ISO 时间戳。目标:改为「若 deps 注入了 `makeRunLogger` 则用它得到的 `Logger`,否则回退现有直写」。

- [ ] **Step 2: PipelineDeps 加字段** —— 在 `PipelineDeps` 接口(pipeline.ts)`notify` 附近加:

```ts
  /** 按 streamKey 造该场的 run 级 Logger(job.log);缺省=内置文件直写(兼容旧行为/测试)。
   *  CLI 注入 @drec/observability 的 FileLogger,使「怎么落盘」由组合根装配、orchestrator 只调接口。 */
  makeRunLogger?: (streamKey: string) => import("@drec/core").Logger;
```

- [ ] **Step 3: jlog 改用注入 Logger** —— 把 `runPipeline` 里构造 `jlog` 的地方改为:

```ts
  // 优先用注入的 run Logger(实现由 CLI 装配);无则回退内置文件直写(兼容)。
  const jlogger = deps.makeRunLogger?.(b.streamKey);
  const jlog = jlogger
    ? (msg: string): void => jlogger.info(msg)
    : makeJobLog(path.join(deps.cfg.stageDir, sanitizeKey(b.streamKey)));
```
> `makeJobLog` 保留作回退。注意:注入的 FileLogger 已自带时间戳,内置 `makeJobLog` 也自带——两者格式一致即可(都 ISO 前缀),job.log 内容不变。

- [ ] **Step 4: 补 pipeline 测试** —— `pipeline.test.ts` 加一条:

```ts
it("makeRunLogger 注入 → job.log 经该 Logger 写入(不直接 appendFileSync)", async () => {
  const lines: string[] = [];
  const fakeLogger = { info: (m: string) => lines.push(m), warn: () => {}, error: () => {} };
  const broadcast = makeBroadcast([
    { tenantId: "node-1", rec: makeRec({ totalGapSec: 0 }) },
    { tenantId: "node-2", rec: makeRec({ totalGapSec: 200 }) },
  ]);
  const deps = makeDeps({ makeRunLogger: () => fakeLogger });
  deps.ledger.upsertPending(broadcast.streamKey);
  await runPipeline(broadcast, deps);
  expect(lines.some((l) => l.includes("pipeline start"))).toBe(true);
  expect(lines.some((l) => l.includes("选优: winner=node-1"))).toBe(true);
  deps.ledger.close();
});
```

- [ ] **Step 5: 跑测试** → `pnpm test -- pipeline`,新用例应 PASS(旧用例仍走回退直写,不受影响)。

- [ ] **Step 6: CLI 注入** —— `packages/cli/src/cli.ts` 的 `hubStarter.start` 内,`pipelineDeps` 构造处(现有 `sh/uploadPlain/appendGroup/notify/cfg`)加:

```ts
      // job.log 的落盘实现由组合根装配:observability 的 FileLogger,路径 = <stage>/<sanitized key>/job.log。
      makeRunLogger: (streamKey: string) => {
        const { FileLogger } = require("@drec/observability"); // 或顶部 import
        const sanitized = streamKey.replace(/[:/]/g, "_");
        return new FileLogger(`${hubCfg.stageDir ?? rootStageDir()}/${sanitized}/job.log`);
      },
```
> 优先在 hubStarter 的动态 import 块里 `const { FileLogger } = await import("@drec/observability")` 与其它 import 同处获取,避免 require/ESM 混用。sanitizeKey 规则与 pipeline 的 `sanitizeKey`(替换 `:` `/` 为 `_`)一致。

- [ ] **Step 7: 验证 job.log 内容不变** —— `pnpm bundle`,本地或已有 stage 跑一次(或看现有 job.log 格式):确认经 FileLogger 写出的 job.log 与旧格式一致(ISO 时间戳 + 消息)。

Run: `pnpm typecheck && pnpm test && pnpm bundle`
Expected: 全绿;bundle 成功。

- [ ] **Step 8: Commit**

```bash
git add packages/orchestrator/src/pipeline.ts packages/orchestrator/src/pipeline.test.ts packages/cli/src/cli.ts
git commit -m "refactor(hub): job.log 改经注入的 Logger 写入(实现由 CLI 装配,orchestrator 只调接口)"
```

---

### Task 6: 收尾验证 —— 分层 / 全量 / 用户可见行为不变

**Files:**
- Modify(按需): 残留引用修正
- Modify: `CLAUDE.md`(架构段:app 不再含 notify/events/task-logs;新增 observability 包;包数 12→13)

- [ ] **Step 1: 确认 app 已无搬走的文件**
```bash
ls packages/app/src/notify packages/app/src/events.ts packages/app/src/task-logs.ts 2>&1
```
Expected: 均不存在(`No such file`)。

- [ ] **Step 2: 确认 manager/orchestrator 未 import observability**
```bash
rtk proxy grep -rn "@drec/observability" packages/manager/src packages/orchestrator/src
```
Expected: **无输出**(它们只吃 core 接口 + 注入)。

- [ ] **Step 3: 全量验证**

Run: `pnpm typecheck && pnpm test && pnpm bundle && (cd packages/web && pnpm build)`
Expected: 全绿;`test/arch/layering.test.ts` 通过(observability 0.5,无向上依赖);bundle + 前端 build 成功。

- [ ] **Step 4: 用户可见行为回归**(部署到 docker 后,或本地 serve)——确认:
  - `GET /api/events` 事件流正常(录制开播/收播 toast 不变)
  - 任务详情日志尾(`GET /api/tasks/:id/logs`)正常
  - hub 一场 run 的 job.log 内容与旧格式一致(ISO 时间戳行)
  - Discord 通知文案不变(formatMessage 未改)

- [ ] **Step 5: 更新 CLAUDE.md 架构段** —— 把「12 包」改「13 包」,包列表加一行 observability(L0.5:logs+notification 实现,端口在 core),app 描述去掉 notify/events。

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: observability 拆包后更新架构说明(13 包,app 不再含通知/日志基建)"
```

---

## 执行顺序与说明

任务严格按序(2→3→4 各是一次"搬一个模块 + 测绿",5 是行为示范,6 收尾)。每个任务结束点都能独立 `pnpm test` 绿、可单独 review。Task 5 是唯一改运行行为路径的(job.log 走注入 Logger),但缺省回退保证兼容;其余纯搬迁 + 导出改写,零行为变化。

## 部署

按本仓库惯例:`pnpm bundle` + `GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build`;VPS rsync `dist/*.mjs` + `web/dist` + 重启 systemd。部署前确认 task1 未在录制。observability 无独立产物(经 import 图打进 `dist/douyin-rec.mjs`)。
