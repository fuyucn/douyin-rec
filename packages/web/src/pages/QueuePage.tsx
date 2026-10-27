/**
 * QueuePage — 处理队列页(/queue,仅 master)。datatable 式:筛选栏 + 表格 + 队列排序。
 *
 * 排序口径:**真实 FIFO** —— 后端按入队时刻(该场首个事件)升序返回,谁先进队列谁排第 1 行。
 * 「#」列是行序(= 入队序);排队行的橙色 chip 是该场在**资源队列**里的实际位次
 * (来自 master ResourcePool 的 waiting 快照)—— 两者是两个维度:行序=整体先后,位次=某池内先后。
 */
import {
  Activity, AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardCheck, ExternalLink, FileText, Hourglass, Loader2, Search, Square, UploadCloud, X,
} from "lucide-react";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type HubQueueDTO, type NodeUploadStatusDTO, type QueueItemDTO, type Task, type WorkerStatus } from "../api/client";
import { hubEnabledAtom, serverTimezoneAtom } from "../atoms";
import { humanSec, humanSecFull, stateColor, JobLogDialog } from "../components/HubJobs";
import { platformLabel, roomId } from "../lib/labels";
import { errMessage, useHubStream, usePolling, useTicker, useToast } from "../lib/hooks";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  baseVersion,
  fmtBytes,
  settleNodeHealthProbe,
  summarizeNodes,
  type NodeHealthProbe,
} from "../lib/nodes-summary";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { AttentionCard, FleetPulse, LiveLane, LivePool, StageReadyRow } from "../components/QueueLive";
import { queueSummary, splitQueue } from "../lib/queue-live";
import { useT } from "../lib/i18n";
import { fmtTimeInTz } from "../lib/tz";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/**
 * streamKey `{platform}:{roomSlug}:{date}[_HHMM][-zd]` → 场次时间展示。
 * 同日多场时 `_HHMM` 是关键区分(如 2026-10-07_2101 = 21:01 开播),加 `·` 分隔更易读。
 */
function sessionTime(streamKey: string): string {
  const suffix = streamKey.split(":").slice(2).join(":"); // "2026-10-07_2101"
  const m = /^(\d{4}-\d{2}-\d{2})(?:_(\d{2})(\d{2}))?(-zd)?$/.exec(suffix);
  if (!m) return suffix;
  const [, date, hh, mm, zd] = m;
  const short = date.slice(5); // MM-DD
  if (!hh) return short;
  // `-zd` = zero-disk run (issue #324): show it as a tag instead of the raw suffix.
  if (zd) return `${short} ${hh}:${mm} · 0落盘`;
  // _HHMM 是录制端按**本地时区**写的,直接用字符串,不再转时区(避免二次偏移)。
  return `${short} ${hh}:${mm}`;
}

/**
 * 步骤名 → 展示标签(与 HubJobs 的 stepNode 同源)。
 * 未知步骤名(新版本加的步骤、旧前端没这条 i18n)→ 安全回落成**步骤名原文**,
 * 不渲染成空白、也不把 `hub.jobs.stepNode.xxx` 这种键名糊到 UI 上。
 */
function stepLabel(t: TFunc, step: string): string {
  const key = `hub.jobs.stepNode.${step}`;
  const label = t(key);
  return label === key ? step : label;
}

/** A poll snapshot older than this is shown as stale (the master polls every minute). */
const NODE_UPLOAD_STALE_MS = 3 * 60_000;

/**
 * Queued node upload line (plan 038 PR5): node · phase/step · bytes · rate · heartbeat · attempt.
 * Times come from the node and the master; small clock skew only shifts the "ago" texts.
 */
function nodeUploadLine(s: NodeUploadStatusDTO, now: number, t: TFunc): ReactNode {
  const ago = (at: number): string => humanSec(Math.max(0, Math.round((now - at) / 1000)));
  const stepKey = s.step === "gate_wait" || s.step === "transfer" || s.step === "submit" ? s.step : null;
  const parts: string[] = [t("queue.nodeUpload.node", { node: s.nodeId }), t(`queue.nodeUpload.${s.phase}`)];
  if (s.phase === "biliup" && s.state === "running" && stepKey) parts.push(t(`queue.nodeUpload.step.${stepKey}`));
  else if (s.state) parts.push(s.state);
  if (s.progress && s.progress.totalBytes > 0) {
    parts.push(`${fmtBytes(s.progress.doneBytes)} / ${fmtBytes(s.progress.totalBytes)}`);
    if (s.progress.bps) parts.push(t("queue.nodeUpload.rate", { rate: fmtBytes(s.progress.bps) }));
  }
  if (s.heartbeatAt) parts.push(t("queue.nodeUpload.heartbeat", { time: ago(s.heartbeatAt) }));
  if (s.attempts && s.attempts > 1) parts.push(t("queue.nodeUpload.attempt", { n: s.attempts }));
  if (s.notBefore && s.notBefore > now) parts.push(t("queue.nodeUpload.retryIn", { time: humanSec(Math.round((s.notBefore - now) / 1000)) }));
  const stale = now - s.polledAt > NODE_UPLOAD_STALE_MS;
  return (
    <div className="text-[11px] mt-0.5 font-mono" style={{ color: stale ? "var(--warning-fg)" : "var(--muted-soft)" }} title={s.error ?? undefined}>
      {parts.join(" · ")}
      {stale && <span> · {t("queue.nodeUpload.stale", { time: ago(s.polledAt) })}</span>}
    </div>
  );
}

/** 行内计时:已运行 / 预计剩余,本地每秒递增(快照只在下一次重拉时刷新)。 */
function rowTiming(
  item: QueueItemDTO,
  now: number,
  dataAt: number,
  t: TFunc,
): ReactNode {
  const finished = item.phase === "done" || item.phase === "failed";
  if (finished) {
    return item.videoDurationSec != null
      ? t("queue.col.videoDuration", { time: humanSecFull(Math.round(item.videoDurationSec)) })
      : "";
  }
  // 以「收到这份快照的时刻」为基准做本地递增,不把 Date.now() 和服务端字段直接相加。
  const drift = Math.max(0, Math.round((now - dataAt) / 1000));
  const elapsed = item.currentStepSec != null
    ? Math.max(0, Math.round(item.currentStepSec + drift))
    : null;
  const eta = item.etaSec != null ? Math.max(0, item.etaSec - drift) : null;
  const queued = item.phase === "queued";
  return (
    <>
      {elapsed != null && t("hub.jobs.runningFor", { time: humanSec(elapsed) })}
      {!queued && eta != null && (elapsed != null ? " " : "")}
      {!queued && eta != null && t("hub.jobs.etaRemaining", { time: humanSec(eta) })}
    </>
  );
}

/** 筛选 chip 样式:选中态用 accent-soft + ink 边(与 telemetry-bar 的克制风格一致)。 */
function chipStyle(on: boolean): CSSProperties {
  return on
    ? { background: "var(--surface)", borderColor: "var(--ink)", color: "var(--ink)", cursor: "pointer" }
    : { cursor: "pointer" };
}

/**
 * 筛选栏:一行放「常用」+ 搜索,「更多筛选」展开全部相位与平台。
 *
 * 原来 11 个相位 chip + 3 个平台 chip + 搜索挤在一行,窄屏要折三行、挤压表格。
 * 常用只有三种意图(全部 / 进行中 / 需处理),其余收进展开区(状态默认不折叠逻辑,只是视觉收起)。
 */
function FilterBar({
  phase, states, platform, q, summary,
  onPhase, onStates, onPlatform, onQ, onReset,
}: {
  phase: string[];
  states: string[];
  platform: string[];
  q: string;
  /** 右端摘要(进行中 / 需处理 / 已完成…),与筛选同一行,省掉一行标题。 */
  summary: ReactNode;
  onPhase: (v: string[]) => void;
  onStates: (v: string[]) => void;
  onPlatform: (v: string[]) => void;
  onQ: (v: string) => void;
  onReset: () => void;
}): ReactNode {
  const t = useT();
  const [more, setMore] = useState(false);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void): void =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const activeCount = phase.length + states.length + platform.length + (q ? 1 : 0);
  // 快捷态:只替换「相位/子状态」这一组,**不动搜索词与平台筛选** ——
  // 否则「搜主播 + 只看需处理」这种组合会被一次点击清掉(老 chip 交互是能的,不能退化)。
  const quick: Array<{ key: string; label: string; on: boolean; apply: () => void }> = [
    {
      key: "all", label: t("queue.filter.quickAll"),
      on: phase.length === 0 && states.length === 0,
      apply: () => { onPhase([]); onStates([]); },
    },
    {
      key: "active", label: t("queue.filter.quickActive"),
      on: phase.length === 3 && phase.includes("running") && phase.includes("queued") && phase.includes("waiting_settle") && states.length === 0,
      apply: () => { onStates([]); onPhase(["running", "queued", "waiting_settle"]); },
    },
    {
      key: "attention", label: t("queue.filter.quickAttention"),
      // 口径与 active 对齐:只有恰好是这一组相位时才高亮,避免「子集也亮」的两个真相。
      on: phase.length === 2 && phase.includes("waiting_manual") && phase.includes("failed") && states.length === 0,
      apply: () => { onStates([]); onPhase(["waiting_manual", "failed"]); },
    },
  ];
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
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <span className="text-[11px] text-muted-soft mr-0.5">{t("queue.filter.byStatus")}</span>
        {quick.map((c) => (
          <button key={c.key} type="button" role="button" onClick={c.apply} aria-pressed={c.on} className="chip" style={chipStyle(c.on)}>
            {c.on && <Check className="w-3 h-3" />}
            {c.label}
          </button>
        ))}
        <button type="button" role="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="chip" style={{ cursor: "pointer" }}>
          {more ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {t(more ? "queue.filter.less" : "queue.filter.more")}
        </button>
        {activeCount > 0 && (
          <button type="button" role="button" onClick={onReset} className="chip" style={{ cursor: "pointer" }} title={t("queue.filter.reset")}>
            <X className="w-3 h-3" /> {t("queue.filter.clear")} ({activeCount})
          </button>
        )}
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--muted-soft)" }} />
          <input
            value={q}
            onChange={(e) => onQ(e.target.value)}
            placeholder={t("queue.filter.search")}
            className="input !pl-8 !h-7 !text-[12px] w-44"
          />
        </div>
        {summary && <span className="flex items-center gap-2.5 font-mono text-[11px] text-muted-soft">{summary}</span>}
      </div>
      {more && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 mt-2 pt-2" style={{ borderTop: "1px solid var(--hairline)" }}>
          {phaseChips.map((c) => (
            <button key={c.key} type="button" role="button" onClick={c.toggle} aria-pressed={c.on} className="chip" style={chipStyle(c.on)}>
              {c.on && <Check className="w-3 h-3" />}
              {c.label}
            </button>
          ))}
          <span className="w-px h-4 mx-1.5" style={{ background: "var(--hairline)" }} />
          <span className="text-[11px] text-muted-soft mr-0.5">{t("queue.filter.byPlatform")}</span>
          {["douyin", "bilibili", "kuaishou"].map((p) => (
            <button
              key={p}
              type="button"
              role="button"
              onClick={() => toggle(platform, p, onPlatform)}
              aria-pressed={platform.includes(p)}
              className="chip"
              style={chipStyle(platform.includes(p))}
            >
              {platform.includes(p) && <Check className="w-3 h-3" />}
              {platformLabel(p)}
            </button>
          ))}
        </div>
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
  if (kind === "queued") return <Hourglass className="w-3.5 h-3.5" aria-hidden="true" />;
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
function QueueCard({ item, index, tz, onOpenLog, onAck }: { item: QueueItemDTO; index: number; tz: string; onOpenLog: (key: string) => void; onAck: (key: string) => void }): ReactNode {
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
          <div className="font-mono text-[11px] text-muted-soft mt-0.5">#{index} · {platformLabel(item.platform)} · {roomId(item.roomSlug)}</div>
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
          {item.state === "needs_manual" && (
            <button type="button" title={t("queue.ack.action")} aria-label={t("queue.ack.action")} onClick={() => onAck(item.streamKey)} className="icon-btn !w-7 !h-7">
              <ClipboardCheck className="w-3.5 h-3.5" />
            </button>
          )}
          <button type="button" title={t("hub.jobs.viewLog")} aria-label={t("hub.jobs.viewLog")} onClick={() => onOpenLog(item.streamKey)} className="icon-btn !w-7 !h-7">
            <FileText className="w-3.5 h-3.5" />
          </button>
          <Link to={`/rooms/${encodeURIComponent(`${item.platform}.${item.roomSlug}`)}`} title={t("queue.openRoom")} aria-label={t("queue.openRoom")} className="icon-btn !w-7 !h-7">
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </span>
      </div>
    </div>
  );
}

/** 一行队列项:位置/场次/状态/做了什么→正在做什么→下面做什么/入队时间。 */
function QueueRow({ item, index, tz, now, dataAt, onOpenLog, onAck }: { item: QueueItemDTO; index: number; tz: string; now: number; dataAt: number; onOpenLog: (key: string) => void; onAck: (key: string) => void }): ReactNode {
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
        {/* 主播名与场次时间同行、房间号与平台同行:原来两行各自折行(reason:「douyin ·」+ 换行的长数字)。
            房间号是定长标识,用 nowrap 保证不被拆成两行。 */}
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-medium text-ink truncate">{item.anchorName ?? roomId(item.roomSlug)}</span>
          <span className="font-mono text-[11px] text-muted tabular-nums shrink-0">{sessionTime(item.streamKey)}</span>
        </div>
        <div className="font-mono text-[11px] text-muted-soft mt-0.5 truncate">
          {platformLabel(item.platform)} · <span className="whitespace-nowrap">{roomId(item.roomSlug)}</span>
        </div>
      </td>
      <td style={{ width: 168 }}>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: phaseColor(info.kind, item.state) }}>
          <PhaseGlyph kind={info.kind} />
          {t(info.textKey)}
        </span>
        <div className="text-[11px] text-muted-soft mt-0.5">
          {rowTiming(item, now, dataAt, t)}
          {finished && item.winnerWorker && <span> · {t("hub.jobs.selected", { worker: item.winnerWorker })}</span>}
        </div>
        {!finished && item.nodeUpload && nodeUploadLine(item.nodeUpload, now, t)}
        {/* 真故障/已停止:把台账里的 error 亮出来(否则只看到「待人工」不知为何)。
            两行截断 + 完整内容进 title:错误文本可能很长,不截断会把整行撑成小作文、挤掉同屏其它场次。 */}
        {((manual || stopped) && item.error) && (
          <div
            className="text-[11px] mt-0.5"
            style={{ color: "var(--error-fg)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
            title={item.error}
          >
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
              <span className="inline-flex items-center gap-1 text-muted-soft min-w-0">
                <Check className="w-3 h-3 shrink-0" style={{ color: "var(--success-fg)" }} />
                <span className="truncate">{item.doneSteps.map((st) => stepLabel(t, st.step)).join(" · ")}</span>
              </span>
            ) : (
              <span className="text-muted-soft">{t("queue.doneNoStepRecord")}</span>
            )
          ) : (
            <>
          <span className="inline-flex items-center gap-1 text-muted-soft min-w-0">
            {item.doneSteps.length > 0 ? (
              <>
                <Check className="w-3 h-3 shrink-0" style={{ color: "var(--success-fg)" }} />
                <span className="truncate">{item.doneSteps.map((st) => stepLabel(t, st.step)).join(" · ")}</span>
              </>
            ) : (
              t("queue.nothingDone")
            )}
          </span>
          <ChevronRight className="w-3 h-3 text-muted-soft shrink-0" />
          <span className="font-medium whitespace-nowrap" style={{ color: "var(--ink)" }}>
            {item.currentNode ? stepLabel(t, item.currentNode) : t("queue.doing.preparing")}
          </span>
          {item.nextSteps.length > 0 && (
            <>
              <ChevronRight className="w-3 h-3 text-muted-soft shrink-0" />
              <span className="text-muted-soft truncate">{item.nextSteps.map((s) => stepLabel(t, s)).join(" / ")}</span>
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
      <td style={{ width: 84 }}>
        <div className="flex items-center justify-end gap-0.5">
          {item.state === "needs_manual" && (
            <button
              type="button"
              title={t("queue.ack.action")}
              aria-label={t("queue.ack.action")}
              onClick={() => onAck(item.streamKey)}
              className="icon-btn !w-7 !h-7"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            title={t("hub.jobs.viewLog")}
            aria-label={t("hub.jobs.viewLog")}
            onClick={() => onOpenLog(item.streamKey)}
            className="icon-btn !w-7 !h-7"
          >
            <FileText className="w-3.5 h-3.5" />
          </button>
          <Link
            to={`/rooms/${encodeURIComponent(`${item.platform}.${item.roomSlug}`)}`}
            title={t("queue.openRoom")}
            aria-label={t("queue.openRoom")}
            className="icon-btn !w-7 !h-7"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
      </td>
    </tr>
  );
}

/** Completed-only table, memoized because the live lanes tick every second. */
const HistorySection = memo(function HistorySection({
  items, filtered, tz, sort, onToggleSort, onOpenLog, onAck,
}: {
  items: QueueItemDTO[];
  filtered: boolean;
  tz: string;
  sort: "newest" | "oldest";
  onToggleSort: () => void;
  onOpenLog: (key: string) => void;
  onAck: (key: string) => void;
}): ReactNode {
  const t = useT();
  return (
    <details className="mb-5">
      <summary className="section-label cursor-pointer select-none">
        {t("queue.history.title")} · {t("queue.history.doneSummary", { done: items.length })}
      </summary>
      <div className="mt-3">
        {/* Mobile uses cards so the wide table cannot overflow or inflate every row. */}
        <div className="sm:hidden space-y-2">
          {items.length === 0 ? (
            <div className="card p-8 text-center text-muted-soft text-sm">
              {filtered ? t("queue.filter.noMatch") : t("queue.empty")}
            </div>
          ) : (
            items.map((it, i) => (
              <QueueCard key={it.streamKey} item={it} index={i + 1} tz={tz} onOpenLog={onOpenLog} onAck={onAck} />
            ))
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
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="text-center text-muted-soft text-sm py-10">
                        {filtered ? t("queue.filter.noMatch") : t("queue.empty")}
                      </div>
                    </td>
                  </tr>
                ) : (
                  items.map((it, i) => (
                    <QueueRow
                      key={it.streamKey}
                      item={it}
                      index={i + 1}
                      tz={tz}
                      now={0}
                      dataAt={0}
                      onOpenLog={onOpenLog}
                      onAck={onAck}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </details>
  );
});

/** 处理队列页(#/queue):datatable,入队时间排序 + 筛选。 */
export function QueuePage(): ReactNode {
  const t = useT();
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const tz = useAtomValue(serverTimezoneAtom);
  const [data, setData] = useState<HubQueueDTO | null>(null);
  /** 收到当前这份快照的本地时刻 —— 本地计时以它为基准递增。 */
  const [dataAt, setDataAt] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);
  // Fleet health is separate from the queue ledger: tasks/status are slow-moving and ssh-backed.
  const [fleetTasks, setFleetTasks] = useState<Task[]>([]);
  const [fleetStatus, setFleetStatus] = useState<Record<string, WorkerStatus | undefined>>({});
  const [fleetWorkers, setFleetWorkers] = useState<Array<{ id: string; name: string }>>([]);
  const [fleetTasksStale, setFleetTasksStale] = useState(false);
  const [fleetWorkersStale, setFleetWorkersStale] = useState(false);
  const [fleetVersionStale, setFleetVersionStale] = useState(false);
  const [fleetStatusStale, setFleetStatusStale] = useState(false);
  const [fleetWorkersLoaded, setFleetWorkersLoaded] = useState(false);
  const [fleetHealthProbe, setFleetHealthProbe] = useState<NodeHealthProbe>("loading");
  const [masterVersion, setMasterVersion] = useState("");

  const [phase, setPhase] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [platform, setPlatform] = useState<string[]>([]);
  const [q, setQ] = useState("");
  // 排序方向:newest(默认,最新入队在前)| oldest(FIFO,等最久的在前)。点表头切换。
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [logKey, setLogKey] = useState<string | null>(null);
  // Review mark for a needs_manual run (issue #312): the key being marked + the required note.
  const [ackKey, setAckKey] = useState<string | null>(null);
  const [ackNote, setAckNote] = useState("");
  const toast = useToast();
  const openAck = useCallback((key: string): void => { setAckKey(key); setAckNote(""); }, []);
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
  // queryKey 稳定标识筛选条件:它变 → poll 换新闭包 → 下面的 effect 立即重拉一次。
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const poll = useMemo(
    () => async (): Promise<void> => {
      // 失败**不吞**:reject 让 useHubStream 置 stale 标记(页面显示「数据可能已过期」)。
      try {
        const d = await api.getHubQueue(JSON.parse(queryKey) as typeof query);
        setData(d);
        setDataAt(Date.now());
      } finally {
        // 首拉就失败也要结束 loading 态,否则页面永远停在「加载中」(静默失败)。
        setLoaded(true);
      }
    },
    [queryKey],
  );
  // 推送驱动:master 走 /api/hub/stream,changed 即重拉;推送不可用自动退化为有界退避轮询。
  const stream = useHubStream(poll, { enabled: hubEnabled === true });
  usePolling(
    () => api.listTasks()
      .then((tasks) => { setFleetTasks(tasks); setFleetTasksStale(false); })
      .catch(() => setFleetTasksStale(true)),
    30_000,
    hubEnabled === true,
  );
  usePolling(
    () => api.listWorkers()
      .then((list) => {
        setFleetWorkers(list.map((w) => ({ id: w.id, name: w.name })));
        setFleetWorkersStale(false);
      })
      .catch(() => setFleetWorkersStale(true))
      .finally(() => setFleetWorkersLoaded(true)),
    300_000,
    hubEnabled === true,
  );
  usePolling(
    () => api.getWorkersStatus()
      .then((list) => {
        setFleetStatus(Object.fromEntries(list.map((s) => [s.id, s])));
        setFleetStatusStale(false);
        setFleetHealthProbe((previous) => settleNodeHealthProbe(previous, "ok"));
      })
      .catch(() => {
        setFleetStatusStale(true);
        setFleetHealthProbe((previous) => settleNodeHealthProbe(previous, "error"));
      }),
    60_000,
    hubEnabled === true,
  );
  usePolling(
    () => api.getVersion()
      .then((r) => { setMasterVersion(baseVersion(r.version)); setFleetVersionStale(false); })
      .catch(() => setFleetVersionStale(true)),
    300_000,
    hubEnabled === true,
  );

  // 计时/冷却本地每秒递增:服务端只在状态变化时推,不能指望它每秒重算。
  const now = useTicker(1000);
  // 筛选一变立刻重拉(不必等下一次推送/兜底 tick)。首次跳过 —— useHubStream 挂载时已拉过一次,
  // 否则 mount 会双请求。
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    void poll();
  }, [poll]);

  const reset = (): void => { setPhase([]); setStates([]); setPlatform([]); setQ(""); };
  const onToggleSort = useCallback((): void => setSort((v) => (v === "newest" ? "oldest" : "newest")), []);
  // rows = 进行中 + 已完成,**同一张表**(像日志的时间轴)。前端只渲染它。
  const rows = data?.rows ?? [];
  // 摘要分四类:真正在跑 / 待人工上传(stage 正常收口)/ 需要处理(失败·停止)/ 已完成。
  // 旧文案「进行中 N」把待人工也算进去 → 显示「进行中 10」但其实 0 条在跑,误导。
  const runningCount = rows.filter((r) => r.phase === "running" || r.phase === "queued" || r.phase === "waiting_settle").length;
  const uploadCount = rows.filter((r) => r.phase === "waiting_upload").length;
  // Same colour rule as HubJobs.stateColor: red only for a failed run, amber for "needs a person".
  const failedCount = rows.filter((r) => r.phase === "failed").length;
  const doneCount = rows.filter((r) => r.phase === "done").length;
  // The server caps the needs_manual inbox (manualLimit); say so instead of implying the list is complete.
  // Only meaningful without filters: `active` is filtered server-side, so a filter would look like "more hidden".
  const manualShown = (data?.active ?? []).filter((r) => r.state === "needs_manual").length;
  const manualTotal = data?.manualTotal ?? 0;
  const pool = data?.pool;
  const sections = useMemo(
    () => splitQueue(rows, data?.delivering ?? [], data?.blocked ?? []),
    [rows, data?.delivering, data?.blocked],
  );
  const fleetNodes = useMemo(
    () => summarizeNodes(fleetTasks, fleetStatus, data?.delivering ?? [], masterVersion, fleetWorkers),
    [fleetTasks, fleetStatus, data?.delivering, masterVersion, fleetWorkers],
  );
  const summary = queueSummary(sections, pool ?? null);
  const attentionCount = summary.attention;
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

      <HubStreamBanner handle={stream} />

      <FleetPulse
        nodes={fleetNodes}
        delivering={data?.delivering?.length ?? 0}
        healthProbe={fleetHealthProbe}
        directoryLoaded={fleetWorkersLoaded}
        stale={fleetStatusStale || fleetTasksStale || fleetWorkersStale || fleetVersionStale}
      />

      {!loaded ? (
        <div className="py-10 text-center text-muted">{t("hub.common.loading")}</div>
      ) : (
        <>
          <FilterBar
            phase={phase} states={states} platform={platform} q={q}
            onPhase={setPhase} onStates={setStates} onPlatform={setPlatform}
            onQ={setQ}
            onReset={reset}
            summary={
              <>
                <span>{t("queue.summary.running", { n: runningCount })}</span>
                {uploadCount > 0 && <span>{t("queue.summary.upload", { n: uploadCount })}</span>}
                {attentionCount > 0 && (
                  <span style={{ color: failedCount > 0 ? "var(--error-fg)" : "var(--warning-fg)" }}>{t("queue.summary.attention", { n: attentionCount })}</span>
                )}
                {!filtered && manualTotal > manualShown && (
                  <span style={{ color: "var(--warning-fg)" }}>{t("queue.summary.manualMore", { total: manualTotal, shown: manualShown })}</span>
                )}
                {(data?.manualAcked ?? 0) > 0 && <span>{t("queue.summary.acked", { n: data?.manualAcked ?? 0 })}</span>}
                <span>{t("queue.summary.done", { n: doneCount })}</span>
              </>
            }
          />
          <div className="section-label mb-2.5">{t("queue.live.title")}</div>
          {pool && <LivePool pool={pool} />}
          {sections.live.length === 0 ? (
            <div className="card mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <Activity className="w-4 h-4" style={{ color: "var(--muted-soft)" }} />
              <span className="text-[13px] font-medium text-ink">{sections.delivering.length ? t("queue.section.delivering") : t("queue.live.empty")}</span>
              <span className="text-[12px] text-muted">{sections.delivering.length ? t("queue.fleet.delivering", { n: sections.delivering.length }) : t("queue.live.idleHint")}</span>
            </div>
          ) : (
            <div className="space-y-2 mb-5">
              {sections.live.map((item) => (
                <LiveLane key={item.streamKey} item={item} now={now} dataAt={dataAt} onOpenLog={setLogKey} />
              ))}
            </div>
          )}

          <div className="section-label mb-2.5">{t("queue.attentionSection.title")}</div>
          {sections.attention.length === 0 ? (
            <div className="card px-4 py-3 mb-5 text-[12px] text-muted">{t("queue.attentionSection.empty")}</div>
          ) : (
            <div className="mb-5">
              {sections.attention.map((g, i) => (
                <AttentionCard
                  key={g.kind}
                  kind={g.kind}
                  rows={g.rows}
                  blocked={g.blocked}
                  onOpenLog={setLogKey}
                  onAck={openAck}
                  defaultOpen={i === 0}
                />
              ))}
            </div>
          )}

          {sections.stageReady.length > 0 && (
            <details className="attention-group mb-5">
              <summary>
                <ChevronDown className="w-3.5 h-3.5 transition-transform" />
                <span className="font-medium text-ink">{t("queue.attentionSection.stageTitle")}</span>
                <span className="font-mono text-[11px] text-muted-soft">{sections.stageReady.length}</span>
              </summary>
              {sections.stageReady.map((item) => (
                <StageReadyRow key={item.streamKey} item={item} onOpenLog={setLogKey} onAck={openAck} />
              ))}
            </details>
          )}

          <HistorySection
            items={sections.history}
            filtered={filtered}
            tz={tz}
            sort={sort}
            onToggleSort={onToggleSort}
            onOpenLog={setLogKey}
            onAck={openAck}
          />
        </>
      )}

      <JobLogDialog logKey={logKey} onClose={() => setLogKey(null)} />
      <ConfirmDialog
        open={ackKey !== null}
        title={t("queue.ack.title")}
        message={t("queue.ack.message")}
        confirmLabel={t("queue.ack.confirm")}
        onCancel={() => setAckKey(null)}
        onConfirm={() => {
          const key = ackKey;
          if (!key) return;
          if (!ackNote.trim()) { toast(t("queue.ack.required"), "error"); return; }
          api.ackHubJob(key, { note: ackNote.trim() })
            .then(() => { toast(t("queue.ack.done"), "success"); setAckKey(null); void poll(); })
            .catch((e: unknown) => toast(errMessage(e), "error"));
        }}
      >
        <div className="space-y-2 mb-3">
          <div className="font-mono text-[11px] text-muted break-all">{ackKey}</div>
          <textarea
            className="input w-full min-h-[72px]"
            maxLength={500}
            value={ackNote}
            placeholder={t("queue.ack.placeholder")}
            onChange={(e) => setAckNote(e.target.value)}
          />
        </div>
      </ConfirmDialog>
    </>
  );
}
