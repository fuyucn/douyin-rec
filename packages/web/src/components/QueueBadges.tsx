import type { ReactNode } from "react";
import { Gauge } from "lucide-react";
import { Tooltip } from "./Tooltip";
import { fmtBytes } from "../lib/nodes-summary";
import { fmtTimeInTz } from "../lib/tz";
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
