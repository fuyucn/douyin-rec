/**
 * RoomsPage — **统一房间页**(T20 第 1 步:并存版)。
 *
 * 为什么有它:实测 13/14 个房间都要在「任务页」与「Hub 页」各配一份 ——
 * 录制在任务页、处理在 Hub 页,改一个房间要来回切。本页把两半合到一处。
 *
 * **结构刻意对齐 Tasks 页(用户反馈「Tasks 页更清晰」)**:
 *   - 桌面用语义化表格 `<table className="tasks">`(thead 列名 + 行 hover);
 *   - 窄屏(lg 以下)用卡片堆叠(与 TaskList 的 TaskCompactRow 同思路);
 *   - 标签-值对齐用既有排版,不手写 div 拼布局。
 * 这样与全站观感一致,而不是本页自创一套。
 *
 * 定位:**并存版,不退役旧页**;也**不进主导航**(用户要求先自己 UAT)。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Pencil, RefreshCw } from "lucide-react";
import { api, type RoomDTO } from "../api/client";
import { Button, IconButton } from "../components/Button";
import { Badge } from "../components/Badge";
import { useHubStream, usePolling, errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { roomId, qualityLabel } from "../lib/labels";
import { RoomEditPanel } from "../modals/RoomEditPanel";

export function RoomsPage(): ReactNode {
  const t = useT();
  const toast = useToast();
  const [rooms, setRooms] = useState<RoomDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<RoomDTO | null>(null);
  const [q, setQ] = useState("");

  const refresh = async (): Promise<void> => {
    try {
      setRooms(await api.listRooms());
    } finally {
      setLoaded(true);
    }
  };
  // 推送驱动(与队列页同款);推送不可用自动退化为有界退避轮询。
  useHubStream(refresh);
  usePolling(() => void refresh().catch(() => {}), 30_000);

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return rooms;
    return rooms.filter((r) =>
      [r.key, r.room, r.roomSlug, r.recording?.name ?? "", r.recording?.anchorName ?? ""]
        .some((x) => x.toLowerCase().includes(k)),
    );
  }, [rooms, q]);

  return (
    <div className="page">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("rooms.title")}</h1>
          <p className="text-muted text-[13px] mt-1">{t("rooms.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <input className="input w-44 sm:w-52" placeholder={t("rooms.searchPlaceholder")}
                 value={q} onChange={(e) => setQ(e.target.value)} />
          <IconButton title={t("rooms.refresh")} onClick={() => void refresh().catch((e) => toast(errMessage(e), "error"))}>
            <RefreshCw className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      {!loaded ? (
        <div className="card p-10 text-center text-muted text-sm">{t("rooms.loading")}</div>
      ) : filtered.length === 0 ? (
        <div className="card p-10 text-center text-muted text-sm">
          {rooms.length === 0 ? t("rooms.empty") : t("rooms.noMatch")}
        </div>
      ) : (
        <>
          {/* 窄屏(<lg):卡片堆叠 —— 表格在窄屏会把列挤爆(TaskList 同款取舍) */}
          <div className="lg:hidden space-y-3">
            {filtered.map((r) => <RoomCard key={r.key} room={r} onEdit={() => setEditing(r)} />)}
          </div>

          {/* 桌面(>=lg):语义化表格 —— 与 Tasks 页同一套视觉 */}
          <div className="hidden lg:block min-w-0 overflow-x-auto">
            <table className="tasks">
              <thead>
                <tr>
                  <th>{t("rooms.colRoom")}</th>
                  <th className="w-[110px]">{t("rooms.colRecording")}</th>
                  <th>{t("rooms.colPipeline")}</th>
                  <th className="w-[240px]">{t("rooms.colNodes")}</th>
                  <th className="w-[104px] text-right">{t("rooms.colAction")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => <RoomRow key={r.key} room={r} onEdit={() => setEditing(r)} />)}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && (
        <RoomEditPanel open room={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void refresh().catch(() => {}); }} />
      )}
    </div>
  );
}

/** 处理管线摘要(纯展示;可写入口只有编辑面板 —— 避免两处可写)。 */
function pipelineBits(t: ReturnType<typeof useT>, r: RoomDTO): string[] {
  const p = r.processing;
  if (!p) return [];
  const steps = p.pipeline?.steps ?? {};
  const up = p.pipeline?.upload ?? {};
  const out: string[] = [];
  if (steps.mergeSegments !== false) out.push(t("rooms.stepMerge"));
  if (steps.burnDanmu) out.push(t("rooms.stepBurnDanmu"));
  if (steps.burnLivechat) out.push(t("rooms.stepBurnLivechat"));
  if (steps.nodeSideUpload) out.push(t("rooms.stepNodeUpload"));
  out.push(up.mode === "upload"
    ? (up.private === false ? t("rooms.stepUploadPublic") : t("rooms.stepUploadPrivate"))
    : t("rooms.stepStageOnly"));
  return out;
}

/** 名称单元(表格与卡片共用):主播名/任务名 + 房间号 + 平台。 */
function RoomName({ room }: { room: RoomDTO }): ReactNode {
  const rec = room.recording;
  const name = rec?.name || rec?.anchorName;
  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-ink truncate">{name || roomId(room.room)}</span>
        <Badge tone="badge-muted">{room.platform}</Badge>
      </div>
      <div className="font-mono text-xs text-muted mt-0.5 truncate" title={room.room}>{roomId(room.room)}</div>
    </>
  );
}

/** 录制状态徽章(录制开/关 / 无录制任务)。 */
function RecBadge({ room }: { room: RoomDTO }): ReactNode {
  const t = useT();
  const rec = room.recording;
  if (!rec) return <Badge tone="badge-muted">{t("rooms.noRecording")}</Badge>;
  return <Badge tone={rec.enabled ? "badge-success" : "badge-neutral"}>{rec.enabled ? t("rooms.recOn") : t("rooms.recOff")}</Badge>;
}

/** 处理状态徽章(处理开/关 / 无规则)。 */
function ProcBadge({ room }: { room: RoomDTO }): ReactNode {
  const t = useT();
  const p = room.processing;
  if (!p) return <Badge tone="badge-muted">{t("rooms.noProcessing")}</Badge>;
  return <Badge tone={p.enabled ? "badge-success" : "badge-neutral"}>{p.enabled ? t("rooms.procOn") : t("rooms.procOff")}</Badge>;
}

/** 桌面表格行。 */
function RoomRow({ room, onEdit }: { room: RoomDTO; onEdit: () => void }): ReactNode {
  const t = useT();
  const rec = room.recording;
  const bits = pipelineBits(t, room);
  const workers = room.processing?.workers;

  return (
    <tr>
      <td>
        {rec ? (
          <Link to={`/task/${rec.taskId}`} className="group block min-w-0 cursor-pointer">
            <RoomName room={room} />
          </Link>
        ) : (
          <div className="min-w-0"><RoomName room={room} /></div>
        )}
      </td>
      <td>
        <div className="flex flex-col gap-1 items-start">
          <RecBadge room={room} />
          {rec && <span className="font-mono text-[11px] text-muted-soft">{qualityLabel(rec.quality)} · {rec.segmentSec}s</span>}
        </div>
      </td>
      <td>
        <div className="flex flex-col gap-1 items-start min-w-0">
          <ProcBadge room={room} />
          <span className="text-xs text-muted truncate max-w-full" title={bits.join(" → ")}>{bits.join(" → ")}</span>
        </div>
      </td>
      <td className="font-mono text-xs text-muted">
        {workers && workers.length > 0 ? workers.join(", ") : t("rooms.allNodes")}
      </td>
      <td className="text-right">
        <Button small variant="secondary" onClick={onEdit}>
          <Pencil className="w-3.5 h-3.5" />
          {t("rooms.edit")}
        </Button>
      </td>
    </tr>
  );
}

/** 窄屏卡片(表格在窄屏放不下;信息与表格一致,只是换排版)。 */
function RoomCard({ room, onEdit }: { room: RoomDTO; onEdit: () => void }): ReactNode {
  const t = useT();
  const rec = room.recording;
  const bits = pipelineBits(t, room);
  const workers = room.processing?.workers;

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><RoomName room={room} /></div>
        <Button small variant="secondary" onClick={onEdit}><Pencil className="w-3.5 h-3.5" />{t("rooms.edit")}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <RecBadge room={room} />
        <ProcBadge room={room} />
        {rec && <span className="font-mono text-[11px] text-muted-soft">{qualityLabel(rec.quality)} · {rec.segmentSec}s</span>}
      </div>
      {bits.length > 0 && (
        <p className="text-xs text-muted mt-2 break-words">{bits.join(" → ")}</p>
      )}
      <p className="font-mono text-[11px] text-muted-soft mt-2 break-all">
        {t("rooms.nodes")}: {workers && workers.length > 0 ? workers.join(", ") : t("rooms.allNodes")}
      </p>
    </div>
  );
}
