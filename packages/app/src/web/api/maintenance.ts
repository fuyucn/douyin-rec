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
import { join } from "node:path";
import { listHubJobs, hubStageDir } from "../../hub-jobs.js";
import { cleanupOrphans, scanOrphans, type ScanOptions, type ScanResult, type CleanupResult } from "../../orphan-cleanup.js";
import { drecRoot, resolveOutputDir, rootStageDir } from "../../paths.js";
import { HUB_TERMINAL_STATES, sanitizeStreamKey } from "@drec/core";
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
}

/**
 * 名字净化成单个安全路径段 —— **必须与 `@drec/record-engine` 的 sanitizePathSegment 同规则**
 * (web/api/context.ts 的 recordingsDir 也是这套)。写错会让「正在录制」的保护落到错误的目录上,
 * 形同没有保护(静默失去安全阀)。
 */
function sanitizeSeg(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 任务的实际录像目录(与 web/api/context.ts 的 recordingsDir 同口径:`outDir` + 净化后的主播子目录)。
 * 无子目录时返回 `null` —— 与 recordingsDir 一致(命名尚未解析出来 → 无法定位,宁可少保护 +
 * 让 scratch 陈旧阈值兜底,也不猜一个错误的目录)。
 */
function recordingDirOf(outDir: string | null, name: string | null, anchor: string | null): string | null {
  const base = resolveOutputDir(outDir);
  const sub = (name ? sanitizeSeg(name) : "") || (anchor ? sanitizeSeg(anchor) : "");
  return sub ? join(base, sub) : null;
}

export function buildMaintenance(deps: MaintenanceDeps): {
  previewOrphans(): ApiResult;
  cleanupOrphans(input: { confirm?: boolean } | undefined): ApiResult;
} {
  const root = deps.dataRoot ?? drecRoot();

  /** 当前活动路径:正在录制的目录 + 非终态 hub job 的 stage 子目录。宁可多保留,不可误删。 */
  const activity = (): { recordingDirs: string[]; activePaths: string[] } => {
    const recordingDirs: string[] = [];
    for (const t of deps.store.listTasks()) {
      if (!deps.manager.isRecording(t.id)) continue;
      const dir = recordingDirOf(t.outDir, t.name, deps.manager.getAnchorName(t.id) ?? t.anchorName);
      if (dir) recordingDirs.push(dir);
    }
    const activePaths: string[] = [];
    if (deps.syncDbPath) {
      try {
        const terminal = new Set<string>(HUB_TERMINAL_STATES);
        const { jobs } = listHubJobs(deps.syncDbPath, { limit: 200, excludeStates: [...terminal] });
        const stage = deps.stageDir ?? hubStageDir();
        // 用权威 sanitizeStreamKey(hub-jobs 的 stage 子目录也按它建),不自己拼一个近似的:
        // 两者一旦不一致,活动 job 的保护就会指向不存在的目录 —— 保护静默失效,比报错更糟。
        for (const j of jobs) {
          activePaths.push(join(stage, sanitizeStreamKey(j.streamKey)));
        }
      } catch {
        // 台账读不到(首次运行/损坏)→ 只靠「正在录制」+ 陈旧阈值兜底(宁可少删)。
      }
    }
    return { recordingDirs, activePaths };
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
  };
}
