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
      const workersCfg = workerStore.listWorkers(hubConfigPath);
      const workerNames = Object.fromEntries(workersCfg.map((w) => [w.id, w.name ?? null]));
      const allWorkerIds = workersCfg.map((w) => w.id);
      const tasks = store.listTasks();

      const seenKeys = new Set<string>();
      const rooms: StatsRoomInfo[] = [];
      for (const t of tasks) {
        let platform = "douyin";
        let roomSlug = "";
        try { const p = platformForRoom(t.room); platform = p.id; roomSlug = p.extractRoomSlug(t.room); } catch { /* leave empty */ }
        const key = `${platform}.${roomSlug}`;
        if (seenKeys.has(key)) continue; // 同一房间多任务只计一次，避免 knownRooms 重复
        seenKeys.add(key);
        const rule = ruleByKey.get(key) ?? null;
        // 无规则 → 本机单节点；有规则但 upload.mode 未配 → stage（与 hub 默认一致）
        const uploadMode = rule?.pipeline?.upload?.mode ?? (rule ? "stage" : "local");
        // hub 语义：workers 缺省/空数组 = 全部节点
        const workers = rule
          ? (rule.workers && rule.workers.length ? [...rule.workers] : [...allWorkerIds])
          : ["local"];
        rooms.push({
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