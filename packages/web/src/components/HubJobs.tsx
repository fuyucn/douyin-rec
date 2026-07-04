import { useState, type ReactNode } from "react";
import { FileText, Loader2 } from "lucide-react";
import { api, type HubJobDTO } from "../api/client";
import { IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { usePolling } from "../lib/hooks";

/** 秒 → 人类可读("2h13m" / "8m" / "45s")。 */
function humanSec(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** 状态 → 中文步骤名 + 是否进行中(spinner)。 */
const STEP_LABEL: Record<string, string> = {
  pending: "排队中",
  settling: "等待收播",
  syncing: "拉取文件",
  merging: "合并 / 烧录",
  uploading: "上传 B 站",
  done: "已完成",
  failed: "失败",
  needs_manual: "待人工",
};
const TERMINAL = new Set(["done", "failed", "needs_manual"]);

function stateColor(state: string): string {
  if (state === "done") return "var(--success)";
  if (state === "failed") return "var(--error)";
  if (state === "needs_manual") return "var(--warning)";
  return "var(--ink)"; // 进行中
}

/** 单个 job 的步骤时间线(横向:每步耗时,当前步高亮 + 已运行时长)。 */
function Timeline({ job }: { job: HubJobDTO }): ReactNode {
  // 事件时间线 → 每步耗时(相邻事件差);最后一步若非终态 = 进行中(用 currentStepSec)。
  const segs: Array<{ state: string; sec: number | null; active: boolean }> = [];
  for (let i = 0; i < job.events.length; i++) {
    const cur = job.events[i];
    const next = job.events[i + 1];
    if (next) segs.push({ state: cur.state, sec: Math.round((next.at - cur.at) / 1000), active: false });
    else if (!TERMINAL.has(cur.state)) segs.push({ state: cur.state, sec: job.currentStepSec, active: true });
    // 终态事件(done/failed)本身不占一段
  }
  if (segs.length === 0) return <span className="text-muted-soft text-xs">—</span>;
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

/** hub 任务运行态列表(step / 进度 / 运行时间 / ETA / 日志)。仅 master 页显示。 */
export function HubJobs(): ReactNode {
  const [jobs, setJobs] = useState<HubJobDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [logKey, setLogKey] = useState<string | null>(null);
  const [logText, setLogText] = useState("");

  const refresh = async (): Promise<void> => {
    try {
      const r = await api.listHubJobs();
      setJobs(r.jobs);
    } catch {
      /* 轮询重试 */
    } finally {
      setLoaded(true);
    }
  };
  usePolling(() => void refresh(), 3000);

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

  if (loaded && jobs.length === 0) return null; // 没有任务 → 不占版面

  return (
    <section className="card overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-hairline">
        <h2 className="text-sm font-semibold text-ink">Hub 任务(运行态)</h2>
        <p className="text-[12px] text-muted-soft mt-0.5">收播后自动:选优 → 拉取 → 合并/烧录 → 上传。每 3s 刷新。</p>
      </div>
      <div className="overflow-x-auto">
        <table className="tasks">
          <thead>
            <tr>
              <th>直播场次</th>
              <th>当前步骤</th>
              <th>步骤时间线</th>
              <th>预计剩余</th>
              <th className="text-right">日志</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.streamKey}>
                <td>
                  <div className="font-mono text-[12px] text-ink break-all">{j.streamKey}</div>
                  {j.bv && (
                    <a
                      className="text-[11px] text-muted hover:text-ink"
                      href={`https://www.bilibili.com/video/${j.bv}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {j.bv}
                    </a>
                  )}
                  {j.error && <div className="text-[11px] mt-0.5" style={{ color: "var(--error)" }}>{j.error}</div>}
                </td>
                <td>
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: stateColor(j.state) }}>
                    {!TERMINAL.has(j.state) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {STEP_LABEL[j.state] ?? j.state}
                    {j.currentStepSec != null && <span className="text-muted-soft font-normal">· {humanSec(j.currentStepSec)}</span>}
                  </span>
                  {j.fails > 0 && <div className="text-[11px] text-muted-soft mt-0.5">已重试 {j.fails} 次</div>}
                </td>
                <td><Timeline job={j} /></td>
                <td>
                  <span className="font-mono text-[13px] text-body">
                    {TERMINAL.has(j.state) ? "—" : j.etaSec != null ? `约 ${humanSec(j.etaSec)}` : "估算中"}
                  </span>
                </td>
                <td className="text-right">
                  {j.hasLog ? (
                    <IconButton title="查看日志" onClick={() => void openLog(j.streamKey)}>
                      <FileText className="w-4 h-4" />
                    </IconButton>
                  ) : (
                    <span className="text-muted-soft text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={logKey !== null} onClose={() => setLogKey(null)} widthClass="max-w-3xl" title={`任务日志 · ${logKey ?? ""}`}>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-[60vh] overflow-auto bg-surface-soft rounded p-3 text-body">
          {logText}
        </pre>
      </Dialog>
    </section>
  );
}
