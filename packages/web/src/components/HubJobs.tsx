import { memo, useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, FileText, Loader2, Minus, X } from "lucide-react";
import { ReactFlow, Background, Handle, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type HubJobDTO } from "../api/client";
import { IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { useT } from "../lib/i18n";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** 秒 → 人类可读("2h13m" / "8m" / "45s")。 */
export function humanSec(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
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

/** 规范 pipeline 节点固定布局(fork/join):merge 后分「烧录轨(上)/上传轨(下)」,再 join 到 append。 */
const STEP_DEFS: Array<{ key: string; x: number; y: number }> = [
  { key: "select", x: 0, y: 70 },
  { key: "pull", x: 150, y: 70 },
  { key: "merge", x: 300, y: 70 },
  { key: "burn_danmu", x: 470, y: 10 },
  { key: "burn_livechat", x: 640, y: 10 },
  { key: "upload_plain", x: 470, y: 130 },
  { key: "append_danmu", x: 810, y: 70 },
  { key: "append_livechat", x: 980, y: 70 },
];
const TERM = { key: "__term__", x: 1150, y: 70 };
const FLOW_EDGES: Array<[string, string]> = [
  ["select", "pull"], ["pull", "merge"],
  ["merge", "burn_danmu"], ["merge", "upload_plain"],
  ["burn_danmu", "burn_livechat"],
  ["burn_livechat", "append_danmu"], ["upload_plain", "append_danmu"],
  ["append_danmu", "append_livechat"], ["append_livechat", "__term__"],
];

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
  for (const def of STEP_DEFS) {
    const e = pair.get(def.key);
    if (e?.done != null) out[def.key] = { status: "done", sec: e.start != null ? Math.round((e.done - e.start) / 1000) : null };
    else if (e?.start != null) out[def.key] = { status: "active", sec: Math.round((now - e.start) / 1000) };
    else out[def.key] = { status: success ? "skipped" : "todo", sec: null };
  }
  return out;
}

/** 自定义节点:状态圆 + 标签 + 耗时。 */
function StepNode({ data }: { data: { label: string; status: NodeStatus; sec: number | null } }): ReactNode {
  const t = useT();
  const c = NODE_COLOR[data.status];
  return (
    <div className="flex flex-col items-center gap-1" style={{ width: 92 }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0, top: 11 }} />
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
        {data.status === "skipped" ? t("hub.jobs.skipped") : data.status === "todo" ? "" : humanSec(data.sec)}
      </span>
      <Handle type="source" position={Position.Right} style={{ opacity: 0, top: 11 }} />
    </div>
  );
}

const NODE_TYPES = { step: StepNode };

/** 单条 run 的 fork/join 流程图(React Flow):固定布局,节点按 job.steps 上色,active 边动画。 */
function PipelineFlowInner({ job }: { job: HubJobDTO }): ReactNode {
  const t = useT();
  const labels = stepLabelMap(t);
  // 旧版本 run 无细粒度 steps → 回落一行粗粒度状态文字(不画图)。
  if (job.steps.length === 0) {
    const line = job.events.map((e) => labels[e.state] ?? e.state).join(" → ");
    return <span className="text-muted-soft text-xs">{line || t("hub.jobs.noStepRecord")}</span>;
  }
  const st = stepStatuses(job);
  const termStatus: NodeStatus =
    job.state === "failed" ? "failed" : job.state === "done" ? "done" : job.state === "needs_manual" ? "done" : "todo";
  const termLabel = job.state === "needs_manual" ? labels.needs_manual : job.state === "failed" ? labels.failed : t("hub.jobs.termDone");
  const statusOf = (key: string): NodeStatus => (key === "__term__" ? termStatus : st[key].status);

  const nodes: Node[] = [
    ...STEP_DEFS.map((d) => ({
      id: d.key, type: "step", position: { x: d.x, y: d.y },
      data: { label: t(`hub.jobs.stepNode.${d.key}`), status: st[d.key].status, sec: st[d.key].sec },
    })),
    { id: TERM.key, type: "step", position: { x: TERM.x, y: TERM.y }, data: { label: termLabel, status: termStatus, sec: null } },
  ];
  const edges: Edge[] = FLOW_EDGES.map(([src, dst]) => {
    const ts = statusOf(dst);
    const reached = ts === "done" || ts === "active" || ts === "failed";
    return {
      id: `${src}-${dst}`, source: src, target: dst,
      animated: ts === "active", // 流入进行中节点 → React Flow 内置流动动画
      style: { stroke: reached ? "var(--success)" : "var(--hairline)", strokeWidth: 1.5 },
    };
  });

  return (
    <div style={{ height: 190 }} className="w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        panOnDrag={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} color="var(--hairline)" />
      </ReactFlow>
    </div>
  );
}

/** graph 的稳定签名:只由 steps + state 决定。轮询每 3s 传入新 job 对象,但只要签名不变就
 *  跳过重渲染 —— 避免每次轮询用全新 nodes/edges 数组冲刷 React Flow、触发 fitView 重算导致偶发空白。 */
function pipelineSig(j: HubJobDTO): string {
  return `${j.state}|${j.steps.map((s) => `${s.step}:${s.phase}:${s.at}`).join(",")}`;
}
export const PipelineFlow = memo(PipelineFlowInner, (a, b) => pipelineSig(a.job) === pipelineSig(b.job));

/** 一条 run 卡片:状态行 + 步骤时间线 + 元信息(选优/时长/BV/错误)+ 日志按钮。
 * `workerName` 可选:把 job.winnerWorker(id)映射成友好名,查不到回落 id。 */
export function RunCard({
  job,
  onOpenLog,
  workerName,
  expanded,
  onToggle,
}: {
  job: HubJobDTO;
  onOpenLog: (key: string) => void;
  workerName?: (id: string) => string;
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
          <PipelineFlow job={job} />
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
