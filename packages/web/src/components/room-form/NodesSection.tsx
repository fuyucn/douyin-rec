import { useState, type ReactNode } from "react";
import type { WorkerDTO } from "../../api/client";
import { useT } from "../../lib/i18n";
import { SectionHeader, ToggleRow } from "./parts";

interface Props {
  workers: WorkerDTO[];
  selected: readonly string[];
  requires: readonly string[];
  onToggle: (id: string) => void;
  onToggleRequire: (cap: string) => void;
  loadError?: boolean;
  /** 新建规则必须至少选 1 个节点;房间面板允许空(= 全部节点)。 */
  requireOne?: boolean;
}

/** 所有 worker 能力标签的并集(去重保序)→ 能力门控候选。 */
function capabilitiesOf(workers: WorkerDTO[]): string[] {
  return [...new Set(workers.flatMap((w) => w.capabilities ?? []))];
}

export function NodesSection(p: Props): ReactNode {
  const t = useT();
  const caps = capabilitiesOf(p.workers);
  // 已勾选、但缺 requires 里某项能力的节点 → 会被门控排除(否则表现为「勾了却不录」)。
  const filteredOut = p.workers.filter(
    (w) => p.selected.includes(w.id) && p.requires.some((r) => !(w.capabilities ?? []).includes(r)),
  );
  const [capsOpen, setCapsOpen] = useState(p.requires.length > 0);
  return (
    <section className="space-y-3">
      <SectionHeader title={t("rooms.nodes")} />
      <p className="text-xs text-muted -mt-1">{t(p.requireOne ? "hub.ruleDialog.workersHint" : "rooms.nodesHint")}</p>
      {p.loadError ? (
        <p className="text-xs text-error-fg">{t("hub.ruleDialog.workersLoadFailed")}</p>
      ) : p.workers.length === 0 ? (
        <p className="text-xs text-muted">{t("rooms.nodesEmpty")}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {p.workers.map((w) => (
            <ToggleRow key={w.id} label={w.name} hint={<span className="font-mono">{w.kind}{w.host ? ` · ${w.host}` : ""}</span>}
                       checked={p.selected.includes(w.id)} onChange={() => p.onToggle(w.id)} />
          ))}
        </div>
      )}
      {p.requireOne && p.selected.length === 0 && p.workers.length > 0 && (
        <p className="text-xs text-error-fg">{t("hub.ruleDialog.workersRequired")}</p>
      )}
      {caps.length > 0 && (
        <details open={capsOpen} onToggle={(e) => setCapsOpen(e.currentTarget.open)}>
          <summary className="text-xs text-muted cursor-pointer">{t("hub.ruleDialog.capsSection")}</summary>
          <p className="text-xs text-muted my-2">{t("hub.ruleDialog.capsHint")}</p>
          <div className="flex flex-wrap gap-2">
            {caps.map((c) => (
              <label key={c} className="inline-flex items-center gap-1.5 text-xs border border-hairline px-2 py-1 cursor-pointer"
                     style={{ borderRadius: "var(--r-pill, 999px)" }}>
                <input type="checkbox" checked={p.requires.includes(c)} onChange={() => p.onToggleRequire(c)} />
                <span className="font-mono text-muted-soft">{c}</span>
              </label>
            ))}
          </div>
        </details>
      )}
      {filteredOut.length > 0 && (
        <p className="text-xs text-error-fg">
          {t("hub.ruleDialog.capsFiltered", { workers: filteredOut.map((w) => w.name).join("、") })}
        </p>
      )}
    </section>
  );
}
