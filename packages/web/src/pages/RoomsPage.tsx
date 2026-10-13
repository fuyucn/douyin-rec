/**
 * RoomsPage — **统一房间页**(T20 第 1 步:并存版)。
 *
 * 为什么有它:实测 13/14 个房间都要在「任务页」与「Hub 页」各配一份 ——
 * 录制在任务页、处理在 Hub 页,改一个房间要来回切。本页把两半合到一处。
 *
 * **结构照抄 Tasks 页(用户两次反馈「不如 tasks 内好看」)**。上一版只把「表格」当成
 * Tasks 页的全部,漏了它真正撑起观感的一整套外壳,于是 15 行裸 `<tr>` 漂在背景上,
 * 看着就是「没做完」:
 *   - `table-shell` 容器(描边 + 圆角 + 裁切)—— 行必须落在这个壳里,不是裸表;
 *   - `telemetry-bar` 指标带(总数/录制中/…),给页面一个「仪表盘」的开场;
 *   - 表头列 + `chip`/`Badge`/`StatusBadge` 等既有控件,不自造徽章;
 *   - 加载态用 **skeleton 行**(不是「加载中…」卡片),空态用 `empty-state`;
 *   - 窄屏用 `task-compact` 紧凑行(Tasks 页同款),不是自拼 card。
 * 差别在于**信息**:房间 = 录制(任务)+ 处理(hub 规则)两半,所以列比 Tasks 多两列。
 *
 * 运行态(running/recording)不在 RoomDTO 里,故按 `recording.taskId` 去 `/api/tasks`
 * 认领对应任务 —— 复用 Tasks 页同一个 `StatusBadge`,而不是在这里另写一套判定。
 *
 * 定位:**并存版,不退役旧页**;也**不进主导航**(用户要求先自己 UAT)。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  FileText,
  FolderOpen,
  History,
  LayoutGrid,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Timer,
  Trash2,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { api, type RoomDTO, type Task, type WorkerDTO } from "../api/client";
import { IconButton } from "../components/Button";
import { Badge, DanmuBadge, StatusBadge } from "../components/Badge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { Button } from "../components/Button";
import { CreateEditTaskDialog } from "../modals/CreateEditTaskDialog";
import { RoomRunsDrawer } from "../components/RoomRunsPanel";
import { useHubStream, usePolling, errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { QUALITY_SHORT, qualityLabel, roomId, scheduleText } from "../lib/labels";
import { RoomEditPanel } from "../modals/RoomEditPanel";

export function RoomsPage(): ReactNode {
  const t = useT();
  const toast = useToast();
  const [rooms, setRooms] = useState<RoomDTO[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<RoomDTO | null>(null);
  /** 待确认的破坏性动作(硬停会截断当前分段 → 必须二次确认)。 */
  const [confirm, setConfirm] = useState<{ kind: "stop" | "delete"; room: RoomDTO } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  /** 打开运行态抽屉的房间(workflow / 运行记录 / 日志 / 重跑)。 */
  const [runsRoom, setRunsRoom] = useState<RoomDTO | null>(null);
  const [q, setQ] = useState("");

  const refresh = async (): Promise<void> => {
    try {
      setRooms(await api.listRooms());
    } finally {
      // 首拉失败也要结束 loading(否则永远停在骨架屏)——失败本身仍向上抛,
      // 由 useHubStream 置 stale → 顶部显示「数据可能已过期」。
      setLoaded(true);
    }
  };
  // 推送驱动(与队列页同款);推送不可用自动退化为有界退避轮询。
  const stream = useHubStream(refresh);
  usePolling(() => void refresh().catch(() => {}), 30_000);

  // 运行态:RoomDTO 不带 running/recording,按 taskId 认领 StatusBadge 需要的字段。
  // 5s:与「录制中」这个结论的时效性相称(任务页 2s,但这里整页只有一张表)。
  usePolling(
    () => void api.listTasks().then(setTasks).catch(() => {}),
    5_000,
  );
  // worker 名单:独立慢速兜底(5 分钟),失败静默(名字本就回落成 id)。
  usePolling(
    () => void api.listWorkers().then(setWorkers).catch(() => {}),
    300_000,
  );

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const workerName = useMemo(
    () => new Map(workers.map((w) => [w.id, w.name || w.id])),
    [workers],
  );

  // ── 行内动作(启停/排空/删除)──────────────────────────────────────────────
  // 复用 Tasks 页同一批 API(不是另写一套):/rooms 要能**替代**任务页日常操作。
  const sourceTaskIdOf = (r: RoomDTO): number | null => r.recording?.taskId ?? null;
  const runTaskAction = async (
    r: RoomDTO,
    action: "start" | "stop" | "drain",
  ): Promise<void> => {
    const id = sourceTaskIdOf(r);
    if (id === null) return;
    try {
      if (action === "start") await api.startTask(id);
      else if (action === "drain") await api.drainTask(id);
      else await api.stopTask(id);
      await refresh().catch(() => {});
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };
  const doDeleteRoom = async (r: RoomDTO): Promise<void> => {
    setConfirm(null);
    try {
      // 删除录制任务(后端两阶段处理 hub 绑定;纯规则房间没有 task 时跳过)。
      const id = sourceTaskIdOf(r);
      if (id !== null) await api.deleteTask(id);
      await refresh().catch(() => {});
      toast(t("rooms.deleted"), "info");
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return rooms;
    return rooms.filter((r) =>
      [r.key, r.room, r.roomSlug, r.recording?.name ?? "", r.recording?.anchorName ?? ""]
        .some((x) => x.toLowerCase().includes(k)),
    );
  }, [rooms, q]);

  // 指标带口径与 Tasks 页对齐:总数 / 录制中 / 待命(启用但未录) / 需注意(错误)。
  const recording = rooms.filter((r) => {
    const task = r.recording ? taskById.get(r.recording.taskId ?? -1) : undefined;
    if (!task?.enabled) return false;
    return (
      task.recordingWorkers?.some((w) => w.state === "recording") ||
      (task.running && task.recording !== false)
    );
  }).length;
  const waiting = rooms.filter((r) => {
    const task = r.recording ? taskById.get(r.recording.taskId ?? -1) : undefined;
    return (
      !!task?.enabled &&
      !task.running &&
      task.status !== "error" &&
      !task.recordingWorkers?.some((w) => w.state === "recording" || w.state === "unavailable")
    );
  }).length;
  const attention = rooms.filter((r) => {
    const task = r.recording ? taskById.get(r.recording.taskId ?? -1) : undefined;
    return task?.status === "error" || task?.recordingWorkers?.some((w) => w.state === "unavailable");
  }).length;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 mb-6">
        <div className="min-w-0 max-w-full">
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("rooms.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("rooms.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="relative">
            <Search
              className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: "var(--muted-soft)" }}
            />
            <input
              className="input !pl-8 w-44 sm:w-56"
              placeholder={t("rooms.searchPlaceholder")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <IconButton
            title={t("rooms.refresh")}
            onClick={() => void refresh().catch((e) => toast(errMessage(e), "error"))}
          >
            <RefreshCw className="w-4 h-4" />
          </IconButton>
          {/* 新建房间 = 新建录制任务(房间由任务派生);处理半边保存后再配。复用既有任务弹窗。 */}
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4" />
            {t("rooms.addRoom")}
          </Button>
        </div>
      </div>

      <HubStreamBanner handle={stream} />

      <div className="telemetry-bar mb-5">
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("rooms.metricTotal")}</span>
            <span className="telemetry-value tabular-nums">{rooms.length}</span>
          </div>
          <span className="telemetry-icon"><LayoutGrid className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("rooms.metricRecording")}</span>
            <span className="telemetry-value tabular-nums" style={{ color: "var(--success-fg)" }}>{recording}</span>
          </div>
          <span className="telemetry-icon" style={{ color: "var(--success-fg)" }}><Activity className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("rooms.metricWaiting")}</span>
            <span className="telemetry-value tabular-nums">{waiting}</span>
          </div>
          <span className="telemetry-icon"><Workflow className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("rooms.metricAttention")}</span>
            <span
              className="telemetry-value tabular-nums"
              style={{ color: attention ? "var(--error-fg)" : "var(--muted-soft)" }}
            >
              {attention}
            </span>
          </div>
          <span className="telemetry-icon" style={attention ? { color: "var(--error-fg)" } : undefined}>
            <TriangleAlert className="w-4 h-4" />
          </span>
        </div>
      </div>

      <section className="table-shell">
        {/* 窄屏(<lg):紧凑行堆叠 —— 8 列在窄屏会把列挤爆(Tasks 页同款取舍) */}
        <div className="lg:hidden">
          {!loaded &&
            [0, 1, 2].map((i) => (
              <div key={i} className="task-compact px-4 py-3.5" aria-hidden="true">
                <span className="skeleton block h-4 w-40 max-w-full" />
                <span className="skeleton block h-3 w-28 max-w-full mt-2" />
                <span className="skeleton block h-5 w-36 max-w-full mt-2" />
              </div>
            ))}
          {loaded && filtered.length === 0 && (
            <div className="empty-state">
              <FolderOpen className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
              <div className="text-sm font-medium text-ink">
                {rooms.length === 0 ? t("rooms.empty") : t("rooms.noMatch")}
              </div>
            </div>
          )}
          {loaded &&
            filtered.map((r) => (
              <RoomCompactRow
                key={r.key}
                room={r}
                task={r.recording ? taskById.get(r.recording.taskId ?? -1) : undefined}
                workerName={workerName}
                onEdit={() => setEditing(r)}
                onAction={(a) => (a === "delete" ? setConfirm({ kind: "delete", room: r }) : a === "stop" ? setConfirm({ kind: "stop", room: r }) : void runTaskAction(r, a))}
                onShowRuns={() => setRunsRoom(r)}
              />
            ))}
        </div>

        <div className="hidden lg:block min-w-0 overflow-x-auto">
          <table className="tasks">
            <thead>
              <tr>
                <th className="w-12">ID</th>
                <th>{t("rooms.colRoom")}</th>
                <th className="w-[78px]">{t("rooms.colQuality")}</th>
                <th className="w-[104px]">{t("rooms.colDanmu")}</th>
                <th className="w-[104px]">{t("rooms.colSchedule")}</th>
                <th className="w-[176px]">{t("rooms.colStatus")}</th>
                <th>{t("rooms.colPipeline")}</th>
                <th className="w-[196px] text-right">{t("rooms.colAction")}</th>
              </tr>
            </thead>
            <tbody>
              {!loaded &&
                [0, 1, 2].map((i) => (
                  <tr key={i} aria-hidden="true">
                    <td><span className="skeleton block h-4 w-8" /></td>
                    <td>
                      <span className="skeleton block h-4 w-40 max-w-full" />
                      <span className="skeleton block h-3 w-28 max-w-full mt-2" />
                    </td>
                    <td><span className="skeleton block h-4 w-12" /></td>
                    <td><span className="skeleton block h-4 w-16" /></td>
                    <td><span className="skeleton block h-4 w-20" /></td>
                    <td><span className="skeleton block h-4 w-24" /></td>
                    <td><span className="skeleton block h-4 w-32 max-w-full" /></td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        <span className="skeleton block h-8 w-8" />
                      </div>
                    </td>
                  </tr>
                ))}
              {loaded && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-0">
                    <div className="empty-state">
                      <FolderOpen className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
                      <div className="text-sm font-medium text-ink">
                        {rooms.length === 0 ? t("rooms.empty") : t("rooms.noMatch")}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              {loaded &&
                filtered.map((r) => (
                  <RoomRow
                    key={r.key}
                    room={r}
                    task={r.recording ? taskById.get(r.recording.taskId ?? -1) : undefined}
                    workerName={workerName}
                    onEdit={() => setEditing(r)}
                    onAction={(a) => (a === "delete" ? setConfirm({ kind: "delete", room: r }) : a === "stop" ? setConfirm({ kind: "stop", room: r }) : void runTaskAction(r, a))}
                    onShowRuns={() => setRunsRoom(r)}
                  />
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 运行态抽屉:该房间的 workflow 流程图 + 运行记录 + 日志 + 重跑。 */}
      {runsRoom && (
        <RoomRunsDrawer
          room={runsRoom}
          workers={workers}
          onClose={() => setRunsRoom(null)}
          onEdit={() => { setEditing(runsRoom); }}
        />
      )}

      {editing && (
        <RoomEditPanel
          open
          room={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh().catch(() => {});
          }}
        />
      )}

      {/* 破坏性动作二次确认(硬停截断当前分段 / 删除任务) */}
      <CreateEditTaskDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        task={null}
        onSaved={() => {
          setCreateOpen(false);
          void refresh().catch(() => {});
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "delete"
            ? t("rooms.deleteConfirm", { name: roomLabel(confirm.room) })
            : t("rooms.stopConfirm", { name: confirm ? roomLabel(confirm.room) : "" })
        }
        confirmLabel={confirm?.kind === "delete" ? t("common.delete") : t("rooms.stopNow")}
        destructive
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "delete") void doDeleteRoom(confirm.room);
          else {
            const r = confirm.room;
            setConfirm(null);
            void runTaskAction(r, "stop");
          }
        }}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

/** 房间显示名(确认框用):任务名 > 主播名 > 房间号。 */
function roomLabel(r: RoomDTO): string {
  return r.recording?.name || r.recording?.anchorName || roomId(r.room);
}

/** 处理管线摘要(纯展示;可写入口只有编辑面板 —— 避免两处可写)。 */
function pipelineBits(t: ReturnType<typeof useT>, r: RoomDTO): string[] {
  const p = r.processing;
  if (!p) return [];
  const steps = p.pipeline?.steps ?? {};
  const up = p.pipeline?.upload ?? {};
  const out: string[] = [];
  if (steps.mergeSegments !== false) out.push(t("rooms.stepMerge"));
  // 烧录缺省 = 开(同后端 burnFlags 口径)。
  if (steps.burnDanmu !== false) out.push(t("rooms.stepBurnDanmu"));
  if (steps.burnLivechat !== false) out.push(t("rooms.stepBurnLivechat"));
  if (steps.nodeSideUpload) out.push(t("rooms.stepNodeUpload"));
  out.push(
    up.mode === "upload" || up.mode === "rolling"
      ? up.private === false
        ? t("rooms.stepUploadPublic")
        : t("rooms.stepUploadPrivate")
      : t("rooms.stepStageOnly"),
  );
  return out;
}

/** 房间名 + 房间号 + 平台(表格与紧凑行共用,避免两份字段语义漂移)。 */
function RoomName({ room }: { room: RoomDTO }): ReactNode {
  const rec = room.recording;
  const name = rec?.name || rec?.anchorName;
  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-ink truncate">{name || roomId(room.room)}</span>
        <span className="badge badge-muted shrink-0">{room.platform}</span>
      </div>
      {/* `break-all`(而不是 `truncate`):非抖音房间这里显示的是完整 URL,B 站 URL 是
          **无空格长 token** —— 用 nowrap 会让该列的 min-content 等于整串 URL,8 列表格
          被顶出外壳、右侧操作列被裁。允许在 token 内断行,列宽才压得回来。 */}
      <div className="font-mono text-xs text-muted mt-0.5 break-all" title={room.room}>
        {roomId(room.room)}
      </div>
    </>
  );
}

/** 录制状态:有任务且认领到 → 与 Tasks 页同一个 StatusBadge;否则回落「无录制任务」。 */
function RecStatus({ room, task }: { room: RoomDTO; task?: Task }): ReactNode {
  const t = useT();
  if (task) {
    return (
      <StatusBadge
        running={task.running}
        status={task.status}
        enabled={task.enabled}
        recording={task.recording}
        recordingWorkers={task.recordingWorkers}
      />
    );
  }
  const rec = room.recording;
  if (!rec) return <Badge tone="badge-muted">{t("rooms.noRecording")}</Badge>;
  // 任务列表还没到(或该任务已被删):至少把「意图」表达出来,不留空。
  return (
    <Badge tone={rec.enabled ? "badge-success" : "badge-neutral"}>
      {rec.enabled ? t("rooms.recOn") : t("rooms.recOff")}
    </Badge>
  );
}

/** 处理状态徽章(处理开/关 / 无规则)。 */
function ProcStatus({ room }: { room: RoomDTO }): ReactNode {
  const t = useT();
  const p = room.processing;
  if (!p) return <Badge tone="badge-muted">{t("rooms.noProcessing")}</Badge>;
  return (
    <Badge tone={p.enabled ? "badge-success" : "badge-neutral"}>
      {p.enabled ? t("rooms.procOn") : t("rooms.procOff")}
    </Badge>
  );
}

/** 参与节点:worker id → 友好名(查不到回落 id);空 = 全部节点。 */
function nodesText(room: RoomDTO, workerName: Map<string, string>, all: string): string {
  const ids = room.processing?.workers;
  if (!ids || ids.length === 0) return all;
  return ids.map((id) => workerName.get(id) ?? id).join(", ");
}

/** 行内动作回调:start/drain 直接执行;stop/delete 由父级弹二次确认。 */
type RowAction = (a: "start" | "stop" | "drain" | "delete") => void;

/**
 * 行内动作按钮组(表格行与紧凑行共用)。
 *
 * 与 Tasks 页同一套规则:enabled → 显示「停」;未启用 → 显示「启」;
 * 另加「排空」(当前场录完自然收播,不截断)。受管(hub 远端)任务只读 → 禁用并说明。
 */
function RowActions({
  room,
  task,
  onAction,
  onEdit,
  onShowRuns,
}: {
  room: RoomDTO;
  task?: Task;
  onAction: RowAction;
  onEdit: () => void;
  onShowRuns: () => void;
}): ReactNode {
  const t = useT();
  const managed = task?.managedBy === "hub";
  const enabled = task?.enabled ?? room.recording?.enabled ?? false;
  if (!room.recording) {
    // 纯规则房间:没有录制任务可启停,只留「编辑」(处理半边仍可配)。
    return (
      <div className="inline-flex items-center gap-1.5 justify-end">
        <IconButton title={t("rooms.runsHeading")} onClick={onShowRuns}>
          <History className="w-4 h-4" />
        </IconButton>
        <IconButton title={t("rooms.edit")} onClick={onEdit}>
          <Pencil className="w-4 h-4" />
        </IconButton>
      </div>
    );
  }
  const tip = (fallback: string): string => (managed ? t("tasks.managedHint") : fallback);
  return (
    <div className="inline-flex items-center gap-1.5 justify-end">
      {enabled ? (
        <IconButton title={tip(t("rooms.actionStop"))} disabled={managed} onClick={() => onAction("stop")}>
          <Square className="w-4 h-4" style={{ color: "var(--warning-fg)" }} fill="currentColor" />
        </IconButton>
      ) : (
        <IconButton title={tip(t("rooms.actionStart"))} disabled={managed} onClick={() => onAction("start")}>
          <Play className="w-4 h-4" style={{ color: "var(--success-fg)" }} fill="currentColor" />
        </IconButton>
      )}
      <IconButton title={tip(t("rooms.actionDrain"))} disabled={managed || !enabled} onClick={() => onAction("drain")}>
        <Timer className="w-4 h-4" />
      </IconButton>
      {/* 运行态:该房间的 workflow 流程图 / 运行记录 / 日志 / 重跑(复用 Hub 的 RunCard)。 */}
      <IconButton title={t("rooms.runsHeading")} onClick={onShowRuns}>
        <History className="w-4 h-4" />
      </IconButton>
      {room.recording.taskId != null && (
        <Link className="btn-icon" to={`/task/${room.recording.taskId}`} title={t("tasks.titleDetail")}>
          <FileText className="w-4 h-4" />
        </Link>
      )}
      <IconButton title={t("rooms.edit")} onClick={onEdit}>
        <Pencil className="w-4 h-4" />
      </IconButton>
      {!managed && (
        <IconButton title={t("common.delete")} style={{ color: "var(--error-fg)" }} onClick={() => onAction("delete")}>
          <Trash2 className="w-4 h-4" />
        </IconButton>
      )}
    </div>
  );
}

/** 桌面表格行。 */
function RoomRow({
  room,
  task,
  workerName,
  onEdit,
  onAction,
  onShowRuns,
}: {
  room: RoomDTO;
  task?: Task;
  workerName: Map<string, string>;
  onEdit: () => void;
  onAction: RowAction;
  onShowRuns: () => void;
}): ReactNode {
  const t = useT();
  const rec = room.recording;
  const bits = pipelineBits(t, room);
  const schedule = rec ? scheduleText(rec) : null;

  return (
    <tr>
      <td className="font-mono text-muted-soft">{rec?.taskId ?? "-"}</td>
      <td>
        {rec?.taskId != null ? (
          <Link to={`/task/${rec.taskId}`} className="group block min-w-0 cursor-pointer">
            <RoomName room={room} />
          </Link>
        ) : (
          <div className="min-w-0"><RoomName room={room} /></div>
        )}
      </td>
      <td>
        {rec ? (
          <span className="chip">{QUALITY_SHORT[rec.quality] ?? qualityLabel(rec.quality)}</span>
        ) : (
          <span className="text-muted-soft">-</span>
        )}
      </td>
      <td>
        {rec ? (
          <DanmuBadge task={{ danmu: rec.danmu, useCookie: rec.useCookie }} />
        ) : (
          <span className="text-muted-soft">-</span>
        )}
      </td>
      <td>
        {schedule ? (
          <span className="font-mono text-[12.5px] text-body tabular-nums whitespace-nowrap">{schedule}</span>
        ) : (
          <span className="text-muted-soft whitespace-nowrap">{t("rooms.allDay")}</span>
        )}
      </td>
      <td>
        <RecStatus room={room} task={task} />
      </td>
      <td>
        <div className="flex flex-col gap-1 items-start min-w-0">
          <ProcStatus room={room} />
          {bits.length > 0 && (
            <span className="text-xs text-muted break-words" title={bits.join(" → ")}>
              {bits.join(" → ")}
            </span>
          )}
          {/* 节点名(id / 友好名)是**无空格长 token**,`truncate` 不生效:它会把列的
              min-content 宽度撑到整串 id,整表溢出、右侧操作列被裁掉(实测 1209 > 1150)。
              `break-all` 允许在 token 内断行,把列宽压回来。 */}
          <span className="font-mono text-[11px] text-muted-soft max-w-full break-all" title={nodesText(room, workerName, t("rooms.allNodes"))}>
            {nodesText(room, workerName, t("rooms.allNodes"))}
          </span>
        </div>
      </td>
      <td className="text-right whitespace-nowrap">
        <RowActions room={room} task={task} onAction={onAction} onEdit={onEdit} onShowRuns={onShowRuns} />
      </td>
    </tr>
  );
}

/** 窄屏紧凑行(Tasks 页 `task-compact` 同款;信息与表格一致,只换排版)。 */
function RoomCompactRow({
  room,
  task,
  workerName,
  onEdit,
  onAction,
  onShowRuns,
}: {
  room: RoomDTO;
  task?: Task;
  workerName: Map<string, string>;
  onEdit: () => void;
  onAction: RowAction;
  onShowRuns: () => void;
}): ReactNode {
  const t = useT();
  const rec = room.recording;
  const bits = pipelineBits(t, room);
  const schedule = rec ? scheduleText(rec) : null;

  return (
    <div className="task-compact px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        {rec?.taskId != null ? (
          <Link to={`/task/${rec.taskId}`} className="min-w-0 group">
            <RoomName room={room} />
          </Link>
        ) : (
          <div className="min-w-0"><RoomName room={room} /></div>
        )}
      </div>
      <div className="mt-2 max-w-full">
        <RecStatus room={room} task={task} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {rec && <span className="chip !h-5 !text-[10px]">{QUALITY_SHORT[rec.quality] ?? qualityLabel(rec.quality)}</span>}
        {rec && <DanmuBadge task={{ danmu: rec.danmu, useCookie: rec.useCookie }} />}
        <span className="font-mono text-[11px] text-muted-soft tabular-nums">
          {schedule ?? t("rooms.allDay")}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <ProcStatus room={room} />
        {bits.length > 0 && <span className="text-xs text-muted break-words">{bits.join(" → ")}</span>}
      </div>
      <p className="font-mono text-[11px] text-muted-soft mt-2 break-all">
        {t("rooms.nodes")}: {nodesText(room, workerName, t("rooms.allNodes"))}
      </p>
      {/* 动作条(与桌面表格同一组按钮):窄屏也要能启停/排空/编辑,否则手机上做不了事 */}
      <div className="mt-2.5 flex justify-end">
        <RowActions room={room} task={task} onAction={onAction} onEdit={onEdit} onShowRuns={onShowRuns} />
      </div>
    </div>
  );
}
