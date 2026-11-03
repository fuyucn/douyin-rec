import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { platformForRoom, isWorkerAssigned } from "@drec/core";
import * as hubStore from "../../hub-store.js";
import * as workerStore from "../../worker-store.js";
import * as roomStats from "../../room-stats.js";
import { rootStatsDbPath } from "../../paths.js";
import { effectiveTimezone } from "../../timezone.js";
import type { StatsDTO } from "@drec/core";
import type { StatsRoomInfo } from "../../room-stats.js";

export function buildStats(ctx: ApiCtx) {
  const { store, hubDir, hubConfigPath, err } = ctx;
  return {
    getStats(opts: { days?: number } = {}): ApiResult {
      const days = Math.max(1, Math.min(90, Number(opts.days) || 30));
      const now = Date.now();
      const rules = hubStore.listHubRules(hubDir);
      const ruleByKey = new Map(rules.map((r) => [r.key, r]));
      const workersCfg = workerStore.listWorkers(hubConfigPath);
      const workerNames = Object.fromEntries(workersCfg.map((w) => [w.id, w.name ?? null]));
      const allWorkerIds = workersCfg.map((w) => w.id);
      const tasks = store.listTasks();

      const byKey = new Map<string, StatsRoomInfo>();
      for (const t of tasks) {
        let platform = "douyin";
        let roomSlug = "";
        try { const p = platformForRoom(t.room); platform = p.id; roomSlug = p.extractRoomSlug(t.room); } catch { /* leave empty */ }
        const key = `${platform}.${roomSlug}`;
        const existing = byKey.get(key);
        if (existing) {
          // 同一房间多任务去重,但 enabled 取「任何一个启用」(停用的老任务不得盖掉启用的新任务)
          existing.enabled = existing.enabled || t.enabled === true;
          if (!existing.anchorName && t.anchorName) existing.anchorName = t.anchorName;
          continue;
        }
        const rule = ruleByKey.get(key) ?? null;
        // 无规则 → 本机单节点；有规则但 upload.mode 未配 → stage（与 hub 默认一致）
        const uploadMode = rule?.pipeline?.upload?.mode ?? (rule ? "stage" : "local");
        // hub 语义：workers 缺省/空数组 = 全部节点
        // 用 core.isWorkerAssigned(唯一真理源)算归属:规则启用 ∧ workers 勾选(空=全选) ∧ 能力满足 requires。
        // 不能只看 workers 数组 —— 规则停用/能力不满足的节点也应在 assignedRooms 里排除。
        const capsOf = (id: string): readonly string[] | undefined => workersCfg.find((w) => w.id === id)?.capabilities;
        const workers = rule
          ? allWorkerIds.filter((id) => isWorkerAssigned(rule as { enabled?: boolean; workers?: readonly string[]; requires?: readonly string[] }, id, capsOf(id)))
          : ["local"];
        byKey.set(key, {
          platform,
          roomSlug,
          anchorName: t.anchorName ?? null,
          enabled: t.enabled === true,
          uploadMode,
          outputFormat: t.outputFormat ?? "original",
          engine: t.engine ?? "ffmpeg",
          danmu: t.danmu === 1,
          workers,
        });
      }
      const rooms = [...byKey.values()];

      let sessions: ReturnType<typeof roomStats.readStatsSessions>;
      try {
        sessions = roomStats.readStatsSessions(rootStatsDbPath(), now - days * 86_400_000);
      } catch (readErr) {
        return err(500, String((readErr as Error)?.message ?? readErr));
      }
      const dto = roomStats.buildStats({
        dbPath: rootStatsDbPath(),
        sessions,
        rooms,
        workerNames,
        windowDays: days,
        now,
        timeZone: effectiveTimezone(store),
      });
      return { status: 200, body: dto as StatsDTO };
    },
  };
}