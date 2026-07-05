# Worker 实时状态(轻量 ping 轮询) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workers 卡状态点改为自动轮询的实时健康点,用轻量 ping(local existsSync / ssh `test -d`)取代完整 listInventory 测试。

**Architecture:** Transport 加可选 ping();CLI 注入 testWorker(改 ping)+ probeAllWorkers(批量);app 新增 GET /api/hub/workers/status;WorkersCard 挂载即拉 + 每 5 分钟轮询、删手动按钮、三态点。

**Tech Stack:** Node 24 ESM, node:sqlite, vitest, React19+jotai+@base-ui/react (web/ 独立 Vite), react-i18next.

## Global Constraints

- **轻量 ping 取代完整测试**:不再 SSH + 完整 `listInventory` 扫 recordings。ping 语义 = resolve(可达 + dataRoot 存在) / reject 带 message(不可达 / dataRoot 不存在)。不再有 `recordingCount`/`dataRootExists`/`reachable`。
- **去掉每行手动测试(wifi)按钮**:状态点只由自动轮询驱动。
- **轮询 5 分钟**(常量 `WORKER_STATUS_POLL_MS = 300000`,改 10 分钟只改一个数)+ **挂载即拉一次**(usePolling 第一次立即执行) + **仅卡片可见时**(usePolling 的 `enabled` 参数)。
- **保留弹窗"存前测试"按钮**(改用轻量 ping 版 `POST /api/hub/workers/test`):验证一个尚未保存的 worker 配置。UX 不变、后端更轻。
- **分层**:app(L4)**不 import** orchestrator(L4.5)。ping 逻辑在 Transport(orchestrator)+ CLI(L5)注入 `probeAllWorkers`/`testWorker`。scoped 一次性 transport(`new LocalTransport`/`new SshTransport`)**绝不碰全局 registry**(sculpt:`registerBuiltinTransports` 会覆盖共享 "local" 工厂,污染运行中的 hub)。
- `WorkerTestResult` 简化为 `{ ok: boolean; error?: string }`;新增 `WorkerStatus = { id: string; ok: boolean; error?: string }` 给批量端点。
- **ssh ping 硬超时 ~6s**(Promise.race + clearTimeout);**每 worker 独立超时**,一个卡住不拖累整批;批量端点用 `Promise.allSettled` 返回部分结果。
- `probeAllWorkers` 未注入(hub 未开)→ 端点返回 `[]`,卡片显示灰/无点。轮询整体失败(端点 5xx/网络)→ `catch` 保持上次状态,不崩。
- **提交规范**:约定式提交 `<type>(<scope>): 中文描述`,正文 bullet points;**不加** `Co-Authored-By` / `Claude-Session` 等 AI trailer;只 `git add` 本次相关文件。
- **ESM `.js` import 后缀**(源码是 .ts,import 写 `.js`)。
- 命令一律走 rtk 代理:`rtk proxy pnpm test -- <pat>` / `rtk proxy pnpm typecheck` / `rtk proxy pnpm bundle` / `cd packages/web && rtk proxy pnpm build`。

---

## Task 1 — 后端:Transport.ping + testWorker 改 ping + status 批量端点(先落绿)

### Files

| 文件 | 动作 |
|------|------|
| `packages/core/src/api-types.ts` | 改 `WorkerTestResult` → `{ ok; error? }`;新增 `WorkerStatus` |
| `packages/orchestrator/src/transport.ts` | `Transport` 接口加可选 `ping(): Promise<void>` |
| `packages/orchestrator/src/transport-local.ts` | `LocalTransport.ping`(existsSync) |
| `packages/orchestrator/src/transport-ssh.ts` | `SshTransport.ping`(`test -d` + 6s 硬超时);`SshOpts` 加可选 `pingTimeoutMs` |
| `packages/cli/src/cli.ts` | `hubStarter.testWorker` 改调 `ping()`;新增 `hubStarter.probeAllWorkers`;注入到 `buildTaskCommand` 的 server deps |
| `packages/app/src/cli-task.ts` | `HubStarter` 接口加 `probeAllWorkers?`;`createWebServer({...})` 传 `probeAllWorkers` |
| `packages/app/src/web/api.ts` | `ApiDeps` 加 `probeAllWorkers?`;`Api` 加 `workersStatus()`;`testWorker` catch 分支去掉旧字段 |
| `packages/app/src/web/server.ts` | `RouteMatch` name 加 `"workersStatus"`;`matchRoute` 加 `GET /api/hub/workers/status`;`WebServerDeps` 加 `probeAllWorkers?`;`dispatch` case;`createWebServer` 透传 |
| `packages/orchestrator/src/transport-local.test.ts` | 加 `LocalTransport.ping` 测试 |
| `packages/orchestrator/src/transport-ssh.test.ts` | 加 `SshTransport.ping` 测试(注入 run fake:ok/非零/超时) |
| `test/app/web-api.test.ts` | 改现有 `testWorker` 测试(去旧字段);加 `workersStatus` 测试 |
| `test/app/web-server.test.ts` | 加 `matchRoute` 对 `/api/hub/workers/status` 的断言 |

### Interfaces (契约,跨 Task 1/2 必须一致)

```ts
// packages/core/src/api-types.ts
/** worker 连接测试结果(POST /api/hub/workers/test)——轻量 ping:可达 + dataRoot 存在。 */
export interface WorkerTestResult { ok: boolean; error?: string; }
/** GET /api/hub/workers/status 的单个 worker 健康结果。 */
export interface WorkerStatus { id: string; ok: boolean; error?: string; }

// packages/orchestrator/src/transport.ts (Transport 接口内追加)
  /**
   * 轻量存活探针:可达 + dataRoot 存在 → resolve;不可达 / dataRoot 不存在 → reject(带 message)。
   * 不扫 recordings(区别于 listInventory)。可选:无此能力的 transport 视为「不支持探针」。
   */
  ping?(): Promise<void>;
```

CLI 注入契约(与 app 层 `ApiDeps.probeAllWorkers` / `HubStarter.probeAllWorkers` 逐字一致):
```ts
probeAllWorkers: () => Promise<Array<{ id: string; ok: boolean; error?: string }>>;
testWorker: (cfg: { kind: string; host?: string; dataRoot?: string; id?: string; apiUrl?: string }) => Promise<WorkerTestResult>;
```

---

### Step 1.1 — `WorkerTestResult` 简化 + `WorkerStatus` 新增

- [ ] **改类型**。编辑 `packages/core/src/api-types.ts` 第 89-90 行:

  改前:
  ```ts
  /** worker 连接测试结果(POST /api/hub/workers/test)。 */
  export interface WorkerTestResult { ok: boolean; reachable: boolean; dataRootExists: boolean; recordingCount?: number; error?: string; }
  ```
  改后:
  ```ts
  /** worker 连接测试结果(POST /api/hub/workers/test)——轻量 ping:可达 + dataRoot 存在。 */
  export interface WorkerTestResult { ok: boolean; error?: string; }
  /** GET /api/hub/workers/status 的单个 worker 健康结果(批量 ping)。 */
  export interface WorkerStatus { id: string; ok: boolean; error?: string; }
  ```

- [ ] **验证会红**(下游还引用旧字段):`rtk proxy pnpm typecheck`
  期望:报错指向 `packages/app/src/web/api.ts`(catch 里 `reachable`/`dataRootExists`)、`packages/cli/src/cli.ts`(testWorker 返回 recordingCount)、web 侧。这些在后续步骤修。**本步不 commit**(留到 1.3 一起,避免中间不可编译)。

### Step 1.2 — Transport 接口加 `ping?`

- [ ] **改接口**。编辑 `packages/orchestrator/src/transport.ts`,在 `Transport` 接口 `cleanup?` 之后追加(第 27 行后、闭合 `}` 前):
  ```ts
  /**
   * 轻量存活探针:可达 + dataRoot 存在 → resolve;不可达 / dataRoot 不存在 → reject(带 message)。
   * 不扫 recordings(区别于 listInventory)。可选:无此能力的 transport 视为「不支持探针」。
   */
  ping?(): Promise<void>;
  ```
- [ ] **验证接口可选不破坏 registry 测试**:`rtk proxy pnpm test -- transport.test`
  期望:绿(`ping?` 可选,已有 fake transport 无 ping 仍满足接口)。

### Step 1.3 — `LocalTransport.ping`(TDD)

- [ ] **写失败测试**。编辑 `packages/orchestrator/src/transport-local.test.ts`,在文件末尾追加:
  ```ts
  describe("LocalTransport.ping(轻量存活探针)", () => {
    it("dataRoot 存在 → resolve", async () => {
      const root = mkdtempSync(join(tmpdir(), "ping-ok-"));
      const t = new LocalTransport({
        id: "local", recordingsDir: root, taskRooms: {},
        ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
      });
      await expect(t.ping()).resolves.toBeUndefined();
    });
    it("dataRoot 不存在 → reject 带 message", async () => {
      const t = new LocalTransport({
        id: "local", recordingsDir: "/no/such/dir/xyz", taskRooms: {},
        ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
      });
      await expect(t.ping()).rejects.toThrow(/不存在|not exist|\/no\/such/i);
    });
  });
  ```
  > 注:`LocalTransport.ping` 用 `recordingsDir` 的父级?**不**——`recordingsDir` 就是 `<dataRoot>/recordings`(见 index.ts `new LocalTransport({ recordingsDir: `${cfg.dataRoot}/recordings` })`)。ping 应校验 `recordingsDir` 存在即可(dataRoot 存在但 recordings 不存在也算「未就绪」,与 listInventory 扫的目录一致)。测试里 `mkdtempSync` 建的目录直接当 recordingsDir 传,存在;不存在用假路径。
- [ ] **跑测试确认红**:`rtk proxy pnpm test -- transport-local.test`
  期望:2 个新 case 红(`t.ping is not a function`)。
- [ ] **实现**。编辑 `packages/orchestrator/src/transport-local.ts`。`existsSync` 已在第 2 行 import。在 `isDone` 方法之后追加:
  ```ts
  /** 轻量探针:recordings 目录存在即视为就绪(不扫内容)。 */
  async ping(): Promise<void> {
    if (!existsSync(this.o.recordingsDir)) {
      throw new Error(`dataRoot 不存在或不可达: ${this.o.recordingsDir}`);
    }
  }
  ```
- [ ] **跑测试确认绿**:`rtk proxy pnpm test -- transport-local.test`

### Step 1.4 — `SshTransport.ping`(TDD,含 6s 硬超时)

- [ ] **写失败测试**。编辑 `packages/orchestrator/src/transport-ssh.test.ts`,在 `describe("SshTransport", …)` 内末尾追加:
  ```ts
  describe("ping(轻量存活探针)", () => {
    it("远端 test -d 退出 0(run resolve)→ resolve;命令含 test -d + dataRoot", async () => {
      const captured: string[][] = [];
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
        run: async (argv) => { captured.push(argv); return ""; }, rsync: async () => {} });
      await expect(t.ping()).resolves.toBeUndefined();
      const cmd = captured[0].join(" ");
      expect(cmd).toContain("test -d");
      expect(cmd).toContain("/data/drec");
    });
    it("远端非零退出(run reject)→ reject 带 message", async () => {
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
        run: async () => { throw new Error("ssh rc=1: No such file"); }, rsync: async () => {} });
      await expect(t.ping()).rejects.toThrow(/rc=1|No such file/);
    });
    it("run 卡住 → pingTimeoutMs 硬超时 reject(不永久挂)", async () => {
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
        pingTimeoutMs: 20,                       // 测试用小超时替代 6s
        run: () => new Promise<string>(() => {}),  // 永不 resolve
        rsync: async () => {} });
      await expect(t.ping()).rejects.toThrow(/超时|timeout/i);
    });
  });
  ```
- [ ] **跑测试确认红**:`rtk proxy pnpm test -- transport-ssh.test`
- [ ] **实现**。编辑 `packages/orchestrator/src/transport-ssh.ts`:
  1. `SshOpts` 接口(第 6-15 行)加字段:
     ```ts
     /** ping() 硬超时(ms),默认 6000。测试注入小值验证超时路径。 */
     pingTimeoutMs?: number;
     ```
  2. 在 `exists` 方法之后追加 `ping`(复用现有单引号转义 + Promise.race+clearTimeout 模式,与 defaultRun 一致):
     ```ts
     /** 轻量探针:远端 `test -d <dataRoot>`(不扫 recordings),硬超时默认 6s。退出非零/超时 → throw。 */
     async ping(): Promise<void> {
       const root = this.o.dataRoot.replace(/'/g, "'\\''");
       const ms = this.o.pingTimeoutMs ?? 6000;
       let timer: NodeJS.Timeout;
       const timeout = new Promise<never>((_, rej) => {
         timer = setTimeout(() => rej(new Error(`ssh ping 超时 ${ms}ms: ${this.o.host}`)), ms);
       });
       // run 单字符串传(远端 shell 执行),同 listInventory 规避 ssh 打散。test -d 成功 → 退出 0 → run resolve。
       const probe = this.run([`test -d '${root}'`]).then(() => undefined);
       await Promise.race([probe, timeout]).finally(() => clearTimeout(timer));
     }
     ```
- [ ] **跑测试确认绿**:`rtk proxy pnpm test -- transport-ssh.test`

### Step 1.5 — CLI:`testWorker` 改 ping + 新增 `probeAllWorkers`

- [ ] **改 `hubStarter.testWorker`**(`packages/cli/src/cli.ts` 第 605-636 行)。把 `listInventory` 换成 `ping`,返回值去掉旧字段:
  改 body 尾部(第 622-635 行)为:
  ```ts
      const t = cfg.kind === "local"
        ? new LocalTransport({ id, recordingsDir: `${cfg.dataRoot}/recordings`, taskRooms: {}, ffprobe })
        : new SshTransport({ id, host: cfg.host!, dataRoot: cfg.dataRoot! });
      try {
        // ping 内置超时(local 瞬时;ssh 6s)。这里不再额外包 20s——探针本就轻量。
        await t.ping!();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  ```
  > `withTimeout` 辅助(第 622-628 行)在 testWorker 里不再需要(ping 自带超时),**删掉它**。但 `probeAllWorkers`(下一步)也用不到,故整段删除。`ffprobe` 仍需保留给 LocalTransport 构造。
- [ ] **新增 `hubStarter.probeAllWorkers`**。在 `hubStarter` 对象里(`testWorker` 之后、闭合 `};` 之前)追加:
  ```ts
    async probeAllWorkers(): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
      // scoped 一次性 transport(不进全局 registry,不污染运行中的 hub);逐 worker ping,allSettled 汇总。
      const { LocalTransport, SshTransport } = await import("@drec/orchestrator");
      const { ffprobeVideo } = await import("@drec/post-process");
      const { statSync } = await import("node:fs");
      const { workerStore, rootHubConfig } = await import("@drec/app");
      const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
        const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
        const endMs = statSync(file).mtimeMs;
        return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
      };
      const workers = workerStore.listWorkers(rootHubConfig());
      const results = await Promise.allSettled(workers.map(async (w) => {
        const t = w.kind === "local"
          ? new LocalTransport({ id: w.id, recordingsDir: `${w.dataRoot}/recordings`, taskRooms: {}, ffprobe })
          : new SshTransport({ id: w.id, host: w.host!, dataRoot: w.dataRoot! });
        await t.ping!();
      }));
      return workers.map((w, i) => {
        const r = results[i];
        return r.status === "fulfilled"
          ? { id: w.id, ok: true }
          : { id: w.id, ok: false, error: (r.reason as Error)?.message ?? String(r.reason) };
      });
    },
  ```
  > `workerStore` + `rootHubConfig` 已在 `hubStarter.start` 里从 `@drec/app` 动态 import(第 449 行),此处同样动态 import(独立方法,各自 import)。
- [ ] **验证 CLI 编译**:`rtk proxy pnpm typecheck`(cli.ts 处应无 WorkerTestResult 报错了;app/web 侧仍待 1.6-1.7)。

### Step 1.6 — app 层:`HubStarter` + `ApiDeps` + `Api.workersStatus` + 修 testWorker catch

- [ ] **`HubStarter` 加 `probeAllWorkers?`**(`packages/app/src/cli-task.ts` 第 210-211 行后追加):
  ```ts
    /** 批量存活探针(cli L5 用 orchestrator scoped transport ping 实现)。省略 → status 端点返回 []。 */
    probeAllWorkers?: () => Promise<Array<{ id: string; ok: boolean; error?: string }>>;
  ```
- [ ] **注入到 server deps**(`packages/app/src/cli-task.ts` 第 543-548 行 `createWebServer({...})`)。在 `testWorker:` 那行后加:
  ```ts
          testWorker: hubEnabled ? hubStarter?.testWorker : undefined,
          probeAllWorkers: hubEnabled ? hubStarter?.probeAllWorkers : undefined,
  ```
- [ ] **`ApiDeps` 加 `probeAllWorkers?`**(`packages/app/src/web/api.ts` 第 101 行 `testWorker?` 后):
  ```ts
    /** 批量存活探针(CLI 注入)。省略(hub 未开)→ status 端点返回 []。 */
    probeAllWorkers?: () => Promise<Array<{ id: string; ok: boolean; error?: string }>>;
  ```
- [ ] **`Api` 接口加 `workersStatus`**(`packages/app/src/web/api.ts` 第 321 行 `testWorker(...)` 声明后):
  ```ts
    /** GET /api/hub/workers/status — 并行 ping 所有已配置 worker(未注入 probeAllWorkers → [])。 */
    workersStatus(): Promise<ApiResult>;
  ```
- [ ] **import `WorkerStatus`**(`packages/app/src/web/api.ts` 第 19 行 type import 里加 `WorkerStatus`):
  ```ts
  import type { RecordingSessionDTO, HubRulePayload, HubRuleDTO, HubPipelineConfig, WorkerDTO, WorkerTestResult, WorkerStatus } from "@drec/core";
  ```
- [ ] **实现 handler + 修 testWorker catch**(`packages/app/src/web/api.ts`)。把现有 `testWorker`(第 819-828 行)catch 分支改掉旧字段,并在其后追加 `workersStatus`:
  ```ts
      async testWorker(input): Promise<ApiResult> {
        if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可测试 worker)");
        if (!deps.testWorker) return err(400, "hub 未启用(连接测试未注入)");
        try {
          const r = await deps.testWorker({ kind: input.kind ?? "", host: input.host, dataRoot: input.dataRoot, apiUrl: input.apiUrl });
          return { status: 200, body: r };
        } catch (e) {
          return { status: 200, body: { ok: false, error: (e as Error).message } satisfies WorkerTestResult };
        }
      },
      async workersStatus(): Promise<ApiResult> {
        // 未注入(hub 未开)→ 空数组(卡片显示灰/无点,不报错)。
        if (!deps.probeAllWorkers) return { status: 200, body: [] as WorkerStatus[] };
        try {
          const list = await deps.probeAllWorkers();
          return { status: 200, body: list satisfies WorkerStatus[] };
        } catch (e) {
          // 整体失败也回 200 空,前端 catch 保上次状态,不崩。
          return { status: 200, body: [] as WorkerStatus[] };
        }
      },
  ```

### Step 1.7 — server 路由:`GET /api/hub/workers/status`

- [ ] **`RouteMatch` name 加 `"workersStatus"`**(`packages/app/src/web/server.ts` 第 70 行 `| "testWorker"` 后):
  ```ts
      | "testWorker"
      | "workersStatus"
  ```
- [ ] **`matchRoute` 加路由**(`packages/app/src/web/server.ts`)。**位置关键**:必须在 `/api/hub/workers/test`(第 155 行)**旁边**、且在 `/api/hub/workers/:id` 正则(第 162 行 `wk`)**之前**,否则 `status` 被当成 `:id`。在第 155 行后加:
  ```ts
    // 批量状态(轮询用):同 /test,必须在 /:id 正则之前匹配,否则 "status" 被当 :id。
    if (p === "/api/hub/workers/status" && method === "GET") return { name: "workersStatus" };
  ```
- [ ] **`WebServerDeps` 加 `probeAllWorkers?`**(`packages/app/src/web/server.ts` 第 228 行 `testWorker?` 后):
  ```ts
    /** 批量存活探针(CLI 注入)。省略 → status 端点返回 []。 */
    probeAllWorkers?: () => Promise<Array<{ id: string; ok: boolean; error?: string }>>;
  ```
- [ ] **`dispatch` case**(`packages/app/src/web/server.ts` 第 379-382 行 testWorker case 后):
  ```ts
      case "workersStatus":
        return api.workersStatus();
  ```
- [ ] **`createWebServer` 透传**(`packages/app/src/web/server.ts` 第 402 行 `testWorker: deps.testWorker,` 后):
  ```ts
      testWorker: deps.testWorker,
      probeAllWorkers: deps.probeAllWorkers,
  ```
- [ ] **验证全仓编译**:`rtk proxy pnpm typecheck`
  期望:后端全绿(web 侧 Task 2 处理;若 typecheck 覆盖 web 会报 WorkersCard/WorkerDialog 引用旧字段 —— 那是 Task 2,先记下)。

### Step 1.8 — 后端测试(TDD:改旧 testWorker 测试 + 加 workersStatus + matchRoute)

- [ ] **改现有 testWorker 测试**(`test/app/web-api.test.ts` 第 630-664 行)去掉已删字段,让它们匹配 `{ok,error}`:
  - 第 633 行 fake:`const fake = vi.fn(async () => ({ ok: true }));`
  - 第 637 行断言:改成 `expect((r.body as any).ok).toBe(true);`(删 recordingCount 断言)
  - 第 645 行 fake:`const fake = vi.fn(async () => ({ ok: false, error: "连接测试超时" }));`
  - 第 650-651 行:删 `reachable` 断言,保留 `expect((r.body as any).ok).toBe(false);` 和 `error` 断言
  - 第 656 THROWS 测试:第 661-663 行删 `reachable`/`dataRootExists` 断言,保留 `ok===false` + `error==="ECONNREFUSED"`
- [ ] **加 workersStatus 测试**。在同一 `describe("hub workers 端点…")` 块内末尾追加:
  ```ts
    it("workersStatus:注入 probeAllWorkers fake → 端点透传数组", async () => {
      const cfg = join(mkdtempSync(join(tmpdir(), "ws-")), "hub.config.json");
      writeFileSync(cfg, JSON.stringify({ workers: [] }));
      const fake = vi.fn(async () => [
        { id: "local", ok: true },
        { id: "worker-1", ok: false, error: "ssh ping 超时 6000ms" },
      ]);
      const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg, probeAllWorkers: fake });
      const r = await a.workersStatus();
      expect(r.status).toBe(200);
      expect(r.body).toEqual([
        { id: "local", ok: true },
        { id: "worker-1", ok: false, error: "ssh ping 超时 6000ms" },
      ]);
      expect(fake).toHaveBeenCalledOnce();
    });
    it("workersStatus:未注入 probeAllWorkers → 200 []", async () => {
      const cfg = join(mkdtempSync(join(tmpdir(), "ws-")), "hub.config.json");
      writeFileSync(cfg, JSON.stringify({ workers: [] }));
      const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg });
      const r = await a.workersStatus();
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    });
    it("workersStatus:probeAllWorkers 抛错 → 200 [](不崩)", async () => {
      const cfg = join(mkdtempSync(join(tmpdir(), "ws-")), "hub.config.json");
      writeFileSync(cfg, JSON.stringify({ workers: [] }));
      const fake = vi.fn(async () => { throw new Error("boom"); });
      const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg, probeAllWorkers: fake });
      const r = await a.workersStatus();
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    });
  ```
  > 注:`workersStatus` **不看 `hubEnabled` 门**(与 testWorker 不同)——未注入即回 `[]`,让 slave/非 master 也安全返回空。测试里传 `hubEnabled:true` 只为一致,不影响。
- [ ] **加 matchRoute 断言**(`test/app/web-server.test.ts` 第 84 行 testWorker 断言后):
  ```ts
      expect(matchRoute("GET", "/api/hub/workers/status")?.name).toBe("workersStatus");
      // status 不能被 /:id 正则吞掉
      expect(matchRoute("GET", "/api/hub/workers/local")).toBeNull(); // GET /:id 无路由(只有 PATCH/DELETE)
  ```
  > 第二行验证 `status` 之外的 GET `/:id` 确实无匹配(现有 `wk` 正则只处理 PATCH/DELETE → 其余 return null),间接确认 `status` 走了专用分支而非 `:id`。
- [ ] **跑相关测试**:`rtk proxy pnpm test -- web-api web-server transport-local transport-ssh`
  期望:全绿。
- [ ] **全量测试 + 打包 + typecheck**:`rtk proxy pnpm test` && `rtk proxy pnpm typecheck` && `rtk proxy pnpm bundle`
  期望:全绿(web 侧未跑 vitest,typecheck 若含 web 会报 → Task 2 修)。
- [ ] **Commit**(约定式,无 AI trailer):
  ```
  feat(hub,transport): worker 轻量存活探针 ping + 批量 status 端点

  - Transport 加可选 ping():local existsSync / ssh `test -d`(6s 硬超时),取代完整 listInventory 测试
  - WorkerTestResult 简化为 {ok,error?};新增 WorkerStatus{id,ok,error?}
  - CLI testWorker 改调 ping;新增 probeAllWorkers(scoped transport + allSettled,不碰全局 registry)
  - app 新增 GET /api/hub/workers/status(未注入/异常 → [],不崩);路由置于 /:id 正则前避免碰撞
  - 单测:transport ping local+ssh(含超时)、status 端点注入 fake、matchRoute
  ```

---

## Task 2 — UI:WorkersCard 三态实时点 + 删手动按钮 + 弹窗 ping 版

### Files

| 文件 | 动作 |
|------|------|
| `packages/web/src/api/client.ts` | `getWorkersStatus()` 方法 + import/re-export `WorkerStatus` |
| `packages/web/src/components/WorkersCard.tsx` | 删 wifi/test 按钮 + status 轮询 + 三态点 |
| `packages/web/src/modals/WorkerDialog.tsx` | test 结果消费简化的 `{ok,error}`(去 recordingCount) |
| `packages/web/src/lib/i18n.tsx` | `testOk` 去 `{count}`;加 `colStatus` 三态 tooltip 文案(zh+en) |

### Interfaces

```ts
// packages/web/src/api/client.ts
getWorkersStatus: (): Promise<WorkerStatus[]> => request("GET", "/api/hub/workers/status"),
```
`WorkerStatus`/`WorkerTestResult` 类型经 `@drec/contracts`(= core api-types)共享,前端只 import type。

---

### Step 2.1 — client:`getWorkersStatus` + `WorkerStatus` 类型

- [ ] **import + re-export `WorkerStatus`**(`packages/web/src/api/client.ts` 第 11-32 行 type import 块)。第 30 行 `WorkerTestResult,` 后加 `WorkerStatus,`;第 32 行 re-export 行末尾 `WorkerTestResult };` 改为 `WorkerTestResult, WorkerStatus };`
- [ ] **加方法**(`packages/web/src/api/client.ts` 第 129 行 `testWorker:` 后):
  ```ts
    /** 批量存活状态(卡片轮询):每 worker {id,ok,error?};hub 未开 → []。 */
    getWorkersStatus: (): Promise<WorkerStatus[]> => request("GET", "/api/hub/workers/status"),
  ```
- [ ] **验证 web 编译**:`cd packages/web && rtk proxy pnpm build`
  期望:client.ts 处无报错(WorkersCard/WorkerDialog 仍红 → 后续步骤;若 build 因它们中断属预期)。

### Step 2.2 — i18n:`testOk` 去 count + 加三态 tooltip 文案

- [ ] **zh**(`packages/web/src/lib/i18n.tsx`)。第 202 行 `testOk` 去 `{count}`:
  ```ts
          testOk: "连接成功 · dataRoot 可达", testFailed: "连接失败:{error}", unknownError: "未知错误",
  ```
  第 194 行 `workers` 块内(zh)加三态 tooltip 文案(在 `deleted:` 后):
  ```ts
          statusOk: "在线 · dataRoot 可达", statusChecking: "检测中…",
  ```
  (statusFail 用后端返回的 error 串直接进 title,不需固定文案。)
- [ ] **en**(`packages/web/src/lib/i18n.tsx`)。第 355 行:
  ```ts
          testOk: "Connected · dataRoot reachable", testFailed: "Connection failed: {error}", unknownError: "Unknown error",
  ```
  第 347 行(en workers 块)`deleted:` 后:
  ```ts
          statusOk: "Online · dataRoot reachable", statusChecking: "Checking…",
  ```

### Step 2.3 — WorkerDialog:消费简化的 `{ok,error}`

- [ ] **改 runTest catch**(`packages/web/src/modals/WorkerDialog.tsx` 第 63 行)去掉旧字段:
  ```ts
        setTest({ ok: false, error: errMessage(e) });
  ```
- [ ] **改结果展示**(`packages/web/src/modals/WorkerDialog.tsx` 第 148 行)去掉 `test.recordingCount`:
  ```ts
              {test.ok ? t("hub.workerDialog.testOk") : t("hub.workerDialog.testFailed", { error: test.error ?? t("hub.workerDialog.unknownError") })}
  ```
  > `WorkerTestResult` 已是 `{ok,error?}`,`test.recordingCount` 不再存在;`testOk` 已去 `{count}` 占位符。其余(runTest 走 `POST /workers/test` = ping 版)无需改,UX 不变。

### Step 2.4 — WorkersCard:删 wifi 按钮 + status 轮询 + 三态点

- [ ] **整体重写**(`packages/web/src/components/WorkersCard.tsx`)。核心变更:
  1. 删 `Wifi` import、`tests`/`testing` state、`runTest`、wifi `IconButton`;
  2. 新增 `status` state(`Record<string, WorkerStatus>`,按 id)+ `WORKER_STATUS_POLL_MS` 常量 + `usePolling(fetchStatus, WORKER_STATUS_POLL_MS)`;
  3. `dot(w)` 三态:有 status 且 ok → 绿;有且 !ok → 红(error 进 `title`);无(首次结果前)→ 灰;
  4. worker 列表刷新(`refresh`)仍走 3s `usePolling`(与 status 5min 各自独立)。

  完整替换文件为:
  ```tsx
  import { Pencil, Plus, Trash2 } from "lucide-react";
  import { useState, type ReactNode } from "react";
  import { api, type WorkerDTO, type WorkerStatus } from "../api/client";
  import { Button, IconButton } from "./Button";
  import { ConfirmDialog } from "./ConfirmDialog";
  import { errMessage, useToast, usePolling } from "../lib/hooks";
  import { WorkerDialog } from "../modals/WorkerDialog";
  import { useT } from "../lib/i18n";

  /** worker 状态轮询周期(ms)。改 10 分钟只需改这个数。 */
  const WORKER_STATUS_POLL_MS = 300_000;

  /** Hub 页顶部的 Workers 卡:录制节点列表(name/kind/host/实时状态点)+ 增删改。 */
  export function WorkersCard(): ReactNode {
    const t = useT();
    const toast = useToast();
    const [workers, setWorkers] = useState<WorkerDTO[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [status, setStatus] = useState<Record<string, WorkerStatus>>({});
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<WorkerDTO | null>(null);
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);

    const refresh = async (): Promise<void> => {
      try {
        setWorkers(await api.listWorkers());
      } catch {
        /* 静默:轮询会重试 */
      } finally {
        setLoaded(true);
      }
    };
    usePolling(() => void refresh(), 3000);

    // 状态点自动轮询:挂载即拉一次 + 每 5 分钟。整体失败 → 保上次状态(不清空),不崩。
    const fetchStatus = async (): Promise<void> => {
      try {
        const list = await api.getWorkersStatus();
        setStatus(Object.fromEntries(list.map((s) => [s.id, s])));
      } catch {
        /* 保留上次 status */
      }
    };
    usePolling(() => void fetchStatus(), WORKER_STATUS_POLL_MS);

    const openCreate = (): void => {
      setEditing(null);
      setDialogOpen(true);
    };
    const openEdit = (w: WorkerDTO): void => {
      setEditing(w);
      setDialogOpen(true);
    };

    const doDelete = async (id: string): Promise<void> => {
      try {
        await api.deleteWorker(id);
        toast(t("hub.workers.deleted"), "info");
        await refresh();
      } catch (e) {
        toast(errMessage(e), "error");
      }
    };

    // 三态:绿=ok / 红=fail / 灰=首次结果返回前(checking)。
    const dotColor = (w: WorkerDTO): string => {
      const s = status[w.id];
      return !s ? "var(--muted-soft)" : s.ok ? "var(--success)" : "var(--error)";
    };
    const dotTitle = (w: WorkerDTO): string => {
      const s = status[w.id];
      if (!s) return t("hub.workers.statusChecking");
      return s.ok ? t("hub.workers.statusOk") : (s.error ?? t("hub.workerDialog.unknownError"));
    };

    return (
      <>
        <section className="card overflow-hidden mb-6">
          <div className="flex items-end justify-between gap-3 p-4 pb-2">
            <div>
              <h2 className="headline text-[18px] leading-tight">{t("hub.workers.title")}</h2>
              <p className="text-muted text-xs mt-1">{t("hub.workers.subtitle")}</p>
            </div>
            <Button small onClick={openCreate}>
              <Plus className="w-4 h-4" />
              {t("hub.workers.add")}
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="tasks">
              <thead>
                <tr>
                  <th>{t("hub.workers.colName")}</th>
                  <th>{t("hub.workers.colKind")}</th>
                  <th>{t("hub.workers.colHost")}</th>
                  <th>{t("hub.workers.colStatus")}</th>
                  <th className="text-right">{t("hub.workers.colAction")}</th>
                </tr>
              </thead>
              <tbody>
                {!loaded && (
                  <tr>
                    <td colSpan={5} className="text-center text-muted py-8">{t("hub.common.loading")}</td>
                  </tr>
                )}
                {loaded && workers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-muted py-8">{t("hub.workers.empty")}</td>
                  </tr>
                )}
                {loaded &&
                  workers.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <div className="font-medium text-ink">{w.name}</div>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-muted">{w.kind}</span>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-body">{w.host ?? "—"}</span>
                      </td>
                      <td>
                        <span className="dot" style={{ background: dotColor(w) }} title={dotTitle(w)} />
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2.5 justify-end">
                          <IconButton title={t("hub.common.edit")} onClick={() => openEdit(w)}>
                            <Pencil className="w-4 h-4" />
                          </IconButton>
                          {w.id !== "local" && (
                            <IconButton title={t("hub.common.delete")} style={{ color: "var(--error)" }} onClick={() => setPendingDelete(w.id)}>
                              <Trash2 className="w-4 h-4" />
                            </IconButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        <WorkerDialog open={dialogOpen} onClose={() => setDialogOpen(false)} worker={editing} onSaved={() => void refresh()} />

        <ConfirmDialog
          open={pendingDelete !== null}
          title={t("hub.workers.deleteConfirmTitle")}
          confirmLabel={t("hub.common.delete")}
          destructive
          onConfirm={() => {
            const id = pendingDelete;
            setPendingDelete(null);
            if (id !== null) void doDelete(id);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      </>
    );
  }
  ```
  > **可见性**:`WorkersCard` 只在 Hub 页(master)渲染 —— 组件挂载 = 卡片可见,卸载 = usePolling 的 `useEffect` cleanup 清 interval。故「仅可见时轮询」由组件挂载/卸载天然满足,`usePolling` 第三参 `enabled` 默认 `true` 即可(无需额外可见性探测)。

### Step 2.5 — 验证 + 手动清单

- [ ] **web build**:`cd packages/web && rtk proxy pnpm build`
  期望:0 错误(WorkersCard/WorkerDialog/client 全过)。
- [ ] **根 typecheck**:`rtk proxy pnpm typecheck`
  期望:0 错误(前后端类型经 @drec/contracts 同步:WorkerTestResult `{ok,error?}` + WorkerStatus)。
- [ ] **根全量测试**(确保 Task 1 未回归):`rtk proxy pnpm test`
- [ ] **手动验证清单**(启 `node dist/douyin-rec.mjs task serve --port 7860 --hub` + `cd packages/web && pnpm dev` 或用 build 产物):
  - [ ] 打开 Hub 页 → Workers 卡挂载即显示状态点(首帧灰「检测中」→ 首次 status 返回后变绿/红);
  - [ ] 每行**无 wifi/测试按钮**,只剩编辑 + 删除(local 无删除);
  - [ ] 停掉一个 ssh worker(或填错 host)→ **下次轮询**(≤5 分钟;可临时把 `WORKER_STATUS_POLL_MS` 调小验证)该行点变红,hover 显示 error 串(`title`);
  - [ ] 打开 Add/Edit 弹窗 → 「测试连接」按钮仍可用,成功显示「连接成功 · dataRoot 可达」,失败显示 error(走 ping 版 `POST /workers/test`);
  - [ ] 切到别的页再回来 → 状态点重新拉一次(组件重挂载 → usePolling 立即执行);
  - [ ] slave 节点(无 `--hub`)不显示 Hub 页 → 不轮询 status。
- [ ] **Commit**(约定式,无 AI trailer):
  ```
  feat(web): Workers 卡实时状态点(5 分钟 ping 轮询)+ 删手动测试按钮

  - 删每行 wifi/测试按钮;状态点改由 GET /api/hub/workers/status 自动轮询驱动
  - usePolling 挂载即拉 + 每 5 分钟(常量 WORKER_STATUS_POLL_MS=300000)、仅卡片可见时(组件挂载天然满足)
  - 三态点:绿=ok / 红=fail(error 进 title tooltip)/ 灰=首次结果前 checking
  - 弹窗「存前测试」按钮改消费简化的 {ok,error}(去 recordingCount);getWorkersStatus 客户端方法 + WorkerStatus 类型
  - i18n testOk 去 {count},加 statusOk/statusChecking(zh+en)
  ```

---

## Self-review checklist(实现者收尾核对)

- [ ] 每个 spec 章节都有对应任务:轻量探针(Task 1.2-1.4)、取代完整测试(1.5-1.6)、端点(1.6-1.7)、UI(Task 2)、错误处理(allSettled/未注入→[]/catch 保状态,1.5/1.6/2.4)、测试(1.3/1.4/1.8)。
- [ ] 无 placeholder:所有代码块是从实际文件读出的真实代码改写。
- [ ] 契约跨任务一致:`WorkerTestResult = {ok,error?}`、`WorkerStatus = {id,ok,error?}`、`ping():Promise<void>`、`probeAllWorkers():Promise<Array<{id,ok,error?}>>` 在 core / orchestrator / cli / app / web 五处签名逐字相同。
- [ ] 分层守护:app 不新增对 orchestrator 的 import(ping/probe 逻辑全在 orchestrator + cli 动态 import);无新增包 → 无需改 `test/arch/layering.test.ts` RANKS。
- [ ] scoped transport(`new LocalTransport`/`new SshTransport`)绝不调 `registerBuiltinTransports`(不污染运行中 hub 的全局 registry)。
- [ ] 路由 `/api/hub/workers/status` 在 `/:id` 正则之前匹配(server.ts),不与 `/test`、`/:id` 碰撞。
```
