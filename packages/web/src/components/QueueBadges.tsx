import type { ReactNode } from "react";
import { Gauge } from "lucide-react";
import type { NodeUploadStatusDTO } from "@drec/contracts";
import { Tooltip } from "./Tooltip";
import { fmtBytes } from "../lib/nodes-summary";
import { fmtTimeInTz } from "../lib/tz";
import { nodeUploadPhaseLabel, queueText } from "../lib/queue-chain";
import {
  partChainFields,
  partChainPolledAgo,
  partChainProgressPct,
  queueBadges,
  type PartChainUpload,
  type QueueChainItem,
  type TFunc,
} from "../lib/queue-chain";

export function QueueStateBadges({ item, t }: { item: QueueChainItem; t: TFunc }): ReactNode {
  const badges = queueBadges(item, t);
  if (badges.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {badges.map((badge) => {
        const node = <span key={badge.kind} className="badge badge-neutral">{badge.label}</span>;
        return badge.title ? <Tooltip key={badge.kind} content={badge.title}>{node}</Tooltip> : node;
      })}
    </span>
  );
}

/**
 * Part-chain telemetry: state / step / attempts / notBefore / live byte progress.
 * Only backend fields are printed; no percentage or retry verdict is synthesized.
 */
export function PartChainLine({
  upload,
  now,
  tz,
  t,
  className = "",
}: {
  upload: PartChainUpload;
  now: number;
  tz: string;
  t: TFunc;
  className?: string;
}): ReactNode {
  const notBeforeText = upload.notBefore != null ? fmtTimeInTz(new Date(upload.notBefore), tz) : null;
  const fields = partChainFields(upload, t, notBeforeText, now);
  const pct = partChainProgressPct(upload);
  const progress = upload.progress;
  return (
    <div className={`space-y-1 ${className}`.trim()}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted" title={upload.error ?? undefined}>
        <span className="inline-flex items-center gap-1"><Gauge className="w-3 h-3" />{upload.nodeId}</span>
        {fields.map((field, index) => <span key={`${index}-${field}`}>{field}</span>)}
        {progress && progress.totalBytes > 0 && (
          <span>{fmtBytes(progress.doneBytes)} / {fmtBytes(progress.totalBytes)}</span>
        )}
        {progress?.bps != null && progress.bps > 0 && <span>{fmtBytes(progress.bps)}/s</span>}
        <span>{partChainPolledAgo(upload, t, now)}</span>
      </div>
      {pct != null && <div className="live-progress"><span style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

/** Node upload telemetry for any queue row: nodeId, phase/step, bytes, rate and attempts. */
export function NodeUploadLine({ upload, now, tz, t, className = "" }: {
  upload: NodeUploadStatusDTO;
  now: number;
  tz: string;
  t: TFunc;
  className?: string;
}): ReactNode {
  if (upload.phase === "part-chain") {
    return <PartChainLine upload={upload} now={now} tz={tz} t={t} className={className} />;
  }
  const p = upload.progress;
  const pct = p && p.totalBytes > 0 ? Math.min(100, Math.max(0, (p.doneBytes / p.totalBytes) * 100)) : null;
  return (
    <div className={`space-y-1 ${className}`.trim()}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
        <span className="inline-flex items-center gap-1"><Gauge className="w-3 h-3" />{t("queue.live.upload")}</span>
        <span>{upload.nodeId}</span>
        <span>{nodeUploadPhaseLabel(t, upload.phase)}{upload.step ? ` · ${queueText(t, `queue.nodeUpload.step.${upload.step}`, upload.step)}` : ""}</span>
        {p && <span>{fmtBytes(p.doneBytes)} / {fmtBytes(p.totalBytes)}</span>}
        {p?.bps != null && p.bps > 0 && <span>{fmtBytes(p.bps)}/s</span>}
        {upload.attempts != null && upload.attempts > 1 && <span>{queueText(t, "queue.nodeUpload.attempt", `attempt ${upload.attempts}`, { n: upload.attempts })}</span>}
      </div>
      {pct != null && <div className="live-progress"><span style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}
