import { useEffect, useState, type ReactNode } from "react";
import { useSetAtom } from "jotai";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { Toaster } from "sonner";
import { api } from "./api/client";
import { hubEnabledAtom, serverTimezoneAtom } from "./atoms";
import { Footer } from "./layout/Footer";
import { TopNav } from "./layout/TopNav";
import { MasterOnly } from "./components/MasterOnly";
import { LoginScreen } from "./components/LoginScreen";
import { useRefreshCookie } from "./lib/hooks";
import { useT } from "./lib/i18n";
import { useEventNotifications } from "./lib/notifications";
import { HubPage } from "./pages/HubPage";
import { HomePage } from "./pages/HomePage";
import { NodesPage } from "./pages/NodesPage";
import { RoomPage } from "./pages/RoomPage";
import { RoomsPage } from "./pages/RoomsPage";
import { QueuePage } from "./pages/QueuePage";
import { StatsPage } from "./pages/StatsPage";

/**
 * `/task/:id` — 旧任务链接/站内通知 → 房间路由(plans/047 §3.1)。
 * 任务是「房间里看不见的实现」,所以这里只做跳转;`?logs=1` 等查询参数原样带走(§6 F6)。
 */
function TaskIdRedirect(): ReactNode {
  const { id } = useParams();
  const { search } = useLocation();
  if (!id) return <Navigate to={{ pathname: "/rooms", search }} replace />;
  return <Navigate to={{ pathname: `/rooms/by-task/${encodeURIComponent(id)}`, search }} replace />;
}

function TasksRedirect(): ReactNode {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/rooms", search }} replace />;
}

/**
 * `/rooms/by-task/:id` — 用 `GET /api/rooms` 找到 `recording.taskId === id` 的房间。
 * 加载中给骨架;找不到 / 请求失败一律回落 `/rooms`(不 404,旧链接仍可用)。
 */
function RoomByTaskRedirect(): ReactNode {
  const { id } = useParams();
  const { search } = useLocation();
  const t = useT();
  /** undefined = 探测中(渲染骨架);string = 目标房间路径;null = 没找到。 */
  const [target, setTarget] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setTarget(undefined);
    if (!id) {
      setTarget(null);
      return () => { alive = false; };
    }
    void api
      .listRooms()
      .then((rooms) => {
        if (!alive) return;
        // taskId 为 null 的房间(只配了处理半边)不参与匹配:String(null) 没有意义。
        const hit = rooms.find((r) => r.recording !== null && r.recording.taskId !== null
          && String(r.recording.taskId) === id);
        setTarget(hit ? `/rooms/${encodeURIComponent(hit.key)}` : null);
      })
      .catch(() => { if (alive) setTarget(null); });
    return () => { alive = false; };
  }, [id]);

  if (target === undefined) return <p className="text-muted text-sm py-10 text-center">{t("tasks.loading")}</p>;
  return <Navigate to={{ pathname: target ?? "/rooms", search }} replace />;
}

/**
 * App — 先探测远程访问是否需要密钥（issue #600）；未登录只渲染登录页，
 * shell 的数据 hooks 在有票据后才挂载，避免一屏 401。
 */
export function App(): ReactNode {
  const t = useT();
  const [session, setSession] = useState<import("./api/client").SessionInfo | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getSession()
      .then((s) => { if (alive) setSession(s); })
      // 探测失败不能把用户锁在登录页；按「未开启鉴权」继续，具体错误由各页面展示。
      .catch(() => { if (alive) setSession({ authRequired: false, authenticated: true }); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onUnauthorized = (): void => setSession({ authRequired: true, authenticated: false });
    window.addEventListener("drec:unauthorized", onUnauthorized);
    return () => window.removeEventListener("drec:unauthorized", onUnauthorized);
  }, []);

  if (!session) {
    return <div className="min-h-[100dvh] grid place-items-center text-muted text-sm">{t("auth.checking")}</div>;
  }
  if (session.authRequired && !session.authenticated) return <LoginScreen />;
  return <AppShell />;
}

/** App shell: nav + routed main + dark footer + toast host. */
function AppShell(): ReactNode {
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
          {/* 唯一用户可见实体 = 房间;master/worker 同一套页面,能力由 lib/capabilities 裁剪。 */}
          <Route path="/rooms" element={<RoomsPage />} />
          <Route path="/rooms/by-task/:id" element={<RoomByTaskRedirect />} />
          <Route path="/rooms/:key" element={<RoomPage />} />
          {/* 旧任务路由退化为跳转:任务不再是用户可见实体,旧链接/通知仍可用(plans/047 §4.1)。 */}
          <Route path="/tasks" element={<TasksRedirect />} />
          <Route path="/task/:id" element={<TaskIdRedirect />} />
          {/* master-only 页面:worker 上给 child-node 说明卡,不解析出任何写操作。 */}
          <Route path="/nodes" element={<MasterOnly descKey="nodes.childDesc"><NodesPage /></MasterOnly>} />
          <Route path="/queue" element={<MasterOnly descKey="queue.childDesc"><QueuePage /></MasterOnly>} />
          <Route path="/stats" element={<MasterOnly><StatsPage /></MasterOnly>} />
          {/* `/hub` 规则级维护仍在 master(plan §6 F1),worker 上原样给 child-node 卡。 */}
          <Route path="/hub" element={<HubPage />} />
          <Route path="/hub/:key" element={<HubPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </main>
      <Footer />
      <Toaster position="top-right" richColors closeButton />
    </div>
  );
}
