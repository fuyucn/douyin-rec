import type { ReactNode } from "react";
import type { Task } from "../api/client";
import { DANMU_BADGE_CLASS, danmuKind } from "../lib/labels";
import { useT } from "../lib/i18n";
import { useTicker } from "../lib/hooks";
import { PHASE_STYLE, taskPhase } from "../lib/task-status";

interface BadgeProps {
  /** One of the badge-* modifier classes (e.g. "badge-violet"). */
  tone?: string;
  children: ReactNode;
  /** 原生 title:放「这一结论来自 N 秒前的探测」这类解释(悬停可见,零布局成本)。 */
  title?: string;
}

/** Square mono chip badge. */
export function Badge({ tone = "badge-muted", children, title }: BadgeProps): ReactNode {
  return <span className={`badge ${tone}`} title={title}>{children}</span>;
}

/** A square status dot (optionally pulsing for the running state). */
export function Dot({ color, pulse }: { color: string; pulse?: boolean }): ReactNode {
  return <span className={`dot${pulse ? " dot-running" : ""}`} style={{ background: color }} />;
}

/**
 * 「N 秒前核对」标签(T17)。
 *
 * 只在**超过 10s** 时显示:正常 2~5s 一探,每次都挂个「3 秒前」纯属噪声;
 * 真正该提醒的是「这个结论已经很旧了」—— 节点探测失败时缓存会一直停在旧值,
 * 不提示就等于把一个陈旧结论当实时显示。
 *
 * 用**最早**那条 checkedAt 算年龄:一行里只要有一个节点是老结论就该提示。
 */
const STALE_AFTER_MS = 10_000;

function recordingAgeLabel(workers: Task["recordingWorkers"], now: number): string | null {
  if (!workers?.length) return null;
  const stamps = workers.map((w) => w.checkedAt).filter((v): v is number => typeof v === "number");
  if (!stamps.length) return null;
  const age = now - Math.min(...stamps);
  if (age < STALE_AFTER_MS) return null;
  return age >= 60_000 ? `${Math.floor(age / 60_000)}m` : `${Math.floor(age / 1000)}s`;
}


/**
 * 任务状态徽章，按「用户意图(enabled) + 运行时状态」分档：
 *   已停用(enabled=false) → 灰，daemon 永不启动
 *   排空中(draining)      → 橙(脉冲)，停止/出窗口后等当前直播自然收播
 *   录制中(running)       → 绿(脉冲)
 *   错误(error)           → 红
 *   已启用·待命           → 蓝，已启用但不在窗口/未开播
 */
export function StatusBadge({
  running,
  status,
  enabled = true,
  recording,
  stopping,
  recordingWorkers,
}: {
  running: boolean;
  status: string;
  enabled?: boolean;
  /** true=正在硬停收尾(rolling 末段上传中)；优先于其他状态显示。 */
  stopping?: boolean;
  /** true=真正在录视频；running 但未录(等开播/重连) → 显示「等待开播中」。 */
  recording?: boolean;
  recordingWorkers?: Task["recordingWorkers"];
}): ReactNode {
  const t = useT();
  // 本地每秒走一次:否则「N 秒前核对」会冻结在渲染那一刻的数字 —— 推送驱动的页面
  // 恰恰很少重渲染,不自带 ticker 就会出现「永远显示 12s 前」。
  const now = useTicker(1_000);
  // 判定顺序与配色只写在 taskPhase / PHASE_STYLE 一处(与任务详情页共用),徽标不再自带分支。
  const phase = taskPhase({ enabled, status, running, recording, stopping, recordingWorkers });
  // T17:远端状态是 SSH 探测的**缓存**,不是实时的。带出「N 秒前核对」,
  // 否则用户把一个 3 分钟前的旧结论当成实时(节点探测失败时缓存会一直是旧值)。
  const staleness = recordingAgeLabel(recordingWorkers, now);
  const style = PHASE_STYLE[phase.kind];
  const allWorkers = (recordingWorkers ?? []).map((w) => w.workerName);
  const nodes = phase.kind === "recording" && phase.recordingNodes.length > 0 ? phase.recordingNodes
    : phase.kind === "offline" ? phase.unavailableNodes
      : phase.kind === "waiting" && allWorkers.length > 0 ? allWorkers
        : [];
  return (
    <Badge tone={style.tone} title={staleness ? t("badge.checkedAgoTitle", { ago: staleness }) : undefined}>
      <Dot color={style.dot} pulse={style.pulse} />
      {nodes.length > 0 ? t(phase.textKey, { nodes: nodes.join(" + ") }) : t(phase.textKey)}
      {staleness ? <span className="ml-1 opacity-70">{staleness}</span> : null}
    </Badge>
  );
}

/** 关闭 / 含礼物 / 匿名 badge driven by danmu + useCookie. */
export function DanmuBadge({ task }: { task: Pick<Task, "danmu" | "useCookie"> }): ReactNode {
  const t = useT();
  const kind = danmuKind(task);
  return <Badge tone={DANMU_BADGE_CLASS[kind]}>{t(`danmuKind.${kind}`)}</Badge>;
}
