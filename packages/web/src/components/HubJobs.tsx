import { memo, useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, FileText, Loader2, Minus, X } from "lucide-react";
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type HubJobDTO } from "../api/client";
import { IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { Tooltip } from "./Tooltip";
import { useT } from "../lib/i18n";
import { buildFlow, pickMetric, type FlowCfg } from "./flow-build";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** 秒 → 人类可读("2h13m" / "8m" / "45s")。节点面板紧凑用,分钟四舍五入(不显示秒)。 */
export function humanSec(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** 秒 → 精确到秒("1h37m59s" / "9m53s" / "45s")。hover 详情用(不四舍五入,整秒为 0 时省略)。 */
export function humanSecFull(sec: number | null): string {
  if (sec == null) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (ss || parts.length === 0) parts.push(`${ss}s`);
  return parts.join("");
}

/** 状态 → 步骤名(译文,渲染时按当前语言解析)。 */
function stepLabelMap(t: TFunc): Record<string, string> {
  return {
    pending: t("hub.jobs.step.pending"),
    settling: t("hub.jobs.step.settling"),
    syncing: t("hub.jobs.step.syncing"),
    merging: t("hub.jobs.step.merging"),
    uploading: t("hub.jobs.step.uploading"),
    done: t("hub.jobs.step.done"),
    failed: t("hub.jobs.step.failed"),
    needs_manual: t("hub.jobs.step.needsManual"),
  };
}

export const TERMINAL = new Set(["done", "failed", "needs_manual"]);

export function stateColor(state: string): string {
  if (state === "done") return "var(--success)";
  if (state === "failed") return "var(--error)";
  if (state === "needs_manual") return "var(--warning)";
  return "var(--ink)"; // 进行中
}

/** streamKey "douyin:767…:2026-07-04" → 场次日期后缀(展示用)。 */
export function runDate(streamKey: string): string {
  const parts = streamKey.split(":");
  return parts.slice(2).join(":") || streamKey;
}

type NodeStatus = "done" | "active" | "skipped" | "todo" | "failed";

const NODE_COLOR: Record<NodeStatus, { bg: string; fg: string; ring: string }> = {
  done: { bg: "var(--success)", fg: "#fff", ring: "var(--success)" },
  active: { bg: "var(--ink)", fg: "var(--canvas)", ring: "var(--ink)" },
  failed: { bg: "var(--error)", fg: "#fff", ring: "var(--error)" },
  skipped: { bg: "transparent", fg: "var(--muted-soft)", ring: "var(--hairline)" },
  todo: { bg: "transparent", fg: "var(--muted-soft)", ring: "var(--hairline)" },
};

/** 所有可能出现的子步骤 key(与布局解耦,仅供 stepStatuses 遍历取状态)。 */
const ALL_STEP_KEYS = ["select", "pull", "merge", "burn_danmu", "burn_livechat", "clean_stage_src", "upload_plain", "append_danmu", "append_livechat", "clean_source", "clean_stage"] as const;

/** 从 job.steps(start/done 配对)推导每个子步骤的状态 + 耗时。 */
function stepStatuses(job: HubJobDTO): Record<string, { status: NodeStatus; sec: number | null }> {
  const pair = new Map<string, { start?: number; done?: number }>();
  for (const s of job.steps) {
    const e = pair.get(s.step) ?? {};
    if (s.phase === "start") e.start = s.at;
    else e.done = s.at;
    pair.set(s.step, e);
  }
  const success = job.state === "done" || job.state === "needs_manual";
  const now = Date.now();
  const out: Record<string, { status: NodeStatus; sec: number | null }> = {};
  for (const key of ALL_STEP_KEYS) {
    const e = pair.get(key);
    if (e?.done != null) out[key] = { status: "done", sec: e.start != null ? Math.round((e.done - e.start) / 1000) : null };
    else if (e?.start != null) out[key] = { status: "active", sec: Math.round((now - e.start) / 1000) };
    else out[key] = { status: success ? "skipped" : "todo", sec: null };
  }
  return out;
}

/** 自定义节点:状态圆 + 标签 + 耗时。hover 出详情(状态 + 耗时)。 */
function StepNode({ data }: { data: { label: string; status: NodeStatus; sec: number | null; metric?: string | null; detail?: string } }): ReactNode {
  const t = useT();
  const c = NODE_COLOR[data.status];
  const showSec = data.status !== "skipped" && data.status !== "todo" && data.sec != null;
  const tip = (
    <div className="text-left leading-snug">
      <div className="font-medium text-[12px]">{data.label}</div>
      <div className="text-[11px] text-muted-soft mt-0.5">
        {t(`hub.jobs.tipStatus.${data.status}`)}
        {showSec ? ` · ${humanSecFull(data.sec)}` : ""}
      </div>
      {data.detail && <div className="text-[11px] text-muted-soft mt-0.5">{data.detail}</div>}
    </div>
  );
  return (
    <div className="flex flex-col items-center" style={{ width: 92 }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0, top: 11 }} />
      <Tooltip content={tip}>
        <div className="flex flex-col items-center gap-1">
          <span
            className={`inline-flex items-center justify-center rounded-full w-6 h-6${data.status === "active" ? " flow-node-active" : ""}`}
            style={{ background: c.bg, color: c.fg, border: `1.5px solid ${c.ring}` }}
          >
            {data.status === "done" && <Check className="w-3.5 h-3.5" />}
            {data.status === "active" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {data.status === "failed" && <X className="w-3.5 h-3.5" />}
            {data.status === "skipped" && <Minus className="w-3.5 h-3.5" />}
            {data.status === "todo" && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--muted-soft)" }} />}
          </span>
          <span
            className="text-[11px] text-center leading-tight"
            style={{ color: data.status === "todo" || data.status === "skipped" ? "var(--muted-soft)" : "var(--ink)", fontWeight: data.status === "active" ? 600 : 400 }}
          >
            {data.label}
          </span>
          <span className="text-[10px] font-mono" style={{ color: data.status === "active" ? "var(--ink)" : "var(--muted-soft)" }}>
            {data.metric ?? (data.status === "skipped" ? t("hub.jobs.skipped") : data.status === "todo" ? "" : humanSec(data.sec))}
          </span>
        </div>
      </Tooltip>
      <Handle type="source" position={Position.Right} style={{ opacity: 0, top: 11 }} />
    </div>
  );
}

/** select 步的 fan-in 候选节点:录制节点 + 覆盖度;winner 绿框 + ✔ + 「最优」。hover 出详情(覆盖/时长/完整/胜出)。 */
function CandidateNode({ data }: { data: { name: string; coveragePct: number; durationSec: number; complete: boolean; isWinner: boolean } }): ReactNode {
  const t = useT();
  const win = data.isWinner;
  const tip = (
    <div className="text-left leading-snug">
      <div className="font-medium text-[12px]">{data.name}{win ? ` · ${t("hub.jobs.candWinner")}` : ""}</div>
      <div className="text-[11px] text-muted-soft mt-0.5">
        {t("hub.jobs.candCoverage", { pct: data.coveragePct })} · {humanSecFull(data.durationSec)}
        {data.complete ? ` · ${t("hub.jobs.candComplete")}` : ""}
      </div>
    </div>
  );
  return (
    <div className="flex flex-col items-center" style={{ width: 104 }}>
      <Tooltip content={tip}>
        <div className="flex flex-col items-center gap-0.5">
          <span
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] max-w-full"
            style={{
              border: `1.5px solid ${win ? "var(--success)" : "var(--hairline)"}`,
              background: win ? "color-mix(in srgb, var(--success) 12%, transparent)" : "transparent",
              color: win ? "var(--ink)" : "var(--muted-soft)",
            }}
          >
            {win && <Check className="w-3 h-3 shrink-0" style={{ color: "var(--success)" }} />}
            <span className="font-medium truncate">{data.name}</span>
          </span>
          <span className="text-[10px] font-mono leading-tight" style={{ color: win ? "var(--ink)" : "var(--muted-soft)" }}>
            {data.complete ? t("hub.jobs.candComplete") : t("hub.jobs.candCoverage", { pct: data.coveragePct })}
            {win ? ` · ${t("hub.jobs.candWinner")}` : ""}
          </span>
        </div>
      </Tooltip>
      <Handle type="source" position={Position.Right} style={{ opacity: 0, top: 13 }} />
    </div>
  );
}

const NODE_TYPES = { step: StepNode, candidate: CandidateNode };

/** 单条 run 的 fork/join 流程图(React Flow):按 job.steps + cfg 动态生成节点(buildFlow),按 job.steps 上色,active 边动画。
 *  workerName:candidate 节点 id→友好名映射(缺省回落 id)。cfg:该房间的 pipeline 规则(决定进行中 run 画哪些可选节点)。 */
function PipelineFlowInner({ job, workerName, cfg }: { job: HubJobDTO; workerName?: (id: string) => string; cfg?: FlowCfg }): ReactNode {
  const t = useT();
  const labels = stepLabelMap(t);
  // 旧版本 run 无细粒度 steps → 回落一行粗粒度状态文字(不画图)。
  if (job.steps.length === 0) {
    const line = job.events.map((e) => labels[e.state] ?? e.state).join(" → ");
    return <span className="text-muted-soft text-xs">{line || t("hub.jobs.noStepRecord")}</span>;
  }
  const st = stepStatuses(job);
  // select 步的候选节点:各录制节点竖排在 select 左侧(-190),edge 汇入 select;winner 高亮。
  const cands = job.candidates;
  const candNodes: Node[] = cands.map((c, i) => ({
    id: `cand:${c.worker}`,
    type: "candidate",
    position: { x: -190, y: 70 + (i - (cands.length - 1) / 2) * 66 },
    data: {
      name: workerName ? workerName(c.worker) : c.worker,
      coveragePct: Math.round(c.coverage * 100),
      durationSec: c.durationSec,
      complete: c.complete,
      isWinner: c.isWinner,
    },
  }));
  const candEdges: Edge[] = cands.map((c) => ({
    id: `cand:${c.worker}-select`,
    source: `cand:${c.worker}`,
    target: "select",
    style: {
      stroke: c.isWinner ? "var(--success)" : "var(--hairline)",
      strokeWidth: c.isWinner ? 2 : 1,
      strokeDasharray: c.isWinner ? undefined : "3 3",
    },
  }));
  const graph = buildFlow(job, TERMINAL.has(job.state) ? undefined : cfg);
  const detailOf = (key: string): string | undefined =>
    job.steps.filter((s) => s.step === key && s.phase === "done").map((s) => s.detail).filter(Boolean).pop();
  const termStatus: NodeStatus =
    job.state === "failed" ? "failed" : job.state === "done" ? "done" : job.state === "needs_manual" ? "done" : "todo";
  const termLabel = job.state === "needs_manual" ? labels.needs_manual : job.state === "failed" ? labels.failed : t("hub.jobs.termDone");

  const nodes: Node[] = [
    ...graph.nodes.filter((n) => n.key !== "__term__").map((n) => ({
      id: n.key, type: "step", position: { x: n.x, y: n.y },
      data: {
        label: t(`hub.jobs.stepNode.${n.key}`),
        status: st[n.key]?.status ?? "todo",
        sec: st[n.key]?.sec ?? null,
        detail: detailOf(n.key),
        metric: n.key === "select"
          ? (job.winnerWorker ? (workerName ? workerName(job.winnerWorker) : job.winnerWorker) : null)
          : pickMetric(n.key, detailOf(n.key)),
      },
    })),
    ...(() => {
      const tn = graph.nodes.find((n) => n.key === "__term__")!;
      return [{ id: "__term__", type: "step", position: { x: tn.x, y: tn.y }, data: { label: termLabel, status: termStatus, sec: null, metric: null } }];
    })(),
    ...candNodes,
  ];
  const edges: Edge[] = [
    ...graph.edges.map(([src, dst]) => {
      const ts = dst === "__term__" ? termStatus : (st[dst]?.status ?? "todo");
      const reached = ts === "done" || ts === "active" || ts === "failed";
      return {
        id: `${src}-${dst}`, source: src, target: dst,
        animated: ts === "active", // 流入进行中节点 → React Flow 内置流动动画
        style: { stroke: reached ? "var(--success)" : "var(--hairline)", strokeWidth: 1.5 },
      };
    }),
    ...candEdges,
  ];

  return (
    <div style={{ height: 190 }} className="w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick
        panOnDrag
        preventScrolling
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} color="var(--hairline)" />
        <Controls showInteractive={false} className="flow-controls" />
      </ReactFlow>
    </div>
  );
}

/** graph 的稳定签名:由 steps + state + 候选(节点/胜出)决定。轮询每 3s 传入新 job 对象,但只要
 *  签名不变就跳过重渲染 —— 避免每次轮询用全新 nodes/edges 数组冲刷 React Flow、触发 fitView 重算导致偶发空白。 */
function pipelineSig(j: HubJobDTO, cfg?: FlowCfg): string {
  const cand = j.candidates.map((c) => `${c.worker}:${c.isWinner ? 1 : 0}`).join(",");
  const steps = j.steps.map((s) => `${s.step}:${s.phase}:${s.at}:${s.detail ?? ""}`).join(",");
  const c = cfg ? JSON.stringify([cfg.steps, cfg.upload?.mode, cfg.cleanup]) : "";
  return `${j.state}|${steps}|${cand}|${c}`;
}
// workerName 也纳入比较:worker 列表异步加载完(candidate 名从 id 变友好名)时须重渲染一次。
// 依赖 workerName 用 useCallback 稳定引用(见 RoomDetail),否则每帧新引用会击穿 memo → 空白 bug 复发。
export const PipelineFlow = memo(
  PipelineFlowInner,
  (a, b) => pipelineSig(a.job, a.cfg) === pipelineSig(b.job, b.cfg) && a.workerName === b.workerName,
);

/** 一条 run 卡片:状态行 + 步骤时间线 + 元信息(选优/时长/BV/错误)+ 日志按钮。
 * `workerName` 可选:把 job.winnerWorker(id)映射成友好名,查不到回落 id。 */
export function RunCard({
  job,
  onOpenLog,
  workerName,
  cfg,
  expanded,
  onToggle,
}: {
  job: HubJobDTO;
  onOpenLog: (key: string) => void;
  workerName?: (id: string) => string;
  /** 该房间的 pipeline 规则(决定进行中 run 画哪些可选节点);终态 run 不需要(buildFlow 按实际 steps)。 */
  cfg?: FlowCfg;
  /** 展开时内联显示该 run 自己的 PipelineFlow 图;收起只留状态行。 */
  expanded?: boolean;
  onToggle?: (streamKey: string) => void;
}): ReactNode {
  const t = useT();
  const labels = stepLabelMap(t);
  return (
    <div
      className={`px-3 py-3${onToggle ? " cursor-pointer transition-colors" : ""}`}
      style={{
        // 平铺列表行:无边框/圆角,展开的一条用直边左 accent 条(方形行不弯曲),靠 divide-y 分隔。
        borderLeft: `2px solid ${expanded ? "var(--muted-soft)" : "transparent"}`,
      }}
      onClick={onToggle ? () => onToggle(job.streamKey) : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {onToggle && (
            <ChevronDown className={`w-3.5 h-3.5 text-muted-soft transition-transform ${expanded ? "" : "-rotate-90"}`} />
          )}
          <span className="font-mono text-[13px] text-ink">{runDate(job.streamKey)}</span>
          <span className="inline-flex items-center gap-1 text-[13px] font-medium" style={{ color: stateColor(job.state) }}>
            {!TERMINAL.has(job.state) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {labels[job.state] ?? job.state}
            {job.currentStepSec != null && (
              <span className="text-muted-soft font-normal">{t("hub.jobs.runningFor", { time: humanSec(job.currentStepSec) })}</span>
            )}
            {!TERMINAL.has(job.state) && job.etaSec != null && (
              <span className="text-muted-soft font-normal">{t("hub.jobs.etaRemaining", { time: humanSec(job.etaSec) })}</span>
            )}
          </span>
        </div>
        {job.hasLog && (
          <IconButton
            title={t("hub.jobs.viewLog")}
            onClick={(e) => {
              e.stopPropagation();
              onOpenLog(job.streamKey);
            }}
          >
            <FileText className="w-4 h-4" />
          </IconButton>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-2 text-[12px] text-muted">
        {job.winnerWorker && <span>{t("hub.jobs.selected", { worker: workerName ? workerName(job.winnerWorker) : job.winnerWorker })}</span>}
        {job.videoDurationSec != null && <span>{t("hub.jobs.duration", { time: humanSec(Math.round(job.videoDurationSec)) })}</span>}
        {job.fails > 0 && <span style={{ color: "var(--warning)" }}>{t("hub.jobs.retries", { count: job.fails })}</span>}
        {job.bv && (
          <a className="text-muted hover:text-ink" href={`https://www.bilibili.com/video/${job.bv}`} target="_blank" rel="noreferrer">
            {job.bv}
          </a>
        )}
      </div>
      {job.error && <div className="text-[12px] mt-1" style={{ color: "var(--error)" }}>{job.error}</div>}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-hairline overflow-x-auto" onClick={(e) => e.stopPropagation()}>
          <PipelineFlow job={job} workerName={workerName} cfg={cfg} />
        </div>
      )}
    </div>
  );
}

/** job.log 查看弹窗(受控:logKey!=null 打开;logKey 变化即重新拉取)。列表页/历史页共用。 */
export function JobLogDialog({ logKey, onClose }: { logKey: string | null; onClose: () => void }): ReactNode {
  const t = useT();
  const [text, setText] = useState(t("hub.common.loading"));
  useEffect(() => {
    if (logKey === null) return;
    let alive = true;
    setText(t("hub.common.loading"));
    void api
      .getHubJobLog(logKey)
      .then((r) => alive && setText(r.log || t("hub.jobs.logEmpty")))
      .catch(() => alive && setText(t("hub.jobs.logReadFailed")));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logKey]);
  return (
    <Dialog open={logKey !== null} onClose={onClose} widthClass="max-w-3xl" title={t("hub.jobs.logTitle", { key: logKey ?? "" })}>
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-[60vh] overflow-auto bg-surface-soft rounded p-3 text-body">
        {text}
      </pre>
    </Dialog>
  );
}

/** 规则行内的「最近一次运行」紧凑徽标(在跑=当前步 spinner;终态=状态)。无 run → 提示。 */
export function LatestRunBadge({ run }: { run: HubJobDTO | undefined }): ReactNode {
  const t = useT();
  const labels = stepLabelMap(t);
  if (!run) return <span className="text-muted-soft text-xs">{t("hub.jobs.noRunYet")}</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: stateColor(run.state) }}>
      {!TERMINAL.has(run.state) && <Loader2 className="w-3 h-3 animate-spin" />}
      {labels[run.state] ?? run.state}
      {run.currentStepSec != null && <span className="text-muted-soft font-normal">· {humanSec(run.currentStepSec)}</span>}
    </span>
  );
}
