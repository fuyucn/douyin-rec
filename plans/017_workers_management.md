# Workers 管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给多节点 hub 的录制 worker 加 Web UI 管理 + 连接测试 + 实时重载,并把 tenant→worker 全量改名(含 ledger 列)。

**Architecture:** file-as-truth (hub.config.json 的 workers 数组) + read-fresh live-reload (Approach A: reconciler 每轮重读). app(L4) 只做文件 CRUD 不 import orchestrator(L4.5);CLI(L5) 注入 loadWorkers thunk + testWorker。

**Tech Stack:** Node 24 ESM, node:sqlite, esbuild bundle, vitest, React19+jotai+@base-ui/react (web/ 独立 Vite).

## Global Constraints

- **提交格式**:约定式提交 `<type>(<scope>): 中文描述`,正文 bullet points。**不加** `Co-Authored-By` / `Claude-Session` 等 AI 署名 trailer。只 `git add` 本次相关文件。
- **ESM `.js` import 后缀**:所有相对 import 必须带 `.js`(即使源文件是 `.ts`)。
- **分层铁律**:`@drec/app`(L4)**永远不能** import `@drec/orchestrator`(L4.5)。`test/arch/layering.test.ts` 的 RANKS 守护(app=4 < orchestrator=4.5)。worker-store.ts 留在 app,零 orchestrator 依赖;所有 orchestrator 能力(getTransport/listInventory)由 **CLI(L5)** 注入。`WorkerConfig` 在 orchestrator 与 app 各定义一份**结构相同**的 interface(结构化类型,cli 传 app 的 worker 对象进 orchestrator 的 `getTransport` 天然兼容),`WorkerDTO`/`WorkerTestResult` 定义在 `@drec/core`(L0)供三端共用。
- **grandfather 现有 id**:`local` / `vps2` 等既有 worker id **值不变**(ledger 历史行按 id 关联,改值会错配)。
- **worker-N 单调**:新建 id = `worker-${++workerSeq}`,`workerSeq` 持久在 hub.config.json,**删除后绝不复用**。
- **local worker 保护**:id==="local"(master 自身)**不可删**、**不可改 kind**;`name`/`dataRoot` 可改。
- **ledger RENAME COLUMN 幂等**:每条 `ALTER TABLE … RENAME COLUMN` 各自 try/catch(fresh DB 上旧列不存在会抛,吞掉),与既有 `ADD COLUMN fails` 同模式。
- **写文件保留其余字段**:worker CRUD 读整个 hub.config.json,只改 `workers`/`workerSeq`,其余(`platform`/`stageDir`/`cookies`/`uploadDefaults`/时序…)逐字保留;原子写(temp + rename,仿 hub-store.ts)。
- **`kind` 不改名**:kind 是 transport 类型(`local`/`ssh`/`tailscale-ssh`),与 tenant/worker 概念正交,保留字段名 `kind`。
- **每步命令**:`rtk proxy pnpm test -- <pattern>`、`rtk proxy pnpm typecheck`、`rtk proxy pnpm bundle`、`cd packages/web && rtk proxy pnpm build`。

---

## Task 1: tenant→worker 全量改名(含 ledger 列迁移 + config 键)

面广但机械。先做、先绿。改完 `rtk proxy grep` 断言非测试源里零残留 `tenantId`/`winnerTenant`/`TenantConfig`。

### 精确符号映射(old → new)

| 层 / 文件 | old | new |
|---|---|---|
| `orchestrator/transport.ts` | `interface TenantConfig` | `interface WorkerConfig`(+ 新增 `name?: string`) |
| `orchestrator/transport.ts` | `NodeInventory.tenantId` | `NodeInventory.workerId` |
| `orchestrator/transport.ts` | `type Factory = (cfg: TenantConfig) => Transport` | `(cfg: WorkerConfig) => Transport` |
| `orchestrator/transport.ts` | `getTransport(cfg: TenantConfig)` | `getTransport(cfg: WorkerConfig)` |
| `orchestrator/identity.ts` | `BroadcastMember.tenantId` | `BroadcastMember.workerId` |
| `orchestrator/identity.ts` | `clusterBroadcasts(byTenant: {tenantId}[])` | `{workerId}[]`(内部 `flat` 的 `m.tenantId`→`m.workerId`) |
| `orchestrator/select.ts` | `CandidateMetrics.tenantId` | `CandidateMetrics.workerId`(`perNode` 变量名保留) |
| `orchestrator/pipeline.ts` | 所有 `m.tenantId` / `winner.tenantId` | `m.workerId` / `winner.workerId` |
| `orchestrator/transport-local.ts` | `return { tenantId: this.id, … }` | `return { workerId: this.id, … }` |
| `orchestrator/transport-ssh.ts` | `return { tenantId: this.id, … }` | `return { workerId: this.id, … }` |
| `orchestrator/reconciler.ts` | 所有 `tenantId`(inventory 降级、settle memberMap、`stillRecording` key) | `workerId` |
| `orchestrator/ledger.ts` | `JobRow.winnerTenant` | `JobRow.winnerWorker` |
| `orchestrator/ledger.ts` | `CandidateRow.tenantId` | `CandidateRow.workerId` |
| `orchestrator/ledger.ts` | `sync_jobs.winnerTenant`(SQL 列) | `sync_jobs.winnerWorker` |
| `orchestrator/ledger.ts` | `sync_candidates.tenantId`(SQL PK 列) | `sync_candidates.workerId` |
| `orchestrator/ledger.ts` | `setState(…, patch: {winnerTenant?})` | `{winnerWorker?}` |
| `orchestrator/ledger.ts` | `recordCandidates(cands:{tenantId}[], winnerTenantId?)` | `{workerId}[], winnerWorkerId?` |
| `app/hub-jobs.ts` | `HubJobView.winnerTenant` + `RawJob.winnerTenant` | `winnerWorker` |
| `core/api-types.ts` | `HubJobDTO.winnerTenant` | `HubJobDTO.winnerWorker` |
| `web/components/HubJobs.tsx` | `job.winnerTenant` | `job.winnerWorker` |
| `cli/cli.ts` | `hubCfg.tenants` | `hubCfg.workers ?? hubCfg.tenants`(读时 back-compat) |
| `configs/hub.config.example.json` | `"tenants"` | `"workers"`(+ `"workerSeq"`) |

> **`kind` 不动**。`docs/*` 里的散文提及不必改(非代码)。

### Files
- **Modify:** `packages/orchestrator/src/transport.ts`, `identity.ts`, `select.ts`, `pipeline.ts`, `transport-local.ts`, `transport-ssh.ts`, `reconciler.ts`, `ledger.ts`
- **Modify:** `packages/app/src/hub-jobs.ts`
- **Modify:** `packages/core/src/api-types.ts`
- **Modify:** `packages/cli/src/cli.ts`
- **Modify:** `packages/web/src/components/HubJobs.tsx`
- **Modify:** `configs/hub.config.example.json`
- **Modify (tests):** `packages/orchestrator/src/ledger.test.ts`, `reconciler.test.ts`, `pipeline.test.ts`, `packages/app/src/hub-jobs.test.ts`, `test/app/web-server.test.ts`(若含 winner 断言)

### Interfaces
- **Produces (orchestrator/transport.ts):**
  ```ts
  export interface WorkerConfig { id: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string; name?: string; }
  export interface NodeInventory { workerId: string; recordings: NodeRecording[]; }
  ```
- **Produces (orchestrator/ledger.ts):**
  ```ts
  export interface JobRow { streamKey: string; state: JobState; winnerWorker?: string; bv?: string; error?: string; fails: number; updatedAt: number; }
  export interface CandidateRow { streamKey: string; workerId: string; coverage: number; durationSec: number; startMs: number; endMs: number; totalGapSec: number; isWinner: number; updatedAt: number; }
  ```

### Steps

- [ ] **TDD 迁移测试先行(会失败)**。在 `packages/orchestrator/src/ledger.test.ts` 末尾加一个 `describe("ledger 列迁移 tenant→worker")`,用 `node:sqlite` 直接建**旧 schema** DB(旧列名 + 一行数据),再 `new SyncLedger(path)`,断言新列存在且旧值保留:
  ```ts
  import { DatabaseSync } from "node:sqlite";
  // …放在文件已有 import 之后

  describe("ledger 列迁移 tenant→worker(幂等 RENAME COLUMN)", () => {
    it("打开旧 schema(winnerTenant/tenantId)库 → 自动改名列 + 旧值保留", () => {
      const dir = mkdtempSync(join(tmpdir(), "led-mig-"));
      const p = join(dir, "old.db");
      const raw = new DatabaseSync(p);
      raw.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
        winnerTenant TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
      raw.exec(`CREATE TABLE sync_candidates(streamKey TEXT NOT NULL, tenantId TEXT NOT NULL,
        coverage REAL NOT NULL, durationSec REAL NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL,
        totalGapSec REAL NOT NULL, isWinner INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(streamKey, tenantId))`);
      raw.exec(`CREATE TABLE sync_job_events(streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
      raw.exec(`CREATE TABLE sync_job_steps(streamKey TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL)`);
      raw.prepare("INSERT INTO sync_jobs(streamKey,state,winnerTenant,updatedAt) VALUES(?,?,?,?)")
        .run("douyin:1:2026-06-28", "done", "local", 1);
      raw.prepare(`INSERT INTO sync_candidates(streamKey,tenantId,coverage,durationSec,startMs,endMs,totalGapSec,isWinner,updatedAt)
        VALUES(?,?,1,10,0,10,0,1,1)`).run("douyin:1:2026-06-28", "vps2");
      raw.close();

      const l = new SyncLedger(p); // 构造函数应就地迁移
      expect(l.get("douyin:1:2026-06-28")?.winnerWorker).toBe("local");   // 旧值保留 + 新列名
      expect(l.getCandidates("douyin:1:2026-06-28")[0].workerId).toBe("vps2");
      l.close();

      // 幂等:同一(已迁移)库再次打开不抛。
      const l2 = new SyncLedger(p);
      expect(l2.get("douyin:1:2026-06-28")?.winnerWorker).toBe("local");
      l2.close();
    });
  });
  ```
- [ ] 运行 `rtk proxy pnpm test -- ledger` → **失败**(列/字段还叫旧名)。
- [ ] **改 ledger.ts**。① `JobRow.winnerTenant`→`winnerWorker`;`CandidateRow.tenantId`→`workerId`。② `CREATE TABLE sync_jobs` 的列 `winnerTenant`→`winnerWorker`;`sync_candidates` 的列 `tenantId`→`workerId`(含 `PRIMARY KEY(streamKey, workerId)`)。③ 在**两个 CREATE TABLE 之后**(紧挨已有 `ALTER TABLE … ADD COLUMN fails` 那段)加幂等迁移:
  ```ts
    // 既有库列改名 tenant→worker(fresh DB 上旧列不存在会抛 → 吞掉;SQLite ≥3.25 支持 PK 列改名)。
    try { this.db.exec("ALTER TABLE sync_jobs RENAME COLUMN winnerTenant TO winnerWorker"); } catch { /* 已是新列名或 fresh */ }
    try { this.db.exec("ALTER TABLE sync_candidates RENAME COLUMN tenantId TO workerId"); } catch { /* 已是新列名或 fresh */ }
  ```
  ④ `setState` 的 `patch: { winnerTenant?: … }`→`{ winnerWorker?: … }`,SQL `SET winnerTenant=COALESCE(...)`→`winnerWorker`,`patch.winnerTenant`→`patch.winnerWorker`。⑤ `recordCandidates(cands: {…tenantId…}[], winnerTenantId?)`→`{…workerId…}[], winnerWorkerId?`;INSERT 列 `tenantId`→`workerId`;`ON CONFLICT(streamKey,tenantId)`→`(streamKey,workerId)`;`c.tenantId`→`c.workerId`,`c.tenantId === winnerTenantId`→`c.workerId === winnerWorkerId`。
- [ ] 改 `ledger.test.ts` 既有 `recordCandidates` 测试:`{ tenantId: "local", … }`→`{ workerId: "local", … }`,`rows[0].tenantId`→`rows[0].workerId`,`again.find((r) => r.tenantId===…)`→`workerId`。
- [ ] 运行 `rtk proxy pnpm test -- ledger` → **通过**。
- [ ] **改 transport.ts**:`TenantConfig`→`WorkerConfig`(加 `name?: string`)、`NodeInventory.tenantId`→`workerId`、`Factory`/`getTransport` 形参类型。
- [ ] **改 transport-local.ts / transport-ssh.ts**:两处 `return { tenantId: this.id, … }`→`{ workerId: this.id, … }`。
- [ ] **改 identity.ts**:`BroadcastMember.tenantId`→`workerId`;`clusterBroadcasts` 形参 `byTenant: { tenantId … }[]`→`{ workerId … }[]`;`flat` map 里 `tenantId: t.tenantId`→`workerId: t.workerId`。
- [ ] **改 select.ts**:`CandidateMetrics.tenantId`→`workerId`;`perNode` map 里 `tenantId: m.tenantId`→`workerId: m.workerId`;`sessionCount` 与 `isComplete` 里 `m.tenantId`→`m.workerId`。
- [ ] **改 pipeline.ts**:所有 `m.tenantId`(成员日志、`transports.get`、剔除告警、cleanup)与 `winner.tenantId`(选优日志、`recordCandidates` 第三参、`setState winnerTenant`→`winnerWorker`、`transports.get(winner.workerId)`、`No transport for tenant:` 报错文案与 pull 日志)全部改 `workerId` / `winnerWorker`。`ledger.setState(streamKey, "needs_manual", { winnerTenant: winner.tenantId })`→`{ winnerWorker: winner.workerId }`;`ledger.setState(streamKey, "syncing", { winnerTenant: winner.tenantId })`→`{ winnerWorker: winner.workerId }`。
- [ ] **改 reconciler.ts**:`inventoryWithTimeout` 降级 `{ tenantId: t.id, … }`→`{ workerId: t.id, … }`(两处);`reconcileAll` 里 `invs.map((i) => ({ tenantId: i.tenantId, … }))`→`{ workerId: i.workerId, … }`;`settleAll` 的 `memberMap`/`pending` key `${m.tenantId}:${…}`→`${m.workerId}:${…}`、解构 `{ tenantId, roomSlug }`→`{ workerId, roomSlug }`、`this.transports.get(tenantId)`→`get(workerId)`、超时日志 `${tenantId}/${roomSlug}`→`${workerId}/…`;`reconcileAll` 第 169 行 `stillRecording.has(\`${m.tenantId}:…\`)`→`${m.workerId}:…`。
- [ ] **改 hub-jobs.ts**:`HubJobView.winnerTenant`→`winnerWorker`;`interface RawJob { … winnerTenant … }`→`winnerWorker`;view map 里 `winnerTenant: j.winnerTenant ?? null`→`winnerWorker: j.winnerWorker ?? null`。(SQL 是 `SELECT *`,列改名后字段自动跟随。)
- [ ] **改 core/api-types.ts**:`HubJobDTO.winnerTenant: string | null`→`winnerWorker: string | null`(注释同步)。
- [ ] **改 web/components/HubJobs.tsx** 第 205 行:`{job.winnerTenant && <span>选优: {job.winnerTenant}</span>}`→`{job.winnerWorker && <span>选优: {job.winnerWorker}</span>}`。(id→name 展示留 Task 4,此处先展示 raw id。)
- [ ] **改 cli/cli.ts**:`hubCfg` 类型里 `tenants?: Array<…>`→加 `workers?: Array<{ id: string; kind: string; host?: string; dataRoot?: string; name?: string }>`(保留 `tenants?` 作旧字段);第 499 行 `const tenants = hubCfg.tenants ?? [];`→`const workers = hubCfg.workers ?? hubCfg.tenants ?? [];`;第 500 行 `new Map(tenants.map(…))`→`workers.map`;第 589 行日志 `${tenants.length} 个租户`→`${workers.length} 个 worker`。
- [ ] **改 configs/hub.config.example.json**:`"tenants"`→`"workers"`,加 `"workerSeq": 0`,每条加 `"name"`:
  ```json
  {
    "platform": "douyin",
    "workerSeq": 0,
    "workers": [
      { "id": "local", "name": "本机(master)", "kind": "local", "dataRoot": "/data" },
      { "id": "vps2", "name": "香港 VPS", "kind": "tailscale-ssh", "host": "CHANGE-ME.ts.net", "dataRoot": "/home/ubuntu/drec" }
    ],
    "cookies": "/data/config/biliup/cookies.json",
    "stageDir": "/data/stage",
    "cleanMaxGapSec": 30,
    "settleMs": 90000, "pollMs": 3000, "reconcileIntervalMs": 1800000,
    "maxWaitSec": 600, "settleSec": 15,
    "uploadDefaults": { "tag": "直播,录像", "tid": 21, "titleTemplate": "{name}_{date}" }
  }
  ```
- [ ] **改连带测试**:
  - `reconciler.test.ts`:`makeTransport` 里 `listInventory … mockResolvedValue({ tenantId: id, recordings })`→`{ workerId: id, recordings }`;`makeRec({ tenantId: "node-1" } as Partial<NodeRecording>)` 这类 cast 是 cosmetic(tenantId 不是 NodeRecording 字段),可保留或删,但**若测试断言了 broadcast member 的 tenantId 则改 workerId**(检查全文件)。
  - `pipeline.test.ts`:grep `tenantId`/`winnerTenant`,把 broadcast members `{ tenantId }`→`{ workerId }`、断言 `winnerTenant`→`winnerWorker`。
  - `hub-jobs.test.ts`:`makeSyncDb` 的 `CREATE TABLE sync_jobs(… winnerTenant …)`→`winnerWorker`,`sync_candidates(… tenantId …)`→`workerId`(含 PK);`seedJob` 的 INSERT 列名 `winnerTenant`→`winnerWorker`、`sync_candidates(…,tenantId,…)`→`workerId`;若断言 `jobs[0].winnerTenant` 则改 `winnerWorker`。
  - `test/app/web-server.test.ts`:若含 `winnerTenant` 断言则改;matchRoute 断言此任务不涉及。
- [ ] **验证**:
  ```bash
  rtk proxy pnpm typecheck
  rtk proxy pnpm test
  rtk proxy grep -rn "tenantId\|winnerTenant\|TenantConfig" packages/*/src configs | rtk proxy grep -v "\.test\.ts"
  ```
  最后一条应**零输出**(散文注释/docs 不算源;若注释里还有可清理但非必须)。
- [ ] **commit**:`refactor(orchestrator,ledger): tenant 全量改名 worker + sqlite 列迁移`
  - 正文:说明改了哪些符号 / RENAME COLUMN 幂等迁移 / config 键 tenants→workers 带 back-compat 读 / DTO+web 同步。

---

## Task 2: worker-store.ts + REST `/api/hub/workers` + 实时重载 thunk

后端文件 CRUD + reconciler 每轮重读 workers 重建 transports(Approach A)。

### Files
- **Create:** `packages/app/src/worker-store.ts`
- **Create:** `packages/app/src/worker-store.test.ts`
- **Modify:** `packages/app/src/index.ts`(barrel 导出 `workerStore`)
- **Modify:** `packages/core/src/api-types.ts`(加 `WorkerDTO`)
- **Modify:** `packages/app/src/web/api.ts`(ApiDeps 加 `hubConfigPath?`;Api 加 4 个 worker 方法 + 实现)
- **Modify:** `packages/app/src/web/server.ts`(RouteMatch name 联合类型 + matchRoute 路由 + dispatch + WebServerDeps 加 `hubConfigPath?` 并透传)
- **Modify:** `packages/orchestrator/src/reconciler.ts`(ReconcilerDeps 加 `loadTransports?`;reconcileAll 顶部重建)
- **Modify:** `packages/orchestrator/src/reconciler.test.ts`(实时重载测试)
- **Modify:** `packages/cli/src/cli.ts`(注入 `loadTransports` thunk)
- **Modify:** `packages/web/src/api/client.ts`(WorkerDTO re-export;暂加 listWorkers 供 Task 4)

### Interfaces
- **Produces (core/api-types.ts):**
  ```ts
  /** 一个录制 worker(节点)的展示投影。id 内部稳定主键(UI 不展示);name 友好名。 */
  export interface WorkerDTO { id: string; name: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string; }
  ```
- **Produces (app/worker-store.ts):**
  ```ts
  export interface WorkerConfig { id: string; name?: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string; }
  export function listWorkers(configPath: string): WorkerConfig[];
  export function createWorker(configPath: string, input: { name?: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string }): WorkerConfig;
  export function updateWorker(configPath: string, id: string, patch: { name?: string; kind?: string; host?: string; dataRoot?: string; apiUrl?: string }): WorkerConfig | null;
  export function deleteWorker(configPath: string, id: string): boolean;
  ```
- **Produces (orchestrator/reconciler.ts):** `ReconcilerDeps.loadTransports?: () => Map<string, Transport>`
- **Consumes (cli.ts):** `workerStore.listWorkers(rootHubConfig())` + `getTransport(w)`

### Steps

- [ ] **TDD worker-store(会失败)**。写 `packages/app/src/worker-store.test.ts`。用 tmp 目录写一个 hub.config.json 起手,覆盖:create→`worker-1` 单调 + 默认 name + workerSeq 持久;update 补丁;delete 移除;`local` 保护(拒删 + 拒改 kind);保留非 worker 字段;`tenants→workers` 读迁移;seq 不复用;kind 校验:
  ```ts
  import { describe, it, expect, beforeEach } from "vitest";
  import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { listWorkers, createWorker, updateWorker, deleteWorker } from "./worker-store.js";

  let cfg: string;
  const read = (): any => JSON.parse(readFileSync(cfg, "utf-8"));
  beforeEach(() => {
    cfg = join(mkdtempSync(join(tmpdir(), "worker-store-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({
      platform: "douyin", stageDir: "/data/stage", cookies: "/c.json",
      workers: [{ id: "local", name: "本机", kind: "local", dataRoot: "/data" }],
      uploadDefaults: { tag: "直播,录像", tid: 21 },
    }, null, 2));
  });

  describe("worker-store(文件版 CRUD)", () => {
    it("create 分配 worker-1 单调 + 默认 name(host)+ 持久 workerSeq", () => {
      const w = createWorker(cfg, { kind: "ssh", host: "1.2.3.4", dataRoot: "/drec" });
      expect(w.id).toBe("worker-1");
      expect(w.name).toBe("1.2.3.4");           // 无 name → 回落 host
      expect(read().workerSeq).toBe(1);
      const w2 = createWorker(cfg, { kind: "local", dataRoot: "/x", name: "备机" });
      expect(w2.id).toBe("worker-2");
      expect(w2.name).toBe("备机");
    });
    it("seq 不复用:删了 worker-1 再 create 得 worker-2", () => {
      createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" }); // worker-1
      expect(deleteWorker(cfg, "worker-1")).toBe(true);
      expect(createWorker(cfg, { kind: "ssh", host: "h2", dataRoot: "/d" }).id).toBe("worker-2");
    });
    it("默认 name 无 host → `Worker N`", () => {
      expect(createWorker(cfg, { kind: "local", dataRoot: "/d" }).name).toBe("Worker 1");
    });
    it("update 部分改;不存在返回 null", () => {
      createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" });
      expect(updateWorker(cfg, "worker-1", { name: "新名", host: "h2" })!.name).toBe("新名");
      expect(updateWorker(cfg, "worker-1", {})!.host).toBe("h2");
      expect(updateWorker(cfg, "nope", { name: "x" })).toBeNull();
    });
    it("local 保护:拒删 + 拒改 kind;name/dataRoot 可改", () => {
      expect(() => deleteWorker(cfg, "local")).toThrow();
      expect(() => updateWorker(cfg, "local", { kind: "ssh" })).toThrow();
      expect(updateWorker(cfg, "local", { name: "主机", dataRoot: "/data2" })!.dataRoot).toBe("/data2");
    });
    it("kind 校验 + 必填:ssh 需 host+dataRoot;local 需 dataRoot", () => {
      expect(() => createWorker(cfg, { kind: "bogus", dataRoot: "/d" })).toThrow();
      expect(() => createWorker(cfg, { kind: "ssh", dataRoot: "/d" })).toThrow();      // 缺 host
      expect(() => createWorker(cfg, { kind: "local" } as any)).toThrow();             // 缺 dataRoot
    });
    it("保留非 worker 字段(原子写不吞其余配置)", () => {
      createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" });
      const j = read();
      expect(j.platform).toBe("douyin");
      expect(j.stageDir).toBe("/data/stage");
      expect(j.uploadDefaults).toEqual({ tag: "直播,录像", tid: 21 });
    });
    it("tenants→workers 读迁移:旧文件 list 能读,首次写迁移成 workers + 补 workerSeq", () => {
      writeFileSync(cfg, JSON.stringify({ platform: "douyin",
        tenants: [{ id: "local", kind: "local", dataRoot: "/data" }, { id: "vps2", kind: "ssh", host: "h", dataRoot: "/d" }] }, null, 2));
      expect(listWorkers(cfg).map((w) => w.id)).toEqual(["local", "vps2"]);
      createWorker(cfg, { kind: "ssh", host: "h3", dataRoot: "/d" });
      const j = read();
      expect(j.workers.map((w: any) => w.id)).toEqual(["local", "vps2", "worker-1"]); // grandfather 值不变
      expect(j.tenants).toBeUndefined();       // 迁移后删旧键
      expect(j.workerSeq).toBe(1);
    });
  });
  ```
- [ ] 运行 `rtk proxy pnpm test -- worker-store` → **失败**(文件不存在)。
- [ ] **写 worker-store.ts**(仿 hub-store.ts 的现读不缓存 + 原子写):
  ```ts
  /**
   * worker-store.ts — 文件版 worker(录制节点)配置存储。真理源 = hub.config.json 的 workers 数组。
   * 读时不缓存 → UI 与手改文件天然同步;原子写(temp+rename)保留所有非 worker 字段。
   * 分层:纯文件 CRUD,零 orchestrator 依赖(app L4)。id 分配/默认 name/tenants→workers 迁移/local 保护都在这里。
   */
  import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
  import { dirname, join, basename } from "node:path";

  export interface WorkerConfig { id: string; name?: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string; }

  const KINDS = new Set(["local", "ssh", "tailscale-ssh"]);

  interface HubConfigFile { workerSeq?: number; workers?: WorkerConfig[]; tenants?: WorkerConfig[]; [k: string]: unknown; }

  function readConfig(path: string): HubConfigFile {
    try { return JSON.parse(readFileSync(path, "utf-8")) as HubConfigFile; }
    catch { return {}; } // 缺失/坏 JSON → 空(list 返 []);create 会写出合法文件
  }

  /** 归一 workers 数组:workers ?? tenants(旧键 back-compat)。不改盘,只读。 */
  function workersOf(cfg: HubConfigFile): WorkerConfig[] {
    return cfg.workers ?? cfg.tenants ?? [];
  }

  /** 原子写:临时文件 + rename。迁移 tenants→workers(删旧键)。保留其余字段。 */
  function writeConfig(path: string, cfg: HubConfigFile, workers: WorkerConfig[], workerSeq: number): void {
    mkdirSync(dirname(path), { recursive: true });
    const next: HubConfigFile = { ...cfg, workers, workerSeq };
    delete next.tenants; // 迁移:统一到 workers
    const tmp = join(dirname(path), `.${basename(path)}.tmp`);
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  }

  function validate(kind: string, host: string | undefined, dataRoot: string | undefined): void {
    if (!KINDS.has(kind)) throw new Error(`未知 worker kind: ${kind}(合法: ${[...KINDS].join("/")})`);
    if (!dataRoot) throw new Error("dataRoot 必填");
    if ((kind === "ssh" || kind === "tailscale-ssh") && !host) throw new Error(`${kind} 类型需要 host`);
  }

  export function listWorkers(configPath: string): WorkerConfig[] {
    return workersOf(readConfig(configPath));
  }

  export function createWorker(
    configPath: string,
    input: { name?: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string },
  ): WorkerConfig {
    validate(input.kind, input.host, input.dataRoot);
    const cfg = readConfig(configPath);
    const workers = [...workersOf(cfg)];
    // 单调 seq:cfg.workerSeq 起,跳过任何已存在的 worker-N(绝不复用/碰撞)。
    let seq = (cfg.workerSeq ?? 0) + 1;
    const has = (id: string): boolean => workers.some((w) => w.id === id);
    while (has(`worker-${seq}`)) seq++;
    const id = `worker-${seq}`;
    const name = (input.name ?? "").trim() || input.host || `Worker ${seq}`;
    const w: WorkerConfig = { id, name, kind: input.kind, dataRoot: input.dataRoot };
    if (input.host) w.host = input.host;
    if (input.apiUrl) w.apiUrl = input.apiUrl;
    workers.push(w);
    writeConfig(configPath, cfg, workers, seq);
    return w;
  }

  export function updateWorker(
    configPath: string,
    id: string,
    patch: { name?: string; kind?: string; host?: string; dataRoot?: string; apiUrl?: string },
  ): WorkerConfig | null {
    const cfg = readConfig(configPath);
    const workers = [...workersOf(cfg)];
    const i = workers.findIndex((w) => w.id === id);
    if (i < 0) return null;
    const cur = workers[i];
    // local(master 自身)保护:不可改 kind(可改 name/host/dataRoot)。
    if (id === "local" && patch.kind != null && patch.kind !== cur.kind) throw new Error("local worker(master 自身)不可改 kind");
    const next: WorkerConfig = { ...cur };
    if (patch.name != null) next.name = patch.name.trim() || cur.name;
    if (patch.kind != null) next.kind = patch.kind;
    if (patch.host != null) next.host = patch.host || undefined;
    if (patch.dataRoot != null) next.dataRoot = patch.dataRoot;
    if (patch.apiUrl != null) next.apiUrl = patch.apiUrl || undefined;
    validate(next.kind, next.host, next.dataRoot);
    workers[i] = next;
    writeConfig(configPath, cfg, workers, cfg.workerSeq ?? 0);
    return next;
  }

  export function deleteWorker(configPath: string, id: string): boolean {
    if (id === "local") throw new Error("local worker(master 自身)不可删除");
    const cfg = readConfig(configPath);
    const workers = workersOf(cfg);
    const next = workers.filter((w) => w.id !== id);
    if (next.length === workers.length) return false; // 不存在
    writeConfig(configPath, cfg, next, cfg.workerSeq ?? 0);
    return true;
  }
  ```
  > 注:`existsSync`/`import` 若 lint 报未用则删。`validate` 里 `local` 也允许(kind 枚举含 local),create 不阻止再建 local(边缘;不在本期范围)。
- [ ] 运行 `rtk proxy pnpm test -- worker-store` → **通过**。
- [ ] **导出**:`packages/app/src/index.ts` 加 `export * as workerStore from "./worker-store.js";` 和 `export type { WorkerConfig } from "./worker-store.js";`。
- [ ] **core WorkerDTO**:在 `packages/core/src/api-types.ts` 加上文 `WorkerDTO` interface(放在 HubJobDTO 附近)。确认 core barrel(`packages/core/src/index.ts`)导出 api-types(既有 HubJobDTO 已导出,同处加即可)。
- [ ] **TDD web-api worker 端点(会失败)**。在 `test/app/web-api.test.ts` 末尾加 `describe("hub workers 端点")`,注入 tmp hubConfigPath + hubEnabled:
  ```ts
  import { mkdtempSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  // …复用文件已有 store/manager fixture(见文件顶部 makeApi 用法)

  describe("hub workers 端点(CRUD + hubEnabled 门)", () => {
    function apiWith(hubEnabled: boolean) {
      const cfg = join(mkdtempSync(join(tmpdir(), "wapi-")), "hub.config.json");
      writeFileSync(cfg, JSON.stringify({ platform: "douyin",
        workers: [{ id: "local", name: "本机", kind: "local", dataRoot: "/data" }] }, null, 2));
      return { api: makeApi({ store, manager, hubEnabled, hubConfigPath: cfg }), cfg };
    }
    it("hub 未启用 → 端点返回 400 hub 未启用", () => {
      const { api } = apiWith(false);
      expect(api.listWorkers().status).toBe(400);
      expect(api.createWorker({ kind: "ssh", host: "h", dataRoot: "/d" }).status).toBe(400);
    });
    it("list 含 local;create 返 worker-1;update/delete 往返", () => {
      const { api } = apiWith(true);
      expect((api.listWorkers().body as any[]).map((w) => w.id)).toEqual(["local"]);
      const c = api.createWorker({ kind: "ssh", host: "1.2.3.4", dataRoot: "/drec", name: "港" });
      expect(c.status).toBe(201);
      expect((c.body as any).id).toBe("worker-1");
      expect(api.updateWorker("worker-1", { name: "港2" }).status).toBe(200);
      expect(api.deleteWorker("worker-1").status).toBe(200);
      expect(api.deleteWorker("worker-1").status).toBe(404);   // 已删
    });
    it("create 校验错 → 400;local 保护 → 400", () => {
      const { api } = apiWith(true);
      expect(api.createWorker({ kind: "ssh", dataRoot: "/d" } as any).status).toBe(400); // 缺 host
      expect(api.deleteWorker("local").status).toBe(400);
      expect(api.updateWorker("local", { kind: "ssh" }).status).toBe(400);
    });
  });
  ```
- [ ] 运行 `rtk proxy pnpm test -- web-api` → **失败**(方法不存在)。
- [ ] **改 api.ts**:① `ApiDeps` 加 `hubConfigPath?: string;`(注释:hub.config.json 路径,省略回落 rootHubConfig())。② import:`import * as workerStore from "../workerStore" ` 改为 `import * as workerStore from "../worker-store.js";`,`import { rootHubConfig } from "../paths.js";`(paths.js 已在 import,追加符号),`import type { WorkerDTO } from "@drec/core";`。③ `Api` interface 加:
  ```ts
    /** GET /api/hub/workers — 列出录制 worker(hub 未启用 → 400)。 */
    listWorkers(): ApiResult;
    /** POST /api/hub/workers — 新建 worker。 */
    createWorker(input: { name?: string; kind?: string; host?: string; dataRoot?: string; apiUrl?: string }): ApiResult;
    /** PATCH /api/hub/workers/:id — 部分更新。 */
    updateWorker(id: string, input: { name?: string; kind?: string; host?: string; dataRoot?: string; apiUrl?: string }): ApiResult;
    /** DELETE /api/hub/workers/:id — 删除(local 保护)。 */
    deleteWorker(id: string): ApiResult;
  ```
  ④ 在 `makeApi` 里 `const hubDir = …` 附近加 `const hubConfigPath = deps.hubConfigPath ?? rootHubConfig();` 和 helper `const workerToDto = (w: workerStore.WorkerConfig): WorkerDTO => ({ id: w.id, name: w.name ?? w.id, kind: w.kind, host: w.host, dataRoot: w.dataRoot, apiUrl: w.apiUrl });`。⑤ 在返回对象里(hub 规则 handlers 旁)加实现:
  ```ts
    listWorkers(): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理 worker)");
      return { status: 200, body: workerStore.listWorkers(hubConfigPath).map(workerToDto) };
    },
    createWorker(input): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理 worker)");
      try {
        const w = workerStore.createWorker(hubConfigPath, {
          name: input.name ?? undefined, kind: input.kind ?? "", host: input.host, dataRoot: input.dataRoot, apiUrl: input.apiUrl,
        });
        return { status: 201, body: workerToDto(w) };
      } catch (e) { return err(400, (e as Error).message); }
    },
    updateWorker(id, input): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理 worker)");
      try {
        const w = workerStore.updateWorker(hubConfigPath, id, input);
        if (!w) return err(404, `未找到 worker id=${id}`);
        return { status: 200, body: workerToDto(w) };
      } catch (e) { return err(400, (e as Error).message); }
    },
    deleteWorker(id): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理 worker)");
      try {
        const ok = workerStore.deleteWorker(hubConfigPath, id);
        if (!ok) return err(404, `未找到 worker id=${id}`);
        return { status: 200, body: { ok: true, id } };
      } catch (e) { return err(400, (e as Error).message); }
    },
  ```
- [ ] **改 server.ts**:① `RouteMatch.name` 联合类型加 `"listWorkers" | "createWorker" | "updateWorker" | "deleteWorker"`。② matchRoute 在 hub rules 路由**之前**(避免 `/api/hub/workers/test` 被别的规则吃掉;test 路由是 Task 3,此处先只加 CRUD)加:
  ```ts
    // 多节点 worker: GET/POST /api/hub/workers + PATCH/DELETE /api/hub/workers/:id
    if (p === "/api/hub/workers") {
      if (method === "GET") return { name: "listWorkers" };
      if (method === "POST") return { name: "createWorker", needsBody: true };
      return null;
    }
    const wk = /^\/api\/hub\/workers\/([A-Za-z0-9_-]+)$/.exec(p);
    if (wk) {
      if (method === "PATCH") return { name: "updateWorker", slug: wk[1], needsBody: true };
      if (method === "DELETE") return { name: "deleteWorker", slug: wk[1] };
      return null;
    }
  ```
  ③ dispatch 加 case:
  ```ts
      case "listWorkers":
        return api.listWorkers();
      case "createWorker": {
        const body = (await readJson(req)) as Parameters<Api["createWorker"]>[0];
        return api.createWorker(body ?? {});
      }
      case "updateWorker": {
        const body = (await readJson(req)) as Parameters<Api["updateWorker"]>[1];
        return api.updateWorker(match.slug!, body ?? {});
      }
      case "deleteWorker":
        return api.deleteWorker(match.slug!);
  ```
  ④ `WebServerDeps` 加 `hubConfigPath?: string;`,`createWebServer` 里 `makeApi({ …, hubConfigPath: deps.hubConfigPath, … })` 透传。
- [ ] **改 web-server.test.ts**:加 matchRoute 断言:
  ```ts
  expect(matchRoute("GET", "/api/hub/workers")?.name).toBe("listWorkers");
  expect(matchRoute("POST", "/api/hub/workers")).toMatchObject({ name: "createWorker", needsBody: true });
  expect(matchRoute("PATCH", "/api/hub/workers/worker-1")).toMatchObject({ name: "updateWorker", slug: "worker-1", needsBody: true });
  expect(matchRoute("DELETE", "/api/hub/workers/local")).toMatchObject({ name: "deleteWorker", slug: "local" });
  ```
- [ ] 运行 `rtk proxy pnpm test -- web-api web-server` → **通过**。
- [ ] **TDD reconciler 实时重载(会失败)**。在 `reconciler.test.ts` 加:改变 `loadTransports()` 返回 → 下一轮 reconcileAll 用新 transports(证明 Approach A)。用 spy runPipeline 记录看到的 broadcast 来自哪个 transport:
  ```ts
  it("实时重载:loadTransports 返回变化 → 下一轮用新 transports 重建", async () => {
    const ledger = freshLedger();
    const recA = makeRec();
    const tOld = makeTransport("old-node", [recA]);
    let current = new Map<string, Transport>([["old-node", tOld]]);
    const pipelineDeps = makePipelineDeps(ledger, current);
    const seen: string[][] = [];
    const spy = vi.fn(async (b: Broadcast) => { seen.push(b.members.map((m) => m.workerId)); ledger.markDone(b.streamKey, "BV"); return { state: "done" as JobState }; });
    const rec = new Reconciler({
      platform: "douyin", transports: current, ledger, pipelineDeps,
      runPipeline: spy, loadTransports: () => current, settle: fastSettle, sleep: fastSleep,
    });
    await rec.reconcileAll();
    expect(seen.at(-1)).toEqual(["old-node"]);
    // 换一台节点(模拟改 hub.config.json 后 loadWorkers→重建)。
    const tNew = makeTransport("new-node", [makeRec()]);
    current = new Map<string, Transport>([["new-node", tNew]]);
    await rec.reconcileAll();
    expect(seen.at(-1)).toEqual(["new-node"]);   // 用的是重建后的 transports
  });
  ```
  > `makeTransport` 已在 Task 1 改成返回 `{ workerId: id, … }`;broadcast member 的 `workerId` 来自 inventory 的 workerId。
- [ ] 运行 `rtk proxy pnpm test -- reconciler` → **失败**(`loadTransports` 未支持,第二轮仍用旧)。
- [ ] **改 reconciler.ts**:① `ReconcilerDeps` 加:
  ```ts
    /**
     * 实时重载(Approach A):每轮 reconcileAll 开头调用重建 transports Map。
     * 无状态 transport 重建极廉价。省略 → 用构造时的 transports(旧行为/测试)。
     */
    loadTransports?: () => Map<string, Transport>;
  ```
  ② 类字段 `private loadTransports?: () => Map<string, Transport>;` + 构造赋值。③ `reconcileAll()` **第一行**:
  ```ts
    // 实时重载:重建 transports(反映 hub.config.json 最新 workers);同步给 pipeline 用的那份。
    if (this.loadTransports) this.transports = this.loadTransports();
    const transports = this.transports;
  ```
  ④ `this._runPipeline(b, { ...this.pipelineDeps, cfg })` → `{ ...this.pipelineDeps, transports, cfg }`(把重建后的 Map 注进 pipeline;pipeline 用 `deps.transports`,不用 reconciler 字段——必须显式传)。
- [ ] 运行 `rtk proxy pnpm test -- reconciler` → **通过**。
- [ ] **改 cli.ts** 注入 `loadTransports`:在 `const workers = hubCfg.workers ?? hubCfg.tenants ?? [];`(Task 1 已改)之后,把 transports 构建改成 thunk 并复用:
  ```ts
    const { rootHubConfig, workerStore } = await import("@drec/app"); // workerStore 已在 Task 2 导出;rootHubConfig 已有
    // loadWorkers 现读 hub.config.json(现读不缓存→UI/手改即时生效)。首启无文件时回落 --hub-config 里的 workers。
    const loadWorkers = (): Array<{ id: string; kind: string; host?: string; dataRoot?: string; name?: string }> => {
      const fromFile = workerStore.listWorkers(rootHubConfig());
      return fromFile.length ? fromFile : workers;
    };
    const buildTransports = (): Map<string, ReturnType<typeof getTransport>> =>
      new Map(loadWorkers().map((w) => [w.id, getTransport(w)]));
    const transports = buildTransports();     // 初始 Map(pipelineDeps 也用它)
  ```
  然后 `new Reconciler({ …, transports, loadTransports: buildTransports, … })`。日志 `${workers.length}` 可改 `${loadWorkers().length}`。
  > `getTransport(w)` 接受结构化 `WorkerConfig`(app 的 worker 对象结构相同)——无跨层类型 import。
- [ ] **改 cli-task.ts**:`createWebServer({ …, hubEnabled, syncDbPath, … })` 加 `hubConfigPath: rootHubConfig()`(import 已有;确认 `resolveDbPath` 段附近能拿到)。这样 web worker 端点写的是 hub 真正读的同一文件。
- [ ] **改 web/api/client.ts**(为 Task 4 铺垫,先加类型 re-export + 方法):在 `import type { … }` 加 `WorkerDTO`;`export type { …, WorkerDTO }`;`api` 对象加(放 hub 规则附近):
  ```ts
    listWorkers: (): Promise<WorkerDTO[]> => request("GET", "/api/hub/workers"),
    createWorker: (input: Partial<WorkerDTO>): Promise<WorkerDTO> => request("POST", "/api/hub/workers", input),
    updateWorker: (id: string, input: Partial<WorkerDTO>): Promise<WorkerDTO> => request("PATCH", `/api/hub/workers/${encodeURIComponent(id)}`, input),
    deleteWorker: (id: string): Promise<{ ok: boolean; id: string }> => request("DELETE", `/api/hub/workers/${encodeURIComponent(id)}`),
  ```
  确认 core 的 WorkerDTO 已从 web 消费的类型入口(client.ts 顶部从 `@drec/core` 或 app 导出处 import;跟随既有 HubRuleDTO 的来源)。
- [ ] **验证**:`rtk proxy pnpm typecheck` + `rtk proxy pnpm test` + `rtk proxy pnpm bundle`(确认打包不炸)+ `cd packages/web && rtk proxy pnpm build`(client.ts 类型编译)。
- [ ] **commit**:`feat(hub): worker-store 文件版 CRUD + REST 端点 + reconciler 实时重载`
  - 正文:worker-store 原子写/单调 workerSeq/local 保护/tenants→workers 迁移;REST /api/hub/workers;reconciler loadTransports 每轮重建(Approach A);cli 注入 loadWorkers thunk。

---

## Task 3: 连接测试(CLI 注入 testWorker)

一次验证 SSH 可达 + dataRoot + inventory 可解析,硬超时,绝不挂起 UI。

### Files
- **Modify:** `packages/core/src/api-types.ts`(加 `WorkerTestResult`)
- **Modify:** `packages/app/src/web/api.ts`(ApiDeps 加 `testWorker?`;Api 加 `testWorker`;实现)
- **Modify:** `packages/app/src/web/server.ts`(RouteMatch + matchRoute `/api/hub/workers/test` + dispatch;WebServerDeps 加 `testWorker?`)
- **Modify:** `packages/app/src/cli-task.ts`(HubStarter 加 `testWorker?`;createWebServer 透传)
- **Modify:** `packages/cli/src/cli.ts`(hubStarter 实现 testWorker,用 orchestrator getTransport+listInventory+超时)
- **Modify:** `packages/web/src/api/client.ts`(testWorker 方法)
- **Modify:** `test/app/web-api.test.ts`(注入 fake testWorker)、`test/app/web-server.test.ts`(路由断言)

### Interfaces
- **Produces (core/api-types.ts):**
  ```ts
  /** worker 连接测试结果(POST /api/hub/workers/test)。 */
  export interface WorkerTestResult { ok: boolean; reachable: boolean; dataRootExists: boolean; recordingCount?: number; error?: string; }
  ```
- **Produces (app/web/api.ts ApiDeps):**
  ```ts
  /** 连接测试(CLI 注入,能 import orchestrator)。省略 → 端点返回「hub 未启用」。 */
  testWorker?: (cfg: { kind: string; host?: string; dataRoot?: string; id?: string; apiUrl?: string }) => Promise<WorkerTestResult>;
  ```
- **Produces (app/cli-task.ts HubStarter):** `testWorker?: (cfg) => Promise<WorkerTestResult>;`(同上签名)

### Steps

- [ ] **TDD web-api testWorker(会失败)**。在 `web-api.test.ts` 的 workers describe 里加:
  ```ts
  it("testWorker:注入 fake → 端点透传结果;未注入(hub 未启用)→ 400", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "wt-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ workers: [] }));
    const fake = vi.fn(async () => ({ ok: true, reachable: true, dataRootExists: true, recordingCount: 3 }));
    const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg, testWorker: fake });
    const r = await a.testWorker({ kind: "ssh", host: "h", dataRoot: "/d" });
    expect(r.status).toBe(200);
    expect((r.body as any).recordingCount).toBe(3);
    expect(fake).toHaveBeenCalledOnce();
    const noDep = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg });
    expect((await noDep.testWorker({ kind: "ssh", host: "h", dataRoot: "/d" })).status).toBe(400);
  });
  ```
- [ ] 运行 `rtk proxy pnpm test -- web-api` → **失败**。
- [ ] **core**:加 `WorkerTestResult` interface + 确认 barrel 导出。
- [ ] **api.ts**:① import `WorkerTestResult`。② `ApiDeps` 加 `testWorker?`(见上)。③ `Api` 加 `testWorker(input: { kind?: string; host?: string; dataRoot?: string; apiUrl?: string }): Promise<ApiResult>;`。④ 实现:
  ```ts
    async testWorker(input): Promise<ApiResult> {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可测试 worker)");
      if (!deps.testWorker) return err(400, "hub 未启用(连接测试未注入)");
      try {
        const r = await deps.testWorker({ kind: input.kind ?? "", host: input.host, dataRoot: input.dataRoot, apiUrl: input.apiUrl });
        return { status: 200, body: r };
      } catch (e) {
        return { status: 200, body: { ok: false, reachable: false, dataRootExists: false, error: (e as Error).message } };
      }
    },
  ```
  > 测试即便异常也回 200 + 结构化 `{ ok:false, error }`——绝不 500 挂前端。
- [ ] **server.ts**:① RouteMatch name 加 `"testWorker"`。② matchRoute:`/api/hub/workers/test` 必须放在 `/api/hub/workers/:id` 正则**之前**(否则 "test" 被当 id):
  ```ts
    if (p === "/api/hub/workers/test" && method === "POST") return { name: "testWorker", needsBody: true };
  ```
  放在 `if (p === "/api/hub/workers")` 块与 `const wk = …` 之间。③ dispatch:
  ```ts
      case "testWorker": {
        const body = (await readJson(req)) as Parameters<Api["testWorker"]>[0];
        return api.testWorker(body ?? {});
      }
  ```
  ④ `WebServerDeps` 加 `testWorker?`(同 ApiDeps 签名);`createWebServer` makeApi 透传 `testWorker: deps.testWorker`。
- [ ] **web-server.test.ts**:`expect(matchRoute("POST", "/api/hub/workers/test")).toMatchObject({ name: "testWorker", needsBody: true });`。
- [ ] 运行 `rtk proxy pnpm test -- web-api web-server` → **通过**。
- [ ] **cli-task.ts**:`HubStarter` interface 加(与 ApiDeps.testWorker 同签名):
  ```ts
    testWorker?: (cfg: { kind: string; host?: string; dataRoot?: string; id?: string; apiUrl?: string }) => Promise<import("@drec/core").WorkerTestResult>;
  ```
  在构造 createWebServer 处透传:`testWorker: hubEnabled ? hubStarter?.testWorker : undefined`(hub 未启用不注入 → 端点回落 400)。
- [ ] **cli.ts**:给 `hubStarter` 对象加 `testWorker` 方法(与 `start` 平级):
  ```ts
    async testWorker(cfg) {
      const { getTransport, registerBuiltinTransports } = await import("@drec/orchestrator");
      const { ffprobeVideo } = await import("@drec/post-process");
      const { statSync } = await import("node:fs");
      // testWorker 可能在 hub.start 之前被调 → 幂等注册一份 transport(registry.set 覆盖,无副作用)。
      const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
        const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
        const endMs = statSync(file).mtimeMs;
        return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
      };
      registerBuiltinTransports({ ffprobe });
      const withTimeout = <T,>(pms: Promise<T>, ms: number): Promise<T> =>
        Promise.race([pms, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`连接测试超时 ${ms}ms`)), ms))]);
      try {
        const t = getTransport({ id: cfg.id ?? "test", kind: cfg.kind, host: cfg.host, dataRoot: cfg.dataRoot });
        const inv = await withTimeout(t.listInventory(), 20_000);
        // listInventory 解析成功 = 可达 + dataRoot/recordings 可扫 + inventory JSON 可解析。
        return { ok: true, reachable: true, dataRootExists: true, recordingCount: inv.recordings.length };
      } catch (e) {
        return { ok: false, reachable: false, dataRootExists: false, error: (e as Error).message };
      }
    },
  ```
  > 语义务实:`listInventory` 解析成功即判 reachable+dataRootExists 皆真、给出 recordingCount;失败则 reachable=false + error。区分 dataRoot 存在 vs 空目录不做(ssh `_inventory` 缺目录返空 recordings 而非报错;精细区分需扩 Transport API,超本期范围)。
- [ ] **web/api/client.ts**:加 `testWorker: (cfg: Partial<WorkerDTO>): Promise<WorkerTestResult> => request("POST", "/api/hub/workers/test", cfg),`;import/re-export `WorkerTestResult`。
- [ ] **验证**:`rtk proxy pnpm typecheck` + `rtk proxy pnpm test` + `rtk proxy pnpm bundle` + `cd packages/web && rtk proxy pnpm build`。
- [ ] **commit**:`feat(hub): worker 连接测试(CLI 注入 testWorker,ssh 可达+inventory 校验)`

---

## Task 4: Web UI Workers 卡 + 弹窗

Hub 页顶部(规则列表之上)加 Workers 卡:每行 name / kind / host / 状态点 + 每行 测试/编辑/删除;Add/Edit 弹窗(name、kind 下拉、host、dataRoot)带存前测试。`id` 不展示。沿用 3s 轮询。**web 无 vitest → 验证 = `cd packages/web && pnpm build` 绿 + 手测清单。**

### Files
- **Create:** `packages/web/src/modals/WorkerDialog.tsx`
- **Create:** `packages/web/src/components/WorkersCard.tsx`
- **Modify:** `packages/web/src/pages/HubPage.tsx`(挂 WorkersCard;winnerWorker id→name 展示)
- **Modify:** `packages/web/src/components/HubJobs.tsx`(RunCard「选优」按 id 查 name,查不到回落 id)

### Interfaces
- **Consumes:** `api.listWorkers / createWorker / updateWorker / deleteWorker / testWorker`(Task 2/3 已加),`WorkerDTO` / `WorkerTestResult`。
- **Produces:** `<WorkersCard />`(自轮询 + 增删改测),`<WorkerDialog open rule={WorkerDTO|null} onClose onSaved />`。

### Steps

- [ ] **写 WorkerDialog.tsx**(仿 HubRuleDialog.tsx 结构:Dialog + FormState + Switch/input):
  - FormState:`{ name: string; kind: string; host: string; dataRoot: string }`。
  - `isEdit = worker !== null`。edit 模式 `id` 只读展示(小字);create 不显示 id。
  - kind 用原生 `<select>`(选项 `local`/`ssh`/`tailscale-ssh`);**edit 且 id==="local" 时 kind 禁用**(disabled,提示"master 自身不可改类型")。
  - host 仅 kind∈{ssh,tailscale-ssh} 时显示 + required;local 隐藏。dataRoot 始终 required。
  - **存前测试**按钮:调 `api.testWorker({ kind, host, dataRoot })`,把 `WorkerTestResult` 存 local state,渲染成一行(绿✓ reachable + recordingCount / 红✗ error)。测试期间 disable。
  - submit:create → `api.createWorker(payload)`;edit → `api.updateWorker(worker.id, payload)`。成功 `toast` + `onClose` + `onSaved`。错误 `toast(errMessage(e))`。
  - 骨架:
    ```tsx
    import { useEffect, useState, type FormEvent, type ReactNode } from "react";
    import { api, type WorkerDTO, type WorkerTestResult } from "../api/client";
    import { Button } from "../components/Button";
    import { Dialog } from "../components/Dialog";
    import { errMessage, useToast } from "../lib/hooks";

    interface Props { open: boolean; onClose: () => void; worker: WorkerDTO | null; onSaved: () => void; }
    interface FormState { name: string; kind: string; host: string; dataRoot: string; }
    const BLANK: FormState = { name: "", kind: "ssh", host: "", dataRoot: "" };
    const KINDS = ["local", "ssh", "tailscale-ssh"] as const;

    export function WorkerDialog({ open, onClose, worker, onSaved }: Props): ReactNode {
      const isEdit = worker !== null;
      const isLocal = worker?.id === "local";
      const toast = useToast();
      const [form, setForm] = useState<FormState>(BLANK);
      const [busy, setBusy] = useState(false);
      const [testing, setTesting] = useState(false);
      const [test, setTest] = useState<WorkerTestResult | null>(null);
      useEffect(() => {
        if (open) { setForm(worker ? { name: worker.name ?? "", kind: worker.kind, host: worker.host ?? "", dataRoot: worker.dataRoot ?? "" } : BLANK); setTest(null); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, worker?.id]);
      const set = <K extends keyof FormState>(k: K, v: FormState[K]): void => setForm((f) => ({ ...f, [k]: v }));
      const needsHost = form.kind === "ssh" || form.kind === "tailscale-ssh";
      const payload = (): Partial<WorkerDTO> => ({ name: form.name.trim() || undefined, kind: form.kind, host: needsHost ? form.host.trim() : undefined, dataRoot: form.dataRoot.trim() });
      async function runTest(): Promise<void> {
        setTesting(true);
        try { setTest(await api.testWorker(payload())); } catch (e) { setTest({ ok: false, reachable: false, dataRootExists: false, error: errMessage(e) }); } finally { setTesting(false); }
      }
      async function submit(ev: FormEvent): Promise<void> {
        ev.preventDefault(); setBusy(true);
        try {
          if (isEdit) await api.updateWorker(worker.id, payload()); else await api.createWorker(payload());
          onClose(); toast(isEdit ? "Worker 已更新" : "Worker 已创建", "success"); onSaved();
        } catch (e) { toast(errMessage(e), "error"); } finally { setBusy(false); }
      }
      return (
        <Dialog open={open} onClose={onClose} widthClass="max-w-lg" title={isEdit ? "编辑 Worker" : "新建 Worker"} description="录制节点(选优合并的数据来源)">
          <form className="grid grid-cols-1 gap-4" onSubmit={submit}>
            <div><label className="field-label">名称 / name</label>
              <input className="input" placeholder="友好名(留空则用 host)" value={form.name} onChange={(e) => set("name", e.target.value)} /></div>
            <div><label className="field-label">类型 / kind</label>
              <select className="input" value={form.kind} disabled={isLocal} onChange={(e) => set("kind", e.target.value)}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              {isLocal && <div className="text-xs text-muted mt-1">master 自身,类型不可改</div>}</div>
            {needsHost && <div><label className="field-label">host<span style={{ color: "var(--error)" }}>*</span></label>
              <input required className="input" placeholder="100.x.y.z 或 host.ts.net" value={form.host} onChange={(e) => set("host", e.target.value)} /></div>}
            <div><label className="field-label">dataRoot<span style={{ color: "var(--error)" }}>*</span></label>
              <input required className="input" placeholder="/home/ubuntu/drec 或 /data" value={form.dataRoot} onChange={(e) => set("dataRoot", e.target.value)} /></div>
            {test && <div className="text-sm rounded-lg border border-hairline px-3 py-2" style={{ color: test.ok ? "var(--success)" : "var(--error)" }}>
              {test.ok ? `连接成功 · 可见 ${test.recordingCount ?? 0} 场录制` : `连接失败:${test.error ?? "未知错误"}`}</div>}
            <div className="flex justify-between gap-3 mt-2">
              <Button type="button" variant="secondary" onClick={() => void runTest()} disabled={testing} loading={testing}>测试连接</Button>
              <div className="flex gap-3">
                <Button type="button" variant="secondary" onClick={onClose}>取消</Button>
                <Button type="submit" disabled={busy} loading={busy}>{isEdit ? "保存" : "创建"}</Button>
              </div>
            </div>
          </form>
        </Dialog>
      );
    }
    ```
- [ ] **写 WorkersCard.tsx**(自轮询 3s;表格行 name / kind / host / 状态点 + 每行 测试/编辑/删除;顶部 Add):
  - 状态点:组件持 `Record<id, WorkerTestResult>`,点某行「测试」→ 调 `api.testWorker` 写回该 id;dot 颜色按最近测试结果(未测=灰 `--muted-soft`,ok=`--success`,fail=`--error`)。
  - 删除走 `ConfirmDialog`(仿 HubPage);id==="local" 行**隐藏删除按钮**(后端也拦,双保险)。
  - 用现有 `Button`/`IconButton`/`Switch`/`ConfirmDialog`/`useToast`/`usePolling`/`errMessage`。
  - 暴露 `onWorkersChanged?()` 回调 → 让 HubPage 刷新 winner id→name 映射(可选;或 WorkersCard 内部管理即可,HubPage 单独也 listWorkers)。
  - 骨架(要点):
    ```tsx
    import { Plus, Pencil, Trash2, Wifi } from "lucide-react";
    import { useState } from "react";
    import { api, type WorkerDTO, type WorkerTestResult } from "../api/client";
    import { Button, IconButton } from "./Button";
    import { ConfirmDialog } from "./ConfirmDialog";
    import { errMessage, useToast, usePolling } from "../lib/hooks";
    import { WorkerDialog } from "../modals/WorkerDialog";

    export function WorkersCard(): ReactNode {
      const toast = useToast();
      const [workers, setWorkers] = useState<WorkerDTO[]>([]);
      const [tests, setTests] = useState<Record<string, WorkerTestResult>>({});
      const [dialogOpen, setDialogOpen] = useState(false);
      const [editing, setEditing] = useState<WorkerDTO | null>(null);
      const [pendingDelete, setPendingDelete] = useState<string | null>(null);
      const refresh = async (): Promise<void> => { try { setWorkers(await api.listWorkers()); } catch { /* 轮询重试 */ } };
      usePolling(() => void refresh(), 3000);
      const runTest = async (w: WorkerDTO): Promise<void> => {
        try { setTests((t) => ({ ...t, [w.id]: await api.testWorker(w) })); }
        catch (e) { setTests((t) => ({ ...t, [w.id]: { ok: false, reachable: false, dataRootExists: false, error: errMessage(e) } })); }
      };
      const doDelete = async (id: string): Promise<void> => {
        try { await api.deleteWorker(id); toast("Worker 已删除", "info"); await refresh(); }
        catch (e) { toast(errMessage(e), "error"); }
      };
      const dot = (w: WorkerDTO): string => { const r = tests[w.id]; return !r ? "var(--muted-soft)" : r.ok ? "var(--success)" : "var(--error)"; };
      // …卡片 <section className="card">…<table className="tasks"> 表头 名称/类型/host/状态/操作;
      //   行:name(粗)+ kind(mono 小字);host;dot;操作按钮组(测试 Wifi / 编辑 Pencil / 删除 Trash2,local 隐藏删除)。
      //   顶部标题「Workers / 录制节点」+ Add 按钮 openCreate。
      //   <WorkerDialog open… worker={editing} onSaved={() => void refresh()} /> + <ConfirmDialog …/>
    }
    ```
- [ ] **改 HubPage.tsx**:① import `WorkersCard`。② 在 `<section className="card overflow-hidden">`(规则表)**之上**插 `<WorkersCard />`。③ winner id→name 映射:HubPage 已轮询;加 `const [workers, setWorkers] = useState<WorkerDTO[]>([])`,`refresh` 里 `setWorkers(await api.listWorkers().catch(() => []))`;把 workers 传给 RunCard/LatestRunBadge 需要之处。**更简单**:直接在 HubJobs.tsx 内做映射(下条)。
- [ ] **改 HubJobs.tsx**:让 RunCard 的「选优」按 id 查 name。给 `RunCard`/`LatestRunBadge` 加可选 prop `workerName?: (id: string) => string`(HubPage 传 `(id) => workers.find((w) => w.id === id)?.name ?? id`)。RunCard 第 205 行:
  ```tsx
  {job.winnerWorker && <span>选优: {workerName ? workerName(job.winnerWorker) : job.winnerWorker}</span>}
  ```
  若不想穿参,退而求其次:仅展示 `job.winnerWorker`(id)——但 spec 要求 name。采用穿参方案:HubPage 已有 workers,给 `<RunCard workerName={…}>` 与 `<LatestRunBadge>`(若显示 winner)传入。查不到回落 id。
- [ ] **验证**:
  ```bash
  cd packages/web && rtk proxy pnpm build   # 必须绿(TS + Vite)
  ```
  **手测清单**(启 master:`node dist/douyin-rec.mjs task serve --port 7860 --hub`,`data-local/config/hub.config.json` 有 workers):
  1. Hub 页顶部出现 Workers 卡,列出 `local` 等,id 不展示,显示 name/kind/host。
  2. Add → 填 ssh/host/dataRoot → 「测试连接」显示成功/失败 → 创建后列表出现 `worker-1`。
  3. 编辑 local:kind 下拉禁用;改 name/dataRoot 可存;删除按钮对 local 不出现。
  4. 删除远端 worker → 消失;手改 hub.config.json 的 name → 3s 内 UI 同步(现读不缓存)。
  5. 每行「测试」→ 状态点变绿/红。
  6. child node(`task serve` 无 `--hub`)Hub 页仍是「这是 child node」提示(worker 端点 400,卡不显示——WorkersCard 只在 hubEnabled 分支渲染,确认 HubPage 的 `hubEnabled === false` early-return 在 WorkersCard 之前)。
- [ ] **commit**:`feat(web): Hub 页 Workers 卡 + 增删改 + 存前连接测试`

---

## 自检(实现者收尾)

- [ ] **每个 spec 章节都映射到任务**:数据模型/改名表→Task 1;file-as-truth+实时重载+worker-store+REST→Task 2;连接测试→Task 3;Web UI→Task 4。错误处理&安全(校验/local 保护/删除优雅失败/超时/原子写)分散在 Task 2/3。
- [ ] **无占位符**:无 "TBD"/"类似 Task N"/"加错误处理"——所有代码为可直接落地的真实代码。
- [ ] **类型一致**:`WorkerConfig`(orchestrator + app,字段 `{ id; name?; kind; host?; dataRoot?; apiUrl? }` 一致)、`WorkerDTO`/`WorkerTestResult`(core,三端共用)在全部任务中字段完全一致。
- [ ] **全绿**:`rtk proxy pnpm typecheck && rtk proxy pnpm test && rtk proxy pnpm bundle && (cd packages/web && rtk proxy pnpm build)`。
- [ ] **分层**:`rtk proxy pnpm test -- layering` 绿(app 未 import orchestrator)。
