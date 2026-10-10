/**
 * RoomsPage — **统一房间页**(T20 第 1 步:并存版)。
 *
 * 为什么有它:实测 13/14 个房间都要在「任务页」与「Hub 页」各配一份 ——
 * 录制(画质/分段/弹幕/窗口/cookie)在任务页、处理(烧录/上传/清理/节点)在 Hub 页,
 * 改一个房间要来回切。本页把两半合到一处:一屏看全,一个弹窗改全。
 *
 * 定位:**并存版,不退役旧页**(旧页与路由一律不动)。新页确认好用后再谈退役。
 * 因此本页也**不加主导航入口** —— 直接访问 `/rooms` 即可,不打扰现有用户习惯。
 *
 * 数据:走 T9 的 `/api/rooms` 聚合视图 + `PUT /api/rooms/:key`(一次写两半、失败回滚)。
 * 渲染:**不引入新视觉语言** —— 复用现有 badge/button/card 类与 i18n 命名空间。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Pencil, RefreshCw } from "lucide-react";
import { api, type RoomDTO } from "../api/client";
import { api as _api } from "../api/client";
import { Button, IconButton } from "../components/Button";
import { Badge, Dot } from "../components/Badge";
import { useHubStream, usePolling, errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { roomId, qualityLabel } from "../lib/labels";
import { RoomEditPanel } from "../modals/RoomEditPanel";

void _api; // (保持 import 形状与其它页面一致)

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
  // 推送驱动(与队列页同款):台账变化即重拉;不可用自动退化为有界退避轮询。
  useHubStream(refresh);
  // 兜底:即便推送断了也定期对齐一次(与其它页一致的兜底节奏)。
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
          <h1 className="headline text-[22px] sm:text-[24px] leading-tight">{t("rooms.title")}</h1>
          <p className="text-muted text-[13px] mt-1">{t("rooms.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="input w-52"
            placeholder={t("rooms.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
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
        <div className="space-y-2">
          {filtered.map((r) => (
            <RoomCard key={r.key} room={r} onEdit={() => setEditing(r)} />
          ))}
        </div>
      )}

      {editing && (
        <RoomEditPanel
          open
          room={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void refresh().catch(() => {}); }}
        />
      )}
    </div>
  );
}

/** 一个房间一张卡:录制 + 处理 + 状态一屏读完,右侧一个「编辑」入口。 */
function RoomCard({ room, onEdit }: { room: RoomDTO; onEdit: () => void }): ReactNode {
  const t = useT();
  const rec = room.recording;
  const proc = room.processing;
  const name = rec?.name || rec?.anchorName || roomId(room.room);
  const steps = proc?.pipeline?.steps ?? {};
  const upload = proc?.pipeline?.upload ?? {};

  // 处理步骤摘要(与 Hub 页同一套语义,但只读展示,不放控件 —— 避免两处可写)。
  const procBits: string[] = [];
  if (proc) {
    if (steps.mergeSegments !== false) procBits.push(t("rooms.stepMerge"));
    if (steps.burnDanmu) procBits.push(t("rooms.stepBurnDanmu"));
    if (steps.burnLivechat) procBits.push(t("rooms.stepBurnLivechat"));
    if (steps.nodeSideUpload) procBits.push(t("rooms.stepNodeUpload"));
    procBits.push(upload.mode === "upload" ? (upload.private === false ? t("rooms.stepUploadPublic") : t("rooms.stepUploadPrivate")) : t("rooms.stepStageOnly"));
  }

  return (
    <div className="card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-ink truncate max-w-full">{name}</span>
            <Badge tone="badge-muted">{room.platform}</Badge>
            {/* 录制开关(用户意图)—— 与 Hub 的「处理开关」是两件事,这里分别用独立标记,不混用 */}
            {rec
              ? <Badge tone={rec.enabled ? "badge-success" : "badge-neutral"}>{rec.enabled ? t("rooms.recOn") : t("rooms.recOff")}</Badge>
              : <Badge tone="badge-muted">{t("rooms.noRecording")}</Badge>}
            {proc
              ? <Badge tone={proc.enabled ? "badge-success" : "badge-neutral"}>{proc.enabled ? t("rooms.procOn") : t("rooms.procOff")}</Badge>
              : <Badge tone="badge-muted">{t("rooms.noProcessing")}</Badge>}
          </div>
          <div className="font-mono text-[11px] text-muted-soft mt-1 truncate" title={room.room}>{room.room}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0 self-start">
          {rec && (
            <Link to={`/task/${rec.taskId}`} className="btn-icon" title={t("rooms.openTaskDetail")}>
              <Dot color={rec.enabled ? "var(--success)" : "var(--muted-soft)"} />
            </Link>
          )}
          <Button small variant="secondary" onClick={onEdit}>
            <Pencil className="w-3.5 h-3.5" />
            {t("rooms.edit")}
          </Button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-[12px]">
        <div className="min-w-0">
          <div className="section-label mb-1.5">{t("rooms.recordingSection")}</div>
          {rec ? (
            <div className="space-y-1 text-[12px]">
              <div className="flex gap-2 min-w-0">
                <span className="text-muted-soft shrink-0 w-14">{t("rooms.quality")}</span>
                <span className="text-body truncate">{qualityLabel(rec.quality)} · {rec.engine} · {rec.segmentSec}s</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted-soft shrink-0 w-14">{t("rooms.danmu")}</span>
                <span className="text-body">{rec.danmu ? t("rooms.danmuOn") : t("rooms.danmuOff")}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted-soft shrink-0 w-14">{t("rooms.schedule")}</span>
                <span className="text-body">{rec.scheduleStart && rec.scheduleEnd ? `${rec.scheduleStart}-${rec.scheduleEnd}` : t("rooms.allDay")}</span>
              </div>
            </div>
          ) : (
            <div className="text-muted text-[12px]">{t("rooms.noRecordingHint")}</div>
          )}
        </div>
        <div className="min-w-0">
          <div className="section-label mb-1.5">{t("rooms.processingSection")}</div>
          {proc ? (
            <div className="space-y-1 text-[12px]">
              <div className="flex gap-2 min-w-0">
                <span className="text-muted-soft shrink-0 w-14">{t("rooms.pipeline")}</span>
                <span className="text-body truncate" title={procBits.join(" → ")}>{procBits.join(" → ")}</span>
              </div>
              <div className="flex gap-2 min-w-0">
                <span className="text-muted-soft shrink-0 w-14">{t("rooms.nodes")}</span>
                <span className="text-body truncate">{proc.workers && proc.workers.length > 0 ? proc.workers.join(", ") : t("rooms.allNodes")}</span>
              </div>
            </div>
          ) : (
            <div className="text-muted text-[12px]">{t("rooms.noProcessingHint")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
