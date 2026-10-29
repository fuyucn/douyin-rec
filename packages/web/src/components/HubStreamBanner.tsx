/** HubStreamBanner — 推送状态提示条(仅在「数据可能已过期」时出现,正常时不占位)。 */
import type { ReactNode } from "react";
import type { HubStreamHandle } from "../lib/hooks";
import { useT } from "../lib/i18n";

/**
 * 队列页与 Hub 页共用一份判定与文案,避免两处各写一遍导致漂移。
 * 两种过期态分开说:推送断开(退避轮询中)/ 最近一次拉取失败。
 */
export function HubStreamBanner({ handle }: { handle: HubStreamHandle }): ReactNode {
  const t = useT();
  if (!handle.stale) return null;
  return (
    <div className="badge-orange flex flex-wrap items-center gap-2 mb-4 px-3 py-2 rounded-lg text-[12px]" role="status">
      <span className="dot" style={{ background: "var(--warning)" }} />
      <span>{handle.live ? t("hub.common.staleHintFetch") : t("hub.common.staleHint")}</span>
      <button type="button" className="btn-secondary btn-sm ml-auto" onClick={handle.refresh}>
        {t("hub.common.refresh")}
      </button>
    </div>
  );
}
