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
import { HomePage } from "./pages/HomePage";
import { NodesPage } from "./pages/NodesPage";
import { RoomPage } from "./pages/RoomPage";
import { RoomsPage } from "./pages/RoomsPage";
import { QueuePage } from "./pages/QueuePage";
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
    <div className="min-h-[100dvh] min-w-0 max-w-full flex flex-col font-sans">
      <TopNav />
      <main className="flex-1 w-full min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <Routes>
          <Route path="/" element={<HomePage />} />
          {/* Legacy master routes stay addressable while Rooms becomes the primary workflow. */}
          <Route path="/tasks" element={<TaskList />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/task/:id" element={<TaskDetail />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/hub" element={<HubPage />} />
          {/* Rooms is the master home; old pages remain as compatibility routes during rollout. */}
          <Route path="/rooms" element={<RoomsPage />} />
          <Route path="/rooms/:key" element={<RoomPage />} />
          <Route path="/hub/:key" element={<HubPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </main>
      <Footer />
      <Toaster position="top-right" richColors closeButton />
    </div>
  );
}
