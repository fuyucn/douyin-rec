import { useState, type ReactNode } from "react";
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

/** 一个直播间的「运行记录」详情:该房间历次 run(新→旧),每条展开步骤时间线/进度/ETA/日志。 */
export function HubTaskDetail({
  open,
  onClose,
  title,
  runs,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  runs: HubJobDTO[];
}): ReactNode {
  const [logKey, setLogKey] = useState<string | null>(null);
  const [logText, setLogText] = useState("");

  const openLog = async (key: string): Promise<void> => {
    setLogKey(key);
    setLogText("加载中…");
    try {
      const r = await api.getHubJobLog(key);
      setLogText(r.log || "(空)");
    } catch {
      setLogText("读取日志失败(可能 stage 已清理)。");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} widthClass="max-w-3xl" title={`运行记录 · ${title}`}>
      {runs.length === 0 ? (
        <p className="text-sm text-muted py-6 text-center">该直播间还没有 hub 运行记录(录制并收播后自动产生)。</p>
      ) : (
        <div className="space-y-3 max-h-[65vh] overflow-auto">
          {runs.map((j) => (
            <div key={j.streamKey} className="rounded-lg border border-hairline p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] text-ink">{runDate(j.streamKey)}</span>
                  <span className="inline-flex items-center gap-1 text-[13px] font-medium" style={{ color: stateColor(j.state) }}>
                    {!TERMINAL.has(j.state) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {STEP_LABEL[j.state] ?? j.state}
                    {j.currentStepSec != null && <span className="text-muted-soft font-normal">· 已运行 {humanSec(j.currentStepSec)}</span>}
                    {!TERMINAL.has(j.state) && j.etaSec != null && (
                      <span className="text-muted-soft font-normal">· 预计剩余约 {humanSec(j.etaSec)}</span>
                    )}
                  </span>
                </div>
                {j.hasLog && (
                  <IconButton title="查看日志" onClick={() => void openLog(j.streamKey)}>
                    <FileText className="w-4 h-4" />
                  </IconButton>
                )}
              </div>
              <Timeline job={j} />
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-2 text-[12px] text-muted">
                {j.winnerTenant && <span>选优: {j.winnerTenant}</span>}
                {j.videoDurationSec != null && <span>时长: {humanSec(Math.round(j.videoDurationSec))}</span>}
                {j.fails > 0 && <span style={{ color: "var(--warning)" }}>已重试 {j.fails} 次</span>}
                {j.bv && (
                  <a className="text-muted hover:text-ink" href={`https://www.bilibili.com/video/${j.bv}`} target="_blank" rel="noreferrer">
                    {j.bv}
                  </a>
                )}
              </div>
              {j.error && <div className="text-[12px] mt-1" style={{ color: "var(--error)" }}>{j.error}</div>}
            </div>
          ))}
        </div>
      )}

      <Dialog open={logKey !== null} onClose={() => setLogKey(null)} widthClass="max-w-3xl" title={`任务日志 · ${logKey ?? ""}`}>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-[60vh] overflow-auto bg-surface-soft rounded p-3 text-body">
          {logText}
        </pre>
      </Dialog>
    </Dialog>
  );
}

/** 规则行内的「最近一次运行」紧凑徽标(在跑=当前步 spinner;终态=状态+可选 BV)。无 run → null。 */
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
