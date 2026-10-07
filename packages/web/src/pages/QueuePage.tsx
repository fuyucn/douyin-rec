/**
 * QueuePage — 处理队列页(/queue,仅 master)。datatable 式:筛选栏 + 表格 + 队列排序。
 *
 * 排序口径:**真实 FIFO** —— 后端按入队时刻(该场首个事件)升序返回,谁先进队列谁排第 1 行。
 * 「#」列是行序(= 入队序);排队行的橙色 chip 是该场在**资源队列**里的实际位次
 * (来自 master ResourcePool 的 waiting 快照)—— 两者是两个维度:行序=整体先后,位次=某池内先后。
 */
import {
  Activity, AlertTriangle, Check, ChevronDown, ChevronRight, Cpu, ExternalLink, FileText, Loader2, Search, Square, UploadCloud, X,
} from "lucide-react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type HubPoolSnapshotDTO, type HubQueueDTO, type QueueItemDTO } from "../api/client";
import { hubEnabledAtom, serverTimezoneAtom } from "../atoms";
import { humanSec, humanSecFull, stateColor, JobLogDialog } from "../components/HubJobs";
import { roomId } from "../lib/labels";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fmtTimeInTz } from "../lib/tz";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/**
 * streamKey `{platform}:{roomSlug}:{date}[_HHMM]` → 场次时间展示。
 * 同日多场时 `_HHMM` 是关键区分(如 2026-10-07_2101 = 21:01 开播),加 `·` 分隔更易读。
 */
function sessionTime(streamKey: string): string {
  const suffix = streamKey.split(":").slice(2).join(":"); // "2026-10-07_2101"
  const m = /^(\d{4}-\d{2}-\d{2})(?:_(\d{2})(\d{2}))?$/.exec(suffix);
  if (!m) return suffix;
  const [, date, hh, mm] = m;
  const short = date.slice(5); // MM-DD
  if (!hh) return short;
  // _HHMM 是录制端按**本地时区**写的,直接用字符串,不再转时区(避免二次偏移)。
  return `${short} ${hh}:${mm}`;
}

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
    { key: "waiting_upload", label: t("queue.filter.uploadWait"), on: phase.includes("waiting_upload"), toggle: () => toggle(phase, "waiting_upload", onPhase) },
    { key: "stopped", label: t("queue.filter.stopped"), on: phase.includes("stopped"), toggle: () => toggle(phase, "stopped", onPhase) },
    { key: "done", label: t("queue.filter.done"), on: phase.includes("done"), toggle: () => toggle(phase, "done", onPhase) },
    { key: "failed", label: t("queue.filter.failed"), on: phase.includes("failed"), toggle: () => toggle(phase, "failed", onPhase) },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 mb-3">
      {/* 状态组(带标签,与平台组区分) */}
      <span className="text-[11px] text-muted-soft mr-0.5">{t("queue.filter.byStatus")}</span>
      {phaseChips.map((c) => (
        <button key={c.key} onClick={c.toggle} aria-pressed={c.on} className="chip" style={chipStyle(c.on)}>
          {c.on && <Check className="w-3 h-3" />}
          {c.label}
        </button>
      ))}
      <span className="w-px h-4 mx-1.5" style={{ background: "var(--hairline)" }} />
      <span className="text-[11px] text-muted-soft mr-0.5">{t("queue.filter.byPlatform")}</span>
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

/** 相位派生(行与卡片共用,避免两份漂移):返回展示文案 key、图标种类、是否终态/需人工。 */
function phaseInfo(item: QueueItemDTO): {
  textKey: string;
  kind: "busy" | "queued" | "manual" | "upload" | "stopped" | "settle" | "done" | "failed";
} {
  const p = item.phase;
  if (p === "done") return { textKey: "queue.phase.done", kind: "done" };
  if (p === "failed") return { textKey: "queue.phase.failed", kind: "failed" };
  if (p === "waiting_manual") return { textKey: "queue.phase.manual", kind: "manual" };
  if (p === "waiting_upload") return { textKey: "queue.phase.uploadWait", kind: "upload" };
  if (p === "stopped") return { textKey: "queue.phase.stopped", kind: "stopped" };
  if (p === "waiting_settle") return { textKey: "queue.phase.settle", kind: "settle" };
  if (p === "queued") return { textKey: "queue.phase.queued", kind: "queued" };
  if (item.state === "syncing") return { textKey: "queue.phase.pulling", kind: "busy" };
  return { textKey: "queue.phase.running", kind: "busy" };
}

/** 相位图标 + 颜色(行与卡片共用)。 */
function PhaseGlyph({ kind }: { kind: ReturnType<typeof phaseInfo>["kind"] }): ReactNode {
  if (kind === "busy") return <Loader2 className="w-3.5 h-3.5 animate-spin" />;
  if (kind === "queued") return <span>⏳</span>;
  if (kind === "manual") return <AlertTriangle className="w-3.5 h-3.5" />;
  if (kind === "upload") return <UploadCloud className="w-3.5 h-3.5" />;
  if (kind === "stopped") return <Square className="w-3 h-3" />;
  if (kind === "done") return <Check className="w-3.5 h-3.5" />;
  if (kind === "failed") return <X className="w-3.5 h-3.5" />;
  return null;
}

/** 相位颜色:待上传中性、已停止灰、其余按 state。 */
function phaseColor(kind: ReturnType<typeof phaseInfo>["kind"], state: string): string {
  if (kind === "upload") return "var(--muted)";
  if (kind === "stopped") return "var(--muted-soft)";
  return stateColor(state);
}

/** 窄屏卡片(<sm):表格在手机上溢出,改竖排卡片,信息不丢。 */
function QueueCard({ item, index, tz, onOpenLog }: { item: QueueItemDTO; index: number; tz: string; onOpenLog: (key: string) => void }): ReactNode {
  const t = useT();
  const info = phaseInfo(item);
  const finished = item.phase === "done" || item.phase === "failed";
  return (
    <div className="card p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-ink truncate">{item.anchorName ?? roomId(item.roomSlug)}</span>
            <span className="font-mono text-[11px] text-muted tabular-nums shrink-0">{sessionTime(item.streamKey)}</span>
          </div>
          <div className="font-mono text-[11px] text-muted-soft mt-0.5">#{index} · {item.platform} · {roomId(item.roomSlug)}</div>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium shrink-0" style={{ color: phaseColor(info.kind, item.state) }}>
          <PhaseGlyph kind={info.kind} />
          {t(info.textKey)}
        </span>
      </div>
      <div className="mt-2 text-[12px] text-muted-soft break-words">
        {(finished || info.kind === "manual" || info.kind === "stopped" || info.kind === "upload")
          ? item.doneSteps.length > 0
            ? item.doneSteps.map((st) => stepLabel(t, st.step)).join(" · ")
            : t("queue.doneNoStepRecord")
          : <>
            {item.doneSteps.map((st) => stepLabel(t, st.step)).join(" · ")}
            {item.currentNode && <> → <b style={{ color: "var(--ink)" }}>{stepLabel(t, item.currentNode)}</b></>}
            {item.nextSteps.length > 0 && <> → {item.nextSteps.map((st) => stepLabel(t, st)).join(" / ")}</>}
          </>}
      </div>
      {(info.kind === "manual" || info.kind === "stopped") && item.error && (
        <div className="mt-1 text-[11px] break-words" style={{ color: "var(--error-fg)" }}>{item.error}</div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-soft">
          {finished
            ? (item.finishedAt ? fmtTimeInTz(new Date(item.finishedAt), tz) : "")
            : (item.enqueuedAt ? fmtTimeInTz(new Date(item.enqueuedAt), tz) : "")}
          {item.fails > 0 && <span style={{ color: "var(--warning-fg)" }}> · {t("hub.jobs.retries", { count: item.fails })}</span>}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {finished && item.bv && (
            <a className="font-mono text-[11px] text-muted hover:text-ink" href={`https://www.bilibili.com/video/${item.bv}`} target="_blank" rel="noreferrer">{item.bv}</a>
          )}
          <button type="button" title={t("hub.jobs.viewLog")} onClick={() => onOpenLog(item.streamKey)} className="icon-btn !w-7 !h-7">
            <FileText className="w-3.5 h-3.5" />
          </button>
          <Link to="/hub" title={t("queue.openRoom")} className="icon-btn !w-7 !h-7">
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </span>
      </div>
    </div>
  );
}

/** 一行队列项:位置/场次/状态/做了什么→正在做什么→下面做什么/入队时间。 */
function QueueRow({ item, index, tz, onOpenLog }: { item: QueueItemDTO; index: number; tz: string; onOpenLog: (key: string) => void }): ReactNode {
  const t = useT();
  const info = phaseInfo(item);
  const queued = info.kind === "queued";
  const manual = info.kind === "manual";
  const stopped = info.kind === "stopped";
  const finished = item.phase === "done" || item.phase === "failed";
  // 「已无正在做」= 终态 + 待人工三态:只列已完成步骤,不显示「正在做/下面做」。
  const settledRow = finished || manual || stopped || info.kind === "upload";
  return (
    <tr>
      <td className="tabular-nums" style={{ width: 56 }}>
        <div className="flex items-center gap-1.5">
          <span style={{ color: info.kind === "busy" || queued ? "var(--ink)" : "var(--muted-soft)", fontWeight: queued ? 600 : 400 }}>{index}</span>
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
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-medium text-ink truncate">{item.anchorName ?? roomId(item.roomSlug)}</span>
          {/* 场次时间是与「时间」列不同的维度(开播时刻),提到主行 —— 同锚点多场靠它区分。 */}
          <span className="font-mono text-[11px] text-muted tabular-nums shrink-0">{sessionTime(item.streamKey)}</span>
        </div>
        <div className="font-mono text-[11px] text-muted-soft mt-0.5">{item.platform} · {roomId(item.roomSlug)}</div>
      </td>
      <td style={{ width: 168 }}>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: phaseColor(info.kind, item.state) }}>
          <PhaseGlyph kind={info.kind} />
          {t(info.textKey)}
        </span>
        <div className="text-[11px] text-muted-soft mt-0.5">
          {finished
            ? item.videoDurationSec != null
              ? t("queue.col.videoDuration", { time: humanSecFull(Math.round(item.videoDurationSec)) })
              : ""
            : <>
              {item.currentStepSec != null ? t("hub.jobs.runningFor", { time: humanSec(item.currentStepSec) }) : ""}
              {!queued && item.etaSec != null && " "}
              {!queued && item.etaSec != null && t("hub.jobs.etaRemaining", { time: humanSec(item.etaSec) })}
            </>}
          {finished && item.winnerWorker && <span> · {t("hub.jobs.selected", { worker: item.winnerWorker })}</span>}
        </div>
        {/* 真故障/已停止:把台账里的 error 亮出来(否则只看到「待人工」不知为何)。 */}
        {(manual || stopped) && item.error && (
          <div className="text-[11px] mt-0.5 truncate" style={{ color: "var(--error-fg)" }} title={item.error}>
            {item.error}
          </div>
        )}
        {item.fails > 0 && (
          <div className="text-[11px] mt-0.5" style={{ color: "var(--warning-fg)" }}>
            {t("hub.jobs.retries", { count: item.fails })}
          </div>
        )}
      </td>
      <td>
        <div className="flex items-center gap-1.5 flex-wrap text-[12px]">
          {settledRow ? (
            // 终态/待人工行:只列已完成的步骤 + BV,**不显示「正在做/下面做」**(没有「正在」可言)。
            item.doneSteps.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-muted-soft">
                <Check className="w-3 h-3 shrink-0" style={{ color: "var(--success-fg)" }} />
                {item.doneSteps.map((st) => stepLabel(t, st.step)).join(" · ")}
              </span>
            ) : (
              <span className="text-muted-soft">{t("queue.doneNoStepRecord")}</span>
            )
          ) : (
            <>
          <span className="inline-flex items-center gap-1 text-muted-soft">
            {item.doneSteps.length > 0 ? (
              <>
                <Check className="w-3 h-3 shrink-0" style={{ color: "var(--success-fg)" }} />
                {item.doneSteps.map((st) => stepLabel(t, st.step)).join(" · ")}
              </>
            ) : (
              t("queue.nothingDone")
            )}
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
            </>
          )}
          {finished && item.bv && (
            <>
              <ChevronRight className="w-3 h-3 text-muted-soft shrink-0" />
              <a
                className="font-mono text-[11px] hover:text-ink"
                style={{ color: "var(--muted)" }}
                href={`https://www.bilibili.com/video/${item.bv}`}
                target="_blank"
                rel="noreferrer"
              >
                {item.bv}
              </a>
            </>
          )}
        </div>
      </td>
      <td className="text-[12px] text-muted tabular-nums" style={{ width: 92 }}>
        {finished
          ? (item.finishedAt ? fmtTimeInTz(new Date(item.finishedAt), tz) : "-")
          : (item.enqueuedAt ? fmtTimeInTz(new Date(item.enqueuedAt), tz) : "-")}
      </td>
      {/* 操作:查看日志(队列页不再是无出口的死胡同)。 */}
      <td style={{ width: 56 }}>
        <div className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            title={t("hub.jobs.viewLog")}
            onClick={() => onOpenLog(item.streamKey)}
            className="icon-btn !w-7 !h-7"
          >
            <FileText className="w-3.5 h-3.5" />
          </button>
          <Link
            to="/hub"
            title={t("queue.openRoom")}
            className="icon-btn !w-7 !h-7"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
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
  // 排序方向:newest(默认,最新入队在前)| oldest(FIFO,等最久的在前)。点表头切换。
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [logKey, setLogKey] = useState<string | null>(null);
  // 输入框每键都触发 → 延迟 250ms 再请求,避免逐字打请求。
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(id);
  }, [q]);

  const query = useMemo(
    () => ({ phase, states, platform, q: debouncedQ || undefined, sort }),
    [phase, states, platform, debouncedQ, sort],
  );
  // 轮询:usePolling 只按 [ms, enabled] 重建,换闭包不会立即重跑 → 筛选变更时干等 3s。
  // 这里显式补一次「筛选变更即拉」:用 queryKey 做依赖,变更后立即 fetch,轮询照旧。
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const poll = useMemo(
    () => async (): Promise<void> => {
      try {
        setData(await api.getHubQueue(JSON.parse(queryKey) as typeof query));
      } catch {
        /* 轮询会重试 */
      } finally {
        setLoaded(true);
      }
    },
    [queryKey],
  );
  usePolling(() => void poll(), 3000);
  // 筛选一变立刻重拉(不等下一个 3s tick)。首次跳过 —— usePolling 挂载时已拉过一次,
  // 否则 mount 会双请求。poll 由 queryKey 稳定,不会造成每帧重拉。
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    void poll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const reset = (): void => { setPhase([]); setStates([]); setPlatform([]); setQ(""); };
  const onToggleSort = (): void => setSort((v) => (v === "newest" ? "oldest" : "newest"));
  // rows = 进行中 + 已完成,**同一张表**(像日志的时间轴)。前端只渲染它。
  const rows = data?.rows ?? [];
  // 摘要分四类:真正在跑 / 待人工上传(stage 正常收口)/ 需要处理(失败·停止)/ 已完成。
  // 旧文案「进行中 N」把待人工也算进去 → 显示「进行中 10」但其实 0 条在跑,误导。
  const runningCount = rows.filter((r) => r.phase === "running" || r.phase === "queued" || r.phase === "waiting_settle").length;
  const uploadCount = rows.filter((r) => r.phase === "waiting_upload").length;
  const attentionCount = rows.filter((r) => r.phase === "waiting_manual" || r.phase === "failed").length;
  const stoppedCount = rows.filter((r) => r.phase === "stopped").length;
  const doneCount = rows.filter((r) => r.phase === "done").length;
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
          <p className="text-muted text-sm mt-1.5">
            {sort === "newest" ? t("queue.subtitle") : t("queue.subtitleOldest")}
          </p>
        </div>
      </div>

      {pool && <PoolBar pool={pool} />}

      {!loaded ? (
        <div className="py-10 text-center text-muted">{t("hub.common.loading")}</div>
      ) : (
        <>
          <div className="flex items-baseline justify-between mb-2.5">
            <span className="section-label">{t("queue.section.all")}</span>
            <span className="flex items-center gap-2.5 font-mono text-[11px] text-muted-soft">
              <span>{t("queue.summary.running", { n: runningCount })}</span>
              {uploadCount > 0 && <span>{t("queue.summary.upload", { n: uploadCount })}</span>}
              {attentionCount > 0 && (
                <span style={{ color: "var(--error-fg)" }}>{t("queue.summary.attention", { n: attentionCount })}</span>
              )}
              {stoppedCount > 0 && <span>{t("queue.summary.stopped", { n: stoppedCount })}</span>}
              <span>{t("queue.summary.done", { n: doneCount })}</span>
            </span>
          </div>
          <FilterBar
            phase={phase} states={states} platform={platform} q={q}
            onPhase={setPhase} onStates={setStates} onPlatform={setPlatform}
            onQ={setQ}
            onReset={reset}
          />
          {/* 窄屏(<sm):表格 5+ 列在手机上必然横向溢出且行高爆炸 → 改卡片式,信息不丢。 */}
          <div className="sm:hidden space-y-2">
            {rows.length === 0 ? (
              <div className="card p-8 text-center text-muted-soft text-sm">
                {filtered ? t("queue.filter.noMatch") : t("queue.empty")}
              </div>
            ) : (
              rows.map((it, i) => <QueueCard key={it.streamKey} item={it} index={i + 1} tz={tz} onOpenLog={setLogKey} />)
            )}
          </div>
          <section className="table-shell hidden sm:block">
            <div className="overflow-x-auto">
              <table className="tasks">
                <thead>
                  <tr>
                    <th className="w-14">#</th>
                    <th>{t("queue.col.room")}</th>
                    <th className="w-44">{t("queue.col.status")}</th>
                    <th>{t("queue.col.flow")}</th>
                    <th className="w-28">
                      <button
                        type="button"
                        onClick={onToggleSort}
                        className="inline-flex items-center gap-1 cursor-pointer"
                        style={{ color: "inherit", font: "inherit" }}
                        title={t(sort === "newest" ? "queue.sort.newestTip" : "queue.sort.oldestTip")}
                      >
                        {t("queue.col.enqueued")}
                        <ChevronDown
                          className={`w-3 h-3 transition-transform ${sort === "oldest" ? "" : "rotate-180"}`}
                          style={{ opacity: 0.75 }}
                        />
                      </button>
                    </th>
                    <th className="w-14 text-right" aria-label={t("queue.col.actions")} />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        <div className="text-center text-muted-soft text-sm py-10">
                          {filtered ? t("queue.filter.noMatch") : t("queue.empty")}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    rows.map((it, i) => <QueueRow key={it.streamKey} item={it} index={i + 1} tz={tz} onOpenLog={setLogKey} />)
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <JobLogDialog logKey={logKey} onClose={() => setLogKey(null)} />
    </>
  );
}
