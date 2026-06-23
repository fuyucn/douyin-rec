import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type MergeJobDTO, type RecordingsDTO } from "../api/client";
import { Button } from "./Button";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";

/**
 * 会话合成面板：列出任务的录制会话(按时间序),勾选 → 合成一整片无损视频 + 偏移合并弹幕 xml。
 * 合成是后台任务:POST 拿 jobId,轮询 GET /merges/:jobId 直到 done/error。合并顺序固定 = 列表
 * (时间)序,与勾选先后无关 → 保证时间排序。
 */
export function MergePanel({ taskId }: { taskId: number }): ReactNode {
  const t = useT();
  const toast = useToast();
  const [rec, setRec] = useState<RecordingsDTO | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<MergeJobDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setRec(await api.listRecordings(taskId));
    } catch {
      /* 目录暂不可用 → 保持空 */
    }
  }, [taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 轮询合成任务进度，直到 done/error。
  useEffect(() => {
    if (!job || job.state !== "running") return;
    pollRef.current = setInterval(async () => {
      try {
        const j = await api.getMerge(job.id);
        setJob(j);
        if (j.state === "done") {
          toast(t("merge.done", { file: baseName(j.mp4) }), "success");
          void refresh();
        } else if (j.state === "error") {
          toast(t("merge.failed", { msg: j.error ?? "?" }), "error");
        }
      } catch {
        /* 轮询失败下次再试 */
      }
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [job, refresh, toast, t]);

  const toggle = (base: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(base)) next.delete(base);
      else next.add(base);
      return next;
    });
  };

  const sessions = rec?.sessions ?? [];
  // 提交顺序 = 列表(时间)序，只保留被勾选的 → 与勾选先后无关，永远时间排序。
  const orderedSelection = sessions.map((s) => s.base).filter((b) => selected.has(b));

  const merge = async (): Promise<void> => {
    if (orderedSelection.length === 0) return;
    setBusy(true);
    try {
      const j = await api.startMerge(taskId, orderedSelection);
      setJob(j);
      toast(t("merge.started", { count: orderedSelection.length }), "info");
    } catch (e) {
      toast(t("merge.startFailed", { msg: errMessage(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const running = job?.state === "running";

  return (
    <section className="card p-6 lg:col-span-3">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h3 className="headline text-[16px]">{t("merge.title")}</h3>
        <div className="flex items-center gap-2">
          <Button small variant="secondary" onClick={() => void refresh()}>
            {t("common.refresh")}
          </Button>
          <Button
            small
            onClick={() => void merge()}
            disabled={busy || running || orderedSelection.length === 0}
            loading={busy || running}
          >
            {running ? t("merge.combining") : t("merge.combine", { n: orderedSelection.length })}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-soft mb-3">{t("merge.hint")}</p>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted">{t("merge.noSessions")}</p>
      ) : (
        <ul className="space-y-1.5">
          {sessions.map((s) => (
            <li key={s.base}>
              <label className="flex items-center gap-3 rounded-lg border border-hairline px-3 py-2 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(s.base)}
                  onChange={() => toggle(s.base)}
                  disabled={running}
                />
                <span className="font-mono break-all text-ink flex-1">{s.base}</span>
                <span className="text-xs text-muted shrink-0">
                  {t("merge.seg", { count: s.segments })}{s.hasXml ? ` · ${t("merge.danmuOk")}` : ""}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {job && (
        <p className="mt-3 text-xs text-muted">
          {job.state === "running" && t("merge.jobRunning", { id: job.id })}
          {job.state === "done" && t("merge.jobDone", { id: job.id, file: baseName(job.mp4) })}
          {job.state === "error" && t("merge.jobError", { id: job.id, msg: job.error ?? "" })}
        </p>
      )}
    </section>
  );
}

/** 取路径末段（仅显示用）。 */
function baseName(p?: string): string {
  if (!p) return "";
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
