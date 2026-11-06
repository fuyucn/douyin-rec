/**
 * components/MasterOnly.tsx — 主控(master)专属页面的守卫(plans/047 §4.1)。
 *
 * master(hub enabled)→ 渲染原页面;worker → child-node 说明卡;探测中(`null`)→ 加载态。
 * 文案**只复用已有 key**:通用句用 `hub.page.childTitle` / `childDesc1..4`(与 Hub/Queue 页同口径),
 * 页面专属的一句由调用方传 `descKey`(如 `nodes.childDesc` / `queue.childDesc`)。
 */
import { useAtomValue } from "jotai";
import { Network } from "lucide-react";
import type { ReactNode } from "react";
import { hubEnabledAtom } from "../atoms";
import { useT } from "../lib/i18n";

export interface MasterOnlyProps {
  children: ReactNode;
  /** 已有的页面专属说明 key(如 `nodes.childDesc`);缺省只显示通用 child-node 说明。 */
  descKey?: string;
}

/** hub 未启用 → 说明卡;启用 → 原页面;探测中 → 加载。 */
export function MasterOnly({ children, descKey }: MasterOnlyProps): ReactNode {
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const t = useT();
  if (hubEnabled === null) {
    return <p className="text-muted text-sm py-10 text-center">{t("tasks.loading")}</p>;
  }
  if (hubEnabled === true) return <>{children}</>;
  return (
    <div className="card p-10 flex flex-col items-center gap-4 text-center">
      <Network className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
      <h1 className="headline text-[22px]">{t("hub.page.childTitle")}</h1>
      <p className="text-muted text-sm max-w-md">
        {t("hub.page.childDesc1")}<code>task serve</code>{t("hub.page.childDesc2")}<code>--hub</code>
        {t("hub.page.childDesc3")}<b>{t("hub.page.childMaster")}</b>{t("hub.page.childDesc4")}
      </p>
      {descKey ? <p className="text-muted text-sm max-w-md">{t(descKey)}</p> : null}
    </div>
  );
}
