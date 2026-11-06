/**
 * RoomsPage — `/rooms` list: one row per live room, sorted by what needs eyes first.
 *
 * **一个页面、按角色裁剪**(plans/047 §3.2/§3.3):master 看到「交付 / 节点」列与节点面板;worker
 * (`caps.nodes === false`)只看录制半边 —— 交付方式、上次交付、节点名都由 master 的规则与台账决定,
 * 在节点上是空值,画出来只会误导。裁剪一律问 `useRoomsData().caps`,不在这里另判 `hubEnabled`。
 *
 * Same visual language as the rest of the app (telemetry band, table shell, chips/badges, icon
 * actions); the telemetry band doubles as the filter. Rooms is the only room entry now (`/tasks`
 * is a redirect), so this page also carries the old task list's unassigned-room filter.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, FileText, FolderOpen, LayoutGrid, Loader, Pencil, Play, Plus, Server, Square, TriangleAlert } from "lucide-react";
import { api, type RoomDTO, type WorkerStatus } from "../api/client";
import { Button, IconButton } from "../components/Button";
import { ConnStatus } from "../components/ConnStatus";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { ModeIndicators } from "../components/ModeIndicator";
import { ModeLogo, type ModeLogoKind } from "../components/ModeLogo";
import { WorkersPanel } from "../components/WorkersPanel";
import { RoomEditor } from "../modals/RoomEditor";
import { isUnassignedHidden } from "../lib/assigned";
import { useTicker } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { roomDisplayId, scheduleText } from "../lib/labels";
import { sortByStatus, type RoomStatusKind } from "../lib/room-status";
import { DeliveryCell, deliverText, nodesText, roomName, RoomBadge, statusDetail, useRoomActions, useRoomsData } from "./rooms/shared";

type Filter = "all" | Extract<RoomStatusKind, "recording" | "processing" | "attention">;
const FILTER_TONE: Record<Filter, string | undefined> = {
  all: undefined, recording: "var(--success-fg)", processing: "var(--status-fg)", attention: "var(--warning-fg)",
};

/** 一格「方式」的渲染数据:标签 + 悬浮说明 + 色调 + 角标图形。 */
interface Method { label: string; title: string; tone?: string; kind: ModeLogoKind }

export function RoomsPage(): ReactNode {
  const t = useT();
  const data = useRoomsData();
  const actions = useRoomActions(data);
  const [filter, setFilter] = useState<Filter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [workersOpen, setWorkersOpen] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<Record<string, WorkerStatus>>({});
  const [showUnassigned, setShowUnassigned] = useState(false);
  // Relative times ("5 min ago") must keep moving even though the page is push-driven.
  const now = useTicker(30_000);
  const { rooms, loaded, statusOf } = data;
  /**
   * master 视图 = 「节点」能力(plan §3.2)。它不是布局开关,而是事实来源的开关:节点表、交付方式、
   * 上次交付都只存在于 master,worker 上既不请求也不显示。
   */
  const master = data.caps.nodes;
  /**
   * 承接原任务列表的过滤(plans/047 §6 F2):节点默认隐藏「受管 ∧ 主控未分配 ∧ 未在录」的房间,
   * 否则迁到 `/rooms` 后节点上会突然多出一批本该藏起来的房间。过滤按房间(而非任务)做,
   * 只配了处理半边的房间在节点上不存在,`taskOf` 缺省即不隐藏。
   */
  const hiddenKeys = useMemo(() => (master ? new Set<string>() : new Set(rooms.filter((r) => {
    const task = data.taskOf(r);
    return task ? isUnassignedHidden(task) : false;
  }).map((r) => r.key))), [master, rooms, data.taskOf]);
  const visible = master || showUnassigned ? rooms : rooms.filter((r) => !hiddenKeys.has(r.key));

  const sorted = useMemo(() => sortByStatus(visible, statusOf), [visible, statusOf]);
  const count = (f: Filter): number => (f === "all" ? visible.length : visible.filter((r) => statusOf(r).kind === f).length);
  const shown = filter === "all" ? sorted : sorted.filter((r) => statusOf(r).kind === filter);
  const attention = sorted.filter((r) => statusOf(r).kind === "attention");

  const openWorkers = (): void => {
    setWorkersOpen(true);
    void refreshWorkerStatus();
  };
  const refreshWorkerStatus = (): Promise<void> =>
    api.getWorkersStatus()
      .then((list) => setWorkerStatus(Object.fromEntries(list.map((s) => [s.id, s]))))
      .catch(() => {});

  const cell = (f: Filter, icon: ReactNode): ReactNode => (
    <div role="tab" tabIndex={0} aria-selected={filter === f}
         className={`telemetry-cell${filter === f ? " is-on" : ""}`}
         onClick={() => setFilter(f)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilter(f); } }}>
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="telemetry-label">{f === "all" ? t("room.all") : t(`room.status.${f}`)}</span>
        <span className="telemetry-value tabular-nums" style={count(f) ? { color: FILTER_TONE[f] } : undefined}>
          {loaded ? count(f) : "–"}
        </span>
      </div>
      <span className="telemetry-icon" style={count(f) ? { color: FILTER_TONE[f] } : undefined}>{icon}</span>
    </div>
  );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 mb-6">
        <div className="min-w-0">
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("room.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("room.subtitle")}</p>
        </div>
        <div className="flex w-full sm:w-auto flex-wrap items-center gap-2 sm:gap-3 min-w-0">
          <ConnStatus conn={data.conn} />
          {!master && (hiddenKeys.size > 0 || showUnassigned) && (
            <Button small variant="secondary" onClick={() => setShowUnassigned((v) => !v)}>
              {t(showUnassigned ? "tasks.hideUnassigned" : "tasks.showUnassigned", { n: hiddenKeys.size })}
            </Button>
          )}
          {master && (
            <Button small variant="secondary" onClick={openWorkers} className="min-w-0 flex-1 sm:flex-none">
              <Server className="w-4 h-4" />
              <span className="truncate">{t("hub.workers.pill", { count: data.workers.length })}</span>
            </Button>
          )}
          <Button onClick={() => setCreateOpen(true)} aria-label={t("room.add")} className="rm-add">
            <Plus className="w-4 h-4" />
            <span className="rm-add-label">{t("room.add")}</span>
          </Button>
        </div>
      </div>

      {/* 推送失效提示讲的是主控的 hub 流:`useRoomsData` 在节点上不订阅,自然也不挂这条横幅。 */}
      {master && <HubStreamBanner handle={data.stream} />}

      <div className="telemetry-bar mb-5" role="tablist">
        {cell("all", <LayoutGrid className="w-4 h-4" />)}
        {cell("recording", <Activity className="w-4 h-4" />)}
        {cell("processing", <Loader className="w-4 h-4" />)}
        {cell("attention", <TriangleAlert className="w-4 h-4" />)}
      </div>

      {attention.length > 0 && filter !== "attention" && (
        <div className="status-strip rm-alert mb-3 sm:mb-4">
          <span className="dot" style={{ background: "var(--warning)" }} />
          <span className="flex-1 min-w-0 truncate">
            <b className="text-ink font-medium">{t("room.alertCount", { count: attention.length })}</b>
            <span className="text-muted-soft">
              {" · "}{roomName(attention[0])}{" · "}{statusDetail(t, attention[0], statusOf(attention[0]))}
            </span>
          </span>
          <Button small variant="secondary" onClick={() => setFilter("attention")}>{t("room.view")}</Button>
        </div>
      )}

      <section className="table-shell">
        <div className="lg:hidden">
          {!loaded && [0, 1, 2].map((i) => (
            <div key={i} className="task-compact px-4 py-3.5" aria-hidden="true">
              <span className="skeleton block h-4 w-32 max-w-full" />
              <span className="skeleton block h-3 w-40 max-w-full mt-2" />
            </div>
          ))}
          {loaded && shown.length === 0 && <Empty t={t} empty={rooms.length === 0} />}
          {loaded && shown.map((r) => <RoomCompactRow key={r.key} room={r} data={data} actions={actions} now={now} master={master} />)}
        </div>

        <div className="hidden lg:block min-w-0 overflow-x-auto">
          <table className="tasks" style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th className={master ? "w-[212px]" : "w-[236px]"}>{t("room.colRoom")}</th>
                <th className={master ? "w-[136px]" : "w-[132px]"}>{master ? t("room.colUploadMethod") : t("room.colRecordingMethod")}</th>
                {master && <th className="w-[112px]">{t("room.colLastDeliver")}</th>}
                {master && <th className="w-[132px]">{t("room.colNodes")}</th>}
                <th className="w-[96px]">{t("room.colSchedule")}</th>
                <th className="w-[168px]">{t("room.colStatus")}</th>
                <th className="w-[146px] text-right">{t("room.colAction")}</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && [0, 1, 2].map((i) => (
                <tr key={i} aria-hidden="true">
                  <td><span className="skeleton block h-4 w-40 max-w-full" /></td>
                  <td><span className="skeleton block h-4 w-14" /></td>
                  {master && <td><span className="skeleton block h-4 w-16" /></td>}
                  {master && <td><span className="skeleton block h-4 w-24" /></td>}
                  <td><span className="skeleton block h-4 w-20" /></td>
                  <td><span className="skeleton block h-4 w-28" /></td>
                  <td><span className="skeleton block h-8 w-8" /></td>
                </tr>
              ))}
              {loaded && shown.length === 0 && (
                <tr><td colSpan={master ? 7 : 5} className="p-0"><Empty t={t} empty={rooms.length === 0} /></td></tr>
              )}
              {loaded && shown.map((r) => (
                <tr key={r.key}>
                  <td>
                    <Link
                      to={`/rooms/${encodeURIComponent(r.key)}`}
                      className="group block min-w-0"
                      title={[
                        r.room,
                        master && r.processing ? deliverText(t, r) : null,
                        master && r.processing?.pipeline?.upload?.private === false ? t("room.publicShort") : null,
                      ].filter(Boolean).join(" · ")}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-ink truncate group-hover:underline">{roomName(r)}</span>
                        {actions.managedOf(r) && <span className="badge badge-muted shrink-0">{t("tasks.managed")}</span>}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 min-w-0">
                        <span className="badge badge-muted shrink-0 !h-[18px] !px-1.5 !text-[10px] uppercase">
                          {r.platform}
                        </span>
                        <span className="font-mono text-xs text-muted truncate">{roomDisplayId(r)}</span>
                      </div>
                    </Link>
                  </td>
                  <td>{master ? <ModeIndicators room={r} /> : <RecordingMethodChip room={r} />}</td>
                  {/* 交付与节点是 master 规则/台账的投影:节点上没有规则,画出来永远是空值。 */}
                  {master && <td><DeliveryCell s={statusOf(r)} now={now} /></td>}
                  {master && <td className="font-mono text-[11px] text-muted truncate max-w-0" title={nodesText(r, data.workers, t("room.allNodes"))}>{nodesText(r, data.workers, t("room.allNodes"))}</td>}
                  <td>
                    {scheduleText(scheduleOf(r)) ? (
                      <span className="font-mono text-[12.5px] text-body tabular-nums whitespace-nowrap">{scheduleText(scheduleOf(r))}</span>
                    ) : <span className="text-muted-soft">-</span>}
                  </td>
                  <td>
                    <div className="min-w-0">
                      <RoomBadge s={statusOf(r)} />
                      <div className="text-[11px] text-muted truncate mt-0.5" title={statusDetail(t, r, statusOf(r))}>
                        {statusDetail(t, r, statusOf(r))}
                      </div>
                    </div>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <RoomActions room={r} data={data} actions={actions} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {actions.dialogs}
      {/* 新增房间 = 同一个编辑弹窗的 create 模式(录制 + 处理两半一次写完)。 */}
      {createOpen && (
        <RoomEditor
          room={null}
          managed={false}
          onClose={() => setCreateOpen(false)}
          onSaved={() => { setCreateOpen(false); void data.refresh().catch(() => {}); }}
        />
      )}
      {/* 节点面板是 master 的节点表:worker 连 worker 列表都不拉(`useRoomsData`.`refreshWorkers` 是 no-op)。 */}
      {master && (
        <WorkersPanel
          open={workersOpen}
          onClose={() => setWorkersOpen(false)}
          workers={data.workers}
          status={workerStatus}
          onChanged={() => {
            void data.refreshWorkers().catch(() => {});
            void refreshWorkerStatus();
          }}
        />
      )}
    </>
  );
}


/**
 * worker 上的「录制方式」(节点能力矩阵):只看**任务字段** —— 直播直传 > 边录边传 >
 * 普通录制 + 存档格式。master 的 `MethodChip` 读规则(处理半边),节点上没有规则,故两者分开判。
 */
function recordingMethod(t: ReturnType<typeof useT>, r: RoomDTO): Method | null {
  const rec = r.recording;
  if (!rec) return null;
  const fmt = rec.outputFormat !== "original" ? rec.outputFormat.toUpperCase() : null;
  const format = `${t("rooms.outputFormat")}: ${fmt ?? t("rooms.outputFormatOriginal")}`;
  if (rec.streamUpload === true) {
    return { label: t("room.methodLiveStream"), title: `${t("room.methodLiveStream")} · ${rec.streamUploadSpool ? "spool" : "0-disk"}`, tone: "var(--status-fg)", kind: "zero-disk" };
  }
  if (rec.rollingEffective || rec.rollingUpload) {
    return { label: t("room.methodRolling"), title: t("room.methodRolling"), tone: "var(--status-fg)", kind: "segment" };
  }
  return { label: fmt ? `${t("room.methodPlain")} · ${fmt}` : t("room.methodPlain"), title: `${t("room.methodPlain")} · ${format}`, kind: "archive" };
}

function RecordingMethodChip({ room }: { room: RoomDTO }): ReactNode {
  const t = useT();
  const m = recordingMethod(t, room);
  return m ? <MethodBadge m={m} /> : <span className="text-muted-soft">-</span>;
}

function MethodBadge({ m }: { m: Method }): ReactNode {
  return (
    <span className="badge badge-muted text-[10.5px] whitespace-nowrap inline-flex items-center gap-1" title={m.title}
          style={m.tone ? { color: m.tone, borderColor: "var(--hairline)" } : undefined}>
      <ModeLogo kind={m.kind} className="mode-chip-icon" />
      {m.label}
    </span>
  );
}

/** Recording half may be missing (rule-only room); scheduleText wants both endpoints. */
function scheduleOf(r: RoomDTO): Pick<NonNullable<RoomDTO["recording"]>, "scheduleStart" | "scheduleEnd"> {
  return r.recording ?? { scheduleStart: null, scheduleEnd: null };
}

function Empty({ t, empty }: { t: ReturnType<typeof useT>; empty: boolean }): ReactNode {
  return (
    <div className="empty-state">
      <FolderOpen className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
      <div className="text-sm font-medium text-ink">{empty ? t("rooms.empty") : t("rooms.noMatch")}</div>
    </div>
  );
}

/**
 * Action column. **受管 = 只读**(plan §3.3):行本身与日志图标就是查看入口,这里不渲染启停/编辑,
 * 也不留一个 disabled 的按钮假装能点。判定唯一来源是 `useRoomActions`(内部 `roomActionsFor`)。
 */
function RoomActions({ room, data, actions }: {
  room: RoomDTO;
  data: ReturnType<typeof useRoomsData>;
  actions: ReturnType<typeof useRoomActions>;
}): ReactNode {
  const t = useT();
  const task = data.taskOf(room);
  const managed = actions.managedOf(room);
  const enabled = task?.enabled ?? room.recording?.enabled ?? false;
  const taskId = room.recording?.taskId ?? null;
  if (managed) {
    return (
      <div className="inline-flex items-center gap-1.5 justify-end">
        {taskId !== null && (
          <Link className="btn-icon" to={`/rooms/${encodeURIComponent(room.key)}?logs=1`} title={t("room.detail.logs")}><FileText className="w-4 h-4" /></Link>
        )}
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5 justify-end">
      {task ? (
        enabled ? (
          <IconButton title={t("tasks.titleStop")} onClick={() => actions.setEnabled(room, false)}>
            <Square className="w-4 h-4" style={{ color: "var(--warning-fg)" }} fill="currentColor" />
          </IconButton>
        ) : (
          <IconButton title={t("tasks.titleStart")} onClick={() => actions.setEnabled(room, true)}>
            <Play className="w-4 h-4" style={{ color: "var(--success-fg)" }} fill="currentColor" />
          </IconButton>
        )
      ) : null}
      {taskId !== null && (
        <Link className="btn-icon" to={`/rooms/${encodeURIComponent(room.key)}?logs=1`} title={t("room.detail.logs")}><FileText className="w-4 h-4" /></Link>
      )}
      <IconButton title={t("room.detail.edit")} onClick={() => actions.edit(room)}><Pencil className="w-4 h-4" /></IconButton>
    </div>
  );
}

function RoomCompactRow({ room, data, actions, now, master }: {
  now: number;
  room: RoomDTO;
  data: ReturnType<typeof useRoomsData>;
  actions: ReturnType<typeof useRoomActions>;
  master: boolean;
}): ReactNode {
  const t = useT();
  const s = data.statusOf(room);
  const sched = scheduleText(scheduleOf(room));
  return (
    <div className="task-compact px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/rooms/${encodeURIComponent(room.key)}`} className="min-w-0 group" title={room.room}>
          <div className="font-medium text-ink truncate group-hover:underline">{roomName(room)}</div>
          <div className="mt-1 flex items-center gap-1.5 min-w-0">
            <span className="badge badge-muted shrink-0 !h-[18px] !px-1.5 !text-[10px] uppercase">
              {room.platform}
            </span>
            <span className="font-mono text-xs text-muted truncate">{roomDisplayId(room)}</span>
          </div>
        </Link>
        <RoomActions room={room} data={data} actions={actions} />
      </div>
      <div className="mt-2 max-w-full flex items-center gap-2 min-w-0">
        <RoomBadge s={s} />
        <span className="text-[12px] text-muted truncate">{statusDetail(t, room, s)}</span>
      </div>
      {master && <div className="mt-2"><DeliveryCell s={s} now={now} /></div>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {master ? <ModeIndicators room={room} /> : <RecordingMethodChip room={room} />}
        {sched && <span className="font-mono text-[11px] text-muted-soft tabular-nums">{sched}</span>}
        {master && <span className="font-mono text-[11px] text-muted-soft truncate">{nodesText(room, data.workers, t("room.allNodes"))}</span>}
      </div>
    </div>
  );
}
