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
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { rootHubConfig, rootStageDir } from "./paths.js";

export interface HubJobEvent { state: string; at: number; }
/** 细粒度子步骤事件(start/done)—— 驱动前端 fork/join 流程图。 */
export interface HubJobStep { step: string; phase: string; at: number; }
export interface HubJobView {
  streamKey: string;
  state: string;
  winnerWorker: string | null;
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
  /** 当前步已运行秒数(终态 = null)。 */
  currentStepSec: number | null;
  /** 当前步预计剩余秒数(粗估;终态/没依据 = null)。 */
  etaSec: number | null;
  /** winner 的视频时长(选优明细,ETA 的换算基准;无 = null)。 */
  videoDurationSec: number | null;
  /** 该场 job.log 是否存在(存在才给「查看日志」入口)。 */
  hasLog: boolean;
}

/** 终态集合(与 orchestrator ledger 的 JobState 对齐,字符串契约)。 */
const TERMINAL = new Set(["done", "needs_manual", "failed"]);
/** 无历史数据时的保守「步骤耗时/视频时长」比率(按 2026-07 实测:烧录 veryfast ~0.11×,上传取决于带宽)。 */
const FALLBACK_RATE: Record<string, number> = { pending: 0.01, settling: 0.05, syncing: 0.1, merging: 0.3, uploading: 0.6 };

function sanitizeKey(key: string): string { return key.replace(/[:/]/g, "_"); }

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
      if (prefix) {
        total = Number((db.prepare("SELECT COUNT(*) AS n FROM sync_jobs WHERE streamKey LIKE ?")
          .get(prefix + "%") as unknown as { n: number }).n);
        jobs = db.prepare("SELECT * FROM sync_jobs WHERE streamKey LIKE ? ORDER BY updatedAt DESC LIMIT ? OFFSET ?")
          .all(prefix + "%", limit, offset) as unknown as RawJob[];
      } else {
        total = Number((db.prepare("SELECT COUNT(*) AS n FROM sync_jobs").get() as unknown as { n: number }).n);
        jobs = db.prepare("SELECT * FROM sync_jobs ORDER BY updatedAt DESC LIMIT ? OFFSET ?")
          .all(limit, offset) as unknown as RawJob[];
      }
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
        steps = db.prepare("SELECT step, phase, at FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC")
          .all(j.streamKey) as unknown as HubJobStep[];
      } catch { /* 旧库无 steps 表 → 空(前端回落粗粒度) */ }
      const videoDurationSec = (db.prepare("SELECT durationSec FROM sync_candidates WHERE streamKey=? AND isWinner=1")
        .get(j.streamKey) as unknown as { durationSec: number } | undefined)?.durationSec ?? null;
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
        winnerWorker: j.winnerWorker ?? null, bv: j.bv ?? null, error: j.error ?? null,
        fails: Number(j.fails ?? 0), updatedAt: Number(j.updatedAt),
        startedAt: events.length ? Number(events[0].at) : null,
        events: events.map((e) => ({ state: e.state, at: Number(e.at) })),
        steps: steps.map((s) => ({ step: s.step, phase: s.phase, at: Number(s.at) })),
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
