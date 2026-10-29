/**
 * RuntimeTree — the read-only room runtime responsibility tree (issue #398).
 *
 * Structure inspired by the agent-tree reference, visuals aligned with the current console tokens:
 * same canvas, hairline borders, 6px radii, mono labels, no shadows or gradients. Connectors are a
 * single inline SVG overlay measured from the laid-out cards, so the tree survives resize and does
 * not hard-code positions.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleHelp, Loader2 } from "lucide-react";
import { useT } from "../lib/i18n";
import { fmtClock } from "../lib/labels";
import type { NodeRole, NodeState, RuntimeNote, RuntimeStage, RuntimeTreeModel, StageState } from "../lib/runtime-tree";

const MiB = 1024 * 1024;

interface Connector { d: string }

/** Measure the laid-out cards and emit rounded trunk + branch paths. */
function useConnectors(ref: React.RefObject<HTMLDivElement | null>, signature: string): Connector[] {
  const [paths, setPaths] = useState<Connector[]>([]);
  useLayoutEffect(() => {
    const wrap = ref.current;
    if (!wrap) return;
    const draw = (): void => {
      const root = wrap.querySelector<HTMLElement>("[data-rt-root]");
      const heads = Array.from(wrap.querySelectorAll<HTMLElement>("[data-rt-head]"));
      if (!root || heads.length === 0 || window.matchMedia("(max-width: 720px)").matches) {
        setPaths([]);
        return;
      }
      const base = wrap.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      const sx = r.left - base.left + r.width / 2;
      const sy = r.bottom - base.top + 6;
      const midY = sy + 20;
      const points = heads.map((h) => {
        const b = h.getBoundingClientRect();
        return { x: b.left - base.left + b.width / 2, y: b.top - base.top - 6 };
      });
      const minX = Math.min(sx, ...points.map((p) => p.x));
      const maxX = Math.max(sx, ...points.map((p) => p.x));
      const out: Connector[] = [
        { d: `M${sx} ${sy} V${midY}` },
        { d: `M${minX} ${midY} H${maxX}` },
      ];
      for (const p of points) {
        const radius = Math.min(8, Math.abs(p.x - sx) / 2);
        const dir = p.x >= sx ? 1 : -1;
        out.push({
          d: Math.abs(p.x - sx) < 1
            ? `M${sx} ${midY} V${p.y}`
            : `M${sx} ${midY} H${p.x - dir * radius} Q${p.x} ${midY} ${p.x} ${midY + radius} V${p.y}`,
        });
      }
      setPaths(out);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    for (const el of wrap.querySelectorAll<HTMLElement>("[data-rt-root],[data-rt-head]")) ro.observe(el);
    window.addEventListener("resize", draw);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [ref, signature]);
  return paths;
}

interface RuntimeTreeProps {
  model: RuntimeTreeModel;
  roomName: string;
  anchorName: string | null;
  platform: string;
  roomId: string;
  startedAt: string;
  bvHref: (bv: string) => string;
}

export function RuntimeTree({ model, roomName, anchorName, platform, roomId, startedAt, bvHref }: RuntimeTreeProps): ReactNode {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const signature = useMemo(() => model.nodes.map((n) => `${n.id}:${n.stages.length}`).join("|"), [model.nodes]);
  const paths = useConnectors(wrapRef, signature);

  const winner = model.nodes.find((n) => n.role === "winner");
  const hub = model.nodes.find((n) => n.role === "controller");
  const workers = model.nodes.filter((n) => n.role !== "controller");
  const elapsed = model.elapsedMs != null ? fmtClock(model.elapsedMs) : "-";

  return (
    <div className="rt">
      <div className="telemetry-bar rt-tele mb-5">
        <Cell label={t("room.runtime.currentRun")} value={`${model.startedAt ? startedAt : t("room.runtime.noRun")} · ${t(`room.runtime.mode.${model.mode}`)}`} />
        <Cell label={t("room.runtime.winner")} value={model.winnerName ?? t("room.runtime.noWinner")} mono />
        <Cell label={t("room.runtime.nodesLabel")} value={t("room.runtime.nodesValue", { total: model.totals.nodes, recording: model.totals.recording })} />
        <Cell label={t("room.runtime.upload")} value={
          model.upload
            ? `P${model.upload.part} · ${model.upload.uploadedMiB.toFixed(1)} MiB`
            : model.bvid ? model.bvid : "-"
        } mono />
      </div>

      <div className="card rt-card">
        <div className="rt-head">
          <div>
            <div className="section-label">{t("room.runtime.title")}</div>
            <div className="rt-sub">{t("room.runtime.subtitle")}</div>
          </div>
          <div className="flex items-center gap-3">
            <OverallPill overall={model.overall} />
            <span className="rt-readonly">{t("room.runtime.readOnly")}</span>
          </div>
        </div>

        <div className="rt-wrap" ref={wrapRef}>
          <svg className="rt-svg" aria-hidden="true">
            {paths.map((p, i) => <path key={i} d={p.d} />)}
          </svg>

          <div className="rt-root" data-rt-root>
            <div className="rt-card-inner">
              <div className="rt-run-top">
                <div className="min-w-0">
                  <div className="rt-kicker">{t("room.runtime.runKicker")}</div>
                  <div className="rt-run-title">{roomName}</div>
                  <div className="rt-run-sub">
                    {model.startedAt ? `${startedAt} · ` : ""}{platform} · {roomId}
                    {anchorName ? ` · ${anchorName}` : ""}
                  </div>
                </div>
                <div className="rt-badges">
                  <span className="rt-pill rt-pill-blue">{t(`room.runtime.mode.${model.mode}`)}</span>
                  {winner && <span className="rt-pill rt-pill-green">{t("room.runtime.winnerBadge", { name: winner.name })}</span>}
                  <span className="rt-pill">{t("room.runtime.nodesBadge", { n: model.totals.nodes })}</span>
                  {model.bvid && (
                    <a className="rt-pill rt-pill-link" href={bvHref(model.bvid)} target="_blank" rel="noreferrer">{model.bvid}</a>
                  )}
                </div>
              </div>
              <div className="rt-run-foot">
                <span>{t("room.runtime.elapsed")} · <span className="font-mono">{elapsed}</span></span>
                {hub && <span>{t("room.runtime.hubState")} · {t(`room.runtime.nodeState.${hub.state}`)}</span>}
              </div>
            </div>
          </div>

          <div className="rt-branches" style={{ "--rt-cols": Math.min(model.nodes.length, 4) } as React.CSSProperties}>
            {workers.length === 0 && (
              <div className="rt-empty">{t("room.runtime.noNodes")}</div>
            )}
            {workers.map((n) => <Branch key={n.id} node={n} defaultOpen={n.role === "winner"} />)}
            {hub && <Branch key={hub.id} node={hub} defaultOpen />}
          </div>
        </div>
      </div>

      <div className="card rt-events">
        <div className="rt-head">
          <div className="section-label">{t("room.runtime.events")}</div>
          <span className="rt-readonly">{t("room.runtime.eventsHint", { n: model.events.length })}</span>
        </div>
        {model.events.length === 0 ? (
          <p className="rt-empty">{t("room.runtime.noEvents")}</p>
        ) : (
          <ul className="rt-event-list">
            {model.events.map((e, i) => (
              <li key={`${e.at}-${e.kind}-${e.part ?? "-"}-${i}`} className="rt-event">
                <span className="rt-event-time">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="rt-event-kind">{t(`room.zeroDisk.live.event.${e.kind}`)}</span>
                <span className="rt-event-detail">
                  {e.part !== undefined ? `P${e.part + 1}` : ""}
                  {e.part !== undefined && e.uploadedBytes !== undefined ? " · " : ""}
                  {e.uploadedBytes !== undefined ? `${(e.uploadedBytes / MiB).toFixed(1)} MiB` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Branch({ node, defaultOpen }: { node: RuntimeTreeModel["nodes"][number]; defaultOpen: boolean }): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const hasStages = node.stages.length > 0;
  return (
    <div className={`rt-branch rt-role-${node.role}`}>
      <div className="rt-node" data-rt-head>
        <div className="rt-card-inner">
          <div className="rt-node-head">
            <div className="min-w-0">
              <div className="rt-node-name">{node.name}</div>
              <div className="rt-node-role">{t(`room.runtime.role.${node.role}`)}</div>
            </div>
            <NodeStatePill role={node.role} state={node.state} />
          </div>
          <div className="rt-node-line">{nodeHeadline(t, node)}</div>
          {(node.version || typeof node.diskFreeGB === "number") && (
            <div className="rt-node-meta">
              <span>{typeof node.diskFreeGB === "number" ? t("room.runtime.diskFree", { gb: node.diskFreeGB.toFixed(1) }) : ""}</span>
              {node.version && <span className="font-mono">{node.version}</span>}
            </div>
          )}
        </div>
      </div>

      {hasStages && (
        <div className="rt-stages">
          <button type="button" className="rt-stages-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <span>{t("room.runtime.stages", { n: node.stages.length })}</span>
          </button>
          {open && (
            <ol className="rt-stage-list">
              {node.stages.map((s, i) => <StageRow key={`${s.key}-${i}`} stage={s} index={i} />)}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function StageRow({ stage, index }: { stage: RuntimeStage; index: number }): ReactNode {
  const t = useT();
  return (
    <li className={`rt-stage rt-stage-${stage.state}`}>
      <span className="rt-stage-dot" aria-hidden="true" />
      <div className="rt-stage-body">
        <div className="rt-stage-top">
          <span className="rt-stage-name">{index + 1} · {t(`room.runtime.stage.${stage.key}`)}</span>
          <StageStatePill state={stage.state} />
        </div>
        {stage.note && <div className="rt-stage-note">{noteText(t, stage.note)}</div>}
      </div>
    </li>
  );
}

function noteText(t: ReturnType<typeof useT>, note: RuntimeNote): string {
  switch (note.kind) {
    case "recording": return t("room.runtime.note.recording");
    case "recorded": return t("room.runtime.note.recorded");
    case "part": return note.capMiB != null
      ? t("room.runtime.note.partCap", {
        part: note.part,
        uploaded: note.uploadedMiB != null ? note.uploadedMiB.toFixed(1) : "0.0",
        cap: note.capMiB.toFixed(0),
      })
      : t("room.runtime.note.part", {
        part: note.part,
        uploaded: note.uploadedMiB != null ? note.uploadedMiB.toFixed(1) : "0.0",
      });
    case "partsConfirmed": return t("room.runtime.note.partsConfirmed", { n: note.count });
    case "winner": return t("room.runtime.note.winner", { name: note.name });
    case "runState": return t("room.runtime.note.runState", { state: note.state });
    case "confirmedBv": return t("room.runtime.note.confirmedBv", { bv: note.bv });
    case "failed": return note.reason ? t("room.runtime.note.failedReason", { reason: note.reason }) : t("room.runtime.note.failed");
    case "ambiguous": return t("room.runtime.note.ambiguous", { n: note.count });
    case "segmentConfirmed": return t("room.runtime.note.segmentConfirmed", { confirmed: note.confirmed, total: note.total });
    case "skipped": return t(`room.runtime.note.skipped.${note.reason}`);
    case "noData": return t("room.runtime.note.noData");
  }
}

function nodeHeadline(t: ReturnType<typeof useT>, node: RuntimeTreeModel["nodes"][number]): string {
  if (node.role === "controller") return t(`room.runtime.nodeState.${node.state}`);
  if (node.state === "uploading") return t("room.runtime.headline.uploading");
  if (node.state === "recording") return t("room.runtime.headline.recording");
  if (node.state === "offline") return t("room.runtime.headline.offline");
  if (node.state === "unknown") return t("room.runtime.headline.unknown");
  if (node.state === "idle") return t("room.runtime.headline.idle");
  return t("room.runtime.headline.unknown");
}

function OverallPill({ overall }: { overall: RuntimeTreeModel["overall"] }): ReactNode {
  const t = useT();
  const cls: Record<RuntimeTreeModel["overall"], string> = {
    live: "rt-pill-blue",
    running: "rt-pill-blue",
    done: "rt-pill-green",
    attention: "rt-pill-red",
    waiting: "rt-pill-muted",
  };
  const spin = overall === "live" || overall === "running";
  return (
    <span className={`rt-pill ${cls[overall]}`}>
      {spin ? <Loader2 className="w-3 h-3 animate-spin" /> : <span className="rt-pill-dot" />}
      {t(`room.runtime.overall.${overall}`)}
    </span>
  );
}

function NodeStatePill({ role, state }: { role: NodeRole; state: NodeState }): ReactNode {
  const t = useT();
  const cls = state === "recording" || state === "uploading"
    ? "rt-pill-blue"
    : state === "syncing"
      ? "rt-pill-blue"
      : state === "offline"
        ? "rt-pill-red"
        : role === "candidate"
          ? "rt-pill-amber"
          : "rt-pill-muted";
  const icon = state === "unknown" ? <CircleHelp className="w-3 h-3" /> : state === "recording" || state === "uploading" || state === "syncing" ? <Loader2 className="w-3 h-3 animate-spin" /> : <span className="rt-pill-dot" />;
  return <span className={`rt-pill ${cls}`}>{icon}{t(`room.runtime.nodeState.${state}`)}</span>;
}

function StageStatePill({ state }: { state: StageState }): ReactNode {
  const t = useT();
  const cls: Record<StageState, string> = {
    done: "rt-pill-green",
    running: "rt-pill-blue",
    waiting: "rt-pill-muted",
    failed: "rt-pill-red",
    skipped: "rt-pill-muted",
    unknown: "rt-pill-muted",
  };
  const spin = state === "running";
  return (
    <span className={`rt-pill ${cls[state]}`}>
      {spin ? <Loader2 className="w-3 h-3 animate-spin" /> : state === "unknown" ? <CircleHelp className="w-3 h-3" /> : <span className="rt-pill-dot" />}
      {t(`room.runtime.stageState.${state}`)}
    </span>
  );
}

function Cell({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className="telemetry-cell">
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="telemetry-label">{label}</span>
        <span className={`telemetry-value-sm truncate ${mono ? "font-mono" : ""}`} title={value}>{value}</span>
      </div>
    </div>
  );
}
