import { useEffect, useState, type ReactNode } from "react";
import { Check, FileText, Loader2, Minus, X } from "lucide-react";
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

/** pipeline 的规范线性步骤(节点顺序;终态另算)。 */
const FLOW_STEPS: Array<{ key: string; label: string }> = [
  { key: "pending", label: "排队" },
  { key: "syncing", label: "拉取" },
  { key: "merging", label: "合并/烧录" },
  { key: "uploading", label: "上传" },
];

type NodeStatus = "done" | "active" | "skipped" | "todo" | "failed";

interface FlowNode {
  label: string;
  status: NodeStatus;
  sec: number | null;
}

/** 从 run 的 events 推导每个流程节点的状态 + 耗时,末尾补一个终态节点。 */
function buildFlow(job: HubJobDTO): FlowNode[] {
  const seen = new Set(job.events.map((e) => e.state));
  const last = job.events[job.events.length - 1];
  const lastState = last?.state;
  const terminal = lastState ? TERMINAL.has(lastState) : false;
  const successTerminal = lastState === "done" || lastState === "needs_manual";
  // 某状态耗时 = 下一事件时刻 − 本事件时刻;末个非终态用 currentStepSec。
  const durOf = (state: string): number | null => {
    const idx = job.events.findIndex((e) => e.state === state);
    if (idx < 0) return null;
    const next = job.events[idx + 1];
    return next ? Math.round((next.at - job.events[idx].at) / 1000) : job.currentStepSec;
  };

  const nodes: FlowNode[] = FLOW_STEPS.map((s) => {
    if (seen.has(s.key)) {
      const active = s.key === lastState && !terminal;
      return { label: s.label, status: active ? "active" : "done", sec: durOf(s.key) };
    }
    // 没走到这步:成功终态(如 stage 模式跳过上传)= 跳过;否则 = 待执行/未到达。
    return { label: s.label, status: successTerminal ? "skipped" : "todo", sec: null };
  });

  // 终态节点。
  if (terminal) {
    nodes.push({
      label: STEP_LABEL[lastState!] ?? lastState!,
      status: lastState === "failed" ? "failed" : "done",
      sec: null,
    });
  } else {
    nodes.push({ label: "完成", status: "todo", sec: null });
  }
  return nodes;
}

const NODE_COLOR: Record<NodeStatus, { bg: string; fg: string; ring: string }> = {
  done: { bg: "var(--success)", fg: "#fff", ring: "var(--success)" },
  active: { bg: "var(--ink)", fg: "var(--canvas)", ring: "var(--ink)" },
  failed: { bg: "var(--error)", fg: "#fff", ring: "var(--error)" },
  skipped: { bg: "transparent", fg: "var(--muted-soft)", ring: "var(--hairline)" },
  todo: { bg: "transparent", fg: "var(--muted-soft)", ring: "var(--hairline)" },
};

/** 单条 run 的横向流程图:固定节点(排队→拉取→合并/烧录→上传→完成),按 events 上色 + 每步耗时。 */
function PipelineFlow({ job }: { job: HubJobDTO }): ReactNode {
  if (job.events.length === 0) return <span className="text-muted-soft text-xs">（无流程记录;旧版本任务）</span>;
  const nodes = buildFlow(job);
  return (
    <div className="flex items-start overflow-x-auto pb-1">
      {nodes.map((n, i) => {
        const c = NODE_COLOR[n.status];
        const next = nodes[i + 1];
        // 连接线状态:流入进行中节点 → 流动虚线动画;流入已完成/失败 → 实色;否则灰。
        const connIntoActive = next?.status === "active";
        const connReached = next && ["done", "active", "failed"].includes(next.status);
        return (
          <div key={i} className="flex items-start shrink-0">
            {/* 节点:圆形状态图标 + 下方标签 + 耗时(进行中加脉冲光环) */}
            <div className="flex flex-col items-center gap-1 w-[68px]">
              <span
                className={`inline-flex items-center justify-center rounded-full w-6 h-6${n.status === "active" ? " flow-node-active" : ""}`}
                style={{ background: c.bg, color: c.fg, border: `1.5px solid ${c.ring}` }}
              >
                {n.status === "done" && <Check className="w-3.5 h-3.5" />}
                {n.status === "active" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {n.status === "failed" && <X className="w-3.5 h-3.5" />}
                {n.status === "skipped" && <Minus className="w-3.5 h-3.5" />}
                {n.status === "todo" && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--muted-soft)" }} />}
              </span>
              <span
                className="text-[11px] text-center leading-tight"
                style={{ color: n.status === "todo" || n.status === "skipped" ? "var(--muted-soft)" : "var(--ink)", fontWeight: n.status === "active" ? 600 : 400 }}
              >
                {n.label}
              </span>
              <span className="text-[10px] font-mono" style={{ color: n.status === "active" ? "var(--ink)" : "var(--muted-soft)" }}>
                {n.status === "skipped" ? "跳过" : n.status === "todo" ? "" : humanSec(n.sec)}
              </span>
            </div>
            {/* 连接线(最后一个节点后不画) */}
            {i < nodes.length - 1 && (
              <span
                className={`mt-3 h-[2px] w-5 sm:w-8${connIntoActive ? " flow-connector-active" : ""}`}
                style={connIntoActive ? undefined : { background: connReached ? "var(--success)" : "var(--hairline)" }}
              />
            )}
          </div>
        );
      })}
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
        {job.winnerTenant && <span>选优: {job.winnerTenant}</span>}
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
