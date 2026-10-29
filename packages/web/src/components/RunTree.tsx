/**
 * RunTree — horizontal runtime tree of one run (issue #401). Read-only; the flow view next to it keeps retry.
 * Cards are laid out by flex; connectors are one SVG measured from the laid-out cards (`data-tr-id`),
 * so the tree follows resize and collapse. Below 1024px it becomes a plain vertical list without connectors.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, CircleHelp } from "lucide-react";
import { useT } from "../lib/i18n";
import type { PartRow, PartsNode, PipelineTree, RunTree as RunTreeModel, StepState } from "../lib/run-tree";

const MiB = 1024 * 1024;
type Edge = [from: string, to: string, dashed?: boolean];

function useEdges(ref: React.RefObject<HTMLDivElement | null>, edges: Edge[], signature: string): Array<{ d: string; dashed: boolean }> {
  const [paths, setPaths] = useState<Array<{ d: string; dashed: boolean }>>([]);
  useLayoutEffect(() => {
    const wrap = ref.current;
    if (!wrap) return;
    const draw = (): void => {
      if (window.matchMedia("(max-width: 1023px)").matches) { setPaths([]); return; }
      const base = wrap.getBoundingClientRect();
      const k = base.width / wrap.offsetWidth || 1; // the tree may be zoomed: measure in unscaled px
      const pt = (id: string): DOMRect | null => wrap.querySelector(`[data-tr-id="${id}"]`)?.getBoundingClientRect() ?? null;
      const out: Array<{ d: string; dashed: boolean }> = [];
      for (const [a, b, dashed] of edges) {
        const ra = pt(a); const rb = pt(b);
        if (!ra || !rb) continue;
        const x1 = (ra.right - base.left) / k; const y1 = (ra.top + ra.height / 2 - base.top) / k;
        const x2 = (rb.left - base.left) / k; const y2 = (rb.top + rb.height / 2 - base.top) / k;
        const mid = x1 + Math.max(14, (x2 - x1) / 2);
        out.push({ d: `M${x1} ${y1}H${mid}V${y2}H${x2}`, dashed: dashed === true });
      }
      setPaths(out);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, signature]);
  return paths;
}

export interface RunTreeRoot { title: string; sub: string; state: StepState; bv?: string | null }

export function RunTreeView({ root, tree }: { root: RunTreeRoot; tree: RunTreeModel }): ReactNode {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [height, setHeight] = useState<number | null>(null);
  const { edges, body } = tree.kind === "parts" ? partsBody(tree.nodes) : pipelineBody(tree);
  const paths = useEdges(wrapRef, edges.list, JSON.stringify(tree) + view.k);

  const desktop = (): boolean => window.matchMedia("(min-width: 1024px)").matches;
  // Fit the whole tree into the panel width (never enlarge past 100%).
  const fit = (): void => {
    const outer = outerRef.current; const inner = wrapRef.current;
    if (!outer || !inner || !desktop()) return;
    setView({ k: Math.min(1, outer.clientWidth / inner.scrollWidth), x: 0, y: 0 });
  };
  useLayoutEffect(fit, [tree.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Panel height follows the scaled tree (capped: a long chain pans instead of stretching the page).
  useLayoutEffect(() => {
    const inner = wrapRef.current;
    if (!inner) return;
    const upd = (): void => setHeight(desktop() ? Math.min(560, Math.ceil(inner.offsetHeight * view.k) + 8) : null);
    upd();
    const ro = new ResizeObserver(upd); ro.observe(inner);
    return () => ro.disconnect();
  }, [view.k]);

  // Ctrl/⌘ + wheel zooms around the pointer; a plain wheel keeps scrolling the page.
  useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || !desktop()) return;
      e.preventDefault();
      const r = outer.getBoundingClientRect();
      const px = e.clientX - r.left; const py = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(2, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        return { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) };
      });
    };
    outer.addEventListener("wheel", onWheel, { passive: false });
    return () => outer.removeEventListener("wheel", onWheel);
  }, []);

  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const zoom = (f: number): void => setView((v) => ({ ...v, k: Math.min(2, Math.max(0.3, v.k * f)) }));
  return (
    <div
      className="tr-wrap"
      ref={outerRef}
      style={height != null ? { height } : undefined}
      onPointerDown={(e) => {
        if (!desktop() || e.button !== 0 || (e.target as HTMLElement).closest("a,button")) return;
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <div className="tr-tools">
        <button type="button" className="tr-tool" aria-label={t("room.runTree.zoomIn")} onClick={() => zoom(1.2)}>+</button>
        <button type="button" className="tr-tool" aria-label={t("room.runTree.zoomOut")} onClick={() => zoom(1 / 1.2)}>−</button>
        <button type="button" className="tr-tool" onClick={fit}>{t("room.runTree.fit")}</button>
      </div>
      <div
        className="tr-inner"
        ref={wrapRef}
        style={{ "--tr-k": view.k, "--tr-x": `${view.x}px`, "--tr-y": `${view.y}px` } as React.CSSProperties}
      >
        <svg className="tr-svg" aria-hidden="true">
          {paths.map((p, i) => <path key={i} d={p.d} strokeDasharray={p.dashed ? "4 4" : undefined} className={p.dashed ? "tr-dash" : undefined} />)}
        </svg>
        <div className="tr-cols">
          <RootCard root={root} />
          {body}
        </div>
      </div>
    </div>
  );
}

function RootCard({ root }: { root: RunTreeRoot }): ReactNode {
  return (
    <div className="tr-col tr-col-root">
      <div className="tr-card tr-root" data-tr-id="root">
        <div className="tr-title">{root.title}</div>
        <div className="tr-sub">{root.sub}</div>
        <div className="tr-row"><StatePill state={root.state} />{root.bv && <span className="tr-pill">{root.bv}</span>}</div>
      </div>
    </div>
  );
}

interface Body { edges: { rootTo: string[]; list: Edge[] }; body: ReactNode }

function partsBody(nodes: PartsNode[]): Body {
  const list: Edge[] = [];
  const rootTo = nodes.map((n) => `n:${n.id}`);
  for (const n of nodes) for (const p of n.parts.filter((x) => !x.collapsed)) list.push([`n:${n.id}`, `p:${n.id}:${p.index}`]);
  for (const n of nodes) if (n.parts.some((p) => p.collapsed) || n.confirmed > 0 || n.pending > 0) list.push([`n:${n.id}`, `s:${n.id}`]);
  const body = (
    <div className="tr-col tr-groups">
      {nodes.map((n) => <PartsGroup key={n.id} node={n} />)}
    </div>
  );
  return { edges: { rootTo, list: [...rootTo.slice(1).map((to) => ["root", to] as Edge), ...list] }, body };
}

function PartsGroup({ node }: { node: PartsNode }): ReactNode {
  const t = useT();
  const open = node.parts.filter((p) => !p.collapsed);
  const folded = node.parts.filter((p) => p.collapsed);
  const summary = Math.max(node.confirmed, folded.length);
  return (
    <div className={`tr-group tr-role-${node.role}`}>
      <div className="tr-card tr-node" data-tr-id={`n:${node.id}`}>
        <div className="tr-kicker">{t(`room.runtime.role.${node.role}`)}</div>
        <div className="tr-title">{node.name}</div>
      </div>
      <div className="tr-parts">
        {(summary > 0 || node.pending > 0) && (
          <div className="tr-card tr-fold" data-tr-id={`s:${node.id}`}>
            {summary > 0 && <span className="tr-pill tr-green">{t("room.runTree.confirmedFold", { n: summary })}</span>}
            {node.pending > 0 && <span className="tr-pill">{t("room.runTree.pending", { n: node.pending })}</span>}
          </div>
        )}
        {open.map((p) => <PartCard key={p.index} part={p} id={`p:${node.id}:${p.index}`} />)}
        {node.parts.length === 0 && summary === 0 && node.pending === 0 && <div className="tr-empty">{t("room.runTree.noParts")}</div>}
      </div>
    </div>
  );
}

function PartCard({ part, id }: { part: PartRow; id: string }): ReactNode {
  const t = useT();
  const bar = part.capBytes && part.bytes != null ? Math.min(100, (part.bytes / part.capBytes) * 100) : null;
  return (
    <div className={`tr-card tr-part tr-part-${part.state}`} data-tr-id={id}>
      <span className="tr-pn">P{part.index + 1}</span>
      <div className="tr-chain">
        {part.steps.map((s, i) => (
          <span key={s.key} className="tr-chain-item">
            {i > 0 && <span className="tr-arrow">→</span>}
            <StatePill state={s.state} label={t(`room.runTree.step.${s.key}`)} />
          </span>
        ))}
      </div>
      {part.bytes != null && (
        <div className="tr-bytes">
          {bar != null && <div className="tr-bar"><i style={{ width: `${bar}%` }} /></div>}
          <span>{(part.bytes / MiB).toFixed(1)}{part.capBytes ? ` / ${(part.capBytes / MiB).toFixed(0)}` : ""} MiB</span>
        </div>
      )}
    </div>
  );
}

function pipelineBody(tree: PipelineTree): Body {
  const list: Edge[] = [];
  const hasCands = tree.candidates.length > 0;
  const rootTo = hasCands ? tree.candidates.map((c) => `c:${c.id}`) : ["sel"];
  if (hasCands) {
    for (const c of tree.candidates) list.push([`c:${c.id}`, "sel", !c.winner]);
  }
  if (tree.steps.length > 0) list.push(["sel", `h:${tree.steps[0].key}`]);
  const body = (
    <>
      {hasCands && <div className="tr-col tr-cands">{tree.candidates.map((c) => <CandidateCard key={c.id} c={c} />)}</div>}
      <div className="tr-col"><SelectCard state={tree.selectState} /></div>
      <div className="tr-col tr-chain-col"><HubChain tree={tree} /></div>
    </>
  );
  return { edges: { rootTo, list: [...rootTo.slice(1).map((to) => ["root", to] as Edge), ...list] }, body };
}

function CandidateCard({ c }: { c: PipelineTree["candidates"][number] }): ReactNode {
  const t = useT();
  return (
    <div className={`tr-card tr-node ${c.winner ? "tr-role-winner" : "tr-role-candidate"}`} data-tr-id={`c:${c.id}`}>
      <div className="tr-kicker">{t(c.winner ? "room.runtime.role.winner" : "room.runtime.role.candidate")}</div>
      <div className="tr-title">{c.name}</div>
      <div className="tr-sub">{t("room.runTree.cover", { pct: Math.round(c.coverage * 100), min: Math.round(c.durationSec / 60) })}{c.complete ? "" : ` · ${t("room.runTree.gap")}`}</div>
    </div>
  );
}

function SelectCard({ state }: { state: StepState }): ReactNode {
  const t = useT();
  return (
    <div className="tr-card tr-select" data-tr-id="sel">
      <div className="tr-kicker">hub</div>
      <div className="tr-title">{t("hub.jobs.stepNode.select")}</div>
      <div className="tr-row"><StatePill state={state} /></div>
    </div>
  );
}

function HubChain({ tree }: { tree: PipelineTree }): ReactNode {
  const t = useT();
  return (
    <div className="tr-hub">
      <div className="tr-kicker">{t("room.runTree.hubChain")}</div>
      {tree.steps.map((s, i) => (
        <div key={s.key} className={`tr-card tr-step tr-part-${s.state}`} data-tr-id={`h:${s.key}`}>
          <b>{i + 1} · {t(`hub.jobs.stepNode.${s.key}`)}</b>
          <StatePill state={s.state} />
        </div>
      ))}
    </div>
  );
}

export function StatePill({ state, label }: { state: StepState; label?: string }): ReactNode {
  const t = useT();
  const cls = state === "done" ? "tr-green" : state === "running" ? "tr-blue" : state === "failed" ? "tr-red" : "";
  const icon = state === "running" ? <Loader2 className="w-3 h-3 animate-spin" /> : state === "unknown" ? <CircleHelp className="w-3 h-3" /> : null;
  return <span className={`tr-pill ${cls} ${state === "waiting" || state === "skipped" ? "tr-dim" : ""}`}>{icon}{label ?? t(`room.runtime.stageState.${state}`)}</span>;
}
