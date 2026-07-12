# 动态 Hub 流程图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Hub 运行记录的流程图从「固定布局 + 关掉的步骤灰显」改成**按功能开关动态生成节点**，且每个节点携带真实信息（文件数/大小/段数/删除计数）。

**Architecture:** 后端给 ledger 的 step 事件加 `detail` 元数据列，pipeline 每步 done 时写入真实计数/大小；DTO 带出 detail。前端新增纯函数 `buildFlow(job, ruleCfg, terminal)`（模板+剪枝+重排+重连），进行中 run 按当前规则配置画计划图、已完成 run 按实际 `job.steps` 画；节点面板显示一个关键指标、hover 显示完整 detail。

**Tech Stack:** Node 24 ESM（`.js` import 后缀）、pnpm workspace、TypeScript、vitest、`node:sqlite`、React19 + @xyflow/react（React Flow）。

## Global Constraints

- ESM，跨包 import 带 `.js` 后缀；packages/web 内部（bundler）不带后缀。
- 迁移用幂等 `try { ALTER TABLE ... } catch {}`（与 ledger 既有 fails/rename 迁移同风格）。
- `packages/web/**` 被根 vitest `exclude`；纯函数单测放 `test/` 目录（exclude 只影响测试发现，不影响被 import）。
- 录制必须跑打包产物；本改动只碰 orchestrator/app/core/web，`pnpm typecheck` + `pnpm test` + `cd packages/web && pnpm build` 全绿即可。
- detail 串为**中文短串**（与 job.log 中文一致），前端原样展示不翻译。
- 向后兼容：旧 run 的 step 无 detail（列为 null）→ 前端回落只显示耗时；旧 run 按 `job.steps` 存在集画。
- 不引入图自动布局库；远端删除文件不统计字节（只计数）。
- 上线只 docker rebuild（master 跑管线）；VPS 是纯录制 slave，不部署。

---

### Task 1: ledger — `detail` 列 + `logStep` 第四参

**Files:**
- Modify: `packages/orchestrator/src/ledger.ts`
- Test: `packages/orchestrator/src/ledger.test.ts`

**Interfaces:**
- Produces: `logStep(streamKey: string, step: StepName, phase: "start" | "done", detail?: string): void`；`StepEvent` 增 `detail?: string`；`getSteps` 返回值带 `detail`。

- [ ] **Step 1: 写失败测试** — 追加到 `packages/orchestrator/src/ledger.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncLedger } from "./ledger.js";

function fresh(): SyncLedger {
  return new SyncLedger(join(mkdtempSync(join(tmpdir(), "ledger-detail-")), "t.db"));
}

describe("logStep detail", () => {
  it("stores and reads back a step detail", () => {
    const l = fresh();
    l.upsertPending("k1", "douyin", "room", Date.now());
    l.logStep("k1", "pull", "start");
    l.logStep("k1", "pull", "done", "2 文件 · 1.9GB ← vps");
    const steps = l.getSteps("k1");
    const done = steps.find((s) => s.step === "pull" && s.phase === "done");
    expect(done?.detail).toBe("2 文件 · 1.9GB ← vps");
    const start = steps.find((s) => s.step === "pull" && s.phase === "start");
    expect(start?.detail ?? null).toBeNull();
  });
});
```

> 注：`upsertPending` 是 ledger 现有建 job 的方法（若签名不同，用 ledger 现有的建 job/首事件方法；本测试只需要 streamKey 存在即可 logStep）。先看 `ledger.ts` 里建 job 的实际方法名并对齐。

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk proxy pnpm test -- ledger.test`
Expected: FAIL —— `detail` 不是 `logStep` 的参数 / `getSteps` 结果无 `detail`。

- [ ] **Step 3: 实现** — 改 `packages/orchestrator/src/ledger.ts`：

3a. `StepEvent` 加 detail（约 line 32）：
```ts
export interface StepEvent { streamKey: string; step: StepName; phase: "start" | "done"; at: number; detail?: string }
```

3b. 建表加列 + 迁移（`sync_job_steps` CREATE 之后，约 line 61-62 之间加迁移）：
```ts
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_job_steps(
      streamKey TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT)`);
    // 既有库迁移:补 detail 列(已存在则忽略)。
    try { this.db.exec("ALTER TABLE sync_job_steps ADD COLUMN detail TEXT"); } catch { /* 列已存在 */ }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_job_steps_key ON sync_job_steps(streamKey, at)");
```

3c. `logStep` 加参 + 写入（约 line 68-71）：
```ts
  logStep(streamKey: string, step: StepName, phase: "start" | "done", detail?: string): void {
    this.db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at,detail) VALUES(?,?,?,?,?)")
      .run(streamKey, step, phase, this.now(), detail ?? null);
  }
```

3d. `getSteps` SELECT detail（约 line 73-75）：
```ts
  getSteps(streamKey: string): StepEvent[] {
    return this.db.prepare("SELECT streamKey,step,phase,at,detail FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC")
      .all(streamKey) as unknown as StepEvent[];
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `rtk proxy pnpm test -- ledger.test`
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

```bash
rtk proxy pnpm typecheck
git add packages/orchestrator/src/ledger.ts packages/orchestrator/src/ledger.test.ts
git commit -m "feat(hub): ledger sync_job_steps 加 detail 列 + logStep 第四参"
```

---

### Task 2: pipeline — 每步 done 写真实 detail + 格式化工具

**Files:**
- Create: `packages/orchestrator/src/format.ts`
- Modify: `packages/orchestrator/src/pipeline.ts`
- Test: `packages/orchestrator/src/format.test.ts`, `packages/orchestrator/src/pipeline.test.ts`

**Interfaces:**
- Consumes: `logStep(..., detail?)`（Task 1）。
- Produces: `humanBytes(n: number): string`、`humanDur(sec: number): string`、`sumBytes(paths: string[]): number`（`packages/orchestrator/src/format.ts`）。

- [ ] **Step 1: 写 format 失败测试** — `packages/orchestrator/src/format.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { humanBytes, humanDur } from "./format.js";

describe("humanBytes", () => {
  it("formats bytes across units", () => {
    expect(humanBytes(0)).toBe("0B");
    expect(humanBytes(512)).toBe("512B");
    expect(humanBytes(1536)).toBe("1.5KB");
    expect(humanBytes(90 * 1024 * 1024)).toBe("90MB");
    expect(humanBytes(2 * 1024 * 1024 * 1024)).toBe("2GB");
  });
});

describe("humanDur", () => {
  it("formats seconds", () => {
    expect(humanDur(45)).toBe("45s");
    expect(humanDur(600)).toBe("10m");
    expect(humanDur(5879)).toBe("1h38m");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk proxy pnpm test -- format.test`
Expected: FAIL —— `./format.js` 不存在。

- [ ] **Step 3: 实现 format.ts**

```ts
/** 字节 → 人类可读("90MB" / "1.5KB" / "2GB")。1 位小数,整数省略小数。 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  return `${s}${units[i]}`;
}

/** 秒 → 人类可读("1h38m" / "10m" / "45s")。 */
export function humanDur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 60) return `${Math.max(0, Math.round(sec))}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** 一组文件字节和(best-effort:stat 失败的跳过;全失败返 0)。 */
export function sumBytes(paths: string[]): number {
  let total = 0;
  for (const p of paths) {
    try { total += Number(require("node:fs").statSync(p).size); } catch { /* 拿不到就跳过 */ }
  }
  return total;
}
```

> `require` 在 ESM 不可用 —— 改用顶部 `import { statSync } from "node:fs";` 后 `total += Number(statSync(p).size)`。（实现时用 import，勿用 require。）

- [ ] **Step 4: 跑 format 测试确认通过**

Run: `rtk proxy pnpm test -- format.test`
Expected: PASS。

- [ ] **Step 5: 写 pipeline detail 失败测试** — 追加到 `packages/orchestrator/src/pipeline.test.ts`（复用文件顶部现有 `makeDeps`/`makeBroadcast`/`makeRec`/`runPipeline`）：

```ts
describe("step detail", () => {
  it("merge/clean steps carry count detail (upload mode)", async () => {
    const deps = makeDeps({ cfg: { ...baseCfg, uploadMode: "upload", cleanup: { sourceAfterDone: true } } });
    // baseCfg: 用文件里现有 makeDeps 默认 cfg;若无导出常量,直接在 overrides.cfg 给全字段。
    const b = makeBroadcast([
      { workerId: "node-1", rec: makeRec({ tsFiles: ["/r/a.ts", "/r/b.ts", "/r/c.ts", "/r/d.ts"] }) },
    ]);
    await runPipeline(b, deps);
    const steps = deps.ledger.getSteps(b.streamKey);
    const merge = steps.find((s) => s.step === "merge" && s.phase === "done");
    expect(merge?.detail).toContain("4 段");
    const cleanSrc = steps.find((s) => s.step === "clean_source" && s.phase === "done");
    expect(cleanSrc?.detail).toContain("删 1 节点");
  });
});
```

> 计数部分（段数=`tsFiles.length`、节点数=`members.length`、文件数）**不依赖 stat**，测试可断言；大小部分依赖真实文件（测试里 mock 的路径不存在 → 省略），故只断言计数子串。若 `makeDeps` 的默认 `cfg` 不便覆盖，按文件里 `makeDeps` 的实际形状补全 `cfg` 全字段。

- [ ] **Step 6: 跑测试确认失败**

Run: `rtk proxy pnpm test -- pipeline.test`
Expected: FAIL —— merge/clean_source 的 `detail` 为 undefined。

- [ ] **Step 7: 实现 pipeline detail** — 改 `packages/orchestrator/src/pipeline.ts`：

7a. 顶部 import：
```ts
import { statSync } from "node:fs";
import { humanBytes, humanDur, sumBytes } from "./format.js";
```

7b. `pull` done（现约 line 185-186）——把 pull 段落改成先算 detail：
```ts
  await transport.pull(filesToPull, stageSub);
  const pulledPaths = filesToPull.map((f) => path.join(stageSub, path.basename(f)));
  const pullBytes = sumBytes(pulledPaths);
  ledger.logStep(streamKey, "pull", "done",
    `${filesToPull.length} 文件${pullBytes > 0 ? ` · ${humanBytes(pullBytes)}` : ""} ← ${winner.workerId}`);
```

7c. `merge` done（现约 line 200）：
```ts
  const plainBytes = (() => { try { return Number(statSync(plain).size); } catch { return 0; } })();
  ledger.logStep(streamKey, "merge", "done",
    `${winner.rec.tsFiles.length} 段 → ${plainBytes > 0 ? humanBytes(plainBytes) : "?"}${winner.rec.durationSec > 0 ? ` · ${humanDur(winner.rec.durationSec)}` : ""}`);
```

7d. `upload_plain` done（现约 line 216,在 `.then` 里）：
```ts
       }).then((bv) => {
         const sz = (() => { try { return Number(statSync(plain).size); } catch { return 0; } })();
         ledger.logStep(streamKey, "upload_plain", "done", sz > 0 ? humanBytes(sz) : undefined);
         return { bv };
       },
```

7e. `burn_danmu` done（现约 line 224）：
```ts
    ledger.logStep(streamKey, "burn_danmu", "done",
      (() => { try { return `→ ${humanBytes(Number(statSync(danmuMp4).size))}`; } catch { return undefined; } })());
```

7f. `burn_livechat` done（现约 line 229）—— 同 7e，改 `livechatMp4`：
```ts
    ledger.logStep(streamKey, "burn_livechat", "done",
      (() => { try { return `→ ${humanBytes(Number(statSync(livechatMp4).size))}`; } catch { return undefined; } })());
```

7g. `clean_stage_src` done（现约在 `if (clean.stageSourceAfterMerge)` 块内）：
```ts
  if (clean.stageSourceAfterMerge) {
    ledger.logStep(streamKey, "clean_stage_src", "start");
    const pulledTs = winner.rec.tsFiles.map((f) => path.join(stageSub, path.basename(f)));
    const victims = [...pulledTs, ...(clean.includeXmlAss && xmlArg ? [xmlArg] : [])];
    await rmStage(victims);
    ledger.logStep(streamKey, "clean_stage_src", "done", `删 ${victims.length} 文件`);
  }
```

7h. `clean_source` done（现约 `cleanupSources` 闭包内，Task 前一次特性已加了 start/done，改 done 带 detail）：
```ts
  const cleanupSources = async (): Promise<void> => {
    if (!clean.sourceAfterDone) return;
    ledger.logStep(streamKey, "clean_source", "start");
    let fileCount = 0;
    for (const m of candidates.members) {
      const paths = sourcePathsOf(m);
      fileCount += paths.length;
      await transports.get(m.workerId)?.cleanup?.(paths).catch(() => {});
    }
    ledger.logStep(streamKey, "clean_source", "done", `删 ${candidates.members.length} 节点 · ${fileCount} 文件`);
  };
```

7i. `clean_stage` done（现约 `if (clean.stageAfterDone)` 块内）：
```ts
  if (clean.stageAfterDone) {
    ledger.logStep(streamKey, "clean_stage", "start");
    const products = [plain, ...danmuParts, ...livechatParts];
    const xmlAss = clean.includeXmlAss
      ? [plainXml, xmlArg, danmuMp4.replace(/\.mp4$/, ".ass"), livechatMp4.replace(/\.mp4$/, ".ass")].filter(Boolean)
      : [];
    const victims = [...products, ...xmlAss];
    await rmStage(victims);
    ledger.logStep(streamKey, "clean_stage", "done", `删 ${victims.length} 文件`);
  }
```

7j. `append_danmu`/`append_livechat` done（现约 line 296,在 appendGroups 循环内）：
```ts
    ledger.logStep(streamKey, g.step, "start");
    await appendGroup({ bv, files: g.files, cookies: cfg.cookies, public: isPublic });
    const apBytes = sumBytes(g.files);
    ledger.logStep(streamKey, g.step, "done",
      `${g.files.length} 段${apBytes > 0 ? ` · ${humanBytes(apBytes)}` : ""}`);
```

> `select`/`syncing` 等不加 detail（select 信息前端从 candidates 派生）。所有 `try/catch` 保证 detail 计算永不反噬管线。

- [ ] **Step 8: 跑测试确认通过**

Run: `rtk proxy pnpm test -- pipeline.test format.test`
Expected: PASS。

- [ ] **Step 9: typecheck + commit**

```bash
rtk proxy pnpm typecheck
git add packages/orchestrator/src/format.ts packages/orchestrator/src/format.test.ts packages/orchestrator/src/pipeline.ts packages/orchestrator/src/pipeline.test.ts
git commit -m "feat(hub): pipeline 每步 done 写真实 detail(文件数/大小/段数/删除计数)"
```

---

### Task 3: DTO + hub-jobs 带出 detail

**Files:**
- Modify: `packages/core/src/api-types.ts`, `packages/app/src/hub-jobs.ts`
- Test: `packages/app/src/hub-jobs.test.ts`

**Interfaces:**
- Consumes: `sync_job_steps.detail`（Task 1）。
- Produces: `HubJobStepDTO.detail?: string`；`HubJobStep.detail?: string`；`listHubJobs` 返回的 step 带 `detail`。

- [ ] **Step 1: 写失败测试** — 追加到 `packages/app/src/hub-jobs.test.ts`（复用文件里现有的「建 sync db + seed + listHubJobs」helper；若无，参照文件顶部现有测试的建库方式）：

```ts
it("includes step detail in the DTO", () => {
  // 用文件里现有的方式建一个 sync db 并 seed 一个 job:
  //   一个 done job + sync_job_steps 里 merge done 带 detail "4 段 → 90MB"
  // 然后:
  const { jobs } = listHubJobs(syncDbPath, { room: "douyin.room" });
  const merge = jobs[0].steps.find((s) => s.step === "merge" && s.phase === "done");
  expect(merge?.detail).toBe("4 段 → 90MB");
});
```

> 实现者：先读 `hub-jobs.test.ts` 现有测试怎么 seed（多半直接用 `SyncLedger` 写或裸 sqlite 插行）。用同样方式插一行 `sync_job_steps(streamKey,'merge','done',<at>,'4 段 → 90MB')`，并确保该 job 是 done 态（`sync_jobs`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk proxy pnpm test -- hub-jobs.test`
Expected: FAIL —— `merge.detail` 为 undefined。

- [ ] **Step 3: 实现**

3a. `packages/core/src/api-types.ts` `HubJobStepDTO`（约 line 50-56）加字段：
```ts
export interface HubJobStepDTO {
  step: string;
  phase: string;
  at: number;
  /** 该步真实信息(done 事件才有;旧库无 → 缺省)。 */
  detail?: string;
}
```

3b. `packages/app/src/hub-jobs.ts`：
- `HubJobStep` 接口（约 line 18）：
```ts
export interface HubJobStep { step: string; phase: string; at: number; detail?: string }
```
- steps 查询（约 line 152）SELECT detail + 映射（约 line 187）：
```ts
        steps = db.prepare("SELECT step, phase, at, detail FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC")
          .all(j.streamKey) as unknown as HubJobStep[];
```
```ts
        steps: steps.map((s) => ({ step: s.step, phase: s.phase, at: Number(s.at), detail: s.detail ?? undefined })),
```
> steps 查询已在 `try/catch`（旧库无表回落空）；若旧库有 `sync_job_steps` 但无 `detail` 列，`SELECT ... detail` 会抛 → 落进 catch → steps 空。为避免旧库整张 steps 丢失,catch 里先降级重试不带 detail 的旧查询：
```ts
      let steps: HubJobStep[] = [];
      try {
        steps = db.prepare("SELECT step, phase, at, detail FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC")
          .all(j.streamKey) as unknown as HubJobStep[];
      } catch {
        try {
          steps = db.prepare("SELECT step, phase, at FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC")
            .all(j.streamKey) as unknown as HubJobStep[];
        } catch { /* 旧库无表 → 空 */ }
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `rtk proxy pnpm test -- hub-jobs.test`
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

```bash
rtk proxy pnpm typecheck
git add packages/core/src/api-types.ts packages/app/src/hub-jobs.ts packages/app/src/hub-jobs.test.ts
git commit -m "feat(hub): HubJobStepDTO 带出 step detail(旧库降级兼容)"
```

---

### Task 4: 前端纯函数 `buildFlow` + `pickMetric`

**Files:**
- Create: `packages/web/src/components/flow-build.ts`
- Test: `test/hub-flow-build.test.ts`

**Interfaces:**
- Produces:
  - `interface FlowNode { key: string; x: number; y: number }`
  - `interface FlowGraph { nodes: FlowNode[]; edges: Array<[string, string]> }`
  - `buildFlow(job: { state: string; steps: { step: string }[] }, cfg: FlowCfg | undefined): FlowGraph`
  - `pickMetric(step: string, detail?: string): string | null`
  - `type FlowCfg = { steps?: { burnDanmu?: boolean; burnLivechat?: boolean }; upload?: { mode?: string }; cleanup?: { stageSourceAfterMerge?: boolean; sourceAfterDone?: boolean; stageAfterDone?: boolean } }`

- [ ] **Step 1: 写失败测试** — `test/hub-flow-build.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { buildFlow, pickMetric } from "../packages/web/src/components/flow-build";

const keys = (g: { nodes: { key: string }[] }) => g.nodes.map((n) => n.key);
const doneJob = (steps: string[]) => ({ state: "done", steps: steps.flatMap((s) => [{ step: s }]) });

describe("buildFlow — 终态按 job.steps", () => {
  it("stage 模式只 danmu:线性,无 upload/append/livechat", () => {
    const g = buildFlow(doneJob(["select", "pull", "merge", "burn_danmu", "clean_source"]), undefined);
    expect(keys(g)).toEqual(["select", "pull", "merge", "burn_danmu", "clean_source", "__term__"]);
    // 线性:全 y=70
    expect(g.nodes.every((n) => n.y === 70)).toBe(true);
    expect(g.edges).toContainEqual(["merge", "burn_danmu"]);
    expect(g.edges).toContainEqual(["burn_danmu", "clean_source"]);
    expect(g.edges).toContainEqual(["clean_source", "__term__"]);
    expect(keys(g)).not.toContain("upload_plain");
    expect(keys(g)).not.toContain("append_danmu");
  });

  it("upload+双烧+清理:fork/join,burn 轨 y=10、upload 轨 y=130", () => {
    const g = buildFlow(doneJob([
      "select", "pull", "merge", "burn_danmu", "burn_livechat",
      "upload_plain", "append_danmu", "append_livechat", "clean_source",
    ]), undefined);
    expect(keys(g)).toContain("upload_plain");
    expect(g.nodes.find((n) => n.key === "burn_danmu")!.y).toBe(10);
    expect(g.nodes.find((n) => n.key === "upload_plain")!.y).toBe(130);
    expect(g.edges).toContainEqual(["merge", "burn_danmu"]);
    expect(g.edges).toContainEqual(["merge", "upload_plain"]);
    // join:两轨末节点都指向第一个 tail(append_danmu)
    expect(g.edges).toContainEqual(["upload_plain", "append_danmu"]);
  });
});

describe("buildFlow — 进行中按 cfg", () => {
  it("in-progress 只画规则开的节点", () => {
    const job = { state: "merging", steps: [{ step: "select" }, { step: "pull" }, { step: "merge" }] };
    const cfg = { steps: { burnDanmu: true, burnLivechat: false }, upload: { mode: "stage" }, cleanup: { sourceAfterDone: true } };
    const g = buildFlow(job, cfg);
    expect(keys(g)).toContain("burn_danmu");
    expect(keys(g)).not.toContain("burn_livechat");
    expect(keys(g)).not.toContain("upload_plain");
    expect(keys(g)).toContain("clean_source");
  });
});

describe("pickMetric", () => {
  it("非清理步取大小段", () => {
    expect(pickMetric("pull", "2 文件 · 1.9GB ← vps")).toBe("1.9GB");
    expect(pickMetric("merge", "4 段 → 90MB · 1h38m")).toBe("90MB");
  });
  it("清理步取删除计数", () => {
    expect(pickMetric("clean_source", "删 2 节点 · 4 文件")).toBe("删 2 节点");
  });
  it("无 detail 返 null", () => {
    expect(pickMetric("pull", undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk proxy pnpm test -- hub-flow-build`
Expected: FAIL —— `flow-build` 不存在。

- [ ] **Step 3: 实现 `packages/web/src/components/flow-build.ts`**

```ts
// 动态 pipeline 流程图构造:纯函数(不 import React/平台代码),根 vitest 可直接单测。
export interface FlowNode { key: string; x: number; y: number }
export interface FlowGraph { nodes: FlowNode[]; edges: Array<[string, string]> }
export type FlowCfg = {
  steps?: { burnDanmu?: boolean; burnLivechat?: boolean };
  upload?: { mode?: string };
  cleanup?: { stageSourceAfterMerge?: boolean; sourceAfterDone?: boolean; stageAfterDone?: boolean };
};

const COL = 170;
const Y_MID = 70, Y_TOP = 10, Y_BOT = 130;
const TERMINAL = new Set(["done", "failed", "needs_manual"]);
const OPTIONAL = [
  "burn_danmu", "burn_livechat", "clean_stage_src",
  "upload_plain", "append_danmu", "append_livechat",
  "clean_source", "clean_stage",
] as const;

/** 该 run 要画哪些可选节点:终态按实际 steps;进行中按规则配置(+已有事件兜底)。 */
export function presentSet(
  job: { state: string; steps: { step: string }[] },
  cfg: FlowCfg | undefined,
): Set<string> {
  const has = (k: string): boolean => job.steps.some((s) => s.step === k);
  const p = new Set<string>(["select", "pull", "merge"]);
  for (const k of OPTIONAL) if (has(k)) p.add(k); // 已跑过的一律画(兜底 + 终态即全部依据)
  if (!TERMINAL.has(job.state) && cfg) {
    const st = cfg.steps ?? {};
    const up = cfg.upload?.mode === "upload";
    const cl = cfg.cleanup ?? {};
    if (st.burnDanmu !== false) p.add("burn_danmu");
    if (st.burnLivechat !== false) p.add("burn_livechat");
    if (up) p.add("upload_plain");
    if (up && st.burnDanmu !== false) p.add("append_danmu");
    if (up && st.burnLivechat !== false) p.add("append_livechat");
    if (cl.stageSourceAfterMerge) p.add("clean_stage_src");
    if (cl.sourceAfterDone) p.add("clean_source");
    if (cl.stageAfterDone) p.add("clean_stage");
  }
  return p;
}

export function buildFlow(
  job: { state: string; steps: { step: string }[] },
  cfg: FlowCfg | undefined,
): FlowGraph {
  const p = presentSet(job, cfg);
  const keep = (arr: string[]): string[] => arr.filter((k) => p.has(k));
  const spine = ["select", "pull", "merge"];
  const burnLane = keep(["burn_danmu", "burn_livechat", "clean_stage_src"]);
  const uploadLane = keep(["upload_plain"]);
  const tail = [...keep(["append_danmu", "append_livechat", "clean_source", "clean_stage"]), "__term__"];

  const nodes: FlowNode[] = [];
  spine.forEach((k, i) => nodes.push({ key: k, x: i * COL, y: Y_MID }));
  const forkStart = spine.length;
  const forked = burnLane.length > 0 && uploadLane.length > 0; // 只有两轨都在才分叉
  burnLane.forEach((k, i) => nodes.push({ key: k, x: (forkStart + i) * COL, y: forked ? Y_TOP : Y_MID }));
  uploadLane.forEach((k, i) => nodes.push({ key: k, x: (forkStart + i) * COL, y: forked ? Y_BOT : Y_MID }));
  const forkWidth = Math.max(burnLane.length, uploadLane.length);
  const tailStart = forkStart + forkWidth;
  tail.forEach((k, i) => nodes.push({ key: k, x: (tailStart + i) * COL, y: Y_MID }));

  const edges: Array<[string, string]> = [["select", "pull"], ["pull", "merge"]];
  const chain = (arr: string[]): void => { for (let i = 0; i + 1 < arr.length; i++) edges.push([arr[i], arr[i + 1]]); };
  chain(burnLane); chain(uploadLane); chain(tail);
  const joinTarget = tail[0]; // 恒有(至少 __term__)
  if (burnLane.length) { edges.push(["merge", burnLane[0]]); edges.push([burnLane[burnLane.length - 1], joinTarget]); }
  if (uploadLane.length) { edges.push(["merge", uploadLane[0]]); edges.push([uploadLane[uploadLane.length - 1], joinTarget]); }
  if (!burnLane.length && !uploadLane.length) edges.push(["merge", joinTarget]);

  return { nodes, edges };
}

const SIZE_RE = /\d[\d.]*\s?[KMGT]?B\b/;
/** 节点面板显示的关键指标:清理步取删除计数,其余取大小段;无 → null(组件回落耗时)。 */
export function pickMetric(step: string, detail?: string): string | null {
  if (!detail) return null;
  if (step.startsWith("clean_")) {
    const m = detail.match(/删\s*\d+\s*\S+/);
    return m ? m[0].replace(/\s+/g, " ").trim() : null;
  }
  const m = detail.match(SIZE_RE);
  return m ? m[0] : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `rtk proxy pnpm test -- hub-flow-build`
Expected: PASS（全部用例）。

- [ ] **Step 5: commit**

```bash
git add packages/web/src/components/flow-build.ts test/hub-flow-build.test.ts
git commit -m "feat(web,hub): 动态流程图纯函数 buildFlow + pickMetric(单测)"
```

---

### Task 5: 接入 HubJobs 流程图 + 节点信息 + RoomDetail 传规则

**Files:**
- Modify: `packages/web/src/components/HubJobs.tsx`, `packages/web/src/components/RoomDetail.tsx`
- Verify: `cd packages/web && rtk proxy pnpm build`；根 `rtk proxy pnpm typecheck`；docker 部署后浏览器核对。

**Interfaces:**
- Consumes: `buildFlow`、`pickMetric`（Task 4）；`HubJobDTO.steps[].detail`（Task 3）；`HubPipelineConfig`（rule.pipeline）。

- [ ] **Step 1: HubJobs 引入 buildFlow + 传 cfg**

1a. 顶部 import：
```ts
import { buildFlow, pickMetric, type FlowCfg } from "./flow-build";
import type { HubPipelineConfig } from "../api/client";
```

1b. `StepNode` 的 `data` 增 `metric?`/`detail?`，面板在名称下显示 metric（无则回落 `humanSec`），hover 追加 detail 行。改 `StepNode`（现约 line 102-160,含 tooltip）：
   - `data` 类型加 `metric?: string | null; detail?: string`。
   - tooltip 内容 `tip` 里，在「状态 · 耗时」下面再加一行：`{data.detail && <div className="text-[11px] text-muted-soft mt-0.5">{data.detail}</div>}`。
   - 面板耗时那行(现 `humanSec(data.sec)`)改为：`{data.metric ?? (data.status === "skipped" ? t("hub.jobs.skipped") : data.status === "todo" ? "" : humanSec(data.sec))}`。

1c. `PipelineFlowInner` 签名加 `cfg`：
```ts
function PipelineFlowInner({ job, workerName, cfg }: { job: HubJobDTO; workerName?: (id: string) => string; cfg?: FlowCfg }): ReactNode {
```

1d. 用 `buildFlow` 取代固定 `STEP_DEFS`/`FLOW_EDGES`（现约 line 240-260）。step 的 detail 从 `job.steps` 里取(取该 step done 事件的 detail)；status 仍由现有 `stepStatuses(job)` 得到(它遍历 job.steps 配对,与 buildFlow 的存在集独立,只是现在只对存在节点取值)。改为：
```ts
  const st = stepStatuses(job);
  const graph = buildFlow(job, TERMINAL.has(job.state) ? undefined : cfg);
  const detailOf = (key: string): string | undefined =>
    job.steps.filter((s) => s.step === key && s.phase === "done").map((s) => s.detail).filter(Boolean).pop();
  const termStatus: NodeStatus =
    job.state === "failed" ? "failed" : job.state === "done" ? "done" : job.state === "needs_manual" ? "done" : "todo";
  const termLabel = job.state === "needs_manual" ? labels.needs_manual : job.state === "failed" ? labels.failed : t("hub.jobs.termDone");

  const nodes: Node[] = [
    ...graph.nodes.filter((n) => n.key !== "__term__").map((n) => ({
      id: n.key, type: "step", position: { x: n.x, y: n.y },
      data: {
        label: t(`hub.jobs.stepNode.${n.key}`),
        status: st[n.key]?.status ?? "todo",
        sec: st[n.key]?.sec ?? null,
        detail: detailOf(n.key),
        metric: n.key === "select"
          ? (job.winnerWorker ? (workerName ? workerName(job.winnerWorker) : job.winnerWorker) : null)
          : pickMetric(n.key, detailOf(n.key)),
      },
    })),
    ...(() => {
      const tn = graph.nodes.find((n) => n.key === "__term__")!;
      return [{ id: "__term__", type: "step", position: { x: tn.x, y: tn.y }, data: { label: termLabel, status: termStatus, sec: null, metric: null } }];
    })(),
    ...candNodes,
  ];
  const edges: Edge[] = [
    ...graph.edges.map(([src, dst]) => {
      const ts = dst === "__term__" ? termStatus : (st[dst]?.status ?? "todo");
      const reached = ts === "done" || ts === "active" || ts === "failed";
      return { id: `${src}-${dst}`, source: src, target: dst, animated: ts === "active",
        style: { stroke: reached ? "var(--success)" : "var(--hairline)", strokeWidth: 1.5 } };
    }),
    ...candEdges,
  ];
```
> 删掉旧的 `STEP_DEFS.map(...)`/`FLOW_EDGES.map(...)` 与 `TERM`/`STEP_DEFS`/`FLOW_EDGES` 常量（`stepStatuses` 里遍历 `STEP_DEFS` 的部分改成遍历一个「全部可能 key」的常量数组 `ALL_STEP_KEYS`，因为 status 现在按 job.steps 配对、与布局解耦）。新增：
```ts
const ALL_STEP_KEYS = ["select","pull","merge","burn_danmu","burn_livechat","clean_stage_src","upload_plain","append_danmu","append_livechat","clean_source","clean_stage"] as const;
```
并把 `stepStatuses` 里 `for (const def of STEP_DEFS)` 改成 `for (const key of ALL_STEP_KEYS)`（用 `key` 取代 `def.key`）。

1e. `pipelineSig`（memo 比较）纳入 cfg + detail，避免规则/detail 变化时不重渲染：
```ts
function pipelineSig(j: HubJobDTO, cfg?: FlowCfg): string {
  const cand = j.candidates.map((c) => `${c.worker}:${c.isWinner ? 1 : 0}`).join(",");
  const steps = j.steps.map((s) => `${s.step}:${s.phase}:${s.at}:${s.detail ?? ""}`).join(",");
  const c = cfg ? JSON.stringify([cfg.steps, cfg.upload?.mode, cfg.cleanup]) : "";
  return `${j.state}|${steps}|${cand}|${c}`;
}
export const PipelineFlow = memo(
  PipelineFlowInner,
  (a, b) => pipelineSig(a.job, a.cfg) === pipelineSig(b.job, b.cfg) && a.workerName === b.workerName,
);
```
`PipelineFlow` 的 props 类型加 `cfg?: FlowCfg`。

1f. `RunCard` 增 `cfg?: FlowCfg` 透传给 `<PipelineFlow job={job} workerName={workerName} cfg={cfg} />`（现约展开区渲染 PipelineFlow 处）。`RunCard` props 类型加 `cfg?: FlowCfg`。

- [ ] **Step 2: RoomDetail 把 rule.pipeline 传下去**

`packages/web/src/components/RoomDetail.tsx` 渲染 `<RunCard .../>` 处加 `cfg={rule.pipeline as FlowCfg}`（`rule.pipeline` 结构与 `FlowCfg` 兼容:steps/upload.mode/cleanup 子集）。顶部 `import type { FlowCfg } from "./flow-build";`。

- [ ] **Step 3: 构建 + typecheck**

Run:
```bash
cd packages/web && rtk proxy pnpm build && cd ../.. && rtk proxy pnpm typecheck
```
Expected: 两者都成功（web `tsc -b` + vite build 通过；根 tsc 0 错）。

- [ ] **Step 4: 手动核对(部署后)** — bundle + docker rebuild：
```bash
rtk proxy pnpm bundle
GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build
```
浏览器 `http://localhost:7860/hub` 核对：
  - 一个 upload+双烧 的历史 run → fork/join 全节点，节点面板显示大小（pull 显示 GB、merge/burn 显示 MB、清理显示「删 N …」），hover 显示完整 detail 行。
  - 关掉 livechat/upload 的规则 → 对应节点**消失**（不再灰显 skipped）。
  - 旧 run（无 detail）→ 面板回落显示耗时，不报错。

- [ ] **Step 5: commit**

```bash
git add packages/web/src/components/HubJobs.tsx packages/web/src/components/RoomDetail.tsx
git commit -m "feat(web,hub): 流程图改动态生成(按开关画节点)+ 节点显示真实信息/hover 详情"
```

---

## Self-Review（写完计划的自查）

**Spec 覆盖**：
- Part 1（ledger detail）→ Task 1 ✓；Part 1 pipeline detail 表 → Task 2 ✓（每步都有）。
- Part 2（DTO + 读取 + 传规则）→ Task 3（DTO/hub-jobs）+ Task 5 Step 2（RoomDetail 传 cfg）✓。
- Part 3（buildFlow 动态图）→ Task 4 ✓。
- Part 4（节点信息 metric/hover）→ Task 4（pickMetric）+ Task 5 Step 1b/1d ✓。
- Part 5（测试 + 上线）→ 各 Task 的 test 步 + Task 5 Step 4 ✓。

**类型一致性**：`buildFlow(job, cfg)`、`pickMetric(step, detail)`、`FlowCfg`、`HubJobStepDTO.detail`、`logStep(...,detail?)` 全计划内签名一致；`FlowNode {key,x,y}`/`FlowGraph {nodes,edges}` 在 Task 4 定义、Task 5 消费一致。

**占位符**：无 TBD/TODO；每步给了实际代码与命令。

**已知风险**：`stepStatuses` 从遍历 `STEP_DEFS` 改遍历 `ALL_STEP_KEYS`（Task 5 Step 1d 明确）；`sumBytes` 用 `import statSync` 非 `require`（Task 2 Step 3 明确）；hub-jobs detail 查询对旧库降级重试（Task 3 Step 3）。
