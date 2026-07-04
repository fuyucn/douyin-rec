import { ChevronLeft } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type HubJobDTO } from "../api/client";
import { RunCard, JobLogDialog } from "../components/HubJobs";
import { Button } from "../components/Button";
import { usePolling } from "../lib/hooks";

const PAGE = 20;

/**
 * 某直播间的 hub run 历史(独立页 /hub/:key,参考 GitHub Actions 某 workflow 的 run 列表)。
 * 分页「加载更多」;进行中的 run 3s 轮询刷新(有未完成 job 时才轮询,全终态则停)。
 */
export function HubRunsPage(): ReactNode {
  const { key = "" } = useParams();
  const [runs, setRuns] = useState<HubJobDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [logKey, setLogKey] = useState<string | null>(null);

  // 已加载页数决定拉取上限(轮询时保持已展开的范围,不缩回)。
  const [pages, setPages] = useState(1);

  const refresh = async (): Promise<void> => {
    try {
      const r = await api.listHubJobs({ room: key, limit: pages * PAGE, offset: 0 });
      setRuns(r.jobs);
      setTotal(r.total);
    } catch {
      /* 轮询重试 */
    } finally {
      setLoaded(true);
    }
  };
  // 有进行中的 run 才 3s 轮询(实时看步骤/ETA);全终态则慢速(只为拿新场次)。
  const anyActive = runs.some((j) => !["done", "failed", "needs_manual"].includes(j.state));
  usePolling(() => void refresh(), anyActive ? 3000 : 15000);

  const anchorTitle = key; // key 即 platform.roomSlug;主播名在规则页有,这里用 key 兜底

  return (
    <>
      <div className="mb-6">
        <Link to="/hub" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-2">
          <ChevronLeft className="w-4 h-4" /> Hub 管理
        </Link>
        <h1 className="headline text-[26px] sm:text-[30px] leading-tight">运行记录</h1>
        <p className="text-muted text-sm mt-1.5 font-mono break-all">{anchorTitle} · 共 {total} 次</p>
      </div>

      {!loaded ? (
        <div className="card p-10 text-center text-muted">加载中…</div>
      ) : runs.length === 0 ? (
        <div className="card p-10 text-center text-muted text-sm">
          该直播间还没有 hub 运行记录(录制并收播后自动产生)。
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((j) => (
            <RunCard key={j.streamKey} job={j} onOpenLog={setLogKey} />
          ))}
          {runs.length < total && (
            <div className="text-center pt-2">
              <Button small variant="secondary" onClick={() => setPages((p) => p + 1)}>
                加载更多（还有 {total - runs.length} 次）
              </Button>
            </div>
          )}
        </div>
      )}

      <JobLogDialog logKey={logKey} onClose={() => setLogKey(null)} />
    </>
  );
}
