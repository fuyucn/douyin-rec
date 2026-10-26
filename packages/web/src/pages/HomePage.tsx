import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { hubEnabledAtom } from "../atoms";
import { useT } from "../lib/i18n";
import { homeTarget } from "../lib/nav";
import { TaskList } from "./TaskList";

/** Master opens on the unified Rooms page; a worker has no hub APIs, so it keeps the Tasks home. */
export function HomePage(): ReactNode {
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const t = useT();
  const target = homeTarget(hubEnabled);
  if (target === null) return <p className="text-muted text-sm py-10 text-center">{t("tasks.loading")}</p>;
  return target === "/rooms" ? <Navigate to={target} replace /> : <TaskList />;
}
