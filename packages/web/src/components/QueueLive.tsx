import type { ReactNode } from "react";
import { ArrowRight, Gauge, Timer } from "lucide-react";
import type { HubPoolSnapshotDTO } from "../api/client";
import { humanSec } from "./HubJobs";
import { useT } from "../lib/i18n";
import type { LiveUploadLane as LiveUploadLaneRow } from "../lib/queue-live";

/** Live zero-disk upload lanes: one compact row per actively uploading part. */
export function LiveUploadLanes({ lanes, now }: { lanes: LiveUploadLaneRow[]; now: number }): ReactNode {
  const t = useT();
  if (lanes.length === 0) return null;
  return (
    <div className="space-y-2 mb-5">
      {lanes.map((l) => (
        <article key={`${l.taskId}-${l.workerId}`} className="live-lane">
          <div className="live-lane-head">
            <div className="min-w-0">
              <div className="font-medium text-ink truncate">{l.name ?? l.room}</div>
              <div className="font-mono text-[11px] text-muted-soft mt-0.5">
                {l.workerName} · {t("queue.liveUpload.state", { state: t(`room.zeroDisk.live.state.${l.state}`) })}
              </div>
            </div>
            <div className="text-right shrink-0">
              {l.partIndex !== undefined && <div className="font-mono text-sm text-ink">P{l.partIndex + 1}</div>}
              {l.bvid && <div className="font-mono text-[11px] text-muted">{l.bvid}</div>}
              <div className="text-[10px] text-muted-soft">{Math.max(0, Math.round((now - l.updatedAt) / 1000))}s</div>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

/** Resource pool strip: only real slots and cooldown values. */
export function LivePool({ pool }: { pool: HubPoolSnapshotDTO }): ReactNode {
  const t = useT();
  const cooldown = Math.max(0, Math.round((pool.upload.cooldownUntil - Date.now()) / 1000));
  const uploadUsage = pool.upload.windowLimit > 0
    ? `${pool.upload.windowUsed}/${pool.upload.windowLimit}`
    : t("queue.pool.unlimited");
  return (
    <div className="telemetry-bar telemetry-bar-cols-3 mb-5">
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5">
          <span className="telemetry-label">{t("queue.pool.cpu")}</span>
          <span className="telemetry-value tabular-nums">
            {pool.cpu.active}/{pool.cpu.max || "-"}
            {pool.cpu.queued > 0 && <span className="text-muted-soft font-normal text-[13px]"> · {t("queue.pool.queued", { n: pool.cpu.queued })}</span>}
          </span>
        </div>
        <span className="telemetry-icon"><Gauge className="w-4 h-4" /></span>
      </div>
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5">
          <span className="telemetry-label">{t("queue.pool.upload")}</span>
          <span className="telemetry-value tabular-nums">
            {uploadUsage}
            {pool.upload.queued > 0 && <span className="text-muted-soft font-normal text-[13px]"> · {t("queue.pool.queued", { n: pool.upload.queued })}</span>}
          </span>
        </div>
        <span className="telemetry-icon"><ArrowRight className="w-4 h-4" /></span>
      </div>
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5"><span className="telemetry-label">{t("queue.pool.cooldown")}</span><span className="telemetry-value tabular-nums" style={{ color: cooldown ? "var(--warning-fg)" : undefined }}>{cooldown ? humanSec(cooldown) : t("queue.pool.noCooldown")}</span></div>
        <span className="telemetry-icon"><Timer className="w-4 h-4" /></span>
      </div>
    </div>
  );
}
