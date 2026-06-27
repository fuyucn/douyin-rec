# 多节点同步编排 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现在手动的每日同步（拉取 → 选优 → 合并/烧录 → 分P 上传）自动化、多节点化：master 共录节点在某场真下播后，跨所有节点挑覆盖最全的一份，同步、合并、烧录、按 P1→append 投稿；无干净版本则 webhook 交人工。

**Architecture:** 新增 `@drec/orchestrator` 包，承载 Transport 轴（local/ssh/tailscale-ssh + 注册表）、识别一致性（roomSlug + 时间窗聚类 → streamKey）、覆盖度选优、`sync_jobs` sqlite 台账（幂等可续）、对账引擎与流水线。重活复用：merge/burn 经 **shell 调现有 CLI**，upload 经 biliup（新增 P1→append）。集成进 `task serve --hub`：触发 = 观察 `manager.isRecording` 翻转到 false 且**持续过 settle 窗口**（抖动会自行恢复 true→取消），外加周期兜底对账。

**Tech Stack:** Node 24（`node:sqlite` 内置）· TypeScript · pnpm workspace · vitest · esbuild。复用 `@drec/post-process`（mergeSessions/burn，经 CLI 调）、`@drec/app`（EventCenter/store/biliup upload）、ssh/rsync over tailscale。

## Global Constraints

- **依赖只能向下**：`@drec/orchestrator` 依赖 core(0)/post-process(0)/app(4)，rank=4.5；cli(5) 依赖它。**必须在 `test/arch/layering.test.ts` 的 `RANKS` 登记**，否则 arch 测试失败。
- **录制必须 `node dist` 不能 tsx**（douyin-live 的 sm-crypto interop）；故 orchestrator **不得 import `douyin-live`**——「房间在播吗」一律经 Transport 问 slave，不在 master 直查平台。orchestrator 在 vitest 里可被 import（纯逻辑 + 注入式 IO）。
- **永不删 `.xml`/`.ass`**（hook 会弹确认）；清理只删 `.ts`/`.mp4`。
- **B站上传**：仅自己可见（`--is-only-self 1`）+ 关水印（`--extra-fields '{"watermark":{"state":0}}'`）+ copyright 1 + tid 21；cookie = `<DOUYIN_REC_ROOT>/config/biliup/cookies.json`；**分P 用 P1 plain upload 拿 BV → `biliup append --vid <BV>` 追加 P2 danmu/P3 livechat**，不再单次 `upload a b c`。
- **就近单测**：纯包单测放 `packages/orchestrator/src/*.test.ts`；跨包集成测试放 `test/`。
- **提交规范**：约定式提交，中文描述，无 AI 署名 trailer。
- **commit 命令**：每个任务末尾 `git add` 仅本任务文件。

---

### Task 1: 新包脚手架 `@drec/orchestrator` + 分层登记

**Files:**
- Create: `packages/orchestrator/package.json`
- Create: `packages/orchestrator/tsconfig.json`
- Create: `packages/orchestrator/src/index.ts`
- Modify: `test/arch/layering.test.ts`（`RANKS` 加一行）

**Interfaces:**
- Produces: 包名 `@drec/orchestrator`；`src/index.ts` 暂空导出 `export const ORCHESTRATOR = true;`

- [ ] **Step 1: 写失败测试**（分层测试已存在，先让它因「新包未登记」而失败）

新建包后 `pnpm test -- layering` 会报「新增包未定层」。这一步即「制造失败」，无需新测试文件。

- [ ] **Step 2: 建 package.json**

```json
{
  "name": "@drec/orchestrator",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@drec/core": "workspace:*",
    "@drec/app": "workspace:*",
    "@drec/post-process": "workspace:*"
  }
}
```

- [ ] **Step 3: tsconfig.json**（照搬其它包，如 `packages/app/tsconfig.json` 内容）

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
（若仓库无 `tsconfig.base.json`，复制 `packages/manager/tsconfig.json` 的内容。先 `cat packages/manager/tsconfig.json` 对齐。）

- [ ] **Step 4: index.ts 占位**

```ts
export const ORCHESTRATOR = true;
```

- [ ] **Step 5: 登记 RANKS**

在 `test/arch/layering.test.ts` 的 `RANKS` 对象内，`"@drec/app": 4,` 之后加：

```ts
  "@drec/orchestrator": 4.5,
```

- [ ] **Step 6: 验证 + 提交**

Run: `pnpm install && pnpm test -- layering`
Expected: 分层测试 PASS（新包已登记、依赖均 < 4.5）。

```bash
git add packages/orchestrator/package.json packages/orchestrator/tsconfig.json packages/orchestrator/src/index.ts test/arch/layering.test.ts pnpm-lock.yaml
git commit -m "feat(orchestrator): 新包脚手架 + 分层登记(rank 4.5)"
```

---

### Task 2: Transport 接口 + 注册表 + 类型

**Files:**
- Create: `packages/orchestrator/src/transport.ts`
- Create: `packages/orchestrator/src/transport.test.ts`
- Modify: `packages/orchestrator/src/index.ts`

**Interfaces:**
- Produces:
  - `interface NodeRecording { roomSlug: string; sessionBase: string; tsFiles: string[]; xmlPath?: string; durationSec: number; startMs: number; endMs: number; totalGapSec: number; }`
  - `interface NodeInventory { tenantId: string; recordings: NodeRecording[]; }`
  - `interface Transport { id: string; listInventory(): Promise<NodeInventory>; isDone(roomSlug: string): Promise<boolean>; pull(remotePaths: string[], localDir: string): Promise<void>; }`
  - `registerTransport(kind: string, factory: (cfg: TenantConfig) => Transport): void`
  - `getTransport(cfg: TenantConfig): Transport`（kind 未注册抛错）
  - `interface TenantConfig { id: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string; }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/orchestrator/src/transport.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerTransport, getTransport, _resetTransports } from "./transport.js";

describe("transport registry", () => {
  beforeEach(() => _resetTransports());
  it("注册后能按 kind 取到，cfg 透传", () => {
    registerTransport("fake", (cfg) => ({
      id: cfg.id, async listInventory() { return { tenantId: cfg.id, recordings: [] }; },
      async isDone() { return true; }, async pull() {},
    }));
    const t = getTransport({ id: "n1", kind: "fake" });
    expect(t.id).toBe("n1");
  });
  it("未注册 kind 抛错", () => {
    expect(() => getTransport({ id: "x", kind: "nope" })).toThrow(/未注册|unknown/i);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- transport`
Expected: FAIL（`./transport.js` 模块不存在）。

- [ ] **Step 3: 实现 transport.ts**

```ts
// packages/orchestrator/src/transport.ts
export interface TenantConfig { id: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string; }

export interface NodeRecording {
  roomSlug: string;
  sessionBase: string;       // 如 一勺小苏打_2026-06-27_07-54-33
  tsFiles: string[];         // 绝对/相对该节点路径
  xmlPath?: string;
  durationSec: number;       // 实录总时长(各段之和)
  startMs: number;           // 首段开录 epoch ms
  endMs: number;             // 末段收录 epoch ms
  totalGapSec: number;       // 断流缺口总秒数(来自 gaps sidecar)
}
export interface NodeInventory { tenantId: string; recordings: NodeRecording[]; }

export interface Transport {
  readonly id: string;
  listInventory(): Promise<NodeInventory>;
  isDone(roomSlug: string): Promise<boolean>;
  pull(remotePaths: string[], localDir: string): Promise<void>;
}

type Factory = (cfg: TenantConfig) => Transport;
const registry = new Map<string, Factory>();

export function registerTransport(kind: string, factory: Factory): void { registry.set(kind, factory); }
export function getTransport(cfg: TenantConfig): Transport {
  const f = registry.get(cfg.kind);
  if (!f) throw new Error(`未注册的 transport kind: ${cfg.kind}`);
  return f(cfg);
}
/** 测试用：清空注册表。 */
export function _resetTransports(): void { registry.clear(); }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- transport`
Expected: PASS（2 tests）。

- [ ] **Step 5: index 导出 + 提交**

`index.ts` 加 `export * from "./transport.js";`（删掉占位 ORCHESTRATOR）。

```bash
git add packages/orchestrator/src/transport.ts packages/orchestrator/src/transport.test.ts packages/orchestrator/src/index.ts
git commit -m "feat(orchestrator): Transport 接口 + 注册表 + 清单类型"
```

---

### Task 3: 缺口 sidecar 读取 + 类型

**Files:**
- Create: `packages/orchestrator/src/gaps.ts`
- Create: `packages/orchestrator/src/gaps.test.ts`

**Interfaces:**
- Produces:
  - `interface GapsSidecar { sessionBase: string; gaps: { startMs: number; endMs: number }[]; totalGapSec: number; }`
  - `readGaps(jsonPath: string): GapsSidecar | null`（不存在/损坏 → null）
  - `totalGapSecOf(gaps: {startMs:number;endMs:number}[]): number`

- [ ] **Step 1: 写失败测试**

```ts
// packages/orchestrator/src/gaps.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGaps, totalGapSecOf } from "./gaps.js";

describe("gaps sidecar", () => {
  it("totalGapSecOf 累加区间秒数", () => {
    expect(totalGapSecOf([{ startMs: 0, endMs: 10_000 }, { startMs: 20_000, endMs: 25_000 }])).toBe(15);
  });
  it("readGaps 解析合法文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaps-"));
    const p = join(dir, "s.gaps.json");
    writeFileSync(p, JSON.stringify({ sessionBase: "s", gaps: [{ startMs: 0, endMs: 5000 }], totalGapSec: 5 }));
    expect(readGaps(p)?.totalGapSec).toBe(5);
  });
  it("缺失/损坏 → null", () => {
    expect(readGaps("/no/such.json")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- gaps` → FAIL（模块不存在）。

- [ ] **Step 3: 实现 gaps.ts**

```ts
// packages/orchestrator/src/gaps.ts
import { readFileSync } from "node:fs";

export interface GapInterval { startMs: number; endMs: number; }
export interface GapsSidecar { sessionBase: string; gaps: GapInterval[]; totalGapSec: number; }

export function totalGapSecOf(gaps: GapInterval[]): number {
  return Math.round(gaps.reduce((s, g) => s + Math.max(0, g.endMs - g.startMs), 0) / 1000);
}

export function readGaps(jsonPath: string): GapsSidecar | null {
  try {
    const d = JSON.parse(readFileSync(jsonPath, "utf-8")) as GapsSidecar;
    if (!Array.isArray(d.gaps)) return null;
    return { sessionBase: d.sessionBase ?? "", gaps: d.gaps, totalGapSec: d.totalGapSec ?? totalGapSecOf(d.gaps) };
  } catch { return null; }
}
```

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- gaps` → PASS（3 tests）。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/gaps.ts packages/orchestrator/src/gaps.test.ts
git commit -m "feat(orchestrator): 缺口 sidecar 读取 + 总缺口计算"
```

---

### Task 4: 识别一致性 — roomSlug 时间窗聚类 → streamKey

**Files:**
- Create: `packages/orchestrator/src/identity.ts`
- Create: `packages/orchestrator/src/identity.test.ts`

**Interfaces:**
- Consumes: `NodeRecording`（Task 2）
- Produces:
  - `interface Broadcast { streamKey: string; roomSlug: string; startMs: number; members: { tenantId: string; rec: NodeRecording }[]; }`
  - `clusterBroadcasts(platform: string, byTenant: { tenantId: string; recordings: NodeRecording[] }[], overlapToleranceMs?: number): Broadcast[]`
  - 同 roomSlug、时间窗 `[startMs,endMs]` 重叠（或起点差 ≤ tolerance，默认 5min）的录像聚为一簇；`streamKey = \`${platform}:${roomSlug}:${YYYY-MM-DD}\``，同日多场则追加 `_HHMM`（取簇内最早 startMs，UTC→本地按 master 时区格式化时用固定 `Intl` 以免测试漂移，这里用 epoch→`new Date(startMs)` 提取——**注意：脚本环境禁用 argless new Date()，但 `new Date(ms)` 合法**）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/orchestrator/src/identity.test.ts
import { describe, it, expect } from "vitest";
import { clusterBroadcasts } from "./identity.js";
import type { NodeRecording } from "./transport.js";

const rec = (over: Partial<NodeRecording>): NodeRecording => ({
  roomSlug: "411", sessionBase: "s", tsFiles: [], durationSec: 100,
  startMs: 0, endMs: 100_000, totalGapSec: 0, ...over,
});

describe("clusterBroadcasts", () => {
  it("同房间、开录差15s → 同一簇(同 streamKey)", () => {
    const out = clusterBroadcasts("douyin", [
      { tenantId: "local", recordings: [rec({ startMs: 1_700_000_000_000, endMs: 1_700_009_000_000 })] },
      { tenantId: "vps",   recordings: [rec({ startMs: 1_700_000_015_000, endMs: 1_700_009_010_000 })] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].members).toHaveLength(2);
    expect(out[0].roomSlug).toBe("411");
  });
  it("同房间、相隔数小时不重叠 → 两簇(两 streamKey)", () => {
    const out = clusterBroadcasts("douyin", [
      { tenantId: "local", recordings: [
        rec({ startMs: 1_700_000_000_000, endMs: 1_700_003_000_000 }),
        rec({ startMs: 1_700_050_000_000, endMs: 1_700_053_000_000 }),
      ] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].streamKey).not.toBe(out[1].streamKey);
  });
  it("不同 roomSlug 永不同簇", () => {
    const out = clusterBroadcasts("douyin", [
      { tenantId: "a", recordings: [rec({ roomSlug: "1" }), rec({ roomSlug: "2" })] },
    ]);
    expect(out).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- identity` → FAIL。

- [ ] **Step 3: 实现 identity.ts**

```ts
// packages/orchestrator/src/identity.ts
import type { NodeRecording } from "./transport.js";

export interface BroadcastMember { tenantId: string; rec: NodeRecording; }
export interface Broadcast { streamKey: string; roomSlug: string; startMs: number; members: BroadcastMember[]; }

const DEFAULT_TOLERANCE = 5 * 60_000;

function overlaps(a: NodeRecording, b: NodeRecording, tol: number): boolean {
  return a.startMs <= b.endMs + tol && b.startMs <= a.endMs + tol;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function ymd(ms: number): string { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function hhmm(ms: number): string { const d = new Date(ms); return `${pad(d.getHours())}${pad(d.getMinutes())}`; }

export function clusterBroadcasts(
  platform: string,
  byTenant: { tenantId: string; recordings: NodeRecording[] }[],
  overlapToleranceMs = DEFAULT_TOLERANCE,
): Broadcast[] {
  // 展平成 (tenantId, rec)，按 roomSlug 分组，组内按 startMs 排序后做区间合并聚簇。
  const flat: BroadcastMember[] = byTenant.flatMap((t) => t.recordings.map((rec) => ({ tenantId: t.tenantId, rec })));
  const byRoom = new Map<string, BroadcastMember[]>();
  for (const m of flat) { const k = m.rec.roomSlug; (byRoom.get(k) ?? byRoom.set(k, []).get(k)!).push(m); }

  const out: Broadcast[] = [];
  for (const [roomSlug, members] of byRoom) {
    members.sort((a, b) => a.rec.startMs - b.rec.startMs);
    let cluster: BroadcastMember[] = [];
    const flush = (): void => {
      if (!cluster.length) return;
      const startMs = Math.min(...cluster.map((m) => m.rec.startMs));
      out.push({ roomSlug, startMs, members: cluster, streamKey: "" });
      cluster = [];
    };
    for (const m of members) {
      if (cluster.length && cluster.some((c) => overlaps(c.rec, m.rec, overlapToleranceMs))) cluster.push(m);
      else { flush(); cluster = [m]; }
    }
    flush();
  }
  // 同房间同一天多簇 → streamKey 追加 _HHMM 区分。
  const dayCount = new Map<string, number>();
  for (const b of out) { const k = `${b.roomSlug}:${ymd(b.startMs)}`; dayCount.set(k, (dayCount.get(k) ?? 0) + 1); }
  for (const b of out) {
    const day = ymd(b.startMs); const base = `${platform}:${b.roomSlug}:${day}`;
    b.streamKey = (dayCount.get(`${b.roomSlug}:${day}`)! > 1) ? `${base}_${hhmm(b.startMs)}` : base;
  }
  return out;
}
```

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- identity` → PASS（3 tests）。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/identity.ts packages/orchestrator/src/identity.test.ts
git commit -m "feat(orchestrator): roomSlug+时间窗聚类生成 streamKey(识别同一场)"
```

---

### Task 5: 覆盖度选优 + 干净判定

**Files:**
- Create: `packages/orchestrator/src/select.ts`
- Create: `packages/orchestrator/src/select.test.ts`

**Interfaces:**
- Consumes: `Broadcast`/`BroadcastMember`（Task 4）
- Produces:
  - `coverageOf(rec: NodeRecording): number`（= `1 - totalGapSec / spanSec`，span = (endMs-startMs)/1000，span≤0 → 1）
  - `interface Selection { winner: BroadcastMember | null; clean: boolean; perNode: { tenantId: string; coverage: number; durationSec: number }[]; }`
  - `selectWinner(b: Broadcast, cleanMaxGapSec: number): Selection`（winner = coverage 最高，并列取 durationSec 长者；clean = winner 的 totalGapSec ≤ cleanMaxGapSec）

- [ ] **Step 1: 写失败测试**

```ts
// packages/orchestrator/src/select.test.ts
import { describe, it, expect } from "vitest";
import { coverageOf, selectWinner } from "./select.js";
import type { Broadcast } from "./identity.js";
import type { NodeRecording } from "./transport.js";

const rec = (over: Partial<NodeRecording>): NodeRecording => ({
  roomSlug: "411", sessionBase: "s", tsFiles: [], durationSec: 1000,
  startMs: 0, endMs: 1_000_000, totalGapSec: 0, ...over,
});
const bc = (recs: NodeRecording[]): Broadcast => ({
  streamKey: "k", roomSlug: "411", startMs: 0,
  members: recs.map((r, i) => ({ tenantId: `n${i}`, rec: r })),
});

describe("覆盖度选优", () => {
  it("coverageOf：无缺口=1，有缺口按比例", () => {
    expect(coverageOf(rec({}))).toBeCloseTo(1);
    expect(coverageOf(rec({ totalGapSec: 100 }))).toBeCloseTo(0.9); // span 1000s, gap 100
  });
  it("有抖动那台落选，干净那台胜出且 clean=true", () => {
    const s = selectWinner(bc([rec({ totalGapSec: 120 }), rec({ totalGapSec: 0 })]), 30);
    expect(s.winner?.tenantId).toBe("n1");
    expect(s.clean).toBe(true);
  });
  it("都断 → 仍选最优但 clean=false", () => {
    const s = selectWinner(bc([rec({ totalGapSec: 120 }), rec({ totalGapSec: 200 })]), 30);
    expect(s.winner?.tenantId).toBe("n0"); // 缺口少者覆盖高
    expect(s.clean).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- select` → FAIL。

- [ ] **Step 3: 实现 select.ts**

```ts
// packages/orchestrator/src/select.ts
import type { NodeRecording } from "./transport.js";
import type { Broadcast, BroadcastMember } from "./identity.js";

export function coverageOf(rec: NodeRecording): number {
  const spanSec = (rec.endMs - rec.startMs) / 1000;
  if (spanSec <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - rec.totalGapSec / spanSec));
}

export interface Selection {
  winner: BroadcastMember | null;
  clean: boolean;
  perNode: { tenantId: string; coverage: number; durationSec: number }[];
}

export function selectWinner(b: Broadcast, cleanMaxGapSec: number): Selection {
  const perNode = b.members.map((m) => ({ tenantId: m.tenantId, coverage: coverageOf(m.rec), durationSec: m.rec.durationSec }));
  const winner = [...b.members].sort((x, y) =>
    coverageOf(y.rec) - coverageOf(x.rec) || y.rec.durationSec - x.rec.durationSec
  )[0] ?? null;
  const clean = !!winner && winner.rec.totalGapSec <= cleanMaxGapSec;
  return { winner, clean, perNode };
}
```

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- select` → PASS（3 tests）。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/select.ts packages/orchestrator/src/select.test.ts
git commit -m "feat(orchestrator): 覆盖度选优 + 干净阈值判定"
```

---

### Task 6: `sync_jobs` 台账（sqlite，幂等可续）

**Files:**
- Create: `packages/orchestrator/src/ledger.ts`
- Create: `packages/orchestrator/src/ledger.test.ts`

**Interfaces:**
- Produces:
  - `type JobState = "pending"|"settling"|"syncing"|"merging"|"uploading"|"done"|"failed"|"needs_manual"`
  - `class SyncLedger { constructor(dbPath: string); upsertPending(streamKey: string): { isNew: boolean }; get(streamKey: string): JobRow | null; setState(streamKey, state, patch?): void; markDone(streamKey, bv): void; listActive(): JobRow[]; close(): void; }`
  - `interface JobRow { streamKey: string; state: JobState; winnerTenant?: string; bv?: string; error?: string; updatedAt: number; }`
  - 幂等：`upsertPending` 对已存在的 streamKey 返回 `{ isNew: false }`、不重置已 done 的作业。

- [ ] **Step 1: 写失败测试**

```ts
// packages/orchestrator/src/ledger.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncLedger } from "./ledger.js";

function fresh(): SyncLedger { return new SyncLedger(join(mkdtempSync(join(tmpdir(), "led-")), "j.db")); }

describe("SyncLedger", () => {
  it("upsertPending 首次 isNew=true，再次 false（幂等去重）", () => {
    const l = fresh();
    expect(l.upsertPending("k1").isNew).toBe(true);
    expect(l.upsertPending("k1").isNew).toBe(false);
    l.close();
  });
  it("已 done 的作业不被 upsertPending 重置", () => {
    const l = fresh();
    l.upsertPending("k1"); l.markDone("k1", "BVxxx");
    l.upsertPending("k1");
    expect(l.get("k1")?.state).toBe("done");
    expect(l.get("k1")?.bv).toBe("BVxxx");
    l.close();
  });
  it("setState 写状态 + 错误", () => {
    const l = fresh();
    l.upsertPending("k1"); l.setState("k1", "failed", { error: "boom" });
    expect(l.get("k1")?.state).toBe("failed");
    expect(l.get("k1")?.error).toBe("boom");
    l.close();
  });
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- ledger` → FAIL。

- [ ] **Step 3: 实现 ledger.ts**（用 `node:sqlite`，与 `app/db.ts` 同栈）

```ts
// packages/orchestrator/src/ledger.ts
import { DatabaseSync } from "node:sqlite";

export type JobState = "pending"|"settling"|"syncing"|"merging"|"uploading"|"done"|"failed"|"needs_manual";
export interface JobRow { streamKey: string; state: JobState; winnerTenant?: string; bv?: string; error?: string; updatedAt: number; }

export class SyncLedger {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_jobs(
      streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
      winnerTenant TEXT, bv TEXT, error TEXT, updatedAt INTEGER NOT NULL)`);
  }
  private now(): number { return Number(this.db.prepare("SELECT unixepoch('now')*1000 AS t").get()!.t); }
  upsertPending(streamKey: string): { isNew: boolean } {
    const existing = this.get(streamKey);
    if (existing) return { isNew: false };
    this.db.prepare("INSERT INTO sync_jobs(streamKey,state,updatedAt) VALUES(?,?,?)").run(streamKey, "pending", this.now());
    return { isNew: true };
  }
  get(streamKey: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM sync_jobs WHERE streamKey=?").get(streamKey) as JobRow | undefined;
    return r ?? null;
  }
  setState(streamKey: string, state: JobState, patch: { winnerTenant?: string; error?: string } = {}): void {
    this.db.prepare("UPDATE sync_jobs SET state=?, winnerTenant=COALESCE(?,winnerTenant), error=?, updatedAt=? WHERE streamKey=?")
      .run(state, patch.winnerTenant ?? null, patch.error ?? null, this.now(), streamKey);
  }
  markDone(streamKey: string, bv: string): void {
    this.db.prepare("UPDATE sync_jobs SET state='done', bv=?, error=NULL, updatedAt=? WHERE streamKey=?").run(bv, this.now(), streamKey);
  }
  listActive(): JobRow[] {
    return this.db.prepare("SELECT * FROM sync_jobs WHERE state NOT IN('done','needs_manual')").all() as JobRow[];
  }
  close(): void { this.db.close(); }
}
```

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- ledger` → PASS（3 tests）。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/ledger.ts packages/orchestrator/src/ledger.test.ts
git commit -m "feat(orchestrator): sync_jobs sqlite 台账(幂等去重 + 状态机)"
```

---

### Task 7: 缺口 sidecar 写入（manager session）

**Files:**
- Modify: `packages/manager/src/index.ts`
- Modify: `test/session.test.ts`

**Interfaces:**
- Consumes: 现有 `recordReconnect`/`recordEnd` 触发点（本会话已加的 `offlineSince`）
- Produces: 会话结束时在 `<sessionXmlBase>.gaps.json` 写 `{ sessionBase, gaps:[{startMs,endMs}], totalGapSec }`，供各节点 `listInventory` 读取（Task 3 的 `readGaps` 消费）。

- [ ] **Step 1: 写失败测试**（扩展现有 session 测试）

```ts
// 追加到 test/session.test.ts 的 describe("RecordingSession") 内
it("断流缺口写入 {base}.gaps.json（供选优用）", async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "sess-gaps-"));
  const rec = new OfflineMock();
  rec.isLiveResults = [true]; // 抖动：会重连成功 → 记一段缺口
  const sess = new RecordingSession(rec, { reconnectDelaySec: 0.01 });
  await sess.start("https://live.douyin.com/123", makeOpts(dir), { anchorName: "" });
  rec.ev.onOffline();
  await vi.runAllTimersAsync();
  await sess.stop();
  const gapsFile = readdirSync(dir).find((f) => f.endsWith(".gaps.json"));
  expect(gapsFile).toBeTruthy();
  const g = JSON.parse(readFileSync(join(dir, gapsFile!), "utf-8"));
  expect(g.gaps.length).toBeGreaterThanOrEqual(1);
  expect(g.totalGapSec).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- session` → FAIL（无 .gaps.json）。

- [ ] **Step 3: 实现**（在 `manager/src/index.ts`）

在类加字段：`private gaps: { startMs: number; endMs: number }[] = [];`
在 `_handleOffline` 设 `this.offlineSince = Date.now()` 处不变；在 `onLive` 里「抖动重连成功」分支（`offlineSince != null && !offlineNotified`）记一段：

```ts
// onLive 重连成功分支内（算出 downSec 后）：
this.gaps.push({ startMs: this.offlineSince!, endMs: Date.now() });
```

在 `stop()` 收尾写 sidecar（用会话 xml 基名）：

```ts
// stop() 内，关闭 writer 之后、notify 之前：
try {
  if (this.currentXmlPath || this.lastXmlPath) {
    const base = (this.currentXmlPath ?? this.lastXmlPath!).replace(/\.xml$/i, "");
    const totalGapSec = Math.round(this.gaps.reduce((s, g) => s + (g.endMs - g.startMs), 0) / 1000);
    writeFileSync(`${base}.gaps.json`, JSON.stringify({ sessionBase: basename(base), gaps: this.gaps, totalGapSec }), "utf-8");
  }
} catch { /* sidecar 失败不影响停止 */ }
```

（需在 `openWriterForSegment` 里记 `this.lastXmlPath = xmlPath`，因为 stop 时 `currentXmlPath` 可能已被清空。`writeFileSync`/`basename` 已在该文件 import；若无则补 import。）

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- session` → PASS（含新用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/manager/src/index.ts test/session.test.ts
git commit -m "feat(manager): 会话结束写 {base}.gaps.json(断流缺口,供多节点选优)"
```

---

### Task 8: local transport（扫本地 dataRoot）

**Files:**
- Create: `packages/orchestrator/src/transport-local.ts`
- Create: `packages/orchestrator/src/transport-local.test.ts`

**Interfaces:**
- Consumes: `Transport`/`NodeInventory`（Task 2）、`readGaps`（Task 3）
- Produces: `class LocalTransport implements Transport`，构造接收 `{ id, recordingsDir, taskRooms: Record<anchorName,roomSlug>, ffprobe?: (file)=>Promise<{durationSec,startMs,endMs}> }`（ffprobe 可注入以便测试）。
  - `listInventory()`: 扫 `recordingsDir/<anchorName>/<base>_NNN.ts`，按会话基名 groupSessions（复用 `@drec/post-process` 的 groupSessions），每会话 ffprobe 求 durationSec/start/end + `readGaps` 求 totalGapSec + 经 taskRooms 映射 roomSlug。
  - `isDone()`: 本地恒 true（master 自己触发时本场已停）。
  - `pull()`: 同机无需拉，no-op（或 cp 到 localDir）。

- [ ] **Step 1: 写失败测试**（用注入的假 ffprobe + 临时目录造两段 + gaps）

```ts
// packages/orchestrator/src/transport-local.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "./transport-local.js";

describe("LocalTransport.listInventory", () => {
  it("聚合会话分段时长 + 读 gaps + 映射 roomSlug", async () => {
    const root = mkdtempSync(join(tmpdir(), "loc-"));
    const dir = join(root, "一勺小苏打"); mkdirSync(dir);
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_000.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_001.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54.gaps.json"),
      JSON.stringify({ sessionBase: "一勺小苏打_2026-06-27_07-54", gaps: [{ startMs: 0, endMs: 10_000 }], totalGapSec: 10 }));
    const t = new LocalTransport({
      id: "local", recordingsDir: root, taskRooms: { "一勺小苏打": "999" },
      ffprobe: async () => ({ durationSec: 1800, startMs: 1_700_000_000_000, endMs: 1_700_001_800_000 }),
    });
    const inv = await t.listInventory();
    expect(inv.recordings).toHaveLength(1);
    expect(inv.recordings[0].roomSlug).toBe("999");
    expect(inv.recordings[0].durationSec).toBe(3600); // 两段 1800 各
    expect(inv.recordings[0].totalGapSec).toBe(10);
  });
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- transport-local` → FAIL。

- [ ] **Step 3: 实现 transport-local.ts**（复用 `groupSessions`——先 `command grep -n "export.*groupSessions" packages/post-process/src/*.ts` 确认导出名/签名，按实际调整）

```ts
// packages/orchestrator/src/transport-local.ts
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { groupSessions } from "@drec/post-process";
import type { Transport, NodeInventory, NodeRecording, TenantConfig } from "./transport.js";
import { readGaps } from "./gaps.js";

export interface LocalOpts {
  id: string;
  recordingsDir: string;
  taskRooms: Record<string, string>; // anchorName(目录名) → roomSlug
  ffprobe: (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;
}

export class LocalTransport implements Transport {
  readonly id: string;
  constructor(private o: LocalOpts) { this.id = o.id; }

  async listInventory(): Promise<NodeInventory> {
    const recordings: NodeRecording[] = [];
    let anchors: string[] = [];
    try { anchors = readdirSync(this.o.recordingsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { anchors = []; }
    for (const anchor of anchors) {
      const dir = join(this.o.recordingsDir, anchor);
      const groups = groupSessions(readdirSync(dir));
      for (const [base, g] of Object.entries(groups)) {
        if (!g.ts.length) continue;
        let durationSec = 0, startMs = Infinity, endMs = 0;
        for (const f of g.ts) { const p = await this.o.ffprobe(join(dir, f)); durationSec += p.durationSec; startMs = Math.min(startMs, p.startMs); endMs = Math.max(endMs, p.endMs); }
        const gaps = readGaps(join(dir, `${base}.gaps.json`));
        recordings.push({
          roomSlug: this.o.taskRooms[anchor] ?? anchor,
          sessionBase: base, tsFiles: g.ts.map((f) => join(dir, f)),
          xmlPath: join(dir, `${base}.xml`),
          durationSec, startMs: startMs === Infinity ? 0 : startMs, endMs,
          totalGapSec: gaps?.totalGapSec ?? 0,
        });
      }
    }
    return { tenantId: this.id, recordings };
  }
  async isDone(): Promise<boolean> { return true; }
  async pull(): Promise<void> { /* 同机无需拉 */ }
}
```

> 注：`groupSessions` 返回结构以 `cli.ts` 用法为准（`groups[base].ts: string[]`）。若签名不同，按实际微调本任务代码与测试。

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- transport-local` → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/transport-local.ts packages/orchestrator/src/transport-local.test.ts
git commit -m "feat(orchestrator): LocalTransport(扫本地 dataRoot + ffprobe + gaps + roomSlug 映射)"
```

---

### Task 9: ssh / tailscale-ssh transport（注入式命令执行，可测）

**Files:**
- Create: `packages/orchestrator/src/transport-ssh.ts`
- Create: `packages/orchestrator/src/transport-ssh.test.ts`

**Interfaces:**
- Consumes: `Transport`/`NodeInventory`（Task 2）
- Produces: `class SshTransport implements Transport`，构造接收 `{ id, host, dataRoot, run: (argv:string[])=>Promise<string>, rsync?: (...)=>Promise<void> }`。`run` 注入（默认 `spawn("ssh", ["host", ...])`）以便测试。
  - `listInventory()`: 远端跑一段 shell（find 会话分段 + 各 ffprobe + cat gaps.json），输出 JSON，本地解析为 `NodeRecording[]`。**roomSlug 映射**经远端 `curl localhost:7860/api/tasks`（slave serve API 返回 room）→ extractRoomSlug。
  - `isDone(roomSlug)`: 远端查该 slave 是否还在录（`/proc` 无 ffmpeg 且 `/api/tasks` 该房间 recording=false）。
  - `pull(remotePaths, localDir)`: `rsync -az host:<path> localDir`。
  - `tailscale-ssh` 与 `ssh` 同实现，仅 host 为 tailscale 主机名（两个 register 调用共用类）。

- [ ] **Step 1: 写失败测试**（注入假 `run` 返回预置 JSON，断言解析）

```ts
// packages/orchestrator/src/transport-ssh.test.ts
import { describe, it, expect } from "vitest";
import { SshTransport } from "./transport-ssh.js";

describe("SshTransport", () => {
  it("listInventory 解析远端 JSON 输出", async () => {
    const fakeJson = JSON.stringify({ recordings: [
      { roomSlug: "411", sessionBase: "z_2026-06-27_07-54", tsFiles: ["a_000.ts"], xmlPath: "z.xml",
        durationSec: 3600, startMs: 1_700_000_000_000, endMs: 1_700_003_600_000, totalGapSec: 0 },
    ]});
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => fakeJson, rsync: async () => {} });
    const inv = await t.listInventory();
    expect(inv.tenantId).toBe("vps");
    expect(inv.recordings[0].roomSlug).toBe("411");
    expect(inv.recordings[0].durationSec).toBe(3600);
  });
  it("isDone：远端报无录制 → true", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => "DONE", rsync: async () => {} });
    expect(await t.isDone("411")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- transport-ssh` → FAIL。

- [ ] **Step 3: 实现 transport-ssh.ts**

```ts
// packages/orchestrator/src/transport-ssh.ts
import { spawn } from "node:child_process";
import type { Transport, NodeInventory, NodeRecording } from "./transport.js";

export interface SshOpts {
  id: string; host: string; dataRoot: string;
  run?: (argv: string[]) => Promise<string>;   // 默认 ssh host -- <argv>
  rsync?: (remote: string, localDir: string) => Promise<void>;
}

function defaultRun(host: string) {
  return (argv: string[]): Promise<string> => new Promise((resolve, reject) => {
    const p = spawn("ssh", ["-o", "ConnectTimeout=10", host, "--", ...argv]);
    let out = "", err = "";
    p.stdout.on("data", (b) => (out += b)); p.stderr.on("data", (b) => (err += b));
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`ssh rc=${c}: ${err.slice(-300)}`))));
    p.on("error", reject);
  });
}

// 远端清单脚本：对 <dataRoot>/recordings 下每会话求时长/起止/缺口，输出一行 JSON。
const INVENTORY_SH = (dataRoot: string) => `node - <<'NODE'
// 远端需有 node;实际实现里把扫描逻辑做成随包分发的小脚本或 slave 的 /api/recordings。
NODE`;

export class SshTransport implements Transport {
  readonly id: string;
  private run: (argv: string[]) => Promise<string>;
  private rsync: (remote: string, localDir: string) => Promise<void>;
  constructor(private o: SshOpts) {
    this.id = o.id;
    this.run = o.run ?? defaultRun(o.host);
    this.rsync = o.rsync ?? ((remote, localDir) => new Promise((res, rej) => {
      const p = spawn("rsync", ["-az", "-e", "ssh -o StrictHostKeyChecking=no", `${o.host}:${remote}`, localDir]);
      p.on("close", (c) => (c === 0 ? res() : rej(new Error(`rsync rc=${c}`)))); p.on("error", rej);
    }));
  }
  async listInventory(): Promise<NodeInventory> {
    const out = await this.run(["bash", "-lc", INVENTORY_SH(this.o.dataRoot)]);
    const parsed = JSON.parse(out) as { recordings: NodeRecording[] };
    return { tenantId: this.id, recordings: parsed.recordings };
  }
  async isDone(roomSlug: string): Promise<boolean> {
    const out = await this.run(["bash", "-lc",
      `cat /proc/[0-9]*/comm 2>/dev/null | grep -ic ffmpeg || true`]);
    return Number(out.trim() || "0") === 0; // 无 ffmpeg = 已收(roomSlug 精化留 v1.1)
  }
  async pull(remotePaths: string[], localDir: string): Promise<void> {
    for (const rp of remotePaths) await this.rsync(rp, localDir);
  }
}
```

> 注：`INVENTORY_SH` 的远端扫描脚本是关键落地细节。**两种落地选一**（实现时定）：(a) 把一个独立的 `inventory.mjs` 随 orchestrator 分发、`scp` 到 slave 后 `node inventory.mjs <dataRoot>` 输出 JSON；(b) 给 slave 的 serve 加 `GET /api/recordings`（spec 的 D1，干净方案）。v1 先用 (a) 或直接复用现有手动 ssh+ffprobe 拼 JSON。本任务测试已用注入 `run` 与具体脚本解耦，脚本细节不阻塞其余任务。

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- transport-ssh` → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/transport-ssh.ts packages/orchestrator/src/transport-ssh.test.ts
git commit -m "feat(orchestrator): SshTransport(注入式 run/rsync,远端清单+isDone+pull)"
```

---

### Task 10: 上传 P1→append（biliup）

**Files:**
- Modify: `packages/app/src/upload/biliup.ts`
- Create: `packages/app/src/upload/biliup-append.test.ts`（或并入现有 `test/upload/biliup.test.ts`）

**Interfaces:**
- Consumes: 现有 `buildUploadArgs`/`parseBV`/`DEFAULT_COOKIES`
- Produces:
  - `buildAppendArgs(o: { cookies: string; bv: string; files: string[] }): string[]` → `["-u",cookies,"append","--vid",bv,...files]`
  - `uploadThenAppend(o: { cookies: string; plain: string; extras: string[]; meta: UploadOpts; run?: (argv)=>Promise<string> }): Promise<string>`（先 upload plain 解析 BV，再 append extras，返回 BV）

- [ ] **Step 1: 写失败测试**

```ts
// test/upload/biliup-append.test.ts
import { describe, it, expect } from "vitest";
import { buildAppendArgs, uploadThenAppend } from "../../packages/app/src/upload/biliup.js";

describe("P1→append", () => {
  it("buildAppendArgs 形如 append --vid BV files", () => {
    expect(buildAppendArgs({ cookies: "c.json", bv: "BV1", files: ["d.mp4", "l.mp4"] }))
      .toEqual(["-u", "c.json", "append", "--vid", "BV1", "d.mp4", "l.mp4"]);
  });
  it("uploadThenAppend：先传 plain 拿 BV，再 append 两个分P", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      return argv.includes("append") ? "appended" : "... bvid BV9 ...";
    };
    const bv = await uploadThenAppend({
      cookies: "c.json", plain: "p.mp4", extras: ["d.mp4", "l.mp4"],
      meta: { cookies: "c.json", files: ["p.mp4"], title: "t", tid: 21, tag: "a", copyright: 1 } as any, run,
    });
    expect(bv).toBe("BV9");
    expect(calls[0].includes("upload")).toBe(true);
    expect(calls[1]).toEqual(["-u", "c.json", "append", "--vid", "BV9", "d.mp4", "l.mp4"]);
  });
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- biliup-append` → FAIL。

- [ ] **Step 3: 实现**（在 `biliup.ts` 追加；`run` 默认 spawn biliup 收集 stdout，复用现有 spawn 逻辑）

```ts
export function buildAppendArgs(o: { cookies: string; bv: string; files: string[] }): string[] {
  return ["-u", o.cookies, "append", "--vid", o.bv, ...o.files];
}

export async function uploadThenAppend(o: {
  cookies: string; plain: string; extras: string[]; meta: UploadOpts;
  run?: (argv: string[]) => Promise<string>;
}): Promise<string> {
  const run = o.run ?? defaultBiliupRun;        // defaultBiliupRun: spawn("biliup",argv) 收集 stdout
  const out = await run(buildUploadArgs({ ...o.meta, files: [o.plain] }));
  const bv = parseBV(out);
  if (!bv) throw new Error(`upload plain 完成但解析不到 BV：${out.slice(-300)}`);
  if (o.extras.length) await run(buildAppendArgs({ cookies: o.cookies, bv, files: o.extras }));
  return bv;
}
```

（`defaultBiliupRun` 用现有 `biliup.ts` 内 spawn biliup 的方式实现并收集 stdout；若已有等价私有函数则复用。）

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- biliup-append` → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/app/src/upload/biliup.ts test/upload/biliup-append.test.ts
git commit -m "feat(upload): biliup P1 upload 拿 BV → append P2/P3(分P 新规则)"
```

---

### Task 11: 流水线（settle→选优→拉取→merge/burn→上传/逃生口）

**Files:**
- Create: `packages/orchestrator/src/pipeline.ts`
- Create: `packages/orchestrator/src/pipeline.test.ts`

**Interfaces:**
- Consumes: `Broadcast`/`selectWinner`/`Transport`/`uploadThenAppend`/`SyncLedger`、注入的 `sh(cmd)`（跑 CLI merge/burn）、注入的 `notify(event)`
- Produces: `runPipeline(b: Broadcast, deps: PipelineDeps): Promise<{ state: JobState; bv?: string }>`
  - 干净有胜者 → pull → `sh(merge)` → `sh(burn danmu)` → `sh(burn livechat)` → `uploadThenAppend` → ledger done(bv)
  - 不干净 → ledger `needs_manual` + `notify({kind:"error",stage:"同步",message:覆盖度对比})` + 仍 pull+merge 暂存（不投稿）
  - `PipelineDeps { transports: Map<tenantId,Transport>; ledger: SyncLedger; sh: (cmd:string)=>Promise<void>; upload: typeof uploadThenAppend; notify:(e)=>void; cfg: { cleanMaxGapSec; stageDir; cookies; uploadMode:"auto-private"|"stage-only" } }`

- [ ] **Step 1: 写失败测试**（全注入：假 transport/ledger/sh/upload/notify）

```ts
// packages/orchestrator/src/pipeline.test.ts —— 关键两条：
// 1) 有干净胜者 + auto-private → 调用了 merge/burn×2/upload，ledger=done，返回 bv
// 2) 都断(无干净) → 未调 upload，notify 收到 error/同步，ledger=needs_manual
import { describe, it, expect } from "vitest";
import { runPipeline } from "./pipeline.js";
// ...构造 Broadcast(两 member,一个 totalGapSec=0 一个=200)、fake deps，断言 sh 调用次数 / ledger 状态 / notify。
```
（完整 fake 装配照 `test/session.test.ts` 风格写；断言：场景1 `sh` 调 3 次含 "merge"/"burn"×2、`upload` 调 1 次、ledger.get(key).state==="done"；场景2 `upload` 调 0 次、notify 收到 `kind:"error"`、ledger 状态 `needs_manual`。）

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- pipeline` → FAIL。

- [ ] **Step 3: 实现 pipeline.ts**（settle 由调用方处理；本函数从「已 settle 的 Broadcast」开始）

```ts
// 伪要点（实现时补全）：
// const sel = selectWinner(b, cfg.cleanMaxGapSec);
// if (!sel.winner) { ledger.setState(b.streamKey,"failed",{error:"无可用录像"}); return {state:"failed"}; }
// const w = sel.winner;
// ledger.setState(b.streamKey,"syncing",{winnerTenant:w.tenantId});
// await transports.get(w.tenantId)!.pull(w.rec.tsFiles.concat(w.rec.xmlPath??[]), stageWinnerDir);
// ledger.setState(b.streamKey,"merging");
// await sh(`node dist/douyin-rec.mjs merge --in ${dir} --base ${w.rec.sessionBase}`);
// await sh(`node dist/douyin-rec.mjs burn --video ${plain} --xml ${xml} --style danmu --gift-value 0.9`);
// await sh(`... --style livechat ...`);
// if (!sel.clean || cfg.uploadMode==="stage-only") {
//   ledger.setState(b.streamKey,"needs_manual");
//   notify({kind:"error",stage:"同步",message:`无干净版本/待批，覆盖度：${JSON.stringify(sel.perNode)}`});
//   return {state:"needs_manual"};
// }
// ledger.setState(b.streamKey,"uploading");
// const bv = await upload({cookies, plain, extras:[danmu,livechat], meta:{...}});
// ledger.markDone(b.streamKey,bv);
// return {state:"done",bv};
```

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- pipeline` → PASS（≥2 tests）。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/pipeline.ts packages/orchestrator/src/pipeline.test.ts
git commit -m "feat(orchestrator): 同步流水线(选优→拉取→merge/burn→P1append上传/都断逃生口)"
```

---

### Task 12: 对账引擎（聚类 + 幂等 + reconcileAll 兜底）

**Files:**
- Create: `packages/orchestrator/src/reconciler.ts`
- Create: `packages/orchestrator/src/reconciler.test.ts`

**Interfaces:**
- Consumes: `clusterBroadcasts`/`runPipeline`/`SyncLedger`/`Transport`
- Produces:
  - `class Reconciler { constructor(deps: ReconcilerDeps); reconcileAll(): Promise<void>; }`
  - `reconcileAll`: 并发 `listInventory` 所有 transport → `clusterBroadcasts` → 对每个 Broadcast `ledger.upsertPending`，仅 `isNew`（或处于可重试态）的跑 `runPipeline`。**幂等**：已 done 的簇跳过。
  - 触发(Task 13)与兜底都调 `reconcileAll`（同一入口，天然合流）。

- [ ] **Step 1: 写失败测试**

```ts
// 两 transport 各报同一场(roomSlug+重叠时间)→ 聚成 1 簇 → runPipeline 被调 1 次；
// 再次 reconcileAll → 已 done，runPipeline 不再调(幂等)。
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- reconciler` → FAIL。

- [ ] **Step 3: 实现 reconciler.ts**

```ts
// 要点：
// const invs = await Promise.all([...transports.values()].map(t => t.listInventory().catch(()=>({tenantId:t.id,recordings:[]}))));
// const broadcasts = clusterBroadcasts(platform, invs.map(i=>({tenantId:i.tenantId,recordings:i.recordings})));
// for (const b of broadcasts) {
//   const job = ledger.get(b.streamKey);
//   if (job?.state === "done" || job?.state === "needs_manual") continue;
//   const { isNew } = ledger.upsertPending(b.streamKey);
//   if (!isNew && job && !RETRYABLE.has(job.state)) continue;  // 别重入进行中的
//   await runPipeline(b, pipelineDeps);
// }
```

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- reconciler` → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/reconciler.ts packages/orchestrator/src/reconciler.test.ts
git commit -m "feat(orchestrator): 对账引擎(跨节点聚类 + 幂等 + reconcileAll 兜底)"
```

---

### Task 13: 触发去抖（isRecording 持续 false 过 settle 才算结束）

**Files:**
- Create: `packages/orchestrator/src/trigger.ts`
- Create: `packages/orchestrator/src/trigger.test.ts`

**Interfaces:**
- Produces: `class EndDebouncer { constructor(settleMs: number, onEnded: ()=>void); observe(isRecording: boolean): void; }`
  - 见到 `false` → 起 settle 定时器；settle 内又见 `true`（抖动重连）→ 取消（不算结束）；settle 过仍未恢复 → `onEnded()`。

- [ ] **Step 1: 写失败测试**（fake timers）

```ts
// packages/orchestrator/src/trigger.test.ts
import { describe, it, expect, vi } from "vitest";
import { EndDebouncer } from "./trigger.js";
describe("EndDebouncer", () => {
  it("持续 false 过 settle → 触发结束", () => {
    vi.useFakeTimers(); let ended = 0;
    const d = new EndDebouncer(1000, () => ended++);
    d.observe(false); vi.advanceTimersByTime(1001);
    expect(ended).toBe(1); vi.useRealTimers();
  });
  it("settle 内恢复 true(抖动) → 不触发", () => {
    vi.useFakeTimers(); let ended = 0;
    const d = new EndDebouncer(1000, () => ended++);
    d.observe(false); vi.advanceTimersByTime(500); d.observe(true); vi.advanceTimersByTime(1000);
    expect(ended).toBe(0); vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- trigger` → FAIL。

- [ ] **Step 3: 实现 trigger.ts**

```ts
// packages/orchestrator/src/trigger.ts
export class EndDebouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private settleMs: number, private onEnded: () => void) {}
  observe(isRecording: boolean): void {
    if (isRecording) { if (this.timer) { clearTimeout(this.timer); this.timer = null; } return; }
    if (this.timer) return;                       // 已在等 settle
    this.timer = setTimeout(() => { this.timer = null; this.onEnded(); }, this.settleMs);
  }
}
```

- [ ] **Step 4: 运行确认通过** — Run: `pnpm test -- trigger` → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/trigger.ts packages/orchestrator/src/trigger.test.ts
git commit -m "feat(orchestrator): 结束去抖(isRecording 持续 false 过 settle 才触发,过滤抖动)"
```

---

### Task 14: 集成进 `task serve --hub` + 内置 transport 注册

**Files:**
- Modify: `packages/orchestrator/src/index.ts`（`registerBuiltinTransports()` 注册 local/ssh/tailscale-ssh）
- Modify: `packages/app/src/cli-task.ts`（serve action 加 `--hub` + 读 hub 配置 + 起 Reconciler + 每任务 isRecording 经 EndDebouncer → reconcileAll + 周期 reconcileAll）
- Modify: `packages/cli/src/cli.ts`（providers-register 调 `registerBuiltinTransports()`）
- Create: `test/orchestrator/hub-wiring.test.ts`（注入 fake manager/transports，断言：某任务 isRecording false 过 settle → reconcileAll 被调）

**Interfaces:**
- Consumes: 全部上游；现有 `serve` 的 `manager.isRecording(taskId)`、`store`、`EventCenter`
- Produces: `serveWithHub` 接线（hub 配置来自 `--hub-config <json>` 或 settings 表 `hubConfig`）

- [ ] **Step 1: 写失败测试**（把「isRecording 轮询 → EndDebouncer → reconcileAll」抽成可注入的 `startHub(deps)` 纯接线函数测）

```ts
// 断言：fake manager 先报 recording=true 再 false 并持续 → reconcileAll 调用次数 +1
```

- [ ] **Step 2: 运行确认失败** — Run: `pnpm test -- hub-wiring` → FAIL。

- [ ] **Step 3: 实现**

`orchestrator/src/index.ts`：
```ts
import { registerTransport } from "./transport.js";
import { LocalTransport } from "./transport-local.js";
import { SshTransport } from "./transport-ssh.js";
export function registerBuiltinTransports(deps: { ffprobe: (f:string)=>Promise<{durationSec:number;startMs:number;endMs:number}> }): void {
  registerTransport("local", (cfg) => new LocalTransport({ id: cfg.id, recordingsDir: `${cfg.dataRoot}/recordings`, taskRooms: {}, ffprobe: deps.ffprobe }));
  registerTransport("ssh", (cfg) => new SshTransport({ id: cfg.id, host: cfg.host!, dataRoot: cfg.dataRoot! }));
  registerTransport("tailscale-ssh", (cfg) => new SshTransport({ id: cfg.id, host: cfg.host!, dataRoot: cfg.dataRoot! }));
}
export { Reconciler } from "./reconciler.js";
export { EndDebouncer } from "./trigger.js";
export { SyncLedger } from "./ledger.js";
```

`cli-task.ts` serve action（`--hub` 开启时）：
```ts
// const hubCfg = JSON.parse(o.hubConfig ?? store.getSetting("hubConfig") ?? "null");
// if (o.hub && hubCfg) {
//   const reconciler = new Reconciler({...transports, ledger, pipelineDeps...});
//   const debouncers = new Map<number, EndDebouncer>();
//   setInterval(() => { for (const t of store.listTasks()) {
//     const d = debouncers.get(t.id) ?? new EndDebouncer(hubCfg.settleSec*1000, () => void reconciler.reconcileAll());
//     debouncers.set(t.id, d); d.observe(manager.isRecording(t.id));
//   }}, 3000);
//   setInterval(() => void reconciler.reconcileAll(), (hubCfg.reconcileIntervalMin ?? 30)*60_000); // 兜底
// }
```

`cli.ts` providers-register：调用 `registerBuiltinTransports({ ffprobe })`（ffprobe 用 `@drec/post-process` 的 `ffprobeVideo` 包一层成 `{durationSec,startMs,endMs}`；起止时间可用 `ffprobe format start_time` + 文件 mtime 兜底）。

- [ ] **Step 4: 验证**

Run: `pnpm test -- hub-wiring` → PASS；`pnpm typecheck` → 0 错误；`pnpm bundle` → 成功（serve 含 hub，不引入 douyin-live 到 orchestrator）。
手动冒烟（可选）：`node dist/douyin-rec.mjs task serve --hub --hub-config '<json>'` 起来不报错，日志显示「hub 已启用，N 个租户」。

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator/src/index.ts packages/app/src/cli-task.ts packages/cli/src/cli.ts test/orchestrator/hub-wiring.test.ts
git commit -m "feat(orchestrator): 集成进 task serve --hub(去抖触发 + 周期兜底对账 + 内置 transport 注册)"
```

---

## 自查（写完计划对照 spec）

- **Transport 轴**：Task 2(接口+注册表)/8(local)/9(ssh,tailscale-ssh 共用)/14(注册) ✓
- **识别一致性(roomSlug+时间窗聚类)**：Task 4 ✓（显式不用 task id/liveId）
- **覆盖度选优 + 都断逃生口**：Task 5(选优) + Task 11(逃生口 webhook+暂存) ✓
- **触发(自录 recordEnd) + 兜底对账**：Task 13(去抖,基于 isRecording——因 EventCenter 无 subscribe 故用观察 isRecording 持续 false 等价「真结束」) + Task 12(reconcileAll 兜底) + Task 14(接线) ✓
- **sync_jobs 幂等可续**：Task 6 ✓
- **流水线复用 post-process(经 CLI shell) + biliup P1→append**：Task 10 + Task 11 ✓
- **缺口数据来自 recordReconnect sidecar**：Task 7(写) + Task 3(读) ✓
- **集成 task serve --hub**：Task 14 ✓
- **v1 不做跨节点拼接**：未列入任务 ✓（spec 标 v2）
- **分层登记**：Task 1 ✓

**已知留待实现期定夺（非 placeholder，是落地选项）**：
- Task 9 远端清单脚本 (a)分发 inventory.mjs / (b)slave `GET /api/recordings`——测试已用注入 `run` 解耦，不阻塞。
- Task 8 `groupSessions` 实际签名以 `packages/post-process` 导出为准，实现时 `grep` 对齐。
- start/end 时间来源：ffprobe `format.start_time` 优先、文件 mtime 兜底（Task 8/14 实现期定）。
