/**
 * QueuePage — 处理队列页(/queue,仅 master)。datatable 式:筛选栏 + 表格 + 队列排序。
 *
 * 排序口径:**真实 FIFO** —— 后端按入队时刻(该场首个事件)升序返回,谁先进队列谁排第 1 行。
 * 「#」列是行序(= 入队序);排队行的橙色 chip 是该场在**资源队列**里的实际位次
 * (来自 master ResourcePool 的 waiting 快照)—— 两者是两个维度:行序=整体先后,位次=某池内先后。
 */
import {
  Activity, AlertTriangle, Check, ChevronRight, Cpu, Loader2, Search, UploadCloud, X,
} from "lucide-react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type HubPoolSnapshotDTO, type HubQueueDTO, type QueueItemDTO } from "../api/client";
import { hubEnabledAtom, serverTimezoneAtom } from "../atoms";
import { humanSec, humanSecFull, runDate, stateColor } from "../components/HubJobs";
import { roomId } from "../lib/labels";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fmtTimeInTz } from "../lib/tz";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** 步骤名 → 展示标签(与 HubJobs 的 stepNode 同源)。 */
function stepLabel(t: TFunc, step: string): string {
  return t(`hub.jobs.stepNode.${step}`);
}

/** 资源占用条:CPU / 上传窗口 / 冷却。 */
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

/** 筛选 chip 样式:选中态用 accent-soft + ink 边(与 telemetry-bar 的克制风格一致)。 */
function chipStyle(on: boolean): CSSProperties {
  return on
    ? { background: "var(--accent-soft)", borderColor: "var(--ink)", color: "var(--ink)", cursor: "pointer" }
    : { cursor: "pointer" };
}

/** 筛选栏:相位 / 平台 / 搜索(受控,变更即重新拉)。datatable 顶栏。 */
function FilterBar({
  phase, states, platform, q,
  onPhase, onStates, onPlatform, onQ, onReset,
}: {
  phase: string[];
  states: string[];
  platform: string[];
  q: string;
  onPhase: (v: string[]) => void;
  onStates: (v: string[]) => void;
  onPlatform: (v: string[]) => void;
  onQ: (v: string) => void;
  onReset: () => void;
}): ReactNode {
  const t = useT();
  const toggle = (arr: string[], v: string, set: (x: string[]) => void): void =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const activeCount = phase.length + states.length + platform.length + (q ? 1 : 0);
  // 相位选项:后端相位 + 前端派生的「拉取中」(state=syncing,不在 QUEUE_PHASES 里)。
  const phaseChips: Array<{ key: string; label: string; on: boolean; toggle: () => void }> = [
    { key: "running", label: t("queue.filter.running"), on: phase.includes("running"), toggle: () => toggle(phase, "running", onPhase) },
    { key: "queued", label: t("queue.filter.queued"), on: phase.includes("queued"), toggle: () => toggle(phase, "queued", onPhase) },
    { key: "pulling", label: t("queue.filter.pulling"), on: states.includes("syncing"), toggle: () => toggle(states, "syncing", onStates) },
    { key: "waiting_settle", label: t("queue.filter.settle"), on: phase.includes("waiting_settle"), toggle: () => toggle(phase, "waiting_settle", onPhase) },
    { key: "waiting_manual", label: t("queue.filter.manual"), on: phase.includes("waiting_manual"), toggle: () => toggle(phase, "waiting_manual", onPhase) },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      {phaseChips.map((c) => (
        <button key={c.key} onClick={c.toggle} aria-pressed={c.on} className="chip" style={chipStyle(c.on)}>
          {c.on && <Check className="w-3 h-3" />}
          {c.label}
        </button>
      ))}
      <span className="w-px h-4 mx-1" style={{ background: "var(--hairline)" }} />
      {["douyin", "bilibili", "kuaishou"].map((p) => (
        <button
          key={p}
          onClick={() => toggle(platform, p, onPlatform)}
          aria-pressed={platform.includes(p)}
          className="chip"
          style={chipStyle(platform.includes(p))}
        >
          {platform.includes(p) && <Check className="w-3 h-3" />}
          {p}
        </button>
      ))}
      <div className="relative ml-auto">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--muted-soft)" }} />
        <input
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder={t("queue.filter.search")}
          className="input !pl-8 !h-7 !text-[12px] w-44"
        />
      </div>
      {activeCount > 0 && (
        <button onClick={onReset} className="chip" style={{ cursor: "pointer" }} title={t("queue.filter.reset")}>
          <X className="w-3 h-3" /> {t("queue.filter.clear")} ({activeCount})
        </button>
      )}
    </div>
  );
}

/** 一行队列项:位置/场次/状态/做了什么→正在做什么→下面做什么/入队时间。 */
function QueueRow({ item, index, tz }: { item: QueueItemDTO; index: number; tz: string }): ReactNode {
  const t = useT();
  const queued = item.phase === "queued";
  const manual = item.phase === "waiting_manual";
  const waitingSettle = item.phase === "waiting_settle";
  const pulling = item.state === "syncing";
  const busy = !queued && !manual && !waitingSettle;
  let phaseText = t("queue.phase.running");
  if (manual) phaseText = t("queue.phase.manual");
  else if (waitingSettle) phaseText = t("queue.phase.settle");
  else if (queued) phaseText = t("queue.phase.queued");
  else if (pulling) phaseText = t("queue.phase.pulling");
  return (
    <tr>
      <td className="tabular-nums" style={{ width: 56 }}>
        <div className="flex items-center gap-1.5">
          <span style={{ color: queued || busy ? "var(--ink)" : "var(--muted-soft)", fontWeight: queued ? 600 : 400 }}>{index}</span>
          {queued && item.queuePosition != null && (
            <span
              className="chip !h-5 !text-[10px]"
              style={{ borderColor: "var(--warning)", color: "var(--warning-fg)" }}
              title={t("queue.queuedAt", { n: item.queuePosition })}
            >
              {t("queue.filter.waitNo", { n: item.queuePosition })}
            </span>
          )}
        </div>
      </td>
      <td>
        <div className="font-medium text-ink truncate">{item.anchorName ?? roomId(item.roomSlug)}</div>
        <div className="font-mono text-[11px] text-muted-soft mt-0.5">{item.platform} · {roomId(item.roomSlug)} · {runDate(item.streamKey)}</div>
      </td>
      <td style={{ width: 168 }}>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: stateColor(item.state) }}>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {queued && <span>⏳</span>}
          {manual && <AlertTriangle className="w-3.5 h-3.5" />}
          {phaseText}
        </span>
        <div className="text-[11px] text-muted-soft mt-0.5">
          {item.currentStepSec != null ? t("hub.jobs.runningFor", { time: humanSec(item.currentStepSec) }) : ""}
          {!queued && item.etaSec != null && " "}
          {!queued && item.etaSec != null && t("hub.jobs.etaRemaining", { time: humanSec(item.etaSec) })}
        </div>
      </td>
      <td>
        <div className="flex items-center gap-1.5 flex-wrap text-[12px]">
          <span className="inline-flex items-center gap-1 text-muted-soft">
            {item.doneSteps.length > 0
              ? item.doneSteps.map((s) => stepLabel(t, s.step)).join(" · ")
              : t("queue.nothingDone")}
          </span>
          <ChevronRight className="w-3 h-3 text-muted-soft shrink-0" />
          <span className="font-medium" style={{ color: "var(--ink)" }}>
            {item.currentNode ? stepLabel(t, item.currentNode) : t("queue.doing.preparing")}
          </span>
          {item.nextSteps.length > 0 && (
            <>
              <ChevronRight className="w-3 h-3 text-muted-soft shrink-0" />
              <span className="text-muted-soft">{item.nextSteps.map((s) => stepLabel(t, s)).join(" / ")}</span>
            </>
          )}
        </div>
      </td>
      <td className="text-[12px] text-muted tabular-nums" style={{ width: 92 }}>
        {item.enqueuedAt ? fmtTimeInTz(new Date(item.enqueuedAt), tz) : "-"}
      </td>
    </tr>
  );
}

/** 处理队列页(#/queue):datatable,入队时间排序 + 筛选。 */
export function QueuePage(): ReactNode {
  const t = useT();
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const tz = useAtomValue(serverTimezoneAtom);
  const [data, setData] = useState<HubQueueDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [platform, setPlatform] = useState<string[]>([]);
  const [q, setQ] = useState("");
  // 输入框每键都触发 → 延迟 250ms 再请求,避免逐字打请求。
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(id);
  }, [q]);

  const query = useMemo(
    () => ({ phase, states, platform, q: debouncedQ || undefined }),
    [phase, states, platform, debouncedQ],
  );
  // refresh 依赖 query:筛选一变就换新函数,usePolling 内部 ref 立即生效(下次 tick 用新筛选)。
  const refresh = useMemo(
    () => async (): Promise<void> => {
      try {
        setData(await api.getHubQueue(query));
      } catch {
        /* 轮询会重试 */
      } finally {
        setLoaded(true);
      }
    },
    [query],
  );
  usePolling(() => void refresh(), 3000);

  const reset = (): void => { setPhase([]); setStates([]); setPlatform([]); setQ(""); };
  const active = data?.active ?? [];
  const recent = data?.recent ?? [];
  const pool = data?.pool;
  const filtered = phase.length + states.length + platform.length + (debouncedQ ? 1 : 0) > 0;

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
      ) : (
        <>
          <FilterBar
            phase={phase} states={states} platform={platform} q={q}
            onPhase={setPhase} onStates={setStates} onPlatform={setPlatform}
            onQ={setQ}
            onReset={reset}
          />
          <section className="table-shell">
            <div className="overflow-x-auto">
              <table className="tasks">
                <thead>
                  <tr>
                    <th className="w-14">#</th>
                    <th>{t("queue.col.room")}</th>
                    <th className="w-44">{t("queue.col.status")}</th>
                    <th>{t("queue.col.flow")}</th>
                    <th className="w-24">{t("queue.col.enqueued")}</th>
                  </tr>
                </thead>
                <tbody>
                  {active.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="text-center text-muted-soft text-sm py-10">
                          {filtered ? t("queue.filter.noMatch") : t("queue.emptyHint")}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    active.map((it, i) => <QueueRow key={it.streamKey} item={it} index={i + 1} tz={tz} />)
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {recent.length > 0 && (
        <>
          <div className="flex items-baseline justify-between mt-8 mb-2.5">
            <h2 className="section-label">{t("queue.section.recent")}</h2>
            <span className="font-mono text-[11px] text-muted-soft">{recent.length}</span>
          </div>
          <section className="table-shell">
            <div className="overflow-x-auto">
              <table className="tasks">
                <thead>
                  <tr>
                    <th>{t("queue.col.room")}</th>
                    <th className="w-32">{t("queue.col.status")}</th>
                    <th className="w-40">{t("queue.col.duration")}</th>
                    <th className="w-32">{t("queue.col.result")}</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((j) => (
                    <tr key={j.streamKey}>
                      <td>
                        <div className="font-mono text-[12px] text-ink truncate">{runDate(j.streamKey)}</div>
                        <div className="font-mono text-[11px] text-muted-soft mt-0.5">{j.streamKey.split(":")[0]}</div>
                      </td>
                      <td>
                        <span className="text-[13px] font-medium" style={{ color: stateColor(j.state) }}>
                          {t(`hub.jobs.step.${j.state === "needs_manual" ? "needsManual" : j.state}`)}
                        </span>
                      </td>
                      <td className="text-[12px] text-muted tabular-nums">
                        {j.videoDurationSec != null ? humanSecFull(Math.round(j.videoDurationSec)) : "-"}
                      </td>
                      <td className="text-[12px]">
                        {j.bv ? (
                          <a className="text-muted hover:text-ink font-mono" href={`https://www.bilibili.com/video/${j.bv}`} target="_blank" rel="noreferrer">{j.bv}</a>
                        ) : (
                          <Link to="/hub" className="text-muted hover:text-ink">{t("queue.col.detail")}</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
