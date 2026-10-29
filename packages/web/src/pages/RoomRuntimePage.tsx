/**
 * RoomRuntimePage — read-only `/rooms/:key/runtime`, the trial "responsibility tree" view (issue #398).
 *
 * The existing `/rooms/:key` detail page is intentionally left untouched: this page is a copy-style
 * preview the user can compare against it and only replace later once it is accepted. It reuses the
 * same room data hook, so both pages cannot drift on what "recording" means.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { useAtomValue } from "jotai";
import { api, type QueueItemDTO, type TaskDetail, type WorkerStatus } from "../api/client";
import { serverTimezoneAtom } from "../atoms";
import { RuntimeTree } from "../components/RuntimeTree";
import { useRoomRolling } from "../components/RollingProgress";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fmtStartedAt, platformLabel, roomId, roomName } from "../lib/labels";
import { buildRuntimeTree } from "../lib/runtime-tree";
import type { LiveDetailEntry } from "../lib/zero-disk-status";
import { RoomBadge, useRoomsData } from "./rooms/shared";

export function RoomRuntimePage(): ReactNode {
  const t = useT();
  const { key = "" } = useParams();
  const data = useRoomsData();
  const room = data.rooms.find((r) => r.key === key);
  const task = room ? data.taskOf(room) : undefined;
  const status = room ? data.statusOf(room) : null;
  const taskId = room?.recording?.taskId ?? null;
  const live = status?.kind === "recording";

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const taskRef = useRef(taskId);
  usePolling(() => {
    if (taskId === null || !live) return;
    const id = taskId;
    void api.getTask(id).then((d) => { if (taskRef.current === id) setDetail(d); }).catch(() => {});
  }, 5_000, live);
  useEffect(() => { taskRef.current = taskId; setDetail(null); }, [taskId]);
  useEffect(() => { if (!live) setDetail(null); }, [live]);

  const [liveEntries, setLiveEntries] = useState<LiveDetailEntry[]>([]);
  const liveRef = useRef(taskId);
  const streamUpload = !!task?.streamUpload;
  useEffect(() => { liveRef.current = taskId; setLiveEntries([]); }, [taskId]);
  usePolling(() => {
    if (taskId === null || !streamUpload) return;
    const id = taskId;
    void api.getTaskLive(id).then((r) => { if (liveRef.current === id) setLiveEntries(r.entries); }).catch(() => {});
  }, 10_000, streamUpload && taskId !== null);

  const [workerStatus, setWorkerStatus] = useState<WorkerStatus[]>([]);
  usePolling(() => void api.getWorkersStatus().then(setWorkerStatus).catch(() => {}), 60_000);

  const [queueItem, setQueueItem] = useState<QueueItemDTO | null>(null);
  const queueRoom = useRef<{ platform: string; roomSlug: string } | null>(null);
  useEffect(() => {
    queueRoom.current = room ? { platform: room.platform, roomSlug: room.roomSlug } : null;
  }, [room?.platform, room?.roomSlug]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setQueueItem(null); }, [key]);
  usePolling(() => {
    const target = queueRoom.current;
    if (!target) return;
    void api.getHubQueue({ q: target.roomSlug }).then((q) => {
      // Only in-flight rows: `rows` also carries finished runs whose winner/BV are history, not the current run.
      const found = q.active.find((i) => i.platform === target.platform && i.roomSlug === target.roomSlug) ?? null;
      if (queueRoom.current === target) setQueueItem(found);
    }).catch(() => { if (queueRoom.current === target) setQueueItem(null); });
  }, 15_000, !!room);

  const rolling = useRoomRolling(room ? room.roomSlug : null);
  const serverTz = useAtomValue(serverTimezoneAtom);
  const model = useMemo(() => room && status
    ? buildRuntimeTree({
      room,
      task,
      detail,
      workers: data.workers,
      workerStatus,
      rolling,
      queueItem,
      live: liveEntries,
      run: status.run ?? null,
    })
    : null, [room, status, task, detail, data.workers, workerStatus, rolling, queueItem, liveEntries]);

  if (!data.loaded) return <div className="skeleton h-40 w-full" aria-hidden="true" />;
  if (!room || !status || !model) {
    return (
      <div className="empty-state">
        <div className="text-sm font-medium text-ink">{t("room.detail.notFound")}</div>
        <Link className="btn-secondary btn-sm" to="/rooms">{t("room.detail.back")}</Link>
      </div>
    );
  }

  return (
    <>
      <Link to={`/rooms/${encodeURIComponent(room.key)}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink transition-colors mb-5">
        <ChevronLeft className="w-4 h-4" />
        {t("room.runtime.backToDetail")}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="headline text-[26px] sm:text-[30px] leading-tight break-all">{roomName(room)}</h1>
            <RoomBadge s={status} />
            <span className="badge badge-muted">{t("room.runtime.preview")}</span>
          </div>
          <p className="text-sm mt-1.5 text-muted">{t("room.runtime.subtitle")}</p>
        </div>
      </div>

      <RuntimeTree
        model={model}
        roomName={roomName(room)}
        anchorName={room.recording?.anchorName ?? null}
        platform={platformLabel(room.platform)}
        roomId={roomId(room.room)}
        startedAt={model.startedAt ? fmtStartedAt(model.startedAt, serverTz) : "-"}
        bvHref={(bv) => `https://www.bilibili.com/video/${bv}`}
      />
    </>
  );
}
