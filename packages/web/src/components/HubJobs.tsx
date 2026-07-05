import { useEffect, useState, type ReactNode } from "react";
import { Check, FileText, Loader2, Minus, X } from "lucide-react";
import { ReactFlow, Background, Handle, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type HubJobDTO } from "../api/client";
import { IconButton } from "./Button";
import { Dialog } from "./Dialog";

/** 秒 → 人类可读("2h13m" / "8m" / "45s")。 */
export function humanSec(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** 状态 → 中文步骤名。 */
export const STEP_LABEL: Record<string, string> = {
  pending: "排队中",
  settling: "等待收播",
  syncing: "拉取文件",
  merging: "合并 / 烧录",
  uploading: "上传 B 站",
  done: "已完成",
  failed: "失败",
  needs_manual: "待人工",
};
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
const STEP_DEFS: Array<{ key: string; label: string; x: number; y: number }> = [
  { key: "select", label: "选优", x: 0, y: 70 },
  { key: "pull", label: "拉取", x: 150, y: 70 },
  { key: "merge", label: "合并 plain", x: 300, y: 70 },
  { key: "burn_danmu", label: "烧 danmu", x: 470, y: 10 },
  { key: "burn_livechat", label: "烧 livechat", x: 640, y: 10 },
  { key: "upload_plain", label: "传 plain P1", x: 470, y: 130 },
  { key: "append_danmu", label: "追 danmu P2", x: 810, y: 70 },
  { key: "append_livechat", label: "追 livechat P3", x: 980, y: 70 },
];
const TERM = { key: "__term__", label: "完成", x: 1150, y: 70 };
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
        {data.status === "skipped" ? "跳过" : data.status === "todo" ? "" : humanSec(data.sec)}
      </span>
      <Handle type="source" position={Position.Right} style={{ opacity: 0, top: 11 }} />
    </div>
  );
}

const NODE_TYPES = { step: StepNode };

/** 单条 run 的 fork/join 流程图(React Flow):固定布局,节点按 job.steps 上色,active 边动画。 */
function PipelineFlow({ job }: { job: HubJobDTO }): ReactNode {
  // 旧版本 run 无细粒度 steps → 回落一行粗粒度状态文字(不画图)。
  if (job.steps.length === 0) {
    const line = job.events.map((e) => STEP_LABEL[e.state] ?? e.state).join(" → ");
    return <span className="text-muted-soft text-xs">{line || "（无流程记录;旧版本任务）"}</span>;
  }
  const st = stepStatuses(job);
  const termStatus: NodeStatus =
    job.state === "failed" ? "failed" : job.state === "done" ? "done" : job.state === "needs_manual" ? "done" : "todo";
  const termLabel = job.state === "needs_manual" ? "待人工" : job.state === "failed" ? "失败" : "完成";
  const statusOf = (key: string): NodeStatus => (key === "__term__" ? termStatus : st[key].status);

  const nodes: Node[] = [
    ...STEP_DEFS.map((d) => ({
      id: d.key, type: "step", position: { x: d.x, y: d.y },
      data: { label: d.label, status: st[d.key].status, sec: st[d.key].sec },
    })),
    { id: TERM.key, type: "step", position: { x: TERM.x, y: TERM.y }, data: { label: termLabel, status: termStatus, sec: null } },
  ];
  const edges: Edge[] = FLOW_EDGES.map(([s, t]) => {
    const ts = statusOf(t);
    const reached = ts === "done" || ts === "active" || ts === "failed";
    return {
      id: `${s}-${t}`, source: s, target: t,
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

/** 一条 run 卡片:状态行 + 步骤时间线 + 元信息(选优/时长/BV/错误)+ 日志按钮。 */
export function RunCard({ job, onOpenLog }: { job: HubJobDTO; onOpenLog: (key: string) => void }): ReactNode {
  return (
    <div className="rounded-lg border border-hairline p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[13px] text-ink">{runDate(job.streamKey)}</span>
          <span className="inline-flex items-center gap-1 text-[13px] font-medium" style={{ color: stateColor(job.state) }}>
            {!TERMINAL.has(job.state) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {STEP_LABEL[job.state] ?? job.state}
            {job.currentStepSec != null && <span className="text-muted-soft font-normal">· 已运行 {humanSec(job.currentStepSec)}</span>}
            {!TERMINAL.has(job.state) && job.etaSec != null && (
              <span className="text-muted-soft font-normal">· 预计剩余约 {humanSec(job.etaSec)}</span>
            )}
          </span>
        </div>
        {job.hasLog && (
          <IconButton title="查看日志" onClick={() => onOpenLog(job.streamKey)}>
            <FileText className="w-4 h-4" />
          </IconButton>
        )}
      </div>
      <PipelineFlow job={job} />
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-2 text-[12px] text-muted">
        {job.winnerWorker && <span>选优: {job.winnerWorker}</span>}
        {job.videoDurationSec != null && <span>时长: {humanSec(Math.round(job.videoDurationSec))}</span>}
        {job.fails > 0 && <span style={{ color: "var(--warning)" }}>已重试 {job.fails} 次</span>}
        {job.bv && (
          <a className="text-muted hover:text-ink" href={`https://www.bilibili.com/video/${job.bv}`} target="_blank" rel="noreferrer">
            {job.bv}
          </a>
        )}
      </div>
      {job.error && <div className="text-[12px] mt-1" style={{ color: "var(--error)" }}>{job.error}</div>}
    </div>
  );
}

/** job.log 查看弹窗(受控:logKey!=null 打开;logKey 变化即重新拉取)。列表页/历史页共用。 */
export function JobLogDialog({ logKey, onClose }: { logKey: string | null; onClose: () => void }): ReactNode {
  const [text, setText] = useState("加载中…");
  useEffect(() => {
    if (logKey === null) return;
    let alive = true;
    setText("加载中…");
    void api
      .getHubJobLog(logKey)
      .then((r) => alive && setText(r.log || "(空)"))
      .catch(() => alive && setText("读取日志失败(可能 stage 已清理)。"));
    return () => {
      alive = false;
    };
  }, [logKey]);
  return (
    <Dialog open={logKey !== null} onClose={onClose} widthClass="max-w-3xl" title={`任务日志 · ${logKey ?? ""}`}>
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-[60vh] overflow-auto bg-surface-soft rounded p-3 text-body">
        {text}
      </pre>
    </Dialog>
  );
}

/** 规则行内的「最近一次运行」紧凑徽标(在跑=当前步 spinner;终态=状态)。无 run → 提示。 */
export function LatestRunBadge({ run }: { run: HubJobDTO | undefined }): ReactNode {
  if (!run) return <span className="text-muted-soft text-xs">尚无运行</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: stateColor(run.state) }}>
      {!TERMINAL.has(run.state) && <Loader2 className="w-3 h-3 animate-spin" />}
      {STEP_LABEL[run.state] ?? run.state}
      {run.currentStepSec != null && <span className="text-muted-soft font-normal">· {humanSec(run.currentStepSec)}</span>}
    </span>
  );
}
