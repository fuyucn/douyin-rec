import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { hubEnabledAtom } from "../atoms";
import { useT } from "../lib/i18n";
import { homeTarget } from "../lib/nav";

/** 所有节点(含 worker)首页都是 Rooms;hub 探测未完成时先等,避免跳到不该去的页面。 */
export function HomePage(): ReactNode {
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const t = useT();
  const target = homeTarget(hubEnabled);
  if (target === null) return <p className="text-muted text-sm py-10 text-center">{t("tasks.loading")}</p>;
  return <Navigate to={target} replace />;
}
