import { useEffect, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { Footer } from "./layout/Footer";
import { TopNav } from "./layout/TopNav";
import { useRefreshCookie } from "./lib/hooks";
import { useEventNotifications } from "./lib/notifications";
import { TaskDetail } from "./pages/TaskDetail";
import { TaskList } from "./pages/TaskList";

/** App shell: nav + routed main + dark footer + toast host. */
export function App(): ReactNode {
  const refreshCookie = useRefreshCookie();
  useEffect(() => {
    void refreshCookie();
  }, [refreshCookie]);
  // 站内事件流 → toast(开播/录完/合成/出错;按用户开关)。
  useEventNotifications();

  return (
    <div className="min-h-screen flex flex-col font-sans">
      <TopNav />
      <main className="flex-1 w-full max-w-[1200px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <Routes>
          <Route path="/" element={<TaskList />} />
          <Route path="/task/:id" element={<TaskDetail />} />
          <Route path="*" element={<TaskList />} />
        </Routes>
      </main>
      <Footer />
      <Toaster position="top-right" richColors closeButton />
    </div>
  );
}
