/**
 * hub-jobs.ts — Web「hub 任务」页的数据读取:job 列表 + 步骤时间线 + 当前步已运行时长 + ETA + job.log。
 *
 * **分层**:台账(sync_jobs/sync_job_events/sync_candidates)由 orchestrator 的 SyncLedger 写;
 * app(L4)不能 import orchestrator(L4.5,方向反了)——这里**直接只读打开同一个 sqlite 文件**
 * (`<db>-sync.db`),表结构即契约。每次请求短开短关(readOnly),不与写端抢锁。
 *
 * **ETA 口径**:当前步预计总耗时 = 历史已完成 job 同步骤「耗时/视频时长」比率的中位数 × 本场视频时长;
 * 无历史 → 保守常数比率。ETA 剩余 = 预计总耗时 − 当前步已运行时长(负数归 0)。粗估,UI 标注"约"。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  HUB_TABLE_NAMES, HUB_TERMINAL_STATES, HUB_FLOW_ORDER, readyNodes,
  type HubPoolSnapshotDTO, type HubQueueDTO, type QueueItemDTO, type QueuePhase,
} from "@drec/core";
import { rootHubConfig, rootStageDir } from "./paths.js";

export interface HubJobEvent { state: string; at: number; }
/** 细粒度子步骤事件(start/done)—— 驱动前端 fork/join 流程图。 */
export interface HubJobStep { step: string; phase: string; at: number; detail?: string }
/** 选优候选(流程图 select 步 fan-in 节点)。 */
export interface HubJobCandidate { worker: string; coverage: number; durationSec: number; complete: boolean; isWinner: boolean; }
/** 单个 workflow 节点的安全阀状态(空=旧 run,前端回落 steps 推导)。 */
export interface HubJobNodeState { node: string; state: string; error: string | null; attempts: number; updatedAt: number }
export interface HubJobView {
  streamKey: string;
  state: string;
  winnerWorker: string | null;
  /** 各录制节点的选优候选(空=旧 run / 未选优)。 */
  candidates: HubJobCandidate[];
  bv: string | null;
  error: string | null;
  fails: number;
  updatedAt: number;
  /** 首个事件时刻(job 创建)。 */
  startedAt: number | null;
  /** 状态转换时间线(升序)。 */
  events: HubJobEvent[];
  /** 子步骤 start/done 事件(升序);空=旧版本 run(前端回落粗粒度)。 */
  steps: HubJobStep[];
  /** 单节点状态(workflow 安全阀;空=旧 run,前端回落 steps 推导)。 */
  nodeStates: HubJobNodeState[];
  /** 当前步已运行秒数(终态 = null)。 */
  currentStepSec: number | null;
  /** 当前步预计剩余秒数(粗估;终态/没依据 = null)。 */
  etaSec: number | null;
  /** winner 的视频时长(选优明细,ETA 的换算基准;无 = null)。 */
  videoDurationSec: number | null;
  /** 该场 job.log 是否存在(存在才给「查看日志」入口)。 */
  hasLog: boolean;
}

/** 终态集合(唯一真理 = core 的 hub 台账契约,与 orchestrator SyncLedger 对齐)。 */
const TERMINAL = new Set<string>(HUB_TERMINAL_STATES);
/** 同一份终态集合的 SQL 形式(常量字面量,无注入面)。 */
const TERMINAL_SQL = HUB_TERMINAL_STATES.map((s) => `'${s}'`).join(",");
/** 历史台账表(同上;旧库缺表跳过)。 */
const HISTORY_TABLES = HUB_TABLE_NAMES;
/** 无历史数据时的保守「步骤耗时/视频时长」比率(按 2026-07 实测:烧录 veryfast ~0.11×,上传取决于带宽)。 */
const FALLBACK_RATE: Record<string, number> = { pending: 0.01, settling: 0.05, syncing: 0.1, merging: 0.3, uploading: 0.6 };

function sanitizeKey(key: string): string { return key.replace(/[:/]/g, "_"); }

/** room key `{platform}.{roomSlug}` → streamKey 前缀 `{platform}:{roomSlug}:`(仅替换首个点)。 */
function roomKeyToStreamPrefix(roomKey: string): string {
  return `${roomKey.replace(".", ":")}:`;
}

/**
 * 该房间仍有「进行中」run(终态 done/failed/needs_manual 不算;failed 允许删除清掉卡住的旧记录)。
 * 无 db / 旧库无表 → 空(无从守卫)。
 */
export function activeHubJobKeys(syncDbPath: string, roomKey: string): string[] {
  if (!existsSync(syncDbPath)) return [];
  const db = new DatabaseSync(syncDbPath, { readOnly: true });
  try {
    return (db.prepare(
      `SELECT streamKey FROM sync_jobs WHERE streamKey LIKE ? AND state NOT IN (${TERMINAL_SQL}) ORDER BY updatedAt DESC`,
    ).all(roomKeyToStreamPrefix(roomKey) + "%") as unknown as { streamKey: string }[]).map((r) => r.streamKey);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export interface DeleteHubHistoryResult {
  /** 删除的历史 run 数(按 sync_jobs 行数计)。 */
  deleted: number;
  /** 被删 run 的 streamKey(旧库无 sync_jobs → 空)。 */
  streamKeys: string[];
}

/**
 * 删除某房间的全部历史 run:五张台账表 + 各场 job.log。
 * 表结构即契约;旧库缺表按存在表删,不炸。无 sync db → 空结果。
 */
export function deleteHubJobHistory(syncDbPath: string, roomKey: string, stageDir = hubStageDir()): DeleteHubHistoryResult {
  const prefix = roomKeyToStreamPrefix(roomKey);
  if (!existsSync(syncDbPath)) return { deleted: 0, streamKeys: [] };
  const db = new DatabaseSync(syncDbPath);
  let rows: { streamKey: string }[] = [];
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[]).map((r) => r.name),
    );
    try {
      rows = db.prepare("SELECT streamKey FROM sync_jobs WHERE streamKey LIKE ?").all(prefix + "%") as unknown as { streamKey: string }[];
    } catch { /* 旧库连 sync_jobs 都没有 → 仍按存在表删 */ }
    for (const table of HISTORY_TABLES) {
      if (!tables.has(table)) continue;
      db.prepare(`DELETE FROM ${table} WHERE streamKey LIKE ?`).run(prefix + "%");
    }
  } finally {
    db.close();
  }
  const streamKeys = rows.map((r) => r.streamKey);
  for (const key of streamKeys) {
    try { rmSync(jobLogPath(key, stageDir), { force: true }); } catch { /* 日志不存在/权限 → 不阻断 */ }
  }
  return { deleted: streamKeys.length, streamKeys };
}

/** stage 根目录:hub.config.json 的 stageDir 优先,否则 rootStageDir()(与 cli hubStarter 同一解析序)。 */
export function hubStageDir(): string {
  try {
    const p = rootHubConfig();
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8")) as { stageDir?: string };
      if (cfg.stageDir) return cfg.stageDir;
    }
  } catch { /* 配置坏了 → 默认 */ }
  return rootStageDir();
}

/** 该场 job.log 的绝对路径(不保证存在)。 */
export function jobLogPath(streamKey: string, stageDir = hubStageDir()): string {
  return join(stageDir, sanitizeKey(streamKey), "job.log");
}

interface RawJob { streamKey: string; state: string; winnerWorker: string | null; bv: string | null; error: string | null; fails: number; updatedAt: number; }

/**
 * 历史步骤速率:最近 done 的 job 里,step 耗时 / winner 视频时长 的中位数。
 * 返回 Map<state, rate>;样本不足的步骤缺席(调用方回落 FALLBACK_RATE)。
 */
function historicalRates(db: DatabaseSync): Map<string, number> {
  const doneKeys = (db.prepare("SELECT streamKey FROM sync_jobs WHERE state='done' ORDER BY updatedAt DESC LIMIT 5")
    .all() as unknown as { streamKey: string }[]).map((r) => r.streamKey);
  const samples = new Map<string, number[]>();
  for (const key of doneKeys) {
    const dur = (db.prepare("SELECT durationSec FROM sync_candidates WHERE streamKey=? AND isWinner=1").get(key) as
      unknown as { durationSec: number } | undefined)?.durationSec;
    if (!dur || dur <= 0) continue;
    const ev = db.prepare("SELECT state, at FROM sync_job_events WHERE streamKey=? ORDER BY at ASC, rowid ASC")
      .all(key) as unknown as HubJobEvent[];
    for (let i = 0; i + 1 < ev.length; i++) {
      const stepSec = (ev[i + 1].at - ev[i].at) / 1000;
      if (stepSec <= 0) continue;
      (samples.get(ev[i].state) ?? samples.set(ev[i].state, []).get(ev[i].state)!).push(stepSec / dur);
    }
  }
  const rates = new Map<string, number>();
  for (const [state, arr] of samples) {
    arr.sort((a, b) => a - b);
    rates.set(state, arr[Math.floor(arr.length / 2)]);
  }
  return rates;
}

export interface ListHubJobsOpts {
  /** 只列某房间的 run(key=`{platform}.{roomSlug}`;streamKey 前缀 `{platform}:{roomSlug}:` 过滤)。省略=全部房间。 */
  room?: string;
  /**
   * 只列这些状态;省略=不限。与 `excludeStates` 互斥。
   * 队列页用它精确取「进行中」(`NOT IN 终态` ∪ `needs_manual`),**不受最近 N 条分页截断**。
   */
  states?: readonly string[];
  /** 排除这些状态(如终态);省略=不限。与 `states` 互斥。 */
  excludeStates?: readonly string[];
  /** 分页:返回条数(默认 10)。 */
  limit?: number;
  /** 分页:跳过条数(默认 0)。 */
  offset?: number;
  now?: number;
  stageDir?: string;
}

export interface HubJobsResult {
  jobs: HubJobView[];
  /** 满足过滤条件的 run 总数(分页用;前端据此决定还有没有下一页)。 */
  total: number;
}

/**
 * hub run 列表(分页 + 可按房间过滤)。无 sync db / 表还没建 → 空(slave/hub 未开过属正常)。
 * room 给定 → 只列该房间的历次 run(GitHub「某 workflow 的 run 列表」);省略 → 全房间最近 N。
 */
export function listHubJobs(syncDbPath: string, opts: ListHubJobsOpts = {}): HubJobsResult {
  const { room, limit = 10, offset = 0, now = Date.now(), stageDir = hubStageDir() } = opts;
  if (!existsSync(syncDbPath)) return { jobs: [], total: 0 };
  const db = new DatabaseSync(syncDbPath, { readOnly: true });
  // room key `{platform}.{roomSlug}` → streamKey 前缀 `{platform}:{roomSlug}:`(仅替换首个点)。
  const prefix = room ? room.replace(".", ":") + ":" : null;
  try {
    let jobs: RawJob[];
    let total = 0;
    try {
      // WHERE 子句统一拼:room 前缀 + 状态过滤(常量占位符,无注入面)。
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (prefix) { where.push("streamKey LIKE ?"); params.push(prefix + "%"); }
      // states 与 excludeStates 互斥(同时给以 excludeStates 为准 —— 调用方不该这么用)。
      if (opts.states && opts.states.length > 0) {
        where.push(`state IN (${opts.states.map(() => "?").join(",")})`);
        params.push(...opts.states);
      } else if (opts.excludeStates && opts.excludeStates.length > 0) {
        where.push(`state NOT IN (${opts.excludeStates.map(() => "?").join(",")})`);
        params.push(...opts.excludeStates);
      }
      const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      total = Number((db.prepare(`SELECT COUNT(*) AS n FROM sync_jobs${whereSql}`)
        .get(...params) as unknown as { n: number }).n);
      jobs = db.prepare(`SELECT * FROM sync_jobs${whereSql} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as unknown as RawJob[];
    } catch { return { jobs: [], total: 0 }; } // 旧库无表
    const rates = historicalRates(db);
    const views = jobs.map((j) => {
      let events: HubJobEvent[] = [];
      try {
        events = db.prepare("SELECT state, at FROM sync_job_events WHERE streamKey=? ORDER BY at ASC, rowid ASC")
          .all(j.streamKey) as unknown as HubJobEvent[];
      } catch { /* 旧库无 events 表 → 空时间线 */ }
      let steps: HubJobStep[] = [];
      try {
        steps = db.prepare("SELECT step, phase, at, detail FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC")
          .all(j.streamKey) as unknown as HubJobStep[];
      } catch {
        try {
          steps = db.prepare("SELECT step, phase, at FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC")
            .all(j.streamKey) as unknown as HubJobStep[];
        } catch { /* 旧库无表 → 空(前端回落粗粒度) */ }
      }
      let candidates: HubJobCandidate[] = [];
      try {
        const rows = db.prepare(
          "SELECT workerId, coverage, durationSec, totalGapSec, isWinner FROM sync_candidates WHERE streamKey=? ORDER BY isWinner DESC, coverage DESC",
        ).all(j.streamKey) as unknown as { workerId: string; coverage: number; durationSec: number; totalGapSec: number; isWinner: number }[];
        candidates = rows.map((c) => ({
          worker: c.workerId,
          coverage: Number(c.coverage),
          durationSec: Number(c.durationSec),
          complete: Number(c.totalGapSec) <= 0,
          isWinner: Number(c.isWinner) === 1,
        }));
      } catch { /* 旧库无表 → 无候选(前端 select 步不画 fan-in) */ }
      let nodeStates: HubJobNodeState[] = [];
      try {
        nodeStates = db.prepare(
          "SELECT node, state, error, attempts, updatedAt FROM sync_node_states WHERE streamKey=? ORDER BY node ASC",
        ).all(j.streamKey) as unknown as HubJobNodeState[];
      } catch { /* 旧库无表 → 空(前端回落 steps) */ }
      const videoDurationSec = candidates.find((c) => c.isWinner)?.durationSec ?? null;
      const terminal = TERMINAL.has(j.state);
      const stepStart = events.length ? events[events.length - 1].at : j.updatedAt;
      const currentStepSec = terminal ? null : Math.max(0, Math.round((now - stepStart) / 1000));
      let etaSec: number | null = null;
      if (!terminal && videoDurationSec && videoDurationSec > 0 && currentStepSec != null) {
        const rate = rates.get(j.state) ?? FALLBACK_RATE[j.state];
        if (rate != null) {
          // 已超预估(剩余 ≤ 0)→ null 让前端隐藏,而非显示误导的「约 0s」。
          const remain = Math.round(rate * videoDurationSec - currentStepSec);
          etaSec = remain > 0 ? remain : null;
        }
      }
      return {
        streamKey: j.streamKey, state: j.state,
        winnerWorker: j.winnerWorker ?? null, candidates, bv: j.bv ?? null, error: j.error ?? null,
        fails: Number(j.fails ?? 0), updatedAt: Number(j.updatedAt),
        startedAt: events.length ? Number(events[0].at) : null,
        events: events.map((e) => ({ state: e.state, at: Number(e.at) })),
        steps: steps.map((s) => ({ step: s.step, phase: s.phase, at: Number(s.at), detail: s.detail ?? undefined })),
        nodeStates,
        currentStepSec, etaSec, videoDurationSec,
        hasLog: existsSync(jobLogPath(j.streamKey, stageDir)),
      };
    });
    return { jobs: views, total };
  } finally {
    db.close();
  }
}

/** 读该场 job.log 尾部(默认 64KB;不存在 → null)。 */
export function readHubJobLog(streamKey: string, tailBytes = 65536, stageDir = hubStageDir()): string | null {
  const p = jobLogPath(streamKey, stageDir);
  if (!existsSync(p)) return null;
  const size = statSync(p).size;
  const buf = readFileSync(p);
  return buf.subarray(Math.max(0, size - tailBytes)).toString("utf-8");
}

/** `{platform}:{roomSlug}:{date...}` → 前两段(platform + roomSlug)。残缺 → 安全兜底。 */
function splitStreamKey(streamKey: string): { platform: string; roomSlug: string } {
  const parts = streamKey.split(":");
  return { platform: parts[0] ?? "", roomSlug: parts[1] ?? "" };
}

/** 资源节点判定(与 orchestrator workflow 的 node.resource 对齐):merge/burn=占用 CPU,上传类=占用上传队列。 */
function resourceOfNode(node: string | null): "cpu" | "net" | "upload" | null {
  if (!node) return null;
  if (node === "upload_plain" || node === "append_danmu" || node === "append_livechat") return "upload";
  if (node === "merge" || node === "burn_danmu" || node === "burn_livechat") return "cpu";
  return null;
}

export interface BuildQueueOpts {
  /** room key(`{platform}.{roomSlug}`)→ 主播显示名;省略 → anchorName=null。 */
  anchorOf?: (platform: string, roomSlug: string) => string | null;
  /**
   * 该房间被规则禁用的 pipeline 节点(如 stage 模式无 upload_plain/append_*)。
   * 用于把 nextSteps 里「本就不会跑」的节点剔除(否则 pending 场会显示不会发生的下一步)。
   * 省略 → 按全开推导(workflow 真跑起来后 nodeStates 的 skipped 会自纠)。
   */
  disabledOf?: (platform: string, roomSlug: string) => ReadonlySet<string> | null;
  /** master 资源池快照;省略(slave/未注入)→ 全 0(不影响列表,只是没有排队位次)。 */
  pool?: HubPoolSnapshotDTO;
  /** 最近完成条数(默认 8)。 */
  recentLimit?: number;
  /**
   * 按 phase 过滤 active(不传 = 全部)。前端筛选器下拉用 —— 大数据量下不必全量回前端再过滤。
   */
  phase?: readonly QueuePhase[];
  /**
   * 按 **pipeline 状态**过滤(`syncing` / `merging` / `uploading` / `pending` / `needs_manual` …),
   * 用于筛 UI 派生相(「拉取中」= state=syncing,它不在 QUEUE_PHASES 里)。不传 = 全部。
   */
  states?: readonly string[];
  /** 按平台过滤(不传 = 全部)。 */
  platform?: readonly string[];
  /** 按主播名 / 房间号 / streamKey 子串过滤(大小写不敏感;不传 = 全部)。 */
  q?: string;
  /**
   * 排序方向(仅作用于 active):
   * - `newest`(缺省):入队时间**倒序** —— 刚进队列的排最前,像日志一样看「最新动态」。
   * - `oldest`:入队时间**升序** —— 真正的 FIFO 视角,谁等最久谁排最前。
   * 两种方向都必须**确定性**(同刻用 streamKey 兜底),否则前端每次轮询顺序会跳动。
   */
  sort?: "newest" | "oldest";
  /**
   * 「待人工」最多列几条(默认 20)。needs_manual 是终态、却要留在进行中列表;
   * stage 模式的正常收口也是它(pipeline.ts:480)→ 长期 master 会堆积,必须 cap 否则淹没进行中区。
   */
  manualLimit?: number;
  now?: number;
  stageDir?: string;
}

const EMPTY_POOL: HubPoolSnapshotDTO = {
  cpu: { active: 0, queued: 0, max: 0 },
  net: { active: 0, queued: 0, max: 0 },
  upload: { active: 0, queued: 0, cooldownUntil: 0, windowUsed: 0, windowLimit: 0, windowResetAt: 0 },
  waiting: [],
};

/**
 * 处理队列聚合视图(GET /api/hub/queue):一屏回答「做了什么 / 正在做什么 / 下面做什么」。
 *
 * - active:所有非终态 job(`pending/settling/syncing/merging/uploading/retrying`),按状态分组排序。
 * - 排队判定:资源池快照里该 streamKey 在 `waiting` 中 → phase=queued + queuePosition(第 N 位);
 *   否则若当前 state 是资源节点 → phase=running;pending/settling → waiting_settle;其他 → running。
 * - doneSteps:该场已完成子步骤(做了什么);nextSteps:按 core DAG 推导(下面做什么)。
 */
export function buildQueueView(syncDbPath: string, opts: BuildQueueOpts = {}): HubQueueDTO {
  const { pool = EMPTY_POOL, recentLimit = 8, manualLimit = 20, stageDir = hubStageDir() } = opts;
  // **不要**用「取最近 N 条再客户端过滤」:台账超过 N 行后,updatedAt 较旧的**正在处理**场
  // 会被新完成的历史挤出结果 → 队列页整场消失(实测 1 active + 520 done → active=[])。
  // 故分两条精确查询:①非终态 ∪ needs_manual(=active) ②终态按 updatedAt 倒序取 recentLimit(=recent)。
  const activeRows = listHubJobs(syncDbPath, {
    excludeStates: [...TERMINAL], limit: 200, offset: 0, now: opts.now, stageDir,
  });
  const manualRows = listHubJobs(syncDbPath, {
    states: ["needs_manual"], limit: manualLimit, offset: 0, now: opts.now, stageDir,
  });
  const recentRows = listHubJobs(syncDbPath, {
    states: ["done", "failed"], limit: recentLimit, offset: 0, now: opts.now, stageDir,
  });
  // 同一场可能登记多条 waiting(两个 burn 同抢 cpu + upload)→ 取**最早**那条(最急)作代表,
  // 其余忽略(位次取该资源队列内的真实序号)。
  const waitingByKey = new Map<string, (typeof pool.waiting)[number]>();
  for (const w of [...pool.waiting].sort((a, b) => a.since - b.since)) {
    if (!waitingByKey.has(w.streamKey)) waitingByKey.set(w.streamKey, w);
  }

  const active: QueueItemDTO[] = [];
  const recent = [...recentRows.jobs];

  for (const job of [...activeRows.jobs, ...manualRows.jobs]) {
    const { platform, roomSlug } = splitStreamKey(job.streamKey);
    // 当前节点:优先 nodeStates 里 running 的节点,回落用 state 名映射。
    const runningNode = job.nodeStates.find((n) => n.state === "running")?.node ?? null;
    const currentNode = runningNode ?? stateToNode(job.state);
    const resource = resourceOfNode(currentNode);
    const waiting = waitingByKey.get(job.streamKey);
    const phase: QueuePhase = job.state === "needs_manual"
      ? "waiting_manual"
      : waiting
        ? "queued"
        : job.state === "pending" || job.state === "settling"
          ? "waiting_settle"
          : "running";
    // 已完成子步骤(做了什么):doneSteps = 有 done 事件的节点(去重,保序)。
    const doneSteps = doneStepsOf(job);
    // 下面做什么:DAG 中所有前驱已 done/skipped 的 pending 节点。
    const doneOrSkipped = new Set<string>(
      job.nodeStates.filter((n) => n.state === "done" || n.state === "skipped").map((n) => n.node),
    );
    const disabled = opts.disabledOf?.(platform, roomSlug) ?? null;
    // 「下面做什么」分两种口径,避免对还没开跑的场过度承诺:
    //  - **未在跑**(waiting_settle / waiting_manual,currentNode=null):只列**立即可跑**的节点
    //    (readyNodes = 所有前驱已 done/skipped)。否则 settling 场会一直挂着
    //    「下一步:烧 danmu / 传 plain / 追 P2 / 追 P3」,读起来像马上要跑(实际可能等几小时收播窗)。
    //  - **正在跑**(running/queued,currentNode!=null):列 DAG 里尚未完成、且不是当前节点的其余节点
    //    (当前节点自己由 currentNode 展示)。burn 与 upload 是并行轨,故这里是并集而非单链。
    const settled = new Set<string>([...doneOrSkipped, ...(disabled ?? [])]);
    const nextSteps = currentNode
      ? HUB_FLOW_ORDER.filter((n) => !doneOrSkipped.has(n) && !disabled?.has(n) && n !== currentNode)
      : readyNodes(settled);
    active.push({
      streamKey: job.streamKey,
      platform,
      roomSlug,
      anchorName: opts.anchorOf ? opts.anchorOf(platform, roomSlug) : null,
      state: job.state,
      phase,
      resource,
      queuePosition: waiting ? waiting.position : null,
      currentNode,
      doneSteps,
      nextSteps,
      currentStepSec: job.currentStepSec,
      etaSec: job.etaSec,
      winnerWorker: job.winnerWorker,
      fails: job.fails,
      updatedAt: job.updatedAt,
      // 入队时刻 = 首个事件(pending);startedAt 即 events[0].at,台账有事件就必有。
      enqueuedAt: job.startedAt,
    });
  }

  // 排序:按入队时刻。默认 `newest`(倒序,刚进队列的排最前 —— 看「最新动态」最直观);
  // `oldest` 才是 FIFO 视角(谁等最久谁排最前)。两者都按入队时间,**不再按 phase 分组**
  // (用户要的是队列顺序,不是状态分类)。入队时间缺失(极老 run)→ 回落 updatedAt;
  // 完全同刻 → streamKey 字典序兜底,保证多次轮询间顺序稳定不跳动。
  const dir = opts.sort === "oldest" ? 1 : -1;
  active.sort((a, b) => {
    const ea = a.enqueuedAt ?? a.updatedAt;
    const eb = b.enqueuedAt ?? b.updatedAt;
    if (ea !== eb) return (ea - eb) * dir;
    return a.streamKey < b.streamKey ? -1 : a.streamKey > b.streamKey ? 1 : 0;
  });
  recent.sort((a, b) => b.updatedAt - a.updatedAt);

  // 筛选(datatable 式):全部筛完再返回,前端拿到即所见。
  const phaseSet = opts.phase && opts.phase.length > 0 ? new Set(opts.phase) : null;
  const stateSet = opts.states && opts.states.length > 0 ? new Set(opts.states) : null;
  const platSet = opts.platform && opts.platform.length > 0 ? new Set(opts.platform) : null;
  const q = (opts.q ?? "").trim().toLowerCase();
  const filtered = active.filter((it) => {
    if (phaseSet && !phaseSet.has(it.phase)) return false;
    if (stateSet && !stateSet.has(it.state)) return false;
    if (platSet && !platSet.has(it.platform)) return false;
    if (q) {
      const hay = `${it.anchorName ?? ""} ${it.roomSlug} ${it.streamKey}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return { active: filtered, recent: recent.slice(0, recentLimit), pool };
}

/** 已完成子步骤(done 事件,按 step 去重、保首次完成序)。 */
function doneStepsOf(job: HubJobView): HubJobStep[] {
  const seen = new Set<string>();
  const out: HubJobStep[] = [];
  for (const s of job.steps) {
    if (s.phase !== "done" || seen.has(s.step)) continue;
    seen.add(s.step);
    out.push(s);
  }
  return out;
}

/** 粗粒度 state → 当前 pipeline 节点名(回落;更准的来自 nodeStates running)。 */
function stateToNode(state: string): string | null {
  switch (state) {
    case "merging": return "merge";
    case "uploading": return "upload_plain";
    case "syncing": return "pull";
    default: return null;
  }
}
