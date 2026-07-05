# Hub 规则按 Worker 选择执行 Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个 hub 规则选择哪些 worker 参与,pipeline 只对选中的 worker 执行(读侧硬过滤)。

**Architecture:** 规则加 workers?: string[];reconciler 在 resolveCfg 后按 workerId∈rule.workers 过滤 broadcast members(settleAll 同过滤);缺省/空=全部(向后兼容)。UI 在 HubRuleDialog 加 worker 多选(拉 listWorkers)。

**Tech Stack:** Node 24 ESM, node:sqlite, vitest, React19+jotai+@base-ui/react (web/ 独立 Vite), react-i18next.

## Global Constraints

- **硬过滤语义**:规则 `workers` 显式非空(≥1 个 id)→ 只对 `workerId ∈ workers` 的录像做聚类/拉取/选优/上传,非选中 worker 的那份录像被完全忽略(不拉取、不选优、不上传)。
- **`workers` 缺省或空数组 = 全部 worker**(向后兼容)。硬过滤**只在 `workers` 显式非空时生效**;767 这类老规则没有 `workers` 字段必须继续跑(全选),绝不因升级停摆。
- **选中的 worker 都没录到该场 → 不建 job(跳过)**,与今天"没人录到"一致。
- 选中的 id 指向已删除的 worker → 该 id 自然不在 inventory/members 里 → 被忽略,无需特判(集合交集)。
- **过滤同时作用于 `settleAll`**:只等选中 worker 收播,不被"没选中但仍在录"的节点拖住 settle。
- **单一插入点**:reconciler `reconcileAll` 聚类之后、settle/select 之前。不改 `clusterBroadcasts`、`selectWinner`、pipeline 内部逻辑。
- **UI 新建规则必须选 ≥1**(保存按钮禁用 + 后端 400 兜底);**编辑无 `workers` 的老规则时 UI 预勾全部当前 worker**;编辑已有显式列表时回显已选。
- **分层**:`app`(L4) **不 import** `orchestrator`(L4.5);orchestrator 只吃 `core` 接口 + CLI(L5)注入。reconciler 通过 `resolveCfg` 返回的 `PipelineCfg` 拿到 `workers`(CLI 在 `resolveCfg` 里从 `HubRule.workers` 塞进去)。
- **提交规范**:`<type>(<scope>): 中文描述`,正文 bullet 展开;**不加** `Co-Authored-By` / `Claude-Session` 等 AI 署名 trailer;只 `git add` 本次相关文件。
- **ESM**:所有相对 import 带 `.js` 后缀(TS 源码里写 `.js`)。
- **命令**:测试/类型检查/打包一律经 rtk 代理:`rtk proxy pnpm test -- <pattern>`、`rtk proxy pnpm typecheck`、`rtk proxy pnpm bundle`;前端 `cd packages/web && rtk proxy pnpm build`。web 无 vitest,只能 build + typecheck + 手动核对。

---

## Task 1 — 后端:规则 `workers?: string[]` 端到端 + reconciler 硬过滤

先落地并全绿。纯类型 + 文件 CRUD + reconciler 过滤 + api 校验,无 UI。

### Files

**Modify:**
- `packages/core/src/api-types.ts` — `HubRuleDTO` 加 `workers?: string[]`;`HubRulePayload` 加 `workers?: string[]`。
- `packages/orchestrator/src/pipeline.ts` — `PipelineCfg` 加 `workers?: string[]`(reconciler 据此过滤;pipeline 本身不用)。
- `packages/app/src/hub-store.ts` — `HubRule` / `HubFile` 加 `workers?: string[]`;`fileToRule` / `upsertHubRule` / `updateHubRule` 读写保留。
- `packages/app/src/web/api.ts` — `hubRuleView` 透出 `workers`;`createHubRule` / `updateHubRule` 校验 `workers`(present 则必须非空 `string[]`,否则 400)并传进 hub-store。
- `packages/cli/src/cli.ts` — `resolveCfg` 把 `rule.workers` 塞进返回的 `PipelineCfg`。
- `packages/orchestrator/src/reconciler.ts` — `reconcileAll` 聚类后按 `cfg.workers` 过滤 `broadcast.members`;`settleAll` 因此只等选中 worker。

**Modify (tests):**
- `packages/orchestrator/src/reconciler.test.ts` — 新增 4 个过滤场景。
- `packages/app/src/hub-store.test.ts` — 新增 `workers` 往返 + 保留其余字段。
- `test/app/web-api.test.ts` — 新增 hub 规则 `workers` 校验(空→400、非空→201 回显、update 生效)。

### Interfaces

**Produces:**
```ts
// packages/core/src/api-types.ts
export interface HubRuleDTO {
  key: string; roomSlug: string; room: string; platform: string;
  enabled: boolean; pipeline: HubPipelineConfig;
  /** 选中参与该房间 hub 处理的 worker id 列表;缺省/空 = 全部(向后兼容)。 */
  workers?: string[];
  anchorName?: string | null;
}
export interface HubRulePayload {
  room?: string; enabled?: boolean; pipeline?: HubPipelineConfig;
  /** 选中的 worker id;present 时后端校验为非空 string[]。缺省 = 全部。 */
  workers?: string[];
}

// packages/orchestrator/src/pipeline.ts
export interface PipelineCfg {
  cleanMaxGapSec: number; stageDir: string; cookies: string;
  uploadMode: "stage" | "upload"; uploadPrivate?: boolean;
  uploadMeta: { tag: string; tid: number; desc?: string };
  steps?: PipelineSteps; cleanup?: PipelineCleanup;
  /** reconciler 硬过滤用:非空 → 只处理这些 worker 的录像;缺省/空 = 全部。pipeline 本身不读。 */
  workers?: string[];
}

// packages/app/src/hub-store.ts
export interface HubRule {
  key: string; roomSlug: string; platform: string; room: string;
  enabled: boolean; pipeline: HubPipelineConfig; workers?: string[];
}
export function upsertHubRule(dir: string, input: {
  room: string; enabled?: boolean; pipeline?: HubPipelineConfig; workers?: string[];
}): HubRule;
export function updateHubRule(dir: string, key: string, patch: {
  enabled?: boolean; pipeline?: HubPipelineConfig; workers?: string[];
}): HubRule | null;
```

**Consumes:** `clusterBroadcasts(...)` → `Broadcast[]`(`Broadcast.members: BroadcastMember[]`,`BroadcastMember.workerId: string`);`resolveCfg(platform, roomSlug) => PipelineCfg | null`。

---

### Step 1.1 — `PipelineCfg` 加 `workers?`(类型先行,零行为)

- [ ] **Edit** `packages/orchestrator/src/pipeline.ts`,在 `PipelineCfg` 尾部加字段。找到:
  ```ts
    uploadMeta: { tag: string; tid: number; desc?: string };
    steps?: PipelineSteps;
    cleanup?: PipelineCleanup;
  }
  ```
  改为:
  ```ts
    uploadMeta: { tag: string; tid: number; desc?: string };
    steps?: PipelineSteps;
    cleanup?: PipelineCleanup;
    /** reconciler 硬过滤用:非空 → 只处理这些 worker 的录像;缺省/空 = 全部(向后兼容)。pipeline 本身不读。 */
    workers?: string[];
  }
  ```
- [ ] 运行 `rtk proxy pnpm typecheck` → 应仍绿(纯 optional 字段,无消费方)。
- [ ] Commit:`feat(orchestrator): PipelineCfg 加 workers 字段(为 reconciler 按 worker 硬过滤铺垫)`

---

### Step 1.2 — reconciler 按 `cfg.workers` 过滤(TDD)

- [ ] **Edit** `packages/orchestrator/src/reconciler.test.ts`,在 `describe("Reconciler", ...)` 末尾(最后一个 `it` 之后、`});` 之前)追加 4 个测试。这些 helper(`freshLedger`/`makeRec`/`makeTransport`/`makePipelineDeps`/`fastSettle`/`fastSleep`)文件里已有,直接复用:

  ```ts
  it("场景I(worker 硬过滤): workers=[local] → 即使 vps2 也录了该场,vps2 被过滤,winner 只能 local", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("local", [makeRec()]);
    const t2 = makeTransport("vps2", [makeRec()]);      // vps2 也录了同一场
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        workers: ["local"],   // 只选 local
      }),
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    const members = spyRunPipeline.mock.calls[0][0].members;
    expect(members).toHaveLength(1);
    expect(members[0].workerId).toBe("local");   // vps2 被硬过滤
    ledger.close();
  });

  it("场景J(向后兼容): resolveCfg 返回的 cfg 无 workers → 全部 members 参与", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("local", [makeRec()]);
    const t2 = makeTransport("vps2", [makeRec()]);
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        // 无 workers → 不过滤
      }),
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0][0].members).toHaveLength(2);
    ledger.close();
  });

  it("场景K(选中的没人录): workers=[local] 但只有 vps2 录到 → 不建 job/不跑 pipeline", async () => {
    const ledger = freshLedger();
    const t2 = makeTransport("vps2", [makeRec()]);   // 只有 vps2 录了
    // local transport 存在但本场没录像(inventory 空)
    const t1 = makeTransport("local", []);
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        workers: ["local"],
      }),
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(0);
    expect(ledger.listActive()).toHaveLength(0);   // 没建任何 job
    ledger.close();
  });

  it("场景L(settle 只等选中): 未选中的 vps2 仍在录(isDone=false)不阻塞;local 已收播 → pipeline 跑", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("local", [makeRec()]);   // isDone 默认 true
    const t2: Transport = {
      id: "vps2",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockResolvedValue({ workerId: "vps2", recordings: [makeRec()] }),
      isDone: vi.fn<(s: string) => Promise<boolean>>().mockResolvedValue(false),   // 仍在录
      pull: vi.fn<(p: string[], d: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: { maxWaitMs: 50, pollMs: 1 }, sleep: fastSleep,
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        workers: ["local"],
      }),
    });
    await reconciler.reconcileAll();
    // vps2 被过滤 → settle 不查它;local 已收播 → pipeline 跑一次(只含 local)。
    expect(t2.isDone).not.toHaveBeenCalled();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0][0].members).toHaveLength(1);
    ledger.close();
  });
  ```
- [ ] 运行 `rtk proxy pnpm test -- reconciler` → 4 个新测试 **fail**(过滤未实现:场景I 会拿到 2 个 members / 场景K 会建 job / 场景L 会调 vps2.isDone)。确认失败信息是这些断言。
- [ ] **Edit** `packages/orchestrator/src/reconciler.ts` 的 `reconcileAll`,替换现有函数体。当前:
  ```ts
    async reconcileAll(): Promise<void> {
      if (this.loadTransports) this.transports = this.loadTransports();
      const transports = this.transports;

      const invs = await Promise.all(
        [...transports.values()].map((t) => this.inventoryWithTimeout(t)),
      );

      const broadcasts = clusterBroadcasts(
        invs.map((i) => ({ workerId: i.workerId, recordings: i.recordings })),
        undefined,
        this.platform,
      );

      const stillRecording = await this.settleAll(broadcasts);

      for (const b of broadcasts) {
        try {
          if (b.members.some((m) => stillRecording.has(`${m.workerId}:${m.rec.roomSlug}`))) continue;

          let cfg = this.pipelineDeps.cfg;
          if (this.resolveCfg) {
            const resolved = this.resolveCfg(b.platform, b.roomSlug);
            if (!resolved) continue;
            cfg = resolved;
          }

          const job = this.ledger.get(b.streamKey);
          if (job?.state === "done" || job?.state === "needs_manual") continue;
          if (job?.state === "failed" && (job.fails ?? 0) >= this.maxRetries) continue;
          const { isNew } = this.ledger.upsertPending(b.streamKey);
          if (!isNew && job && !RETRYABLE.has(job.state)) continue;
          await this._runPipeline(b, { ...this.pipelineDeps, transports, cfg });
        } catch (err) {
          console.error(`[reconciler] broadcast ${b.streamKey} failed:`, err);
          this.ledger.markFailed(b.streamKey, String((err as Error)?.message ?? err).slice(0, 300));
        }
      }
    }
  ```
  改为(把 resolveCfg + worker 过滤上提到 settle 之前;缓存 cfg 供循环复用):
  ```ts
    async reconcileAll(): Promise<void> {
      // 实时重载:重建 transports(反映 hub.config.json 最新 workers);同步给 pipeline 用的那份。
      if (this.loadTransports) this.transports = this.loadTransports();
      const transports = this.transports;

      // 1. Concurrently fetch all inventories; 挂起/出错的租户经 inventoryWithTimeout 降级为空,不锁死整轮。
      const invs = await Promise.all(
        [...transports.values()].map((t) => this.inventoryWithTimeout(t)),
      );

      // 2. Cluster recordings across nodes into broadcasts —— 按每条录像的 platform 聚类(多平台)。
      const broadcasts = clusterBroadcasts(
        invs.map((i) => ({ workerId: i.workerId, recordings: i.recordings })),
        undefined,
        this.platform,
      );

      // 2.5 按每场规则解析 cfg + **worker 硬过滤**(单一插入点:聚类后、settle 前)。
      //   - resolveCfg 返回 null(房间没开 hub)→ 清空 members → settle 不等它、循环跳过。
      //   - cfg.workers 显式非空 → 只留 workerId∈workers 的成员;缺省/空 = 全部(向后兼容)。
      const cfgByKey = new Map<string, PipelineCfg>();
      for (const b of broadcasts) {
        let cfg = this.pipelineDeps.cfg;
        if (this.resolveCfg) {
          const resolved = this.resolveCfg(b.platform, b.roomSlug); // 按本场 platform 取配置(多平台)
          if (!resolved) { b.members = []; continue; }              // 房间未开 hub → 本场不处理
          cfg = resolved;
        }
        if (cfg.workers && cfg.workers.length > 0) {
          b.members = b.members.filter((m) => cfg.workers!.includes(m.workerId));
        }
        cfgByKey.set(b.streamKey, cfg);   // 过滤后仍有/无成员都缓存;空成员在循环里跳过
      }

      // 3. Settle: 只等(过滤后)仍有成员的场收播;返回仍在录的成员 key 集。
      const stillRecording = await this.settleAll(broadcasts);

      // 4. For each broadcast: idempotent upsert + run pipeline if needed.
      for (const b of broadcasts) {
        try {
          // 过滤后无成员 → 房间没开 hub / 选中 worker 没人录到 → 跳过(不建 job)。
          if (b.members.length === 0) continue;
          // 仍有成员在录制 → 本轮跳过(不建 job、不合并残片),待其录完的后续轮再处理。
          if (b.members.some((m) => stillRecording.has(`${m.workerId}:${m.rec.roomSlug}`))) continue;

          const cfg = cfgByKey.get(b.streamKey) ?? this.pipelineDeps.cfg;

          const job = this.ledger.get(b.streamKey);
          // Skip terminal states.
          if (job?.state === "done" || job?.state === "needs_manual") continue;
          // failed 且已达重试上限 → 放弃自动重试(留 failed 供人工/诊断),不再重入。
          if (job?.state === "failed" && (job.fails ?? 0) >= this.maxRetries) continue;

          const { isNew } = this.ledger.upsertPending(b.streamKey);
          // Don't re-enter an in-progress job unless it was retryable.
          if (!isNew && job && !RETRYABLE.has(job.state)) continue;

          await this._runPipeline(b, { ...this.pipelineDeps, transports, cfg });
        } catch (err) {
          // Per-broadcast 出错:置 job=failed(可见 + 重试上限内自动重试),不中止其余 broadcast。
          console.error(`[reconciler] broadcast ${b.streamKey} failed:`, err);
          this.ledger.markFailed(b.streamKey, String((err as Error)?.message ?? err).slice(0, 300));
        }
      }
    }
  ```
  > 注:`PipelineCfg` 已在 reconciler.ts 顶部 `import type { PipelineDeps, PipelineCfg } from "./pipeline.js";` 导入,无需新增 import。
- [ ] 运行 `rtk proxy pnpm test -- reconciler` → 全绿(新 4 个 + 原有场景 A/B/E/F/G/H + settle + 实时重载全过;特别确认 **场景G**(resolveCfg=null)仍绿:members 清空 → 跳过)。
- [ ] Commit:`feat(orchestrator): reconciler 按规则 workers 硬过滤 broadcast 成员(settle 同过滤)`

---

### Step 1.3 — hub-store 读写保留 `workers`(TDD)

- [ ] **Edit** `packages/app/src/hub-store.test.ts`,在 `describe(...)` 内追加:
  ```ts
  it("workers 字段创建/更新往返 + 其余字段(room/enabled/pipeline)保留", () => {
    const pipeline = { steps: { burnDanmu: false }, upload: { mode: "stage" as const, tag: "t", tid: 21 } };
    const r = upsertHubRule(dir, { room: "https://live.douyin.com/123456", pipeline, workers: ["local", "vps2"] });
    expect(r.workers).toEqual(["local", "vps2"]);
    // 落盘往返
    expect(getHubRule(dir, "douyin.123456")!.workers).toEqual(["local", "vps2"]);
    // update 只改 workers,其余保留
    const u = updateHubRule(dir, "douyin.123456", { workers: ["local"] })!;
    expect(u.workers).toEqual(["local"]);
    expect(u.pipeline).toEqual(pipeline);   // pipeline 保留
    expect(u.enabled).toBe(true);           // enabled 保留
    // 缺省(老规则)= 无 workers 字段
    const bare = upsertHubRule(dir, { room: "https://live.douyin.com/999" });
    expect(bare.workers).toBeUndefined();
  });
  ```
- [ ] 运行 `rtk proxy pnpm test -- hub-store` → 新测试 **fail**(`workers` 未读写)。
- [ ] **Edit** `packages/app/src/hub-store.ts`:
  1. `HubRule` 接口加字段。找到:
     ```ts
       enabled: boolean;
       pipeline: HubPipelineConfig;
     }
     ```
     改为:
     ```ts
       enabled: boolean;
       pipeline: HubPipelineConfig;
       /** 选中参与该房间 hub 处理的 worker id;缺省/空 = 全部(向后兼容)。 */
       workers?: string[];
     }
     ```
  2. `HubFile` 接口加字段。找到:
     ```ts
     interface HubFile {
       room: string;
       enabled?: boolean;
       pipeline?: HubPipelineConfig;
     }
     ```
     改为:
     ```ts
     interface HubFile {
       room: string;
       enabled?: boolean;
       pipeline?: HubPipelineConfig;
       workers?: string[];
     }
     ```
  3. `fileToRule` 透出。找到 `return { ... pipeline: raw.pipeline ?? {}, };`,在 `pipeline` 后加一行:
     ```ts
         enabled: raw.enabled !== false,
         pipeline: raw.pipeline ?? {},
         // workers 缺省 = undefined(= 全部 worker,向后兼容)。只在文件显式含时透出。
         workers: raw.workers,
     ```
  4. `upsertHubRule` 签名 + 写入。找到:
     ```ts
     export function upsertHubRule(
       dir: string,
       input: { room: string; enabled?: boolean; pipeline?: HubPipelineConfig },
     ): HubRule {
       const { key } = deriveKey(input.room);
       const existing = readRule(dir, key);
       writeRule(dir, key, {
         room: normalizeRoom(input.room),
         enabled: input.enabled ?? existing?.enabled ?? true,
         pipeline: input.pipeline ?? existing?.pipeline ?? {},
       });
       return getHubRule(dir, key)!;
     }
     ```
     改为:
     ```ts
     export function upsertHubRule(
       dir: string,
       input: { room: string; enabled?: boolean; pipeline?: HubPipelineConfig; workers?: string[] },
     ): HubRule {
       const { key } = deriveKey(input.room);
       const existing = readRule(dir, key);
       writeRule(dir, key, {
         room: normalizeRoom(input.room),
         enabled: input.enabled ?? existing?.enabled ?? true,
         pipeline: input.pipeline ?? existing?.pipeline ?? {},
         // workers 缺省沿用已有(undefined = 全部);显式传才覆盖。
         workers: input.workers ?? existing?.workers,
       });
       return getHubRule(dir, key)!;
     }
     ```
  5. `updateHubRule` 签名 + 写入。找到:
     ```ts
     export function updateHubRule(
       dir: string,
       key: string,
       patch: { enabled?: boolean; pipeline?: HubPipelineConfig },
     ): HubRule | null {
       const existing = readRule(dir, key);
       if (!existing) return null;
       writeRule(dir, key, {
         room: existing.room,
         enabled: patch.enabled ?? existing.enabled,
         pipeline: patch.pipeline ?? existing.pipeline,
       });
       return getHubRule(dir, key);
     }
     ```
     改为:
     ```ts
     export function updateHubRule(
       dir: string,
       key: string,
       patch: { enabled?: boolean; pipeline?: HubPipelineConfig; workers?: string[] },
     ): HubRule | null {
       const existing = readRule(dir, key);
       if (!existing) return null;
       writeRule(dir, key, {
         room: existing.room,
         enabled: patch.enabled ?? existing.enabled,
         pipeline: patch.pipeline ?? existing.pipeline,
         // 部分更新:未传 workers 沿用已有;传了(UI 总传非空列表)才覆盖。
         workers: patch.workers ?? existing.workers,
       });
       return getHubRule(dir, key);
     }
     ```
- [ ] 运行 `rtk proxy pnpm test -- hub-store` → 全绿(新 + 原有 6 个)。
- [ ] Commit:`feat(app): hub-store 读写保留规则 workers 字段`

---

### Step 1.4 — `HubRuleDTO`/`HubRulePayload` + `hubRuleView` 透出(TDD 在 web-api)

- [ ] **Edit** `packages/core/src/api-types.ts`:
  1. `HubRuleDTO` 加字段。找到:
     ```ts
       /** 流水线配置(steps / upload / cleanup);upload 是 pipeline 的一个阶段。 */
       pipeline: HubPipelineConfig;
       /** 主播名(若有同 roomSlug 的录制任务/录像可关联显示);未知 null。 */
       anchorName?: string | null;
     ```
     在 `pipeline` 后插入:
     ```ts
       /** 流水线配置(steps / upload / cleanup);upload 是 pipeline 的一个阶段。 */
       pipeline: HubPipelineConfig;
       /** 选中参与该房间 hub 处理的 worker id;缺省/空 = 全部 worker(向后兼容)。 */
       workers?: string[];
       /** 主播名(若有同 roomSlug 的录制任务/录像可关联显示);未知 null。 */
       anchorName?: string | null;
     ```
  2. `HubRulePayload` 加字段。找到:
     ```ts
     export interface HubRulePayload {
       /** 房间地址或房间号(归一化解析出 roomSlug);create 必填。 */
       room?: string;
       enabled?: boolean;
       pipeline?: HubPipelineConfig;
     }
     ```
     改为:
     ```ts
     export interface HubRulePayload {
       /** 房间地址或房间号(归一化解析出 roomSlug);create 必填。 */
       room?: string;
       enabled?: boolean;
       pipeline?: HubPipelineConfig;
       /** 选中的 worker id;present 时后端校验必须为非空 string[]。缺省 = 全部 worker。 */
       workers?: string[];
     }
     ```
- [ ] **Edit** `test/app/web-api.test.ts`,在文件末尾(最后一个 `describe` 的 `});` 之后)追加一个新 describe。它注入 `hubDir`(指向临时目录),`hubEnabled` 无关(规则端点不看 hubEnabled):
  ```ts
  describe("hub rules workers 字段(校验 + 往返)", () => {
    function apiWithHubDir(): ReturnType<typeof makeApi> {
      const hubDir = mkdtempSync(join(tmpdir(), "hubrules-"));
      return makeApi({ store, manager, hubDir });
    }
    it("createHubRule 带空 workers → 400", () => {
      const a = apiWithHubDir();
      const r = a.createHubRule({ room: "https://live.douyin.com/123456", workers: [] });
      expect(r.status).toBe(400);
    });
    it("createHubRule 带非空 workers → 201 且回显", () => {
      const a = apiWithHubDir();
      const r = a.createHubRule({ room: "https://live.douyin.com/123456", workers: ["local", "vps2"] });
      expect(r.status).toBe(201);
      expect((r.body as { workers?: string[] }).workers).toEqual(["local", "vps2"]);
    });
    it("createHubRule 不带 workers → 201(向后兼容,workers 缺省)", () => {
      const a = apiWithHubDir();
      const r = a.createHubRule({ room: "https://live.douyin.com/123456" });
      expect(r.status).toBe(201);
      expect((r.body as { workers?: string[] }).workers).toBeUndefined();
    });
    it("createHubRule workers 含非字符串 → 400", () => {
      const a = apiWithHubDir();
      const r = a.createHubRule({ room: "https://live.douyin.com/123456", workers: [1 as unknown as string] });
      expect(r.status).toBe(400);
    });
    it("updateHubRule 改 workers 生效", () => {
      const a = apiWithHubDir();
      a.createHubRule({ room: "https://live.douyin.com/123456", workers: ["local", "vps2"] });
      const u = a.updateHubRule("douyin.123456", { workers: ["local"] });
      expect(u.status).toBe(200);
      expect((u.body as { workers?: string[] }).workers).toEqual(["local"]);
    });
    it("updateHubRule 带空 workers → 400", () => {
      const a = apiWithHubDir();
      a.createHubRule({ room: "https://live.douyin.com/123456", workers: ["local"] });
      expect(a.updateHubRule("douyin.123456", { workers: [] }).status).toBe(400);
    });
  });
  ```
- [ ] 运行 `rtk proxy pnpm test -- web-api` → 新测试 **fail**(校验/透传未实现)。
- [ ] **Edit** `packages/app/src/web/api.ts`:
  1. `hubRuleView` 透出 `workers`。找到:
     ```ts
         return {
           key: r.key,
           roomSlug: r.roomSlug,
           room: r.room,
           platform: r.platform,
           enabled: r.enabled,
           pipeline: r.pipeline,
           anchorName,
         };
     ```
     在 `pipeline` 后加一行:
     ```ts
         return {
           key: r.key,
           roomSlug: r.roomSlug,
           room: r.room,
           platform: r.platform,
           enabled: r.enabled,
           pipeline: r.pipeline,
           workers: r.workers,
           anchorName,
         };
     ```
  2. 在 `makeApi` 内加一个校验 helper(放在 `hubRuleView` 定义之前,与其它局部 helper 并列)。找到 `const hubRuleView = (r: HubRule): HubRuleDTO => {` 之前插入:
     ```ts
     // workers 校验:present(payload 含该键)时必须是非空 string[](元素为 worker id 字符串);
     // 缺省(不含键)允许(= 全部 worker,兼容老规则)。返回错误消息(null=通过)。
     const validateWorkers = (input: HubRulePayload): string | null => {
       if (!("workers" in input) || input.workers === undefined) return null;
       const w = input.workers;
       if (!Array.isArray(w) || w.length === 0) return "workers 必须是非空 worker id 列表";
       if (!w.every((x) => typeof x === "string" && x.trim().length > 0)) return "workers 每项必须是非空字符串(worker id)";
       return null;
     };
     ```
  3. `createHubRule` 加校验 + 传 workers。找到:
     ```ts
         createHubRule(input: HubRulePayload): ApiResult {
           const room = (input.room ?? "").trim();
           if (!room) return err(400, "缺少房间地址 room");
           try {
             const rule = hubStore.upsertHubRule(hubDir, { room, enabled: input.enabled, pipeline: input.pipeline });
             return { status: 201, body: hubRuleView(rule) };
           } catch (e) {
             return err(400, `无法解析房间地址: ${(e as Error).message}`);
           }
         },
     ```
     改为:
     ```ts
         createHubRule(input: HubRulePayload): ApiResult {
           const room = (input.room ?? "").trim();
           if (!room) return err(400, "缺少房间地址 room");
           const werr = validateWorkers(input);
           if (werr) return err(400, werr);
           try {
             const rule = hubStore.upsertHubRule(hubDir, { room, enabled: input.enabled, pipeline: input.pipeline, workers: input.workers });
             return { status: 201, body: hubRuleView(rule) };
           } catch (e) {
             return err(400, `无法解析房间地址: ${(e as Error).message}`);
           }
         },
     ```
  4. `updateHubRule` 加校验 + patch workers。找到:
     ```ts
         updateHubRule(key: string, input: HubRulePayload): ApiResult {
           const patch: { enabled?: boolean; pipeline?: HubPipelineConfig } = {};
           if ("enabled" in input) patch.enabled = input.enabled;
           if ("pipeline" in input) patch.pipeline = input.pipeline;
           const updated = hubStore.updateHubRule(hubDir, key, patch);
           if (!updated) return err(404, `未找到 hub 规则 key=${key}`);
           return { status: 200, body: hubRuleView(updated) };
         },
     ```
     改为:
     ```ts
         updateHubRule(key: string, input: HubRulePayload): ApiResult {
           const werr = validateWorkers(input);
           if (werr) return err(400, werr);
           const patch: { enabled?: boolean; pipeline?: HubPipelineConfig; workers?: string[] } = {};
           if ("enabled" in input) patch.enabled = input.enabled;
           if ("pipeline" in input) patch.pipeline = input.pipeline;
           if ("workers" in input) patch.workers = input.workers;
           const updated = hubStore.updateHubRule(hubDir, key, patch);
           if (!updated) return err(404, `未找到 hub 规则 key=${key}`);
           return { status: 200, body: hubRuleView(updated) };
         },
     ```
- [ ] 运行 `rtk proxy pnpm test -- web-api` → 全绿。
- [ ] Commit:`feat(app): hub 规则 API 透出 workers + create/update 非空校验`

---

### Step 1.5 — CLI `resolveCfg` 把 `rule.workers` 塞进 `PipelineCfg`

- [ ] **Edit** `packages/cli/src/cli.ts`,`resolveCfg`(约 553–571 行)。找到:
  ```ts
        const p = rule.pipeline ?? {};
        return {
          cleanMaxGapSec: hubCfg.cleanMaxGapSec ?? 30,
          stageDir: hubCfg.stageDir ?? rootStageDir(),
          cookies: hubCfg.cookies ?? "",
          uploadMode: p.upload?.mode === "upload" ? "upload" : "stage", // 其它值(含旧 stage-only)→ stage
          uploadPrivate: p.upload?.private !== false,                    // 缺省 / true → 仅自己可见
          uploadMeta: {
            tag: p.upload?.tag || defaultTag,
            tid: p.upload?.tid ?? defaultTid,
            desc: p.upload?.desc ?? uploadDefaults.desc,
          },
          steps: p.steps,
          cleanup: p.cleanup,
        };
  ```
  在 `cleanup: p.cleanup,` 后加一行:
  ```ts
          steps: p.steps,
          cleanup: p.cleanup,
          // worker 硬过滤:reconciler 据此把 broadcast members 收窄到选中的 worker。
          // 缺省/空(老规则)→ reconciler 不过滤 = 全部 worker(向后兼容)。
          workers: rule.workers,
        };
  ```
  > `getHubRule` 已返回带 `workers` 的 `HubRule`(Step 1.3),此处直接透传。`PipelineCfg` 已有 `workers?`(Step 1.1),类型对齐。
- [ ] 运行 `rtk proxy pnpm typecheck` → 绿。
- [ ] 运行 `rtk proxy pnpm bundle` → 打包成功(确认 cli.ts 改动能进 `dist/douyin-rec.mjs`)。
- [ ] Commit:`feat(cli): hub resolveCfg 透传规则 workers 给 reconciler`

---

### Step 1.6 — Task 1 收尾:全量校验

- [ ] `rtk proxy pnpm test` → 全绿(重点:reconciler / hub-store / web-api 三处新测试 + 未回归)。
- [ ] `rtk proxy pnpm typecheck` → 0 error(含 layering:app 未新增对 orchestrator 的 import;reconciler 只吃 core 接口 + cli 注入)。
- [ ] `rtk proxy pnpm bundle` → 成功。
- [ ] 若前面各步已分别 commit,此步无新 commit;否则 `chore(hub): worker 选择后端收尾(测试/类型/打包全绿)`。

---

## Task 2 — UI:HubRuleDialog worker 多选

依赖 Task 1 的 DTO/Payload(`workers` 字段)。web 无 vitest → 靠 `build` + `typecheck` + 手动核对。

### Files

**Modify:**
- `packages/web/src/api/client.ts` — `WorkerDTO`/`HubRuleDTO`/`HubRulePayload` 已含 `workers`(经 `@drec/contracts` 共享,Task 1 已加);`api.listWorkers()` 已存在。**通常无需改**;仅当发现 `HubRulePayload` 未 re-export 时补(见 Step 2.1 核对)。
- `packages/web/src/modals/HubRuleDialog.tsx` — 加 worker 多选(checkbox);`FormState`/`BLANK`/`fromRule`/`submit` 扩展;新建未选 ≥1 时禁用保存;编辑无 workers 的老规则预勾全部当前 worker。
- `packages/web/src/lib/i18n.tsx` — `hub.ruleDialog` 组加 worker-select 文案(zh + en)。

### Interfaces

**Consumes:**
```ts
api.listWorkers(): Promise<WorkerDTO[]>   // WorkerDTO { id; name; kind; host?; dataRoot?; apiUrl? }
api.createHubRule(input: HubRulePayload): Promise<HubRuleDTO>   // HubRulePayload.workers?: string[]
api.updateHubRule(key: string, input: HubRulePayload): Promise<HubRuleDTO>
// HubRuleDTO.workers?: string[]
```

**Produces:** payload 里带 `workers: string[]`(始终非空 —— UI 保证 ≥1)。

---

### Step 2.1 — 核对 client.ts 已 re-export `workers` 相关类型

- [ ] 打开 `packages/web/src/api/client.ts`,确认 import 块含 `HubRuleDTO`、`HubRulePayload`、`WorkerDTO`,且 `export type { ... }` 一行含这三者(现状已含,见文件 11–32 行)。Task 1 给 `HubRuleDTO`/`HubRulePayload` 加了 `workers?`,前端经 `@drec/contracts` alias 自动拿到,**无需改 client.ts**。
- [ ] 确认 `api.listWorkers: (): Promise<WorkerDTO[]>` 存在(现状 123 行已有)。
- [ ] 无代码改动 → 无 commit(仅核对)。

---

### Step 2.2 — i18n 加 worker-select 文案(zh + en)

- [ ] **Edit** `packages/web/src/lib/i18n.tsx`,**zh** 的 `hub.ruleDialog`(约 168–185 行)。找到:
  ```ts
        descLabel: "B站简介 desc", descPlaceholder: "(可选,支持多行)",
        created: "Hub 规则已创建", updated: "Hub 规则已更新",
      },
  ```
  改为(在 `created` 前插入 worker-select 文案):
  ```ts
        descLabel: "B站简介 desc", descPlaceholder: "(可选,支持多行)",
        workersSection: "参与 Worker / workers",
        workersHint: "只对勾选的 worker 的录像做选优合并上传;不勾 = 忽略该 worker。至少选 1 个。",
        workersEmpty: "还没有配置 Worker,请先在 Workers 页添加。",
        workersLoadFailed: "加载 Worker 列表失败,请重试。",
        workersRequired: "请至少选择一个 Worker",
        created: "Hub 规则已创建", updated: "Hub 规则已更新",
      },
  ```
- [ ] **Edit** 同文件 **en** 的 `hub.ruleDialog`(约 316–333 行)。找到:
  ```ts
        descLabel: "Bilibili description", descPlaceholder: "(optional, multi-line)",
        created: "Hub rule created", updated: "Hub rule updated",
      },
  ```
  改为:
  ```ts
        descLabel: "Bilibili description", descPlaceholder: "(optional, multi-line)",
        workersSection: "Participating workers",
        workersHint: "Only selected workers' recordings are selected / merged / uploaded; unchecked = ignore that worker. Pick at least one.",
        workersEmpty: "No workers configured yet. Add one on the Workers page first.",
        workersLoadFailed: "Failed to load workers, please retry.",
        workersRequired: "Select at least one worker",
        created: "Hub rule created", updated: "Hub rule updated",
      },
  ```
- [ ] 运行 `cd packages/web && rtk proxy pnpm build` → 绿(仅确认无语法/类型错误;文案暂无消费方也不报错)。
- [ ] Commit:`feat(web): HubRuleDialog worker 多选 i18n 文案(zh/en)`

---

### Step 2.3 — HubRuleDialog 加 worker 多选

- [ ] **Edit** `packages/web/src/modals/HubRuleDialog.tsx`。

  1. import 加 `WorkerDTO`。找到:
     ```ts
     import { api, type HubRuleDTO, type HubRulePayload } from "../api/client";
     ```
     改为:
     ```ts
     import { api, type HubRuleDTO, type HubRulePayload, type WorkerDTO } from "../api/client";
     ```

  2. `FormState` 加 `workers: string[]`。找到:
     ```ts
     interface FormState {
       room: string;
       enabled: boolean;
       burnDanmu: boolean;
     ```
     改为:
     ```ts
     interface FormState {
       room: string;
       enabled: boolean;
       /** 选中的 worker id 列表;新建默认空(需用户选 ≥1);编辑无 workers 的老规则预勾全部当前 worker。 */
       workers: string[];
       burnDanmu: boolean;
     ```

  3. `BLANK` 加 `workers: []`。找到:
     ```ts
     const BLANK: FormState = {
       room: "",
       enabled: true,
       burnDanmu: true,
     ```
     改为:
     ```ts
     const BLANK: FormState = {
       room: "",
       enabled: true,
       workers: [],
       burnDanmu: true,
     ```

  4. `fromRule` 回显 `workers`(老规则无 workers → 先给空;由组件加载 worker 列表后预勾全部,见第 8 点)。找到:
     ```ts
     function fromRule(r: HubRuleDTO): FormState {
       const c = r.pipeline ?? {};
       return {
         room: r.room ?? "",
         enabled: r.enabled,
         burnDanmu: c.steps?.burnDanmu !== false,
     ```
     改为:
     ```ts
     function fromRule(r: HubRuleDTO): FormState {
       const c = r.pipeline ?? {};
       return {
         room: r.room ?? "",
         enabled: r.enabled,
         // 显式列表回显;无 workers(老规则)先给空,加载 worker 列表后在 effect 里预勾全部。
         workers: r.workers ?? [],
         burnDanmu: c.steps?.burnDanmu !== false,
     ```

  5. 组件内加 worker 列表 state + 加载。找到:
     ```ts
       const [form, setForm] = useState<FormState>(BLANK);
       const [busy, setBusy] = useState(false);

       useEffect(() => {
         if (open) setForm(rule ? fromRule(rule) : BLANK);
         // eslint-disable-next-line react-hooks/exhaustive-deps
       }, [open, rule?.key]);
     ```
     改为:
     ```ts
       const [form, setForm] = useState<FormState>(BLANK);
       const [busy, setBusy] = useState(false);
       const [workers, setWorkers] = useState<WorkerDTO[]>([]);
       const [workersError, setWorkersError] = useState(false);

       useEffect(() => {
         if (open) setForm(rule ? fromRule(rule) : BLANK);
         // eslint-disable-next-line react-hooks/exhaustive-deps
       }, [open, rule?.key]);

       // 打开时拉 worker 列表(name 显示 / id 存储)。失败给提示不崩。
       useEffect(() => {
         if (!open) return;
         let alive = true;
         setWorkersError(false);
         api.listWorkers()
           .then((ws) => {
             if (!alive) return;
             setWorkers(ws);
             // 编辑无 workers 的老规则(隐式 all)→ 预勾全部当前 worker,显性化让用户确认。
             if (rule && (rule.workers === undefined || rule.workers.length === 0)) {
               setForm((f) => ({ ...f, workers: ws.map((w) => w.id) }));
             }
           })
           .catch(() => { if (alive) setWorkersError(true); });
         return () => { alive = false; };
         // eslint-disable-next-line react-hooks/exhaustive-deps
       }, [open, rule?.key]);

       const toggleWorker = (id: string): void =>
         setForm((f) => ({
           ...f,
           workers: f.workers.includes(id) ? f.workers.filter((x) => x !== id) : [...f.workers, id],
         }));
       // 新建必须选 ≥1;编辑同理(编辑老规则已预勾全部,用户主动清空也要拦)。
       const workersInvalid = form.workers.length === 0;
     ```

  6. `submit` 带 `workers`(始终非空,前置由保存按钮 disable + 这里兜底)。找到:
     ```ts
       async function submit(ev: FormEvent): Promise<void> {
         ev.preventDefault();
         const payload: HubRulePayload = {
           enabled: form.enabled,
           pipeline: {
     ```
     改为:
     ```ts
       async function submit(ev: FormEvent): Promise<void> {
         ev.preventDefault();
         if (workersInvalid) { toast(t("hub.ruleDialog.workersRequired"), "error"); return; }
         const payload: HubRulePayload = {
           enabled: form.enabled,
           workers: form.workers,
           pipeline: {
     ```

  7. 在 JSX 里加 worker 多选 section。放在「流水线 pipeline」section 之前(即 `{/* ── Section: 流水线 pipeline ... ── */}` 那个 `<div className="sm:col-span-2">` 之前)插入:
     ```tsx
             {/* ── Section: 参与 Worker(多选;硬过滤,至少 1)── */}
             <div className="sm:col-span-2">
               <h3 className="text-sm font-semibold text-ink mb-2 pb-1 border-b border-hairline">{t("hub.ruleDialog.workersSection")}</h3>
               <p className="text-xs text-muted mb-2">{t("hub.ruleDialog.workersHint")}</p>
               {workersError ? (
                 <p className="text-xs" style={{ color: "var(--error)" }}>{t("hub.ruleDialog.workersLoadFailed")}</p>
               ) : workers.length === 0 ? (
                 <p className="text-xs text-muted">{t("hub.ruleDialog.workersEmpty")}</p>
               ) : (
                 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                   {workers.map((w) => (
                     <label key={w.id} className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-4 py-3 cursor-pointer">
                       <span className="flex flex-col">
                         <span className="text-sm font-medium text-ink">{w.name}</span>
                         <span className="text-xs text-muted mt-0.5 font-mono">{w.kind}{w.host ? ` · ${w.host}` : ""}</span>
                       </span>
                       <Switch checked={form.workers.includes(w.id)} onCheckedChange={() => toggleWorker(w.id)} name={`worker-${w.id}`} />
                     </label>
                   ))}
                 </div>
               )}
               {workersInvalid && !workersError && workers.length > 0 && (
                 <p className="text-xs mt-2" style={{ color: "var(--error)" }}>{t("hub.ruleDialog.workersRequired")}</p>
               )}
             </div>
     ```
     > 复用文件已 import 的 `Switch`(勾选框语义;与 pipeline toggles 视觉一致)。`WorkerDTO.name` 后端 `workerToDto` 保证非空(`w.name ?? w.id`)。

  8. 保存按钮:新建/编辑都在 `workersInvalid`(或 busy)时禁用。找到:
     ```tsx
             <Button type="submit" disabled={busy} loading={busy}>
               {isEdit ? t("hub.common.save") : t("hub.common.create")}
             </Button>
     ```
     改为:
     ```tsx
             <Button type="submit" disabled={busy || workersInvalid} loading={busy}>
               {isEdit ? t("hub.common.save") : t("hub.common.create")}
             </Button>
     ```

- [ ] 运行 `cd packages/web && rtk proxy pnpm build` → 绿(无 TS / 未用变量错误)。
- [ ] 运行(仓库根)`rtk proxy pnpm typecheck` → 0 error。
- [ ] Commit:`feat(web): HubRuleDialog 加 worker 多选(新建必选 ≥1、编辑老规则预勾全部)`

---

### Step 2.4 — 手动核对清单(web 无 vitest)

启动 master:`node dist/douyin-rec.mjs task serve --port 7860 --hub`(需 `<root>/config/hub.config.json` 至少含 local + 1 个 ssh worker),浏览器开 `http://localhost:7860` → Hub 页 → 新建/编辑规则。逐项核对:

- [ ] **新建**:打开弹窗,worker 区列出所有已配 worker(显示 name + kind/host);默认全不勾;保存按钮**禁用**;底部显示"请至少选择一个 Worker"。
- [ ] 勾选 ≥1 后保存按钮启用;保存成功 → 落盘 `<root>/config/hub/{platform}.{roomSlug}.json` 含 `"workers": [...]`(非空)。
- [ ] **编辑无 workers 的老规则**(手造一个不含 `workers` 键的 json):打开弹窗 → worker 区**预勾全部当前 worker**;保存 → 文件写成显式全列表。
- [ ] **编辑已有显式列表**:回显之前所选(非全选也正确回显)。
- [ ] worker 列表为空(hub.config.json 只有 local 被删?——local 不可删,此项造"仅 local"场景验证仍能选):显示不崩;`api.listWorkers` 失败(停 hub / 改 hubEnabled)→ 显示"加载失败"提示,不崩。
- [ ] **reconciler 端到端**:给某房间规则只选 local,VPS 也录了同一场 → 收播后 hub job 的 winner/成员只含 local(查 Hub jobs 页 selected: local,或 `<db>-sync.db` 的 sync_candidates 只有 local)。改选包含 VPS → 下轮对账两者都参与选优。
- [ ] 语言切换 en/zh,worker section 标题/提示/错误文案均有对应翻译(无 raw key 泄漏)。

---

## Self-review(交付前已核对)

- **每个 spec 章节都有落点**:语义/硬过滤 → Step 1.2;配置&DTO → 1.1/1.3/1.4/1.5;向后兼容(缺省=全部) → 1.2(members 不过滤)+1.3(workers undefined 沿用)+2.3(编辑老规则预勾全部);过滤在 reconciler(reconcileAll + settleAll) → 1.2;错误处理(create/update 非空校验) → 1.4;UI → Task 2;测试(reconciler 4 例 / hub-store 往返 / web-api 400) → 1.2/1.3/1.4。
- **无占位符**:所有代码为从源文件引用/改写的真实片段。
- **命名/类型一致**:字段名统一 `workers`(`HubRule`/`HubFile`/`HubRuleDTO`/`HubRulePayload`/`PipelineCfg` 均 `workers?: string[]`);过滤谓词跨文件一致 `cfg.workers.includes(m.workerId)`(reconciler)与后端校验 `Array.isArray && length>0 && every(string)`(api),UI toggle 存 id。
- **分层**:reconciler 仅通过 `resolveCfg` 返回的 `PipelineCfg.workers` 拿选择,CLI(L5)在 `resolveCfg` 里从 `HubRule.workers` 注入;app(L4)未新增对 orchestrator 的 import。
