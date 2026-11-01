/**
 * web/api/maintenance.ts — T13 维护清理端点(孤儿/空壳/scratch)。
 *
 *   GET  /api/maintenance/orphans → **预览**(只扫不删)
 *   POST /api/maintenance/orphans → 执行(**必须显式 `{confirm:true}`**,否则退化成预览)
 *
 * ## 活动文件保护(本文件的核心价值)
 * 清理会**自己**从 store/manager 推导「正在录制」与「正在上传/处理」的路径并传给扫描器:
 *   - 正在录制:`manager.isRecording(id)===true` 的任务的输出目录(正在写的分段、刚落的 xml);
 *   - 正在处理:非终态 hub job 的 stage 子目录(正在 merge/burn/upload 的产物)。
 * 推导不出来(无 hub 台账)→ 只按「正在录制」保护,stage 侧靠 scratch 陈旧阈值兜底。
 *
 * 直接构造所需 handler(**不进 `makeApi`**),故只依赖 store/manager/hub 台账路径 ——
 * 无需在 `Api`/`ApiDeps` 上加字段(`web/api/types.ts` 不在本次改动范围)。
 */
import { listHubJobs, hubStageDir, jobLogPaths } from "../../hub-jobs.js";
import { cleanupOrphans, scanOrphans, type ScanOptions, type ScanResult, type CleanupResult } from "../../orphan-cleanup.js";
import { drecRoot, resolveOutputDir, rootLogsDir, rootStageDir } from "../../paths.js";
import { join as pathJoin } from "node:path";
import { cleanupJobLogs, parseJobLogDays, previewJobLogs } from "../../job-log-cleanup.js";
import { HUB_TERMINAL_STATES, platformForRoom, recordingRoomDirCandidates, stageSessionDirCandidates } from "@drec/core";
import type { ManagerLike, ApiResult } from "./types.js";
import type { TaskStore } from "../../store.js";

export interface MaintenanceDeps {
  store: TaskStore;
  manager: ManagerLike;
  /** hub 台账 sqlite 路径;省略 → 不做「正在处理」侧保护(仅靠正在录制 + 陈旧阈值)。 */
  syncDbPath?: string;
  /** 数据根(扫描根);省略回落 `drecRoot()`。 */
  dataRoot?: string;
  /** stage 目录覆盖(hub.config.json 的 stageDir 优先,默认 `<root>/stage`)。 */
  stageDir?: string;
  /** hub 场次日志根目录;省略回落 `rootLogsDir()`。 */
  logsDir?: string;
  /** 维护审计文件目录;省略回落 `<root>/config/maintenance`。 */
  auditDir?: string;
}

/**
 * Every recording directory a task may be writing to: the legacy anchor-name directory (same rule as
 * web/api/context.ts recordingsDir, both go through core) plus any suffix-matched room directory.
 * Empty when the name is not resolved yet -- protect nothing rather than guess a wrong directory
 * (the scratch staleness threshold covers that case).
 */
function recordingDirsOf(task: { room: string; outDir: string | null; name: string | null }, anchor: string | null): string[] {
  const base = resolveOutputDir(task.outDir);
  let room: { platform: string; roomSlug: string } | undefined;
  try {
    const p = platformForRoom(task.room);
    room = { platform: p.id, roomSlug: p.extractRoomSlug(task.room) };
  } catch { /* unknown platform: legacy directory only */ }
  return recordingRoomDirCandidates(base, [task.name, anchor], room);
}

export function buildMaintenance(deps: MaintenanceDeps): {
  previewOrphans(): ApiResult;
  cleanupOrphans(input: { confirm?: boolean } | undefined): ApiResult;
  previewJobLogs(days: unknown): ApiResult;
  cleanupJobLogs(input: { olderThanDays?: unknown; confirm?: boolean } | undefined): ApiResult;
} {
  const root = deps.dataRoot ?? drecRoot();
  const logsRoot = deps.logsDir ?? rootLogsDir();

  /** 当前活动路径:正在录制的目录 + 非终态 hub job 的 stage 子目录 + 非终态 job 的 job.log。宁可多保留,不可误删。 */
  const activity = (): { recordingDirs: string[]; activePaths: string[]; activeLogPaths: string[] } => {
    const recordingDirs: string[] = [];
    for (const t of deps.store.listTasks()) {
      if (!deps.manager.isRecording(t.id)) continue;
      recordingDirs.push(...recordingDirsOf(t, deps.manager.getAnchorName(t.id) ?? t.anchorName));
    }
    const activePaths: string[] = [];
    const activeLogPaths: string[] = [];
    if (deps.syncDbPath) {
      try {
        const terminal = new Set<string>(HUB_TERMINAL_STATES);
        const { jobs } = listHubJobs(deps.syncDbPath, { limit: 200, excludeStates: [...terminal] });
        const stage = deps.stageDir ?? hubStageDir();
        // Paths come from the core resolver (the pipeline builds them there too) and cover both the
        // legacy and the room layout: a mismatch would leave the active job unprotected, silently.
        for (const j of jobs) {
          activePaths.push(...stageSessionDirCandidates(stage, j.streamKey));
          // job.log 的全部候选位置(新 logs/hub + legacy stage):job-log 清理据此排除非终态 job(#429)。
          activeLogPaths.push(...jobLogPaths(j.streamKey, stage, logsRoot));
        }
      } catch {
        // 台账读不到(首次运行/损坏)→ 只靠「正在录制」+ 陈旧阈值兜底(宁可少删);
        // job-log 侧同样不排除也不报错(保守 = 维持旧口径,不误伤接口)。
      }
    }
    return { recordingDirs, activePaths, activeLogPaths };
  };

  const scanOpts = (): ScanOptions => {
    const dirs = [resolveOutputDir(null), deps.stageDir ?? rootStageDir()];
    return { dirs, ...activity() };
  };

  return {
    previewOrphans(): ApiResult {
      try {
        const r: ScanResult = scanOrphans(root, scanOpts());
        return { status: 200, body: { dryRun: true, ...r } };
      } catch (e) {
        return { status: 500, body: { error: `扫描失败: ${(e as Error)?.message ?? e}` } };
      }
    },

    cleanupOrphans(input): ApiResult {
      // 绝无「手滑就删」:未显式 confirm → 400,提示先预览。
      if (input?.confirm !== true) {
        return { status: 400, body: { error: "清理需要显式 confirm=true(先用 GET 预览)" } };
      }
      try {
        const r: CleanupResult = cleanupOrphans(root, { ...scanOpts(), dryRun: false });
        // 删除失败不吞:failed 数组随 body 返回,前端可见;整体仍 200(部分成功是常态)。
        return { status: 200, body: r };
      } catch (e) {
        return { status: 500, body: { error: `清理失败: ${(e as Error)?.message ?? e}` } };
      }
    },

    previewJobLogs(days: unknown): ApiResult {
      const n = parseJobLogDays(days);
      if (n === null) return { status: 400, body: { error: "天数必须为 1–3650 的整数" } };
      try {
        // 非终态 job 的日志不在清理集(#429);台账读不到 → activity() 给空集 = 不排除。
        return { status: 200, body: { dryRun: true, ...previewJobLogs(logsRoot, n, Date.now(), { paths: new Set(activity().activeLogPaths) }) } };
      } catch {
        // Fixed text: an fs error message would carry the full data-root path.
        return { status: 500, body: { error: "场次日志扫描失败" } };
      }
    },

    cleanupJobLogs(input): ApiResult {
      // 同孤儿清理:未显式 confirm → 400,先预览。
      if (input?.confirm !== true) {
        return { status: 400, body: { error: "清理需要显式 confirm=true(先用 GET 预览)" } };
      }
      const n = parseJobLogDays(input.olderThanDays);
      if (n === null) return { status: 400, body: { error: "天数必须为 1–3650 的整数" } };
      try {
        // 删除失败不吞:failed 随 body 返回;整体 200(部分成功是常态)。
        // Same audit file as the orphan cleanup: always the data root's config/maintenance.
        // 非终态 job 的日志不在清理集(#429);台账读不到 → 空集 = 不排除、不报错。
        return { status: 200, body: cleanupJobLogs(logsRoot, n, deps.auditDir ?? pathJoin(root, "config", "maintenance"), Date.now(), { paths: new Set(activity().activeLogPaths) }) };
      } catch {
        return { status: 500, body: { error: "场次日志清理失败" } };
      }
    },
  };
}
