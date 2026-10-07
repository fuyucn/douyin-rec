/**
 * QueuePage — 处理队列页(/queue)。一屏回答「做了什么 / 正在做什么 / 下面做什么」。
 *
 * 数据来自 GET /api/hub/queue:active(进行中,含排队相位)+ recent(最近完成)+ pool(资源池占用)。
 * 每行一场直播:已完成步骤(✓)/ 当前步骤(⏳ 已运行 + ETA)/ 后续步骤(·)。排队中显式标注「等锁(第 N 位)」。
 */
import { Activity, AlertTriangle, CheckCircle2, Cpu, Loader2, Radio, UploadCloud } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { Link } from "react-router-dom";
import { api, type HubQueueDTO, type QueueItemDTO, type HubPoolSnapshotDTO } from "../api/client";
import { hubEnabledAtom } from "../atoms";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { humanSec, runDate, stateColor, TERMINAL } from "../components/HubJobs";
import { roomId } from "../lib/labels";

/** 步骤名 → 展示标签(与 HubJobs 的 stepNode 文案同源)。 */
function stepLabel(t: (k: string, v?: Record<string, string | number>) => string, step: string): string {
  return t(`hub.jobs.stepNode.${step}`);
}

/** 相位徽标颜色。 */
function phaseColor(phase: QueueItemDTO["phase"]): string {
  if (phase === "running") return "var(--ink)";
  if (phase === "queued") return "var(--warning-fg)";
  if (phase === "waiting_manual") return "var(--error-fg)";
  return "var(--muted)";
}

/** 资源池占用条:CPU / 上传窗口 / 冷却。 */
function PoolBar({ pool }: { pool: HubPoolSnapshotDTO }): ReactNode {
  const t = useT();
  const cooldownSec = pool.upload.cooldownUntil > Date.now() ? Math.round((pool.upload.cooldownUntil - Date.now()) / 1000) : 0;
  return (
    <div className="telemetry-bar telemetry-bar-cols-3 mb-5">
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5 min-w-0">
          <span className="telemetry-label">{t("queue.pool.cpu")}</span>
          <span className="telemetry-value tabular-nums">
            {pool.cpu.active}/{pool.cpu.max || "-"}
            {pool.cpu.queued > 0 && <span className="text-muted-soft font-normal text-[13px]"> · {t("queue.pool.queued", { n: pool.cpu.queued })}</span>}
          </span>
        </div>
        <span className="telemetry-icon"><Cpu className="w-4 h-4" /></span>
      </div>
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5 min-w-0">
          <span className="telemetry-label">{t("queue.pool.upload")}</span>
          <span className="telemetry-value tabular-nums">
            {pool.upload.windowLimit > 0 ? `${pool.upload.windowUsed}/${pool.upload.windowLimit}` : t("queue.pool.unlimited")}
            {pool.upload.queued > 0 && <span className="text-muted-soft font-normal text-[13px]"> · {t("queue.pool.queued", { n: pool.upload.queued })}</span>}
          </span>
        </div>
        <span className="telemetry-icon"><UploadCloud className="w-4 h-4" /></span>
      </div>
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5 min-w-0">
          <span className="telemetry-label">{t("queue.pool.cooldown")}</span>
          <span className="telemetry-value tabular-nums" style={{ color: cooldownSec > 0 ? "var(--warning-fg)" : undefined }}>
            {cooldownSec > 0 ? humanSec(cooldownSec) : t("queue.pool.noCooldown")}
          </span>
        </div>
        <span className="telemetry-icon" style={cooldownSec > 0 ? { color: "var(--warning-fg)" } : undefined}>
          <AlertTriangle className="w-4 h-4" />
        </span>
      </div>
    </div>
  );
}

/** 一场直播的队列行:① 已完成 ② 当前(含排队) ③ 后续。 */
function QueueRow({ item }: { item: QueueItemDTO }): ReactNode {
  const t = useT();
  const queued = item.phase === "queued";
  const manual = item.phase === "waiting_manual";
  const waitingSettle = item.phase === "waiting_settle";
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-ink truncate">{item.anchorName ?? roomId(item.roomSlug)}</span>
          <span className="font-mono text-[11px] text-muted-soft">{item.platform} · {roomId(item.roomSlug)}</span>
          <span className="font-mono text-[11px] text-muted-soft">{runDate(item.streamKey)}</span>
        </div>
        <div className="flex items-center gap-2 text-[13px] font-medium shrink-0" style={{ color: stateColor(item.state) }}>
          {!queued && !manual && !waitingSettle && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {queued && <span className="text-[13px]">⏳</span>}
          <span style={{ color: phaseColor(item.phase) }}>
            {manual
              ? t("queue.phase.manual")
              : waitingSettle
                ? t("queue.phase.settle")
                : queued
                  ? t("queue.phase.queued")
                  : // pull(syncing)不占资源闸门,不会被排队 → 用中性「拉取中」而非「执行中」,避免误导。
                    item.state === "syncing"
                      ? t("queue.phase.pulling")
                      : t("queue.phase.running")}
          </span>
          {item.currentStepSec != null && (
            <span className="text-muted-soft font-normal">{t("hub.jobs.runningFor", { time: humanSec(item.currentStepSec) })}</span>
          )}
          {!queued && !manual && !waitingSettle && item.etaSec != null && (
            <span className="text-muted-soft font-normal">{t("hub.jobs.etaRemaining", { time: humanSec(item.etaSec) })}</span>
          )}
        </div>
      </div>

      {/* ①②③ 三步:做了什么 → 正在做什么 → 下面做什么 */}
      <div className="flex items-center gap-2 flex-wrap mt-2.5">
        {/* ① 已完成 */}
        {item.doneSteps.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-muted">
            <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "var(--success-fg)" }} />
            {item.doneSteps.map((s) => stepLabel(t, s.step)).join(" · ")}
          </span>
        ) : (
          <span className="text-[12px] text-muted-soft">{t("queue.nothingDone")}</span>
        )}
        <span className="text-muted-soft">→</span>
        {/* ② 正在做什么 */}
        <span className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: "var(--ink)" }}>
          {item.currentNode
            ? stepLabel(t, item.currentNode)
            : manual
              ? t("queue.doing.manual")
              : waitingSettle
                ? t("queue.doing.settle")
                : t("queue.doing.preparing")}
          {queued && (
            <span className="chip" style={{ borderColor: "var(--warning)", color: "var(--warning-fg)" }}>
              {t("queue.queuedAt", { n: item.queuePosition ?? 1 })}
            </span>
          )}
        </span>
        {/* ③ 下面做什么 */}
        {item.nextSteps.length > 0 && (
          <>
            <span className="text-muted-soft">→</span>
            <span className="text-[12px] text-muted-soft">
              {t("queue.next")}: {item.nextSteps.map((s) => stepLabel(t, s)).join(" / ")}
            </span>
          </>
        )}
      </div>

      {item.fails > 0 && <div className="text-[12px] mt-1" style={{ color: "var(--warning-fg)" }}>{t("hub.jobs.retries", { count: item.fails })}</div>}
    </div>
  );
}

/** 区块:标题 + 计数 + 空态。 */
function Section({ title, count, color, children }: { title: string; count: number; color?: string; children: ReactNode }): ReactNode {
  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-2.5">
        <h2 className="section-label" style={color ? { color } : undefined}>{title}</h2>
        <span className="font-mono text-[11px] text-muted-soft">{count}</span>
      </div>
      {children}
    </section>
  );
}

/** 处理队列页(#/queue):master only。 */
export function QueuePage(): ReactNode {
  const t = useT();
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const [data, setData] = useState<HubQueueDTO | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      setData(await api.getHubQueue());
    } catch {
      /* 轮询会重试 */
    } finally {
      setLoaded(true);
    }
  };
  usePolling(() => void refresh(), 3000);

  const active = data?.active ?? [];
  const running = active.filter((a) => a.phase === "running" || a.phase === "queued");
  const pending = active.filter((a) => a.phase === "waiting_settle" || a.phase === "waiting_manual");
  const recent = data?.recent ?? [];
  const pool = data?.pool;

  // hub 未启用(slave)→ 队列页无意义,给 child-node 提示(与 HubPage 同口径)。
  if (hubEnabled === false) {
    return (
      <div className="card p-10 flex flex-col items-center gap-4 text-center">
        <Activity className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
        <h1 className="headline text-[22px]">{t("hub.page.childTitle")}</h1>
        <p className="text-muted text-sm max-w-md">{t("queue.childDesc")}</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="headline text-[26px] sm:text-[30px] leading-tight">{t("queue.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("queue.subtitle")}</p>
        </div>
      </div>

      {pool && <PoolBar pool={pool} />}

      {!loaded ? (
        <div className="py-10 text-center text-muted">{t("hub.common.loading")}</div>
      ) : active.length === 0 ? (
        <section className="empty-state">
          <Activity className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
          <div className="text-sm font-medium text-ink">{t("queue.empty")}</div>
          <div className="text-muted-soft text-xs">{t("queue.emptyHint")}</div>
        </section>
      ) : (
        <>
          <Section title={t("queue.section.running")} count={running.length} color="var(--ink)">
            {running.length === 0 ? (
              <div className="card p-6 text-center text-muted-soft text-sm">{t("queue.section.noneRunning")}</div>
            ) : (
              <div className="run-list-shell divide-y divide-hairline">
                {running.map((it) => <QueueRow key={it.streamKey} item={it} />)}
              </div>
            )}
          </Section>

          {pending.length > 0 && (
            <Section title={t("queue.section.pending")} count={pending.length} color="var(--muted)">
              <div className="run-list-shell divide-y divide-hairline">
                {pending.map((it) => <QueueRow key={it.streamKey} item={it} />)}
              </div>
            </Section>
          )}
        </>
      )}

      {recent.length > 0 && (
        <Section title={t("queue.section.recent")} count={recent.length}>
          <div className="run-list-shell divide-y divide-hairline">
            {recent.map((j) => (
              <div key={j.streamKey} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-[12px] text-muted-soft">{runDate(j.streamKey)}</span>
                  <span className="text-[12px] font-medium" style={{ color: stateColor(j.state) }}>
                    {j.state === "done" ? <CheckCircle2 className="w-3.5 h-3.5 inline" /> : null}
                    {" "}{TERMINAL.has(j.state) ? t(`hub.jobs.step.${j.state === "needs_manual" ? "needsManual" : j.state}`) : j.state}
                  </span>
                  {j.winnerWorker && <span className="text-[12px] text-muted-soft">{t("hub.jobs.selected", { worker: j.winnerWorker })}</span>}
                  {j.videoDurationSec != null && <span className="text-[12px] text-muted-soft">{t("hub.jobs.duration", { time: humanSec(Math.round(j.videoDurationSec)) })}</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {j.bv && (
                    <a className="text-[12px] text-muted hover:text-ink" href={`https://www.bilibili.com/video/${j.bv}`} target="_blank" rel="noreferrer">{j.bv}</a>
                  )}
                  <Link to={`/hub`} className="text-[12px] text-muted hover:text-ink" title={t("queue.section.recent")}>
                    <Radio className="w-3.5 h-3.5 inline" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
