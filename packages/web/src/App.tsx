import { useEffect, type ReactNode } from "react";
import { useSetAtom } from "jotai";
import { Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { api } from "./api/client";
import { hubEnabledAtom, serverTimezoneAtom } from "./atoms";
import { Footer } from "./layout/Footer";
import { TopNav } from "./layout/TopNav";
import { useRefreshCookie } from "./lib/hooks";
import { useEventNotifications } from "./lib/notifications";
import { HubPage } from "./pages/HubPage";
import { TaskDetail } from "./pages/TaskDetail";
import { TaskList } from "./pages/TaskList";

/** App shell: nav + routed main + dark footer + toast host. */
export function App(): ReactNode {
  const refreshCookie = useRefreshCookie();
  const setHubEnabled = useSetAtom(hubEnabledAtom);
  const setServerTimezone = useSetAtom(serverTimezoneAtom);
  useEffect(() => {
    void refreshCookie();
    // 本节点是不是 master(启用 hub)?启动时拉一次,决定是否显示「Hub」导航/页。
    void api.getHubStatus().then((s) => setHubEnabled(s.enabled)).catch(() => setHubEnabled(false));
    // 后端实际生效时区,启动时拉一次;各处时间显示统一按它为主口径(见 lib/tz.ts)。
    void api.getTimezone().then((r) => setServerTimezone(r.effective || r.default)).catch(() => {});
  }, [refreshCookie, setHubEnabled, setServerTimezone]);
  // 站内事件流 → toast(开播/录完/合成/出错;按用户开关)。
  useEventNotifications();

  return (
    <div className="min-h-screen flex flex-col font-sans">
      <TopNav />
      <main className="flex-1 w-full max-w-[1200px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <Routes>
          <Route path="/" element={<TaskList />} />
          <Route path="/task/:id" element={<TaskDetail />} />
          <Route path="/hub" element={<HubPage />} />
          <Route path="*" element={<TaskList />} />
        </Routes>
      </main>
      <Footer />
      <Toaster position="top-right" richColors closeButton />
    </div>
  );
}
