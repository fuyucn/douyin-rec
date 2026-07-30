# Hub 上传重试:幂等 + 断点续跑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 hub pipeline 的上传失败重试变成**幂等 + 可续跑**——已建稿的 BV 立即落库、重试跳过已完成阶段、绝不重传已建稿的 P1,消除重复投稿;瞬时 append 失败就地重试;多次仍失败升级为 `needs_manual` + 通知人工。

**Architecture:** 在现有 `@drec/orchestrator` 状态机上做三处收口:① `SyncLedger` 增 `setBv`(P1 成功即落库 BV)+ `isStepDone`(查某 append 步是否已完成);② `pipeline` 入口检查 `job.bv`——有则走**续跑分支**(跳过 select/pull/merge/burn/uploadPlain,只补没做完的 append),并把 `appendGroup` 包一层有限次重试;③ `reconciler` 在 `fails >= maxRetries` 时由静默 `continue` 改为转 `needs_manual` + 发一次通知。不动录制层/平台层/引擎层。

**Tech Stack:** TypeScript(ESM,`.js` import 后缀)、`node:sqlite`、vitest(co-located `*.test.ts`)、注入式 deps 测试(不碰真 biliup/ffmpeg)。

## Global Constraints

- **不变量(本计划的存在理由)**:`任何 uploadPlain 调用之前,必须确认这场还没有 BV;拿到 BV 的那一刻必须先落库,再做后续 append。` 满足这条,重复稿在结构上不可能发生。
- ESM:所有相对 import 带 `.js` 后缀。
- 测试就近:新代码的单测放 `packages/orchestrator/src/*.test.ts`,挨着源码。
- 运行测试:仓库根 `pnpm test`(vitest run);单文件 `pnpm vitest run packages/orchestrator/src/<file>.test.ts`。
- 不碰真 biliup/ffmpeg/ssh:pipeline/ledger 测试全用注入式 deps(见既有 `pipeline.test.ts` 的 `makeDeps`)。
- `appendGroup` 只做**单逻辑组**(danmu 一组、livechat 一组);就地重试**只对单文件组开启**(常态),多段组(>16GB 罕见)`tries=1` 不就地重试,避免跨调用重复分 P(见 Task 3 Notes)。
- 提交规范:约定式提交 `<type>(<scope>): <中文描述>`,scope 用 `orchestrator`/`hub`;不加 AI 署名 trailer。
- **本计划文件单独 commit**(先 commit `plans/021_*.md`,代码变更分 Task 各自 commit)。

---

## File Structure

- `packages/orchestrator/src/ledger.ts` — 加 `setBv` + `isStepDone`(方法,不改表结构)。
- `packages/orchestrator/src/ledger.test.ts` — 加对应单测。
- `packages/orchestrator/src/retry.ts` — **新建**:纯函数 `retry(fn, opts)`,有限次重试 + 退避,sleep 可注入。
- `packages/orchestrator/src/retry.test.ts` — **新建**:retry 单测。
- `packages/orchestrator/src/pipeline.ts` — ① P1 成功即 `setBv`;② `appendGroup` 包 `retry`;③ append 循环跳过 `isStepDone` 已完成组;④ 入口续跑分支;⑤ stageSub 计算上移到入口。
- `packages/orchestrator/src/pipeline.test.ts` — 加续跑/防重/跳过/重试相关单测。
- `packages/orchestrator/src/reconciler.ts` — `fails >= maxRetries` → `needs_manual` + notify 一次。
- `packages/orchestrator/src/reconciler.test.ts` — 加升级 needs_manual 单测。

---

## Task 1: SyncLedger 加 setBv + isStepDone

**Files:**
- Modify: `packages/orchestrator/src/ledger.ts`(在 `markDone` 附近加 `setBv`;在 `getSteps` 附近加 `isStepDone`)
- Test: `packages/orchestrator/src/ledger.test.ts`

**Interfaces:**
- Consumes: 现有 `SyncLedger`(`db`, `now()`, `logEvent`, `getSteps`)。
- Produces:
  - `setBv(streamKey: string, bv: string): void` — 只更新 `bv` 列 + `updatedAt`,**不改 state、不写事件**(这是 checkpoint,不是终态)。
  - `isStepDone(streamKey: string, step: StepName): boolean` — 该 step 的**最新一条**事件 `phase === "done"` 返回 true;无该 step 事件返回 false。

- [ ] **Step 1: 写失败测试(setBv + isStepDone)**

在 `ledger.test.ts` 的 `describe("SyncLedger", …)` 内追加:

```typescript
it("setBv 只落 bv 列,不改 state、不产生新事件", () => {
  const l = fresh();
  l.upsertPending("k1");                 // pending
  l.setState("k1", "uploading");         // uploading
  const before = l.getEvents("k1").length;
  l.setBv("k1", "BVabc");
  expect(l.get("k1")?.bv).toBe("BVabc");
  expect(l.get("k1")?.state).toBe("uploading"); // state 不变
  expect(l.getEvents("k1").length).toBe(before); // 不新增事件
  l.close();
});

it("isStepDone:最新事件为 done → true;只有 start → false;无该 step → false", () => {
  const l = fresh();
  l.upsertPending("k1");
  l.logStep("k1", "append_danmu", "start");
  expect(l.isStepDone("k1", "append_danmu")).toBe(false); // 只 start
  l.logStep("k1", "append_danmu", "done");
  expect(l.isStepDone("k1", "append_danmu")).toBe(true);  // 最新 done
  expect(l.isStepDone("k1", "append_livechat")).toBe(false); // 无该 step
  l.close();
});

it("isStepDone:同 step 再次 start(续跑重入)→ 最新为 start → false", () => {
  const l = fresh();
  l.upsertPending("k1");
  l.logStep("k1", "append_danmu", "start");
  l.logStep("k1", "append_danmu", "done");
  l.logStep("k1", "append_danmu", "start"); // 重入又开始
  expect(l.isStepDone("k1", "append_danmu")).toBe(false);
  l.close();
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm vitest run packages/orchestrator/src/ledger.test.ts`
Expected: FAIL(`l.setBv is not a function` / `l.isStepDone is not a function`)

- [ ] **Step 3: 实现 setBv + isStepDone**

在 `ledger.ts` 的 `markDone(...)` 方法**之后**插入:

```typescript
  /** checkpoint:P1 上传成功即落 bv 列(不改 state、不写事件)。续跑靠它判断"已建稿"。 */
  setBv(streamKey: string, bv: string): void {
    const at = this.now();
    this.db.prepare("UPDATE sync_jobs SET bv=?, updatedAt=? WHERE streamKey=?").run(bv, at, streamKey);
  }
```

在 `getSteps(...)` 方法**之后**插入:

```typescript
  /** 某 step 的最新事件是否为 done(续跑用:跳过已完成的 append 组)。无该 step 事件 → false。 */
  isStepDone(streamKey: string, step: StepName): boolean {
    const r = this.db
      .prepare("SELECT phase FROM sync_job_steps WHERE streamKey=? AND step=? ORDER BY at DESC, rowid DESC LIMIT 1")
      .get(streamKey, step) as { phase?: string } | undefined;
    return r?.phase === "done";
  }
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm vitest run packages/orchestrator/src/ledger.test.ts`
Expected: PASS(全绿)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/ledger.ts packages/orchestrator/src/ledger.test.ts
git commit -m "feat(orchestrator): SyncLedger 加 setBv(BV checkpoint)+ isStepDone(续跑判定)"
```

---

## Task 2: retry 纯函数工具

**Files:**
- Create: `packages/orchestrator/src/retry.ts`
- Test: `packages/orchestrator/src/retry.test.ts`

**Interfaces:**
- Produces:
  - `retry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T>` — 最多 `tries` 次调用 `fn`;每次失败后 `sleep(backoffMs * 2^(attempt-1))` 再试;全部失败抛**最后一次**的错误。`tries<=1` → 只调一次不重试。
  - `interface RetryOpts { tries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, err: unknown) => void }`
  - 默认:`tries=3`, `backoffMs=5000`, `sleep=setTimeout 包装`。

- [ ] **Step 1: 写失败测试**

新建 `packages/orchestrator/src/retry.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { retry } from "./retry.js";

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

describe("retry", () => {
  it("首次成功 → 只调一次", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await retry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("前两次失败第三次成功 → 共 3 次,返回成功值", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValue("ok");
    expect(await retry(fn, { tries: 3, sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("全部失败 → 抛最后一次错误,调用次数 = tries", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockRejectedValue(new Error("last"));
    await expect(retry(fn, { tries: 3, sleep: noSleep })).rejects.toThrow("last");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("tries<=1 → 只调一次,不重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retry(fn, { tries: 1, sleep: noSleep })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("退避:每次失败后 sleep 递增(backoffMs * 2^(n-1))", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValue("ok");
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => { sleeps.push(ms); return Promise.resolve(); };
    await retry(fn, { tries: 3, backoffMs: 100, sleep });
    expect(sleeps).toEqual([100, 200]); // 两次失败 → 两次退避
  });

  it("onRetry:每次重试前回调(attempt 从 1 计,即将第 attempt+1 次)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("e1")).mockResolvedValue("ok");
    const seen: number[] = [];
    await retry(fn, { tries: 3, sleep: noSleep, onRetry: (a) => seen.push(a) });
    expect(seen).toEqual([1]); // 第 1 次失败后回调一次
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm vitest run packages/orchestrator/src/retry.test.ts`
Expected: FAIL(找不到 `./retry.js` 模块)

- [ ] **Step 3: 实现 retry.ts**

新建 `packages/orchestrator/src/retry.ts`:

```typescript
export interface RetryOpts {
  /** 最大调用次数(含首次)。默认 3。<=1 则只调一次不重试。 */
  tries?: number;
  /** 首次退避 ms(第 n 次失败后等 backoffMs * 2^(n-1))。默认 5000。 */
  backoffMs?: number;
  /** 可注入 sleep(测试用)。默认 setTimeout 包装。 */
  sleep?: (ms: number) => Promise<void>;
  /** 每次失败(还会重试时)回调,attempt 从 1 计。 */
  onRetry?: (attempt: number, err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 有限次重试 + 指数退避。fn 成功即返回;全部失败抛**最后一次**错误。
 * 纯逻辑,不知道 fn 是什么——调用方负责保证 fn 幂等安全(见 pipeline:只包安全的单文件 append)。
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const tries = opts.tries ?? 3;
  const backoffMs = opts.backoffMs ?? 5000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= Math.max(1, tries); attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= tries) break;          // 用尽,跳出后抛
      opts.onRetry?.(attempt, err);
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm vitest run packages/orchestrator/src/retry.test.ts`
Expected: PASS(6 个全绿)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/retry.ts packages/orchestrator/src/retry.test.ts
git commit -m "feat(orchestrator): 加 retry 纯函数(有限次重试+指数退避,sleep 可注入)"
```

---

## Task 3: pipeline — P1 即落库 + append 就地重试 + 跳过已完成组

> 本 Task 只改**主路径**(P1 上传成功之后那段);续跑分支在 Task 4。改完后:同一次 pipeline 运行内,拿到 bv 立即落库,append 组失败会就地重试,且已 done 的组会被跳过(为 Task 4 续跑做准备,主路径上天然不会命中"已 done")。

**Files:**
- Modify: `packages/orchestrator/src/pipeline.ts`(`runPipelineInner` 尾部 append 段,约 line 296–322)
- Test: `packages/orchestrator/src/pipeline.test.ts`

**Interfaces:**
- Consumes: `ledger.setBv`, `ledger.isStepDone`(Task 1);`retry`(Task 2)。
- Produces: 主路径行为不变(仍产出 `{state:"done", bv}`),但 ① `setBv` 在 append 前已落库;② 每个 `appendGroup` 经 `retry` 包裹(单文件组 tries=3、多段组 tries=1);③ 循环内 `isStepDone` 命中则跳过该组。

**Notes(分 P 幂等边界):** biliup 只在文件**完整上传 + 提交**后才把它加成一个分 P;单文件组 append 中途失败 ⇒ 没有分 P 被加入 ⇒ 就地重试安全。多段组(>16GB,罕见:单版本视频超 16GB≈4h+)若在两段之间失败,重试可能重复已加入的分 P → 故多段组 `tries=1` 不就地重试(退回 reconciler 级,行为不比现状差)。

- [ ] **Step 1: 写失败测试(setBv 落库 + append 就地重试 + 跳过已 done)**

在 `pipeline.test.ts` 追加(沿用文件顶部的 `makeDeps`/`makeBroadcast`/`makeRec`;注意 `makeDeps` 里 `uploadMode` 需设 `"upload"`,若默认不是则在 `overrides.cfg` 覆盖):

```typescript
it("P1 上传成功后立即 setBv 落库(append 之前 job.bv 已存在)", async () => {
  const deps = makeDeps({ cfg: { ...baseCfg(), uploadMode: "upload" } });
  // appendGroup 里断言:被调用时 ledger 里已有 bv
  deps.appendGroup.mockImplementation(async () => {
    expect(deps.ledger.get(BROADCAST_KEY)?.bv).toBe("BV123");
  });
  await runPipeline(makeBroadcast([{ workerId: "node-1", rec: makeRec() }]), deps);
  expect(deps.ledger.get(BROADCAST_KEY)?.bv).toBe("BV123");
});

it("appendGroup 单文件组瞬时失败 → 就地重试后成功(不新建稿)", async () => {
  const deps = makeDeps({ cfg: { ...baseCfg(), uploadMode: "upload" } });
  deps.appendGroup
    .mockRejectedValueOnce(new Error("Connection timed out"))
    .mockResolvedValue(undefined);
  const r = await runPipeline(makeBroadcast([{ workerId: "node-1", rec: makeRec() }]), deps);
  expect(deps.uploadPlain).toHaveBeenCalledTimes(1);            // 绝不重传 P1
  expect(deps.appendGroup.mock.calls.length).toBeGreaterThanOrEqual(2); // 至少重试一次
  expect(r.state).toBe("done");
});

it("append 循环跳过 isStepDone 已完成的组(续跑幂等基石)", async () => {
  const deps = makeDeps({ cfg: { ...baseCfg(), uploadMode: "upload" } });
  // 预置:danmu 组已 done
  deps.ledger.upsertPending(BROADCAST_KEY);
  deps.ledger.logStep(BROADCAST_KEY, "append_danmu", "start");
  deps.ledger.logStep(BROADCAST_KEY, "append_danmu", "done");
  await runPipeline(makeBroadcast([{ workerId: "node-1", rec: makeRec() }]), deps);
  // appendGroup 被调用的文件里不含 danmu 版(被跳过),只含 livechat
  const appended = deps.appendGroup.mock.calls.map((c) => c[0].files.join(",")).join("|");
  expect(appended).not.toContain("_danmu.mp4");
  expect(appended).toContain("_livechat.mp4");
});
```

> 若 `pipeline.test.ts` 尚无 `baseCfg()`/`BROADCAST_KEY` 辅助,在文件顶部辅助区加:
> ```typescript
> const BROADCAST_KEY = "douyin:test-room:2026-06-27"; // = makeBroadcast 的 streamKey
> function baseCfg() {
>   return { cleanMaxGapSec: 30, stageDir: "/tmp/stage", cookies: "/tmp/c.json",
>     uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 } };
> }
> ```
> (若已存在等价物,复用,勿重复定义。)

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm vitest run packages/orchestrator/src/pipeline.test.ts`
Expected: FAIL(setBv 未在 append 前调用 / 无重试 / 未跳过已 done 组)

- [ ] **Step 3: 实现主路径改动**

在 `pipeline.ts` 顶部 import 区加:

```typescript
import { retry } from "./retry.js";
```

把 `const bv = r.bv;`(约 line 303)之后**立即**加落库:

```typescript
  const bv = r.bv;
  jlog(`P1 上传完成: ${bv}`);
  ledger.setBv(streamKey, bv);   // checkpoint:此刻烧录已完成 ⇒ bv 落库 ⟺ 产物齐全,续跑可复用
```

把 append 循环(约 line 310–320)改为**跳过已 done + 单文件组就地重试**:

```typescript
  for (const g of appendGroups) {
    if (g.files.length === 0) continue;                 // 关掉的步骤 → 空组
    if (ledger.isStepDone(streamKey, g.step)) {         // 续跑:已完成的组跳过(幂等)
      jlog(`append 跳过(已完成): ${g.step}`);
      continue;
    }
    jlog(`append 开始: ${g.files.map((f) => path.basename(f)).join(", ")}`);
    const tApp = Date.now();
    ledger.logStep(streamKey, g.step, "start");
    // 单文件组就地重试安全(biliup 完整上传才加分 P);多段组 tries=1(避免跨调用重复分 P,见计划 Notes)
    const tries = g.files.length === 1 ? 3 : 1;
    await retry(() => appendGroup({ bv, files: g.files, cookies: cfg.cookies, public: isPublic }), {
      tries,
      onRetry: (attempt, err) =>
        jlog(`append ${g.step} 第 ${attempt} 次失败,重试: ${String((err as Error)?.message ?? err).slice(0, 200)}`),
    });
    const apBytes = sumBytes(g.files);
    ledger.logStep(streamKey, g.step, "done", `${g.files.length} 段${apBytes > 0 ? ` · ${humanBytes(apBytes)}` : ""}`);
    jlog(`append 完成(${Math.round((Date.now() - tApp) / 1000)}s)`);
  }
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm vitest run packages/orchestrator/src/pipeline.test.ts`
Expected: PASS(含新加 3 个 + 原有全绿)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/pipeline.ts packages/orchestrator/src/pipeline.test.ts
git commit -m "feat(orchestrator): pipeline P1 成功即落 BV + append 单文件组就地重试 + 跳过已完成组"
```

---

## Task 4: pipeline — 续跑分支(有 BV 则跳过前段,只补 append)

**Files:**
- Modify: `packages/orchestrator/src/pipeline.ts`(`runPipelineInner`:stageSub 计算上移 + 入口续跑分支)
- Test: `packages/orchestrator/src/pipeline.test.ts`

**Interfaces:**
- Consumes: `ledger.get`(读 `bv`)、`ledger.isStepDone`、`ledger.markDone`、`ledger.setState`、`retry`、`splitForUpload`、`appendGroup`、`notify`。
- Produces: `runPipelineInner` 入口若 `job.bv` 已存在 → 走 `resumeAppends`:不 select/pull/merge/burn/uploadPlain,直接补没做完的 append;产物齐全 → `markDone` 返回 `{state:"done", bv}`;产物缺失 → `needs_manual` 返回。

**Notes:** 续跑**只做 append + stageAfterDone 清理**,不做 `sourceAfterDone`(删各 slave 节点 .ts)——续跑无 select 结果、拿不到成员清单;这些 .ts 残留可接受(极少发生,下次归档/人工清)。此限制写进 jlog。

- [ ] **Step 1: 写失败测试(续跑 / 产物缺失 → needs_manual / 不重传 P1)**

在 `pipeline.test.ts` 追加。需要在 stageSub 目录里放置假产物文件让续跑找到:

```typescript
import { mkdirSync, writeFileSync } from "node:fs";

it("续跑:job 已有 bv → 跳过 uploadPlain,只补没做完的 append,最后 markDone", async () => {
  const stageDir = mkdtempSync(join(tmpdir(), "resume-stage-"));
  const deps = makeDeps({ cfg: { ...baseCfg(), stageDir, uploadMode: "upload" } });
  // 预置:job 已建稿 + danmu 已 append 完
  deps.ledger.upsertPending(BROADCAST_KEY);
  deps.ledger.setState(BROADCAST_KEY, "uploading");
  deps.ledger.setBv(BROADCAST_KEY, "BVexisting");
  deps.ledger.logStep(BROADCAST_KEY, "append_danmu", "start");
  deps.ledger.logStep(BROADCAST_KEY, "append_danmu", "done");
  // 预置 stage 产物(dateName = makeRec().sessionBase 去掉 _HH-MM-SS)
  const dateName = "主播名_2026-06-27";
  const sub = join(stageDir, "douyin_test-room_2026-06-27");
  mkdirSync(sub, { recursive: true });
  for (const suf of [".mp4", "_danmu.mp4", "_livechat.mp4", ".xml"]) writeFileSync(join(sub, dateName + suf), "x");

  const r = await runPipeline(makeBroadcast([{ workerId: "node-1", rec: makeRec() }]), deps);

  expect(deps.uploadPlain).not.toHaveBeenCalled();      // 绝不重传 P1(防重核心)
  expect(deps.sh).not.toHaveBeenCalled();               // 不 merge/burn
  const appended = deps.appendGroup.mock.calls.map((c) => c[0].files.join(",")).join("|");
  expect(appended).not.toContain("_danmu.mp4");         // danmu 已 done,跳过
  expect(appended).toContain("_livechat.mp4");          // 只补 livechat
  expect(deps.appendGroup.mock.calls.every((c) => c[0].bv === "BVexisting")).toBe(true);
  expect(r).toEqual({ state: "done", bv: "BVexisting" });
  expect(deps.ledger.get(BROADCAST_KEY)?.state).toBe("done");
});

it("续跑:有 bv 但 stage 产物缺失 → needs_manual + 通知,绝不重传", async () => {
  const stageDir = mkdtempSync(join(tmpdir(), "resume-missing-"));
  const deps = makeDeps({ cfg: { ...baseCfg(), stageDir, uploadMode: "upload" } });
  deps.ledger.upsertPending(BROADCAST_KEY);
  deps.ledger.setBv(BROADCAST_KEY, "BVexisting");
  // 不创建任何 stage 产物文件

  const r = await runPipeline(makeBroadcast([{ workerId: "node-1", rec: makeRec() }]), deps);

  expect(deps.uploadPlain).not.toHaveBeenCalled();
  expect(deps.appendGroup).not.toHaveBeenCalled();
  expect(r.state).toBe("needs_manual");
  expect(deps.ledger.get(BROADCAST_KEY)?.state).toBe("needs_manual");
  expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm vitest run packages/orchestrator/src/pipeline.test.ts`
Expected: FAIL(续跑分支不存在 → 走了 select/uploadPlain)

- [ ] **Step 3: 实现续跑分支**

在 `pipeline.ts` 顶部 import 区补齐(若缺):

```typescript
import { existsSync, readdirSync } from "node:fs";
```

在 `runPipelineInner` **开头**(`const { streamKey } = b;` 之后、`#1 防护` 之前)加:先算 stageSub,再判断续跑。

```typescript
  const { streamKey } = b;
  const stageSub = path.join(cfg.stageDir, sanitizeKey(streamKey));

  // 续跑:job 已有 bv ⇒ P1 已建稿(不可逆),绝不重传。跳过 select/pull/merge/burn/uploadPlain,只补 append。
  const existing = ledger.get(streamKey);
  if (cfg.uploadMode === "upload" && existing?.bv) {
    return await resumeAppends(streamKey, existing.bv, stageSub, deps, jlog);
  }
```

> **注意:** 原代码在 line 177 附近还有一处 `const stageSub = path.join(...)`,**删除那一行**(现在入口已声明,重复声明会编译报错)。其余用到 `stageSub` 的代码不变。

在 `runPipelineInner` 函数**之后**(文件尾部)新增续跑函数:

```typescript
/** 从 stageSub 目录按确定命名反推产物路径;找不到任何产物 → null。 */
function deriveProducts(stageSub: string): { dateName: string; plain: string; danmuMp4: string; livechatMp4: string } | null {
  let files: string[];
  try { files = readdirSync(stageSub); } catch { return null; }
  const danmu = files.find((f) => f.endsWith("_danmu.mp4"));
  const livechat = files.find((f) => f.endsWith("_livechat.mp4"));
  const plainF = files.find((f) => f.endsWith(".mp4") && !f.endsWith("_danmu.mp4") && !f.endsWith("_livechat.mp4"));
  let dateName: string | undefined;
  if (danmu) dateName = danmu.slice(0, -"_danmu.mp4".length);
  else if (livechat) dateName = livechat.slice(0, -"_livechat.mp4".length);
  else if (plainF) dateName = plainF.slice(0, -".mp4".length);
  if (!dateName) return null;
  return {
    dateName,
    plain: path.join(stageSub, dateName + ".mp4"),
    danmuMp4: path.join(stageSub, dateName + "_danmu.mp4"),
    livechatMp4: path.join(stageSub, dateName + "_livechat.mp4"),
  };
}

/**
 * 续跑:已建稿(bv 已落库),只补没做完的 append。产物齐全 → markDone;缺失 → needs_manual。
 * 不做 sourceAfterDone(无成员清单),只做 append + 可选 stageAfterDone 清理。
 */
async function resumeAppends(
  streamKey: string,
  bv: string,
  stageSub: string,
  deps: PipelineDeps,
  jlog: (msg: string) => void,
): Promise<{ state: JobState; bv?: string }> {
  const { ledger, appendGroup, notify, cfg } = deps;
  jlog(`续跑:已建稿 bv=${bv},跳过 select/pull/merge/burn/uploadPlain,只补 append(不做 sourceAfterDone 清理)`);
  const splitForUpload = deps.splitForUpload ?? ((mp4: string) => splitToSizeLimit(mp4));
  const burnDanmu = cfg.steps?.burnDanmu !== false;
  const burnLivechat = cfg.steps?.burnLivechat !== false;
  const isPublic = cfg.uploadPrivate === false;

  const prod = deriveProducts(stageSub);
  const need = [
    ...(burnDanmu ? [prod?.danmuMp4] : []),
    ...(burnLivechat ? [prod?.livechatMp4] : []),
  ].filter((f): f is string => !!f);
  if (!prod || need.some((f) => !existsSync(f))) {
    jlog(`续跑失败:stage 产物缺失(可能已清理),转人工。need=${JSON.stringify(need)}`);
    ledger.setState(streamKey, "needs_manual", { error: `续跑失败:bv=${bv} 但 stage 产物缺失,请人工补 append` });
    notify({ kind: "error", stage: "上传", message: `续跑失败:${bv} 产物缺失,请人工处理(补 append 或删稿重来)` });
    return { state: "needs_manual", bv };
  }

  const groups: Array<{ step: "append_danmu" | "append_livechat"; mp4: string; on: boolean }> = [
    { step: "append_danmu", mp4: prod.danmuMp4, on: burnDanmu },
    { step: "append_livechat", mp4: prod.livechatMp4, on: burnLivechat },
  ];
  for (const g of groups) {
    if (!g.on) continue;
    if (ledger.isStepDone(streamKey, g.step)) { jlog(`append 跳过(已完成): ${g.step}`); continue; }
    const files = await splitForUpload(g.mp4);
    if (files.length === 0) continue;
    jlog(`续跑 append 开始: ${g.step} (${files.length} 段)`);
    ledger.logStep(streamKey, g.step, "start");
    const tries = files.length === 1 ? 3 : 1;
    await retry(() => appendGroup({ bv, files, cookies: cfg.cookies, public: isPublic }), {
      tries,
      onRetry: (attempt, err) => jlog(`续跑 append ${g.step} 第 ${attempt} 次失败,重试: ${String((err as Error)?.message ?? err).slice(0, 200)}`),
    });
    ledger.logStep(streamKey, g.step, "done", `${files.length} 段`);
    jlog(`续跑 append 完成: ${g.step}`);
  }

  ledger.markDone(streamKey, bv);
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });

  // 可选:done 后删 stage 产物(与主路径同一开关;续跑不删 slave 源)。
  if (cfg.cleanup?.stageAfterDone) {
    const rmStage = deps.rmStage ?? (async (paths: string[]) => {
      const { rmSync } = await import("node:fs");
      for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } }
    });
    const products = [prod.plain, prod.danmuMp4, prod.livechatMp4];
    const xmlAss = cfg.cleanup?.includeXmlAss
      ? [path.join(stageSub, prod.dateName + ".xml"),
         prod.danmuMp4.replace(/\.mp4$/, ".ass"), prod.livechatMp4.replace(/\.mp4$/, ".ass")]
      : [];
    ledger.logStep(streamKey, "clean_stage", "start");
    await rmStage([...products, ...xmlAss]);
    ledger.logStep(streamKey, "clean_stage", "done", `删 ${products.length + xmlAss.length} 文件`);
  }
  return { state: "done", bv };
}
```

> `resumeAppends` 用到的 `retry`/`splitToSizeLimit`/`existsSync`/`readdirSync`/`JobState` 均已在文件 import(Task 3 加了 retry;`splitToSizeLimit` 已有;`JobState` 已有类型 import)。确认 import 齐全再编译。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm vitest run packages/orchestrator/src/pipeline.test.ts`
Expected: PASS(续跑 2 个 + 之前全绿)

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 无错误(重点看 stageSub 重复声明已删、import 齐全)

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/pipeline.ts packages/orchestrator/src/pipeline.test.ts
git commit -m "feat(orchestrator): pipeline 续跑分支(有 BV 则跳过前段只补 append;产物缺失转 needs_manual)"
```

---

## Task 5: reconciler — N 次失败升级 needs_manual + 通知

**Files:**
- Modify: `packages/orchestrator/src/reconciler.ts`(约 line 208–209 的 `fails >= maxRetries` 分支;`ReconcilerDeps` 加可选 `notify`)
- Test: `packages/orchestrator/src/reconciler.test.ts`

**Interfaces:**
- Consumes: `ledger.setState`、`ledger.get`;新增可选 `deps.notify?: (e: NotifyEvent) => void`。
- Produces: `fails >= maxRetries` 且当前 state 仍为 `failed` → 转 `needs_manual`(终态)+ 调一次 `notify({kind:"error", stage:"同步", ...})`;已是 `needs_manual` → 直接跳过(不重复通知)。

- [ ] **Step 1: 写失败测试**

在 `reconciler.test.ts` 追加(沿用该文件既有的 reconciler 构造辅助;若需 notify,传入 mock):

```typescript
it("failed 且 fails>=maxRetries → 升级 needs_manual + 通知一次,不再重入 pipeline", async () => {
  const { ledger, deps, runPipelineMock } = makeReconcilerCase(); // 沿用文件既有工厂;若无则见下方说明
  const notify = vi.fn();
  const key = "douyin:test-room:2026-06-27";
  // 预置:已 failed 且 fails 达上限
  ledger.upsertPending(key);
  ledger.markFailed(key, "boom");  // fails=1
  ledger.markFailed(key, "boom");  // fails=2
  ledger.markFailed(key, "boom");  // fails=3 = maxRetries 默认

  const rec = new Reconciler({ ...deps, notify, maxRetries: 3 });
  await rec.reconcileAll();

  expect(ledger.get(key)?.state).toBe("needs_manual");
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  expect(runPipelineMock).not.toHaveBeenCalled(); // 不再重试
});

it("已是 needs_manual → 跳过,不重复通知", async () => {
  const { ledger, deps } = makeReconcilerCase();
  const notify = vi.fn();
  const key = "douyin:test-room:2026-06-27";
  ledger.upsertPending(key);
  ledger.setState(key, "needs_manual");
  const rec = new Reconciler({ ...deps, notify, maxRetries: 3 });
  await rec.reconcileAll();
  expect(notify).not.toHaveBeenCalled();
});
```

> **说明:** `reconciler.test.ts` 已有构造 Reconciler + 让某 broadcast 出现在 inventory 的既有模式(见文件内现有用例)。若没有 `makeReconcilerCase` 工厂,直接复用文件里现成的 transports/ledger 构造代码;关键是让被测 broadcast 的 streamKey 与预置 job 的 key 一致(需让 transport 的 `listInventory` 返回能聚成该 streamKey 的录像,或复用现有用例已铺好的那套)。以现有测试里"能触发 pipeline 的那组 inventory"为模板改造。

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm vitest run packages/orchestrator/src/reconciler.test.ts`
Expected: FAIL(状态仍是 failed,notify 未被调)

- [ ] **Step 3: 实现升级逻辑**

在 `reconciler.ts` 的 `ReconcilerDeps` 接口加(在 `maxRetries?` 附近):

```typescript
  /** 达重试上限升级 needs_manual 时发一次通知(webhook/UI)。省略 → 只转状态不通知。 */
  notify?: (e: import("@drec/core").NotifyEvent) => void;
```

在类里加字段 + 构造赋值:

```typescript
  private notify?: (e: import("@drec/core").NotifyEvent) => void;
  // ↓ 构造函数内
    this.notify = deps.notify;
```

把 `reconcileAll` 里这两行(约 line 208–209):

```typescript
        // failed 且已达重试上限 → 放弃自动重试(留 failed 供人工/诊断),不再重入。
        if (job?.state === "failed" && (job.fails ?? 0) >= this.maxRetries) continue;
```

改为:

```typescript
        // failed 且已达重试上限 → 升级 needs_manual(终态)+ 通知一次人工,不再重入。
        if (job?.state === "failed" && (job.fails ?? 0) >= this.maxRetries) {
          this.ledger.setState(b.streamKey, "needs_manual", { error: job.error ?? "达重试上限" });
          this.notify?.({
            kind: "error",
            stage: "同步",
            message: `${b.streamKey} 上传重试 ${job.fails} 次仍失败,已转人工(needs_manual)。最后错误:${(job.error ?? "").slice(0, 200)}`,
          });
          continue;
        }
```

> `needs_manual` 已是 `reconcileAll` 顶部 `Skip terminal states`(line 206:`done`/`needs_manual` → continue)覆盖的终态,故升级后下一轮自动跳过、不会重复通知。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm vitest run packages/orchestrator/src/reconciler.test.ts`
Expected: PASS

- [ ] **Step 5: 接线 CLI 注入 notify(让线上真的发通知)**

在 `packages/cli/src/cli.ts` 的 `new Reconciler({...})`(约 line 576)处,补传 `notify`(复用 pipeline 已用的同一个 EventCenter notify;查该文件里 `pipelineDeps.notify` 或等价 notify 来源,传同一个):

```typescript
    const reconciler = new Reconciler({
      // …现有字段…
      notify: pipelineDeps.notify,   // 与 pipeline 同源:EventCenter → 站内 toast + Discord webhook
    });
```

> 若 `pipelineDeps` 变量名不同,按该文件实际的 notify 来源传;目标是复用现有通知通道,不新建。

- [ ] **Step 6: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/reconciler.ts packages/orchestrator/src/reconciler.test.ts packages/cli/src/cli.ts
git commit -m "feat(orchestrator,hub): 重试达上限升级 needs_manual + 通知人工(替代静默 failed)"
```

---

## Task 6: bundle + 部署验证(docker master)

**Files:** 无源码改动(打包 + 冒烟)。

- [ ] **Step 1: 打包**

Run: `pnpm bundle`
Expected: 生成 `dist/douyin-rec.mjs`,无报错。

- [ ] **Step 2: 部署到 docker master 并重启 hub**

将新 `dist/douyin-rec.mjs` 部署进 `douyin-rec` 容器(按现有部署方式:镜像 rebuild 或挂载卷同步),重启 `task serve --hub` 进程。

- [ ] **Step 3: 冒烟——构造一次 append 失败后的续跑**

在测试 streamKey 上:观察日志出现 `续跑:已建稿 bv=… 跳过 … 只补 append`,确认 **`uploadPlain` 不被再调**、`sync_jobs.bv` 在 append 前已非空、最终 `state=done` 且**只有一个 BV**(B站创作中心核对无重复稿)。

- [ ] **Step 4: 重新启用之前禁掉的房间配置**

确认线上遗留的 `douyin:767116735823:*` 那场已 `done`(手动救火完成)后,把 `config/hub/douyin.767116735823.json` 的 `enabled` 改回 `true`。

---

## Self-Review

**1. Spec coverage:**
- BV 立即落库(checkpoint)→ Task 1(`setBv`)+ Task 3(P1 后调用)✓
- 上传前防重(有 bv 绝不重传)→ Task 4(续跑分支跳过 uploadPlain)✓
- 续跑分支(跳过已完成、补缺失 append)→ Task 4 + Task 1(`isStepDone`)✓
- 产物缺失安全阀 → needs_manual → Task 4 ✓
- 就地重试(只 append、单文件组)→ Task 2(`retry`)+ Task 3 ✓
- uploadPlain 不就地重试(防重复稿)→ Task 3 仅包 appendGroup,未包 uploadPlain ✓
- N 次失败 → needs_manual + 通知 → Task 5 ✓
- 测试全走注入式、不碰真 biliup → 各 Task 用 mock deps ✓

**2. Placeholder scan:** 无 TBD/TODO;每个改动步骤都给了完整代码。Task 5 Step 1 对 `reconciler.test.ts` 既有工厂做了"复用现有模式"的说明(因该文件工厂命名需以实际为准),非占位——实现时以文件现状为模板。

**3. Type consistency:** `setBv(streamKey,bv)`、`isStepDone(streamKey,step)`、`retry(fn,opts)`、`resumeAppends(...)`、`deriveProducts(...)` 全计划内一致;`StepName`/`JobState`/`NotifyEvent` 均复用现有类型。`append_danmu`/`append_livechat` 步名与既有 `StepName` 一致。

**已知限制(设计接受,非缺口):**
- 多段组(>16GB 单版本,≈4h+ 直播)append 中途失败 + 续跑可能重复分 P → 故多段组 `tries=1` 不就地重试;若真发生由 needs_manual 兜底人工。
- 续跑不做 `sourceAfterDone`(删 slave .ts)——续跑无成员清单;残留 .ts 可接受,由归档/人工清。
