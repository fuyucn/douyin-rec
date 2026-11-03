import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { platformForRoom } from "@drec/core";
import * as hubStore from "../../hub-store.js";
import * as workerStore from "../../worker-store.js";
import * as roomStats from "../../room-stats.js";
import { rootStatsDbPath } from "../../paths.js";
import { effectiveTimezone } from "../../timezone.js";
import type { StatsDTO } from "@drec/core";
import type { StatsRoomInfo } from "../../room-stats.js";

export function buildStats(ctx: ApiCtx) {
  const { store, hubDir, hubConfigPath } = ctx;
  return {
    getStats(opts: { days?: number } = {}): ApiResult {
      const days = Math.max(1, Math.min(90, Number(opts.days) || 30));
      const now = Date.now();
      const rules = hubStore.listHubRules(hubDir);
      const ruleByKey = new Map(rules.map((r) => [r.key, r]));
      const workers = workerStore.listWorkers(hubConfigPath);
      const workerNames = Object.fromEntries(workers.map((w) => [w.id, w.name ?? null]));
      const tasks = store.listTasks();

      const rooms: StatsRoomInfo[] = tasks.map((t) => {
        let platform = "douyin";
        let roomSlug = "";
        try { const p = platformForRoom(t.room); platform = p.id; roomSlug = p.extractRoomSlug(t.room); } catch { /* leave empty */ }
        const key = `${platform}.${roomSlug}`;
        const rule = ruleByKey.get(key) ?? null;
        const uploadMode = rule?.pipeline?.upload?.mode ?? (rule ? "stage" : "local");
        return {
          platform,
          roomSlug,
          anchorName: t.anchorName ?? null,
          enabled: t.enabled === true,
          uploadMode,
          outputFormat: t.outputFormat ?? "original",
          engine: t.engine ?? "ffmpeg",
          danmu: t.danmu === 1,
          workers: rule?.workers && rule.workers.length ? [...rule.workers] : (rule ? [] : ["local"]),
        };
      });

      const sessions = roomStats.readStatsSessions(rootStatsDbPath(), now - days * 86_400_000);
      const dto = roomStats.buildStats({
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