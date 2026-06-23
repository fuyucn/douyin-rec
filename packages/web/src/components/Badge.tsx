import type { ReactNode } from "react";
import type { Task } from "../api/client";
import { DANMU_BADGE_CLASS, danmuKind } from "../lib/labels";
import { useT } from "../lib/i18n";

interface BadgeProps {
  /** One of the badge-* modifier classes (e.g. "badge-violet"). */
  tone?: string;
  children: ReactNode;
}

/** Generic pastel badge. */
export function Badge({ tone = "badge-muted", children }: BadgeProps): ReactNode {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** A colored dot (optionally pulsing for the running state). */
export function Dot({ color, pulse }: { color: string; pulse?: boolean }): ReactNode {
  return <span className={`dot${pulse ? " dot-running" : ""}`} style={{ background: color }} />;
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
}: {
  running: boolean;
  status: string;
  enabled?: boolean;
  /** true=真正在录视频；running 但未录(等开播/重连) → 显示「等待开播中」。 */
  recording?: boolean;
}): ReactNode {
  const t = useT();
  // 已停用优先：用户主动关掉，daemon 不会再拉起。
  if (!enabled) {
    return (
      <Badge tone="badge-neutral">
        <Dot color="var(--muted-soft)" />
        {t("badge.disabled")}
      </Badge>
    );
  }
  // draining 必须先于 running 判定（排空期间进程仍在跑，running=true）。
  // 兼容两种来源：窗口结束自动排空 / 手动「停止」→ 都是等当前直播自然收播。
  if (status === "draining") {
    return (
      <Badge tone="badge-orange">
        <Dot color="var(--warning)" pulse />
        {t("badge.draining")}
      </Badge>
    );
  }
  if (running) {
    // 进程在跑但还没拿到流（轮询开播 / 重连中）→ 「等待开播中」，不要误显示录制中。
    if (recording === false) {
      return (
        <Badge tone="badge-violet">
          <Dot color="var(--muted-soft)" pulse />
          {t("badge.waiting")}
        </Badge>
      );
    }
    return (
      <Badge tone="badge-success">
        <Dot color="var(--success)" pulse />
        {t("badge.recording")}
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge tone="badge-error">
        <Dot color="var(--error)" />
        {t("badge.error")}
      </Badge>
    );
  }
  // 已启用但当前没在录：等窗口 / 等开播。
  return (
    <Badge tone="badge-violet">
      <Dot color="var(--muted-soft)" />
      {t("badge.idle")}
    </Badge>
  );
}

/** 关闭 / 含礼物 / 匿名 badge driven by danmu + useCookie. */
export function DanmuBadge({ task }: { task: Pick<Task, "danmu" | "useCookie"> }): ReactNode {
  const t = useT();
  const kind = danmuKind(task);
  return <Badge tone={DANMU_BADGE_CLASS[kind]}>{t(`danmuKind.${kind}`)}</Badge>;
}
