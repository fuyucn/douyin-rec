# 多节点 hub followups 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉 `docs/multi-node-sync-followups.md` 的全部待办:漂移检测告警、短链重试、daemon 停止语义收尾、废弃旧 merge skill、per-平台 cookie、跨会话自动拼接。

**Architecture:** 全部顺着现有接缝做——Transport 轴加可选能力(`listTasks`)、reconciler/hub 周期里挂检查、settings 表按平台分 key、pipeline 在 `!selection.clean` 分支加 autoStitch 旁路。零新框架、零新依赖。

**Tech Stack:** Node 24 ESM(`.js` import 后缀)、node:sqlite、vitest、commander、ffmpeg。

## Global Constraints

- 分层守护:`test/arch/layering.test.ts` RANKS——orchestrator(L4.5) 可依赖 app(L4)/post-process(L0),反向不行;改包依赖须同步 RANKS。
- vitest **不能 import douyin-live**(sm-crypto);测试用 `test/setup.ts` 假平台。纯包单测就近放 `packages/**/*.test.ts`,集成测试放 `test/`。
- 提交规范:`<type>(<scope>): 中文描述`,**不加** AI 署名 trailer;只 add 本任务相关文件。
- 录制生产环境(docker + VPS)不可被破坏:改动全部走本地测试,部署由用户另行触发。
- 隐藏子命令命名沿用 `_` 前缀(`_inventory` 先例),经 ssh 以**单字符串**传命令(勿包 bash -lc,见 transport-ssh.ts:56-58 事故注释)。
- settings 表 key 惯例:小写驼峰;平台限定 key 用 `{base}.{platform}` 后缀式。

## 现状核对(计划前提,已验证于 2026-07-02)

- ✅ **streamKey 同主播同日碰撞** —— 已修(identity.ts:54-59 同日多簇 `_HHMM` 后缀 + meta 身份,followups doc 标 ✅)。**本计划无此任务。**
- ✅ **pipeline 出错标 failed** —— 已修(ledger fails 列 + markFailed + maxRetries=3,reconciler.ts:194-198,commit `c8d6de1`)。**本计划无此任务。**
- ⚠️ **daemon 手动停止自动重启** —— 实际已被「stop=停用」缓解(api.ts:517 `stopTask` 先 `setEnabled(false)` 再 stop,daemon `decide()` 只启 enabled 任务)→ 手动停止不会被重启。剩余仅文档收尾(Task 3)。

---

### Task 1: 任务定义漂移检测告警

多节点各自建同房间任务,改排期/画质漏改一边 → 两边悄悄漂移 → hub 选优时段不对齐。检测即可(不做中心化分发,见 followups doc「想法记录」)。

**Files:**
- Create: `packages/orchestrator/src/drift.ts`
- Create: `packages/orchestrator/src/drift.test.ts`
- Modify: `packages/orchestrator/src/transport.ts`(Transport 接口 + TenantConfig)
- Modify: `packages/orchestrator/src/transport-ssh.ts`(实现 listTasks)
- Modify: `packages/orchestrator/src/index.ts`(导出 drift)
- Modify: `packages/cli/src/cli.ts`(`_tasks` 隐藏子命令 + hubStarter 挂周期检查)

**Interfaces:**
- Produces: `interface NodeTaskDef { platform: string; roomSlug: string; scheduleStart: string | null; scheduleEnd: string | null; quality: string; engine: string; enabled: boolean }`
- Produces: `Transport.listTasks?(): Promise<NodeTaskDef[]>`(可选能力,同 exists/cleanup 惯例)
- Produces: `detectDrift(byTenant: { tenantId: string; tasks: NodeTaskDef[] }[]): DriftFinding[]`,`interface DriftFinding { platform: string; roomSlug: string; field: "schedule" | "quality" | "engine"; values: Record<string, string> }`(values: tenantId → 值)
- Consumes: `SshTransport.run`(现有单字符串 ssh 执行)、`store.listTasks()`(local 侧)

- [ ] **Step 1: 写失败测试** `packages/orchestrator/src/drift.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { detectDrift, type NodeTaskDef } from "./drift.js";

const t = (over: Partial<NodeTaskDef>): NodeTaskDef => ({
  platform: "douyin", roomSlug: "767116735823",
  scheduleStart: "22:00", scheduleEnd: "01:30",
  quality: "origin", engine: "ffmpeg", enabled: true, ...over,
});

describe("detectDrift", () => {
  it("两节点同 (platform,roomSlug) 排期不同 → 报 schedule 漂移,values 带各自值", () => {
    const findings = detectDrift([
      { tenantId: "local", tasks: [t({})] },
      { tenantId: "vps2", tasks: [t({ scheduleStart: "20:00" })] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      platform: "douyin", roomSlug: "767116735823", field: "schedule",
      values: { local: "22:00-01:30", vps2: "20:00-01:30" },
    });
  });

  it("完全一致 → 无发现;仅单节点有该房间 → 不算漂移(另一边没建任务是正常形态)", () => {
    expect(detectDrift([
      { tenantId: "local", tasks: [t({})] },
      { tenantId: "vps2", tasks: [t({})] },
    ])).toHaveLength(0);
    expect(detectDrift([
      { tenantId: "local", tasks: [t({})] },
      { tenantId: "vps2", tasks: [] },
    ])).toHaveLength(0);
  });

  it("disabled 任务不参与比对(停用=退出编排,漂移无意义);quality/engine 各自独立报", () => {
    expect(detectDrift([
      { tenantId: "local", tasks: [t({ enabled: false })] },
      { tenantId: "vps2", tasks: [t({ scheduleStart: "20:00" })] },
    ])).toHaveLength(0);
    const findings = detectDrift([
      { tenantId: "local", tasks: [t({})] },
      { tenantId: "vps2", tasks: [t({ quality: "hd", engine: "mesio" })] },
    ]);
    expect(findings.map((f) => f.field).sort()).toEqual(["engine", "quality"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- drift`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `packages/orchestrator/src/drift.ts`

```ts
/**
 * drift.ts — 跨节点任务定义漂移检测(检测不分发,设计取舍见
 * docs/multi-node-sync-followups.md「想法记录:hub 中心化任务管理」)。
 * 同 (platform, roomSlug) 的任务在多节点间排期/画质/引擎不一致 → 报告,由调用方通知。
 * 只比对 enabled 任务;某房间只在一个节点有任务不算漂移(单节点录制是正常形态)。
 */
export interface NodeTaskDef {
  platform: string;
  roomSlug: string;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  quality: string;
  engine: string;
  enabled: boolean;
}

export interface DriftFinding {
  platform: string;
  roomSlug: string;
  field: "schedule" | "quality" | "engine";
  /** tenantId → 该节点的值(schedule 拼成 "HH:MM-HH:MM" / "—")。 */
  values: Record<string, string>;
}

const sched = (t: NodeTaskDef): string =>
  t.scheduleStart && t.scheduleEnd ? `${t.scheduleStart}-${t.scheduleEnd}` : "—";

export function detectDrift(
  byTenant: { tenantId: string; tasks: NodeTaskDef[] }[],
): DriftFinding[] {
  // (platform:roomSlug) → tenantId → task。同节点同房间多任务取第一个 enabled 的。
  const rooms = new Map<string, Map<string, NodeTaskDef>>();
  for (const { tenantId, tasks } of byTenant) {
    for (const t of tasks) {
      if (!t.enabled) continue;
      const key = `${t.platform}:${t.roomSlug}`;
      const m = rooms.get(key) ?? rooms.set(key, new Map()).get(key)!;
      if (!m.has(tenantId)) m.set(tenantId, t);
    }
  }

  const out: DriftFinding[] = [];
  for (const [key, byId] of rooms) {
    if (byId.size < 2) continue; // 单节点 → 不算漂移
    const sep = key.indexOf(":");
    const platform = key.slice(0, sep);
    const roomSlug = key.slice(sep + 1);
    const fields: Array<["schedule" | "quality" | "engine", (t: NodeTaskDef) => string]> = [
      ["schedule", sched],
      ["quality", (t) => t.quality],
      ["engine", (t) => t.engine],
    ];
    for (const [field, get] of fields) {
      const values: Record<string, string> = {};
      for (const [id, t] of byId) values[id] = get(t);
      if (new Set(Object.values(values)).size > 1) out.push({ platform, roomSlug, field, values });
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- drift`
Expected: PASS(3 tests)

- [ ] **Step 5: Transport 接口扩展** `packages/orchestrator/src/transport.ts`

在 `Transport` 接口 `cleanup?` 之后加(db 位置由 slave 端 `_tasks` 自行探测,TenantConfig 无需新字段):

```ts
  /**
   * 该节点的任务定义清单(漂移检测用)。可选:无此能力的 transport 不参与漂移比对。
   * local = 直接读自身 store;ssh = 远端 `_tasks <dataRoot>` 子命令输出 JSON。
   */
  listTasks?(): Promise<import("./drift.js").NodeTaskDef[]>;
```

- [ ] **Step 6: SshTransport 实现 listTasks** `packages/orchestrator/src/transport-ssh.ts`

类内加(模式同 listInventory,SshOpts 无需新字段):

```ts
  async listTasks(): Promise<import("./drift.js").NodeTaskDef[]> {
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    // _tasks 自己按 dataRoot 探测 db 位置(<dataRoot>/douyin-rec.db 或 <dataRoot>/db/douyin-rec.db)。
    const out = await this.run([`${nodePrefix} _tasks ${this.o.dataRoot}`]);
    return (JSON.parse(out) as { tasks: import("./drift.js").NodeTaskDef[] }).tasks;
  }
```

单测(`transport-ssh.test.ts` 追加,注入 fake run 断言 argv 是单字符串、含 `_tasks`,返回样例 JSON 能解析)。

- [ ] **Step 7: `_tasks` 隐藏子命令** `packages/cli/src/cli.ts`(紧挨 `_inventory` 之后)

```ts
// ─── _tasks <dataRoot>(隐藏子命令,供 master 漂移检测经 SSH 调用)──────────
// 输出 JSON { tasks: NodeTaskDef[] }。db 位置探测:<dataRoot>/douyin-rec.db(VPS systemd
// --db 直传根下的惯例)优先,其次 <dataRoot>/db/douyin-rec.db(paths.ts 标准布局)。
program
  .command("_tasks <dataRoot>", { hidden: true })
  .description("(内部) 输出本节点任务定义 JSON(供 master 漂移检测)")
  .action(async (dataRoot: string) => {
    const { join: pathJoin } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const { TaskStore } = await import("@drec/app");
    const flat = pathJoin(dataRoot, "douyin-rec.db");
    const nested = pathJoin(dataRoot, "db", "douyin-rec.db");
    const dbPath = existsSync(flat) ? flat : nested;
    const store = new TaskStore(dbPath);
    const tasks = store.listTasks().map((t) => {
      let roomSlug = t.room;
      try { roomSlug = platformForRoom(t.room).extractRoomSlug(t.room); } catch { /* 原样 */ }
      return {
        platform: t.platform, roomSlug,
        scheduleStart: t.scheduleStart, scheduleEnd: t.scheduleEnd,
        quality: t.quality, engine: t.engine, enabled: t.enabled,
      };
    });
    store.close();
    process.stdout.write(JSON.stringify({ tasks }) + "\n");
  });
```

- [ ] **Step 8: hubStarter 挂周期漂移检查** `packages/cli/src/cli.ts`(hubStarter.start 内,`startHub(...)` 之后、`opts.log` 之前)

```ts
    // 漂移检测:每小时比对各节点 enabled 任务的排期/画质/引擎,不一致 → 站内+webhook 告警。
    // 告警指纹去重:同一漂移态只报一次,恢复一致后清指纹(修好再漂会再报)。
    const { detectDrift } = await import("@drec/orchestrator");
    const seenDrift = new Set<string>();
    const checkDrift = async (): Promise<void> => {
      try {
        const byTenant = await Promise.all(
          [...transports.entries()].map(async ([id, tr]) => {
            if (id === "local" || !tr.listTasks) {
              // local:直接读自身 store(转 NodeTaskDef,slug 解析同 _tasks)。
              const tasks = opts.store.listTasks().map((t) => {
                let roomSlug = t.room;
                try { roomSlug = platformForRoom(t.room).extractRoomSlug(t.room); } catch { /* 原样 */ }
                return {
                  platform: t.platform, roomSlug,
                  scheduleStart: t.scheduleStart, scheduleEnd: t.scheduleEnd,
                  quality: t.quality, engine: t.engine, enabled: t.enabled,
                };
              });
              return { tenantId: id, tasks };
            }
            return { tenantId: id, tasks: await tr.listTasks().catch(() => []) };
          }),
        );
        const findings = detectDrift(byTenant);
        const current = new Set(findings.map((f) => `${f.platform}:${f.roomSlug}:${f.field}:${JSON.stringify(f.values)}`));
        for (const f of findings) {
          const fp = `${f.platform}:${f.roomSlug}:${f.field}:${JSON.stringify(f.values)}`;
          if (seenDrift.has(fp)) continue;
          seenDrift.add(fp);
          opts.onEvent({
            kind: "error", stage: "配置漂移",
            message: `任务定义跨节点不一致:${f.platform}/${f.roomSlug} 的 ${f.field} — ${Object.entries(f.values).map(([k, v]) => `${k}=${v}`).join(" vs ")}`,
          });
        }
        for (const fp of seenDrift) if (!current.has(fp)) seenDrift.delete(fp);
      } catch (e) { opts.warn(`[hub] 漂移检测失败(下轮重试): ${String(e)}`); }
    };
    void checkDrift();
    const driftTimer = setInterval(() => void checkDrift(), 3600_000);
```

并把返回的 stop 包一层:`const stopAll = () => { clearInterval(driftTimer); stop(); }; … return stopAll;`

- [ ] **Step 9: 导出 + 全量验证**

`packages/orchestrator/src/index.ts` 加 `export { detectDrift } from "./drift.js";` 及类型导出。
Run: `pnpm typecheck && pnpm test && pnpm bundle`
Expected: 全绿;bundle 成功(_tasks 打进 dist)。

- [ ] **Step 10: Commit**

```bash
git add packages/orchestrator/src/drift.ts packages/orchestrator/src/drift.test.ts \
  packages/orchestrator/src/transport.ts packages/orchestrator/src/transport-ssh.ts \
  packages/orchestrator/src/transport-ssh.test.ts packages/orchestrator/src/index.ts \
  packages/cli/src/cli.ts
git commit -m "feat(hub): 跨节点任务定义漂移检测告警(排期/画质/引擎不一致→通知,指纹去重)"
```

---

### Task 2: 短链转换重试 + serve 启动扫描

现状:创建/改房间时一次性解析(api.ts:314-319),失败静默留短链 → 短链会过期、hub 按 roomSlug 聚类拿不到数字 slug。

**Files:**
- Create: `packages/app/src/shortlink-sweep.ts`
- Create: `packages/app/src/shortlink-sweep.test.ts`
- Modify: `packages/app/src/web/api.ts`(resolveAnchorBg 内改用带重试的解析)
- Modify: `packages/app/src/cli-task.ts`(serve 启动时扫一遍)
- Modify: `packages/app/src/index.ts`(导出)

**Interfaces:**
- Produces: `resolveWithRetry(resolve: (url: string) => Promise<string | null>, url: string, delaysMs?: number[]): Promise<string | null>`(默认 delays `[0, 5000, 30000]` = 共 3 次)
- Produces: `sweepShortLinks(store: TaskStore, resolve: (url: string) => Promise<string | null>): Promise<number>`(返回成功转换数)
- Consumes: `store.listTasks() / store.updateTask(id, { room })`、`anchor.resolveShortUrl`

- [ ] **Step 1: 写失败测试** `packages/app/src/shortlink-sweep.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveWithRetry, sweepShortLinks } from "./shortlink-sweep.js";
import { TaskStore } from "./store.js";

describe("resolveWithRetry", () => {
  it("前两次 null、第三次成功 → 返回 web_rid;全失败 → null", async () => {
    const r = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce("123456");
    expect(await resolveWithRetry(r, "https://v.douyin.com/abc", [0, 0, 0])).toBe("123456");
    expect(r).toHaveBeenCalledTimes(3);
    const fail = vi.fn().mockResolvedValue(null);
    expect(await resolveWithRetry(fail, "https://v.douyin.com/abc", [0, 0])).toBeNull();
  });
  it("抛错按失败算,不中断重试", async () => {
    const r = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce("789");
    expect(await resolveWithRetry(r, "https://v.douyin.com/x", [0, 0])).toBe("789");
  });
});

describe("sweepShortLinks", () => {
  it("只处理 v.douyin.com 任务,成功→room 写回规范 URL,失败→原样;返回成功数", async () => {
    const store = new TaskStore(":memory:");
    const a = store.addTask({ room: "https://v.douyin.com/AAA" });
    store.addTask({ room: "https://live.douyin.com/767116735823" }); // 已规范,不动
    const b = store.addTask({ room: "https://v.douyin.com/BBB" });
    const resolve = vi.fn(async (u: string) => (u.includes("AAA") ? "111222333" : null));
    const n = await sweepShortLinks(store, resolve);
    expect(n).toBe(1);
    expect(store.getTask(a.id)!.room).toBe("https://live.douyin.com/111222333");
    expect(store.getTask(b.id)!.room).toBe("https://v.douyin.com/BBB");
    store.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- shortlink`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `packages/app/src/shortlink-sweep.ts`

```ts
/**
 * shortlink-sweep.ts — 抖音短链(v.douyin.com/XXX)转换的重试与兜底扫描。
 * 创建时一次性解析可能失败(网络抖动);短链会过期、且 hub 按数字 roomSlug 聚类,
 * 留着短链 = 定时炸弹。两道防线:① 创建路径带退避重试;② serve 启动全表扫一遍。
 */
import type { TaskStore } from "./store.js";

const SHORT = /v\.douyin\.com\//;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 逐延迟重试 resolve(delaysMs[i] 为第 i 次尝试前的等待);成功返回 web_rid,全败 null。 */
export async function resolveWithRetry(
  resolve: (url: string) => Promise<string | null>,
  url: string,
  delaysMs: number[] = [0, 5_000, 30_000],
): Promise<string | null> {
  for (const d of delaysMs) {
    if (d > 0) await sleep(d);
    const rid = await resolve(url).catch(() => null);
    if (rid) return rid;
  }
  return null;
}

/** 全表扫描:room 仍是短链的任务逐个(单次,不重试——启动扫描本身就是重试)转换写回。 */
export async function sweepShortLinks(
  store: TaskStore,
  resolve: (url: string) => Promise<string | null>,
): Promise<number> {
  let ok = 0;
  for (const t of store.listTasks()) {
    if (!SHORT.test(t.room)) continue;
    const rid = await resolve(t.room).catch(() => null);
    if (rid) {
      store.updateTask(t.id, { room: `https://live.douyin.com/${rid}` });
      ok++;
    }
  }
  return ok;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- shortlink`
Expected: PASS

- [ ] **Step 5: 接线** 两处:

api.ts `resolveAnchorBg`(第 314-319 行)改:

```ts
      if (deps.resolveShortUrl && /v\.douyin\.com\//.test(r)) {
        // 带退避重试(0s/5s/30s):一次性解析失败会把过期短链永久留库(hub 聚类拿不到数字 slug)。
        const webRid = await resolveWithRetry(deps.resolveShortUrl, r);
        if (webRid) {
          r = `https://live.douyin.com/${webRid}`;
          store.updateTask(taskId, { room: r });
        }
      }
```

cli-task.ts serve action(daemon 构建后、hub 之前)加:

```ts
      // 短链兜底扫描:历史任务里创建时没转换成功的短链,启动时再试一遍(fire-and-forget)。
      void (async () => {
        const { sweepShortLinks } = await import("./shortlink-sweep.js");
        const { resolveShortUrl } = await import("./anchor.js");
        const n = await sweepShortLinks(store, resolveShortUrl).catch(() => 0);
        if (n > 0) serveLog.info(`[shortlink] 启动扫描转换了 ${n} 个过期风险短链`);
      })();
```

`packages/app/src/index.ts` 导出 `resolveWithRetry / sweepShortLinks`;api.ts 顶部补 import。

- [ ] **Step 6: 全量验证 + Commit**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

```bash
git add packages/app/src/shortlink-sweep.ts packages/app/src/shortlink-sweep.test.ts \
  packages/app/src/web/api.ts packages/app/src/cli-task.ts packages/app/src/index.ts
git commit -m "fix(task): 短链转换加退避重试 + serve 启动兜底扫描(防过期短链滞留库中)"
```

---

### Task 3: daemon「手动停止自动重启」文档收尾

代码已解决(stop=停用:api.ts:517 `store.setEnabled(id, false)` → `decide()` 不再启动),followups doc 仍挂在待做。无代码变更。

**Files:**
- Modify: `docs/multi-node-sync-followups.md`

- [ ] **Step 1: 把该条从「待做」移入 ✅ 区**,措辞:

```markdown
### ✅ daemon「手动 stop 后自动重启」—— 已由 stop=停用 语义解决
- `stopTask` 先 `setEnabled(false)` 再停进程(api.ts),daemon `decide()` 只启 enabled 任务 → 手动停止天然粘住。
- 取舍:不做单独 paused 标志——「停了但下窗口自动恢复」的需求至今没出现过(YAGNI);要恢复录制就手动再启用,语义直白。
```

- [ ] **Step 2: Commit**

```bash
git add docs/multi-node-sync-followups.md
git commit -m "docs(hub): daemon 手动停止条目收尾(已由 stop=停用 解决,不另做 paused)"
```

---

### Task 4: `merge-recording-today` skill 标废弃

skill 调已删除的 Python `remote/merge.py`(本地不可跑);hub 已自动合并/烧录/上传,手动路径走 TS CLI。skill 文件在 `~/.claude/skills/merge-recording-today/`(用户目录,不在仓库)。

**Files:**
- Modify: `~/.claude/skills/merge-recording-today/SKILL.md`(顶部加废弃声明)
- Modify: `CLAUDE.md`(仓库,更新「保留的 Python 部分」缺口备注)

- [ ] **Step 1:** SKILL.md 标题下加:

```markdown
> ⚠️ **已废弃(2026-07)**:本 skill 依赖已删除的 Python `remote/merge.py`,本地不可跑。
> 替代:**hub 自动管线**(task serve --hub,录完自动 选优→merge→烧录→上传)或手动 TS CLI:
> `node dist/douyin-rec.mjs merge --in <dir>` + `burn --video <mp4> --xml <xml> --style danmu|livechat --gift-value 0.9`,
> 上传仍用 upload-recording-today skill。保留本文档仅供流程参考。
```

- [ ] **Step 2:** CLAUDE.md 末尾「保留的 Python 部分」里 `⚠️ merge-recording-today skill 仍调…待切到 TS CLI(已知缺口)` 改为 `merge-recording-today skill 已标废弃(合并走 hub 自动管线或 TS CLI)`。

- [ ] **Step 3: Commit(仅仓库文件)**

```bash
git add CLAUDE.md
git commit -m "docs: merge-recording-today skill 标废弃(合并已由 hub 管线/TS CLI 取代)"
```

---

### Task 5: per-平台 cookie(bilibili 高画质档)

现状:cookie 模型「抖音单一」(settings `defaultCookies`)。bilibili `getStream` 支持 cookie(大会员 4K/杜比档)但没处存。方案:settings key `defaultCookies.{platform}`;douyin 继续用旧 key(零迁移);解析时按 task.platform 取。

**Files:**
- Modify: `packages/app/src/store.ts`(getDefaultCookies 带平台参数)
- Modify: `packages/app/src/store.test.ts` 或就近新增(per-platform 读写测试)
- Modify: 全部 `getDefaultCookies()` 调用点传 `task.platform`(grep 确认:api.ts、task-manager.ts、cli-task.ts)
- Modify: `packages/app/src/web/api.ts` + `server.ts`(setCookie/getCookieStatus 可选 `platform` 参数)
- Modify: `packages/web/src/modals/CookieDialog.tsx` + `api/client.ts` + `lib/i18n.tsx`(粘贴框加平台选择,默认 douyin)

**Interfaces:**
- Produces: `TaskStore.getDefaultCookies(platform?: string): string | null` —— `platform` 省略或 `"douyin"` → 旧 key `defaultCookies`;其它 → `defaultCookies.{platform}`,空串视为未设。
- Produces: settings key 惯例 `defaultCookies.bilibili`。
- 不变式: `resolveTaskCookies(task, globalCookie)` 签名不动——调用方负责传对平台的 global。

- [ ] **Step 1: 写失败测试**(store 就近,`packages/app/src/store.pcookie.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { TaskStore } from "./store.js";

describe("per-platform defaultCookies", () => {
  it("douyin(或省略)读旧 key;bilibili 读 defaultCookies.bilibili;互不串", () => {
    const s = new TaskStore(":memory:");
    s.setSetting("defaultCookies", "dy=1");
    s.setSetting("defaultCookies.bilibili", "SESSDATA=abc");
    expect(s.getDefaultCookies()).toBe("dy=1");
    expect(s.getDefaultCookies("douyin")).toBe("dy=1");
    expect(s.getDefaultCookies("bilibili")).toBe("SESSDATA=abc");
    s.setSetting("defaultCookies.bilibili", "  ");
    expect(s.getDefaultCookies("bilibili")).toBeNull(); // 空白=未设,不回落抖音
    s.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `pnpm test -- pcookie`,FAIL(参数不存在)

- [ ] **Step 3: 实现** store.ts `getDefaultCookies` 替换为:

```ts
  /**
   * 全局账号 cookie,**按平台分 key**:douyin(默认)沿用旧 key `defaultCookies`(零迁移,
   * 扫码登录/手动粘贴的历史数据继续生效);其它平台用 `defaultCookies.{platform}`。
   * 平台间**不回落**(抖音 cookie 发给 B 站没有意义还泄漏)。空串视为未设 → null。
   */
  getDefaultCookies(platform?: string): string | null {
    const key = !platform || platform === "douyin" ? "defaultCookies" : `defaultCookies.${platform}`;
    const v = (this.getSetting(key) ?? "").trim();
    return v.length > 0 ? v : null;
  }
```

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 调用点传平台**。`rtk proxy grep -rn "getDefaultCookies()" packages/` 逐个:凡在任务上下文中(有 task 对象)改 `store.getDefaultCookies(task.platform)`;非任务上下文(cookie 状态顶栏 = 抖音账号语义)保持无参。重点:
  - `api.ts` resolveAnchorBg(约 324 行)→ `store.getDefaultCookies(t.platform)`
  - `task-manager.ts` spawnFor 的 cookie 解析 → 传 `task.platform`
  - `cli-task.ts` run 命令同理
- [ ] **Step 6: API 面**。`setCookie(input: { cookie?: string; platform?: string })`:platform 非法(不在注册表)→ 400;写对应 key。`getCookieStatus` 加可选 `?platform=`(默认 douyin,`parseCookieExpiry` 仅 douyin 有意义,bilibili 只报 set/未 set)。server.ts 路由透传 query/body。测试:`test/app/web-server.test.ts` 加 http 用例(set bilibili cookie → get 状态 set=true,douyin 状态不受影响)。
- [ ] **Step 7: 前端**。CookieDialog 加平台 `<select>`(douyin/bilibili,默认 douyin,复用 SettingsDialog 下拉样式);`client.ts` `setCookie(cookie, platform?)`;i18n 加 `paste.platformLabel`。`cd packages/web && pnpm build` 通过。
- [ ] **Step 8: 全量验证 + Commit**

```bash
pnpm typecheck && pnpm test && (cd packages/web && pnpm build)
git add packages/app/src/store.ts packages/app/src/store.pcookie.test.ts \
  packages/app/src/web/api.ts packages/app/src/web/server.ts packages/app/src/task-manager.ts \
  packages/app/src/cli-task.ts test/app/web-server.test.ts \
  packages/web/src/modals/CookieDialog.tsx packages/web/src/api/client.ts packages/web/src/lib/i18n.tsx
git commit -m "feat(cookie): per-平台 cookie(defaultCookies.{platform},douyin 沿用旧 key 零迁移;B站高画质档就绪)"
```

---

### Task 6: 跨会话对齐拼接(断流场自动出完整版)

现状:所有节点都断流 → pipeline 直接 `needs_manual` 中断(pipeline.ts:101-109)。目标:hub 规则开 `pipeline.autoStitch` 时,自动「逐会话烧再拼」:每会话 merge→burn(offset=0,弹幕相对本会话起点零漂移)→ **concat filter 重编码**拼接(各会话 fps 可能不同,`-c copy` 会压坏 PTS)。默认关(保守:重编码耗时+有损,人工路径仍是缺省)。

> 前置知识:building blocks 已在 post-process(`mergeSession` / `burn --indir --base` / ass 按 `video_start_time` 分段锚定);会话时长用 ffprobe 末帧 PTS 兜底(mesio flv 头时长可能=0,见 [[reference_mesio_engine_gotchas]])。livechat 的 gift/member 用绝对 epoch 锚,拼接后参照系不统一 → **autoStitch v1 只烧 danmu,不烧 livechat**(在 doc 注明)。

**Files:**
- Create: `packages/post-process/src/concat.ts` + `concat.test.ts`
- Modify: `packages/post-process/src/index.ts`(导出)
- Modify: `packages/cli/src/cli.ts`(新增用户可见 `concat` 子命令,pipeline 经 sh 调用)
- Modify: `packages/orchestrator/src/pipeline.ts`(`!selection.clean` 分支加 autoStitch 旁路)
- Modify: `packages/orchestrator/src/pipeline.test.ts`(autoStitch 场景)
- Modify: `packages/app/src/hub-store.ts`(HubRule.pipeline 加 `autoStitch?: boolean`)
- Modify: `packages/web/src`(Hub 页规则编辑加开关;小改)
- Modify: `docs/multi-node-sync-followups.md`(该条移 ✅,注明 v1 限 danmu)

**Interfaces:**
- Produces: `buildConcatArgs(inputs: string[], out: string, fps?: number): string[]`(纯函数,ffmpeg concat filter 重编码参数;`fps` 默认 30)
- Produces: `concatReencode(inputs: string[], out: string, fps?: number): Promise<void>`(spawn ffmpeg)
- Produces: CLI `douyin-rec concat --out <mp4> <inputs...>`
- Produces: `PipelineCfg.autoStitch?: boolean`(resolveCfg 从 HubRule.pipeline.autoStitch 透传)
- Consumes: pipeline 现有 `sh` 接缝(`node dist/douyin-rec.mjs merge/burn/concat …`)、`transport.pull`、`ledger.setState`

- [ ] **Step 1: 写失败测试** `packages/post-process/src/concat.test.ts`(纯参数构建,不跑 ffmpeg)

```ts
import { describe, it, expect } from "vitest";
import { buildConcatArgs } from "./concat.js";

describe("buildConcatArgs", () => {
  it("N 输入 → N 个 -i + concat filter(v+a 各 N 路)+ 统一 fps 重编码,绝不 -c copy", () => {
    const args = buildConcatArgs(["a.mp4", "b.mp4"], "out.mp4", 30);
    expect(args.filter((x) => x === "-i")).toHaveLength(2);
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1");
    expect(fc).toContain("fps=30");
    expect(args).not.toContain("-c");           // 无 stream copy
    expect(args[args.length - 1]).toBe("out.mp4");
  });
  it("单输入直接报错(没有拼接意义,调用方 bug)", () => {
    expect(() => buildConcatArgs(["only.mp4"], "o.mp4")).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `pnpm test -- concat`,FAIL

- [ ] **Step 3: 实现** `packages/post-process/src/concat.ts`

```ts
/**
 * concat.ts — 多会话成品 mp4 拼接(**concat filter 重编码**,非 -c copy)。
 * 各会话 fps/timebase 可能不同(断流重连后流参数会变),copy 拼接会压坏 PTS
 * (见 [[reference_concat_mixed_fps_reencode]]);统一 fps + 重编码是唯一稳妥路径。
 */
import { spawn } from "node:child_process";

export function buildConcatArgs(inputs: string[], out: string, fps = 30): string[] {
  if (inputs.length < 2) throw new Error(`concat 需要 ≥2 个输入,收到 ${inputs.length}`);
  const n = inputs.length;
  const pads = inputs.map((_, i) => `[${i}:v][${i}:a]`).join("");
  const filter = `${pads}concat=n=${n}:v=1:a=1[cv][ca];[cv]fps=${fps}[v]`;
  return [
    "-y",
    ...inputs.flatMap((f) => ["-i", f]),
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[ca]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    out,
  ];
}

export function concatReencode(inputs: string[], out: string, fps = 30): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn("ffmpeg", buildConcatArgs(inputs, out, fps), { stdio: ["ignore", "ignore", "inherit"] });
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg concat rc=${c}`))));
    p.on("error", rej);
  });
}
```

- [ ] **Step 4: 跑测试确认通过**;index.ts 导出;cli.ts 加 `concat` 子命令(参数直传 concatReencode,模式仿现有 `merge` 命令);`pnpm bundle` 后本地用两段真实小视频手工验证一次拼接产物可播。

- [ ] **Step 5: pipeline autoStitch 旁路**(pipeline.ts,替换 101-109 的 early-return 为:)

```ts
  if (!selection.clean) {
    // autoStitch 关(默认):维持原语义 —— 中断 + 通知,绝不删源,留人工。
    if (!cfg.autoStitch) {
      ledger.setState(streamKey, "needs_manual", { winnerTenant: winner.tenantId });
      notify({ kind: "error", stage: "同步",
        message: `所有节点均断流未录全,最完整=${winner.tenantId}(${Math.round(winner.rec.durationSec)}s),已保留全部源,请人工对齐拼接。覆盖度:${JSON.stringify(selection.perNode)}` });
      return { state: "needs_manual" };
    }
    // autoStitch 开:取覆盖最全 tenant 的**全部会话**,逐会话 merge→burn(offset=0)→concat 重编码。
    // v1 限 danmu(livechat 的 gift/member 绝对 epoch 锚在拼接参照系下会漂,暂不做)。绝不删源。
    ledger.setState(streamKey, "syncing", { winnerTenant: winner.tenantId });
    const transport = transports.get(winner.tenantId);
    if (!transport) throw new Error(`No transport for tenant: ${winner.tenantId}`);
    const stageSub = path.join(cfg.stageDir, sanitizeKey(streamKey));
    // winner 成员在本场的全部会话(同 tenant 可能多条 NodeRecording,按 startMs 升序)
    const sessions = candidates.members
      .filter((m) => m.tenantId === winner.tenantId)
      .sort((a, b) => a.rec.startMs - b.rec.startMs);
    await transport.pull(
      sessions.flatMap((s) => [...s.rec.tsFiles, ...(s.rec.xmlPath ? [s.rec.xmlPath] : [])]),
      stageSub,
    );
    ledger.setState(streamKey, "merging");
    const parts: string[] = [];
    for (const s of sessions) {
      const base = s.rec.sessionBase;
      await sh(`node dist/douyin-rec.mjs merge --in ${stageSub} --base ${base}`);
      const sessDate = base.replace(/_\d{2}-\d{2}-\d{2}$/, "");
      const plainPart = path.join(stageSub, sessDate + ".mp4");
      if (s.rec.xmlPath) {
        await sh(`node dist/douyin-rec.mjs burn --video ${plainPart} --xml ${path.join(stageSub, path.basename(s.rec.xmlPath))} --style danmu --gift-value 0.9`);
        parts.push(path.join(stageSub, sessDate + "_danmu.mp4"));
      } else parts.push(plainPart);
    }
    const stitched = path.join(stageSub, sessions[0].rec.sessionBase.replace(/_\d{2}-\d{2}-\d{2}$/, "") + "_stitched_danmu.mp4");
    await sh(`node dist/douyin-rec.mjs concat --out ${stitched} ${parts.join(" ")}`);
    ledger.setState(streamKey, "needs_manual"); // 产物在 stage,上传仍留人工(拼接件先人工过目)
    notify({ kind: "error", stage: "同步",
      message: `断流场已自动拼接完整版(${sessions.length} 会话,重编码):${stitched},请人工核验后上传。` });
    return { state: "needs_manual" };
  }
```

注意:同一 sessDate 多会话会同名冲突 —— merge 产物名相同时段会撞,实现时给 `merge --base` 后的产物按 sessionBase(含 HH-MM-SS)重命名再入 parts(实现者据 merge 命令实际输出名调整;pipeline.test 场景必须覆盖同日两会话)。

- [ ] **Step 6: 配置透传**:`PipelineCfg` 加 `autoStitch?: boolean`;hub-store `HubRulePipeline` 加同名字段;cli.ts `resolveCfg` 加 `autoStitch: p.autoStitch === true`;Hub 页规则表单加 Switch(默认关,i18n `hub.autoStitch`)。
- [ ] **Step 7: pipeline.test.ts 加场景**:`都断 + autoStitch=true → pull 全部会话文件、sh 依次含 merge×N/burn×N/concat×1、终态 needs_manual、不删源`(fake sh 记录命令序列断言;仿现有 场景2 测试的搭法)。
- [ ] **Step 8: 全量验证 + 文档 + Commit**

```bash
pnpm typecheck && pnpm test && pnpm bundle && (cd packages/web && pnpm build)
git add packages/post-process/src/concat.ts packages/post-process/src/concat.test.ts \
  packages/post-process/src/index.ts packages/cli/src/cli.ts \
  packages/orchestrator/src/pipeline.ts packages/orchestrator/src/pipeline.test.ts \
  packages/app/src/hub-store.ts packages/web/src docs/multi-node-sync-followups.md
git commit -m "feat(hub): autoStitch 断流场自动逐会话烧录+concat重编码拼接(默认关,v1 限 danmu,绝不删源)"
```

---

## 执行顺序与优先级

| 顺序 | 任务 | 价值/成本 | 备注 |
|---|---|---|---|
| 1 | Task 3 文档收尾 | 5 分钟 | 先清账面 |
| 2 | Task 4 skill 废弃 | 10 分钟 | 同上 |
| 3 | Task 1 漂移检测 | 高/中 | 上次讨论定的「便宜替代方案」 |
| 4 | Task 2 短链重试 | 中/低 | 真实踩过的坑 |
| 5 | Task 5 per-平台 cookie | 中/中 | B 站 4K 档解锁 |
| 6 | Task 6 autoStitch | 中/高 | 最大件,放最后;做前可再评估必要性 |

每个任务独立可交付、可单独部署验证;Task 6 若时机不成熟可以只做到 Step 4(concat 工具落地,pipeline 旁路延后)。
