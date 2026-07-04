import { useEffect, useState, type ReactNode } from "react";
import { FileText, Loader2 } from "lucide-react";
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

/** 单条 run 的步骤时间线(横向:每步耗时,当前步高亮 spinner + 已运行时长)。 */
function Timeline({ job }: { job: HubJobDTO }): ReactNode {
  const segs: Array<{ state: string; sec: number | null; active: boolean }> = [];
  for (let i = 0; i < job.events.length; i++) {
    const cur = job.events[i];
    const next = job.events[i + 1];
    if (next) segs.push({ state: cur.state, sec: Math.round((next.at - cur.at) / 1000), active: false });
    else if (!TERMINAL.has(cur.state)) segs.push({ state: cur.state, sec: job.currentStepSec, active: true });
  }
  if (segs.length === 0) return <span className="text-muted-soft text-xs">（无时间线;旧版本任务）</span>;
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {segs.map((s, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono"
          style={{
            background: s.active ? "var(--ink)" : "var(--surface-soft)",
            color: s.active ? "var(--canvas)" : "var(--muted)",
          }}
        >
          {s.active && <Loader2 className="w-3 h-3 animate-spin" />}
          {STEP_LABEL[s.state] ?? s.state} {humanSec(s.sec)}
        </span>
      ))}
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
      <Timeline job={job} />
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
