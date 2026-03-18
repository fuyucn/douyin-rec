"""任务管理器 — DB 持久化 + 多任务并发执行"""

from __future__ import annotations

import logging
import os
import queue
import re
import random
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field, replace as dc_replace
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import text as sa_text
from sqlmodel import Session, SQLModel, create_engine, select

import asyncio

from src.config import load_config
from src.danmu.client import DouyinDanmakuClient
from src.danmu.models import SimpleDanmaku, StreamEndSignal
from src.danmu.xml_writer import XmlWriter
from src.dlr_launcher import DlrLauncher
from src.input.live import DouyinLiveSource
from src.storage.database import LocalVideoTask, RecordingSession, RecordingTask
from src.storage.manager import StorageManager

logger = logging.getLogger(__name__)

DEFAULT_OUTPUT_DIR = "./output"


def _install_thread_excepthook() -> None:
    """将未捕获的线程异常记录到 logger（含完整 traceback），便于事后排查线程死亡原因。"""
    _orig = threading.excepthook

    def _hook(args: threading.ExceptHookArgs) -> None:
        if args.exc_type is SystemExit:
            _orig(args)
            return
        logger.error(
            "线程 %s 异常退出:",
            args.thread.name if args.thread else "unknown",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )
        _orig(args)

    threading.excepthook = _hook


_install_thread_excepthook()


@dataclass
class TaskWorker:
    """单个任务的运行时状态"""

    thread: threading.Thread | None = None
    stop_event: threading.Event = field(default_factory=threading.Event)
    preview_frame: bytes | None = None
    preview_lock: threading.Lock = field(default_factory=threading.Lock)
    stream_url: str | None = None
    status_text: str = ""
    recording_started_at: datetime | None = None
    active_session_id: int | None = None
    log_file: "Path | None" = None       # 服务器日志（全量）
    rec_log_file: "Path | None" = None   # 录制日志（仅录制相关，与 TS 文件同目录）
    # 当前活跃的子组件引用，供 stop_task() 直接停止
    launcher: "DlrLauncher | None" = None
    danmu_worker: "_DanmuWorker | None" = None


@dataclass
class LocalVideoWorker:
    """本地视频任务的运行时状态"""

    thread: threading.Thread | None = None
    stop_event: threading.Event = field(default_factory=threading.Event)


class _DanmuWorker:
    """在 daemon thread 里跑 asyncio，与 DLR 子进程同生共死"""

    def __init__(
        self,
        url: str,
        ass_base: Path,     # 不含扩展名的基路径，如 recording_dir / "瑶瑶_session"
        cookies: str | None,
        cdn_delay: int,
        log_fn,
        segment_sec: int = 0,
        anchor_name: str = '',
    ) -> None:
        self._url = url
        self._ass_base = ass_base
        self._cookies = cookies
        self._cdn_delay = cdn_delay
        self._log = log_fn
        self._segment_sec = segment_sec
        self._anchor_name = anchor_name
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        # DLR 开始写入文件时调用 sync_start()，用于对齐文件名时间戳和 seg_start
        self._sync_event = threading.Event()
        self._sync_ts: str = ""
        self._sync_wall_time: float = 0.0  # sync_start() 被调用的精确时刻

    def sync_start(self, ts_override: str | None = None) -> None:
        """DLR 日志出现"准备开始录制视频"时调用。
        ts_override：强制使用指定时间戳字符串（外部崩溃重启时，保持与原 TS 文件一致）。"""
        if not self._sync_event.is_set():
            self._sync_wall_time = time.time()
            self._sync_ts = ts_override or datetime.fromtimestamp(self._sync_wall_time).strftime("%Y-%m-%d_%H-%M-%S")
            self._sync_event.set()

    def _seg_path(self, ts: str, idx: int, ext: str = '.xml') -> Path:
        """生成弹幕文件路径：{base}_{ts}[_{idx:03d}]{ext}（0-based 索引与 DLR 一致）"""
        if self._segment_sec <= 0:
            return self._ass_base.parent / f"{self._ass_base.name}_{ts}{ext}"
        return self._ass_base.parent / f"{self._ass_base.name}_{ts}_{idx:03d}{ext}"

    def _item_time(self, item: SimpleDanmaku, seg_start: float) -> float:
        """计算弹幕相对于分段起始的时间（秒）。
        使用 ChatMessage.eventTime（服务端 Unix 秒时间戳），对齐方式参考 biliLive-tools DouYinDanma：
        progress = eventTime - recordStart（自然补偿 CDN 延迟，无需手动调参）。"""
        return item.timestamp - seg_start

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._thread_main, daemon=True, name=f"danmu-{id(self)}"
        )
        self._thread.start()

    def is_alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def stop(self) -> None:
        self._stop_event.set()
        # 如果还在等待 sync，直接触发让 asyncio 退出等待
        self._sync_event.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

    def _thread_main(self) -> None:
        try:
            asyncio.run(self._async_main())
        except Exception as e:
            logger.exception("弹幕线程异常退出 (%s):", self._url)
            self._log(f"[弹幕] 线程异常: {type(e).__name__}: {e}")

    async def _async_main(self) -> None:
        import re as _re
        self._ass_base.parent.mkdir(parents=True, exist_ok=True)
        _m = _re.search(r'live\.douyin\.com/(\d+)', self._url)
        _room_id = _m.group(1) if _m else ''

        # 以下状态在 WS 断线重连时保持不变 —— 这是避免孤立 XML 的关键
        pre_buffer: list[SimpleDanmaku] = []
        seg_idx = 0
        seg_start = 0.0
        open_ts = ""
        writer_opened = False
        xml_writer = XmlWriter()
        q: asyncio.Queue = asyncio.Queue()  # 每次重连前刷新

        def _open_writer() -> None:
            nonlocal seg_start, open_ts, writer_opened
            seg_start = self._sync_wall_time if self._sync_wall_time > 0 else time.time()
            open_ts = self._sync_ts or datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            xml_writer.open(self._seg_path(open_ts, seg_idx, '.xml'), seg_start, open_ts, seg_idx,
                            user_name=self._anchor_name, room_id=_room_id)
            self._log(f"[弹幕] 开始录制 → {self._seg_path(open_ts, seg_idx, '.xml').name}")
            # 回放缓冲区（eventTime 对齐）
            for buffered in pre_buffer:
                buffered.time = self._item_time(buffered, seg_start)
                xml_writer.add(buffered)
            pre_buffer.clear()
            writer_opened = True

        async def consume() -> None:
            nonlocal seg_idx, seg_start, open_ts, writer_opened
            while not self._stop_event.is_set():
                try:
                    item = await asyncio.wait_for(q.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    # 超时期间检查 sync 是否触发
                    if not writer_opened and self._sync_event.is_set():
                        _open_writer()
                    continue
                if isinstance(item, StreamEndSignal):
                    self._log("[弹幕] 收到下播信号")
                    continue
                if not isinstance(item, SimpleDanmaku):
                    continue

                if not writer_opened:
                    if self._sync_event.is_set():
                        _open_writer()
                        # fall through：写当前条目
                    else:
                        pre_buffer.append(item)
                        continue

                # 分段边界（按挂钟时间，与 DLR 分段逻辑一致）
                now = time.time()
                if self._segment_sec > 0 and (now - seg_start) >= self._segment_sec:
                    xml_writer.close()
                    seg_idx += 1
                    seg_start = now
                    xml_writer.open(self._seg_path(open_ts, seg_idx, '.xml'), seg_start, open_ts, seg_idx,
                            user_name=self._anchor_name, room_id=_room_id)
                    self._log(f"[弹幕] 新分段 → {self._seg_path(open_ts, seg_idx, '.xml').name}")

                item.time = self._item_time(item, seg_start)
                xml_writer.add(item)

        # 内部 WS 重连循环：断线后保持 seg_idx/xml_writer 状态，避免孤立 XML
        _ws_reconnect_count = 0
        while not self._stop_event.is_set():
            if _ws_reconnect_count > 0:
                delay = min(5 * _ws_reconnect_count, 60)
                self._log(f"[弹幕] {delay}s 后第 {_ws_reconnect_count} 次重连...")
                for _ in range(delay):
                    if self._stop_event.is_set():
                        break
                    await asyncio.sleep(1)
                if self._stop_event.is_set():
                    break
            q = asyncio.Queue()  # 刷新队列，丢弃旧连接残留
            client = DouyinDanmakuClient(self._url, q, self._cookies)
            self._log("[弹幕] 正在连接 WebSocket...")
            try:
                await asyncio.gather(client.start(), consume())
                break  # stop_event 触发正常退出
            except Exception as e:
                if not self._stop_event.is_set():
                    self._log(f"[弹幕] 连接中断: {type(e).__name__}: {e}")
                    _ws_reconnect_count += 1
            finally:
                await client.stop()

        xml_writer.close()
        self._log("[弹幕] 录制结束（线程退出）")


# 本地任务日志 ID 偏移，避免与录制任务 ID 冲突
LOCAL_ID_OFFSET = 1_000_000


def task_dir_name(task_id: int, anchor_name: str | None) -> str:
    """返回任务输出子目录名：task{id}_{主播名}（特殊字符去掉）"""
    safe = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]", "", anchor_name or "")
    return f"task{task_id}_{safe}" if safe else f"task{task_id}"


class TaskManager:
    """集中管理任务 DB 操作和运行状态"""

    def __init__(
        self,
        output_dir: str = DEFAULT_OUTPUT_DIR,
        *,
        db_path: str | None = None,
    ) -> None:
        self._config = load_config()
        self._output_dir = Path(output_dir)
        self._output_dir.mkdir(parents=True, exist_ok=True)
        db = Path(db_path) if db_path else self._output_dir / "tasks.db"
        db.parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(f"sqlite:///{db}")
        SQLModel.metadata.create_all(self.engine)
        self._migrate_db()
        self._workers: dict[int, TaskWorker] = {}  # task_id → worker
        self._local_workers: dict[int, LocalVideoWorker] = {}  # local task_id → worker
        self._preview_task_id: int | None = None  # 当前预览的任务 ID
        self._lock = threading.Lock()
        # 串行化 ffmpeg 启动：防止多任务同时初始化导致竞争
        self._ffmpeg_start_lock = threading.Lock()
        self._log_queues: list[tuple[queue.Queue, int | None]] = []  # (queue, task_id_filter)
        self._logs_dir = self._output_dir / "logs"
        self._logs_dir.mkdir(parents=True, exist_ok=True)

        # 启动时处理上次遗留的孤儿录制会话，再恢复任务状态
        self._kill_orphan_dlr_processes()
        self._handle_orphan_sessions()
        self._recover_running_tasks()
        self._recover_running_local_tasks()

    def _kill_orphan_dlr_processes(self) -> None:
        """启动时清理上次遗留的 DLR 子进程（匹配 tmpdir 路径 dlr_task{N}_）。
        用 killpg 杀整个进程组，确保 DLR 启动的 ffmpeg 子进程也被清理。"""
        try:
            result = subprocess.run(
                ['pgrep', '-f', r'dlr_task[0-9]+_'],
                capture_output=True, text=True,
            )
            pids = [int(p) for p in result.stdout.split() if p.strip().isdigit()]
            if not pids:
                return
            logger.info("清理遗留 DLR 进程组: %s", pids)
            pgids: set[int] = set()
            for pid in pids:
                try:
                    pgids.add(os.getpgid(pid))
                except ProcessLookupError:
                    pass
            for pgid in pgids:
                try:
                    os.killpg(pgid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            time.sleep(1)
            for pgid in pgids:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        except Exception as e:
            logger.warning("清理遗留 DLR 进程失败: %s", e)

    def _migrate_db(self) -> None:
        """为旧 DB 补充缺失的列"""
        migrations = [
            ("enable_segment", "BOOLEAN NOT NULL DEFAULT 1"),
            ("segment_sec", "INTEGER NOT NULL DEFAULT 1800"),
            ("poll_interval", "INTEGER NOT NULL DEFAULT 180"),
            ("show_countdown", "BOOLEAN NOT NULL DEFAULT 1"),
            ("max_threads", "INTEGER NOT NULL DEFAULT 3"),
            ("schedule_enabled", "BOOLEAN NOT NULL DEFAULT 0"),
            ("schedule_timezone", "TEXT NOT NULL DEFAULT 'America/Los_Angeles'"),
            ("schedule_start", "TEXT NOT NULL DEFAULT '00:00'"),
            ("schedule_stop", "TEXT NOT NULL DEFAULT '23:59'"),
            ("schedule_run_until_end", "BOOLEAN NOT NULL DEFAULT 0"),
            ("started_at", "DATETIME"),
            ("custom_name", "TEXT"),
            ("enable_danmu", "BOOLEAN NOT NULL DEFAULT 0"),
            ("danmu_cdn_delay", "INTEGER NOT NULL DEFAULT 6"),
            ("danmu_merge_types", "TEXT NOT NULL DEFAULT 'danmaku,gift'"),
            ("danmu_burn_min_vbitrate", "INTEGER NOT NULL DEFAULT 2166"),
            ("auto_quality_fallback", "BOOLEAN NOT NULL DEFAULT 0"),
            ("stream_title", "TEXT"),
            ("stream_resolution", "TEXT"),
            ("stream_fps", "INTEGER"),
            ("stream_vbitrate", "INTEGER"),
            ("stream_vcodec", "TEXT"),
            ("stream_encoder", "TEXT"),
        ]
        local_migrations = [
            ("ai_backend", "TEXT"),
        ]
        with self.engine.connect() as conn:
            for col, col_def in migrations:
                try:
                    conn.execute(
                        sa_text(
                            f"ALTER TABLE recordingtask ADD COLUMN {col} {col_def}"
                        )
                    )
                    conn.commit()
                except Exception:
                    pass  # 列已存在，跳过
            for col, col_def in local_migrations:
                try:
                    conn.execute(
                        sa_text(
                            f"ALTER TABLE localvideotask ADD COLUMN {col} {col_def}"
                        )
                    )
                    conn.commit()
                except Exception:
                    pass  # 列已存在，跳过

    def _handle_orphan_sessions(self) -> None:
        """服务器重启时处理上次未关闭的录制会话"""
        with Session(self.engine) as db:
            orphans = list(db.exec(
                select(RecordingSession).where(RecordingSession.status == "active")
            ).all())
        for s in orphans:
            alive = self._pid_is_ffmpeg(s.ffmpeg_pid)
            with Session(self.engine) as db:
                sess = db.get(RecordingSession, s.id)
                if alive:
                    sess.status = "orphan"
                    db.add(sess)
                    db.commit()
                    t = threading.Thread(
                        target=self._orphan_monitor,
                        args=(s.id, s.ffmpeg_pid, s.task_id),
                        daemon=True,
                        name=f"orphan-{s.ffmpeg_pid}",
                    )
                    t.start()
                else:
                    sess.status = "stopped"
                    sess.end_reason = "server_restart"
                    sess.ended_at = datetime.now()
                    if sess.started_at:
                        sess.duration_sec = (sess.ended_at - sess.started_at).total_seconds()
                    db.add(sess)
                    db.commit()

    @staticmethod
    def _pid_is_ffmpeg(pid: int) -> bool:
        """检查 PID 是否存活且是 ffmpeg 进程"""
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            return False
        try:
            result = subprocess.run(
                ["ps", "-p", str(pid), "-o", "comm="],
                capture_output=True, text=True, timeout=3,
            )
            return "ffmpeg" in result.stdout.lower()
        except Exception:
            return False

    def _orphan_monitor(self, session_id: int, pid: int, task_id: int) -> None:
        """被动轮询孤儿 PID，进程结束后更新 session 状态"""
        logger.info("[孤儿监控] task=%d pid=%d 开始监控", task_id, pid)
        while True:
            time.sleep(5)
            if not self._pid_is_ffmpeg(pid):
                break
        with Session(self.engine) as db:
            sess = db.get(RecordingSession, session_id)
            if sess and sess.status == "orphan":
                sess.status = "stopped"
                sess.end_reason = "orphan_died"
                sess.ended_at = datetime.now()
                if sess.started_at:
                    sess.duration_sec = (sess.ended_at - sess.started_at).total_seconds()
                db.add(sess)
                db.commit()
        logger.info("[孤儿监控] task=%d pid=%d 进程已结束", task_id, pid)

    def _recover_running_tasks(self) -> None:
        with Session(self.engine) as db:
            orphan_task_ids = set(
                r.task_id for r in db.exec(
                    select(RecordingSession).where(RecordingSession.status == "orphan")
                ).all()
            )
            running = list(db.exec(
                select(RecordingTask).where(RecordingTask.status == "running")
            ).all())
        scheduled_to_restart: list[int] = []
        for t in running:
            if t.id in orphan_task_ids:
                logger.info("task %d 有活跃孤儿进程，跳过状态重置", t.id)
                continue
            with Session(self.engine) as db:
                task = db.get(RecordingTask, t.id)
                task.status = "stopped"
                task.stopped_at = datetime.now()
                db.add(task)
                db.commit()
            if t.schedule_enabled:
                scheduled_to_restart.append(t.id)
        for task_id in scheduled_to_restart:
            try:
                self.start_task(task_id)
                logger.info("task %d 定时任务已自动重启", task_id)
            except Exception as e:
                logger.warning("task %d 定时任务重启失败: %s", task_id, e)

    # ── 日志广播 ─────────────────────────────────────────────────────

    _REC_LOG_KEYWORDS = ('[DLR]', '[弹幕]', '[检测]', '[定时]',
                         '直播标题:', '流信息:', '直播设备:')

    @staticmethod
    def _is_rec_log(msg: str) -> bool:
        return any(kw in msg for kw in TaskManager._REC_LOG_KEYWORDS)

    def broadcast(
        self, msg: str, task_name: str | None = None, task_id: int | None = None,
    ) -> None:
        """向所有 SSE 客户端推送一条日志，同时写入日志文件"""
        ts = datetime.now().strftime("%H:%M:%S")
        prefix = f"[{task_name}] " if task_name else ""
        line = f"[{ts}] {prefix}{msg}"
        logger.info("%s%s", prefix, msg)

        # 写入日志文件
        if task_id is not None:
            try:
                worker = self._workers.get(task_id)
                # 服务器日志：全量
                log_file = worker.log_file if (worker and worker.log_file) else None
                if log_file:
                    log_file.parent.mkdir(parents=True, exist_ok=True)
                    with open(log_file, "a", encoding="utf-8") as f:
                        f.write(line + "\n")
                # 录制日志：仅录制相关消息
                rec_log_file = worker.rec_log_file if (worker and worker.rec_log_file) else None
                if rec_log_file and self._is_rec_log(msg):
                    with open(rec_log_file, "a", encoding="utf-8") as f:
                        f.write(line + "\n")
            except Exception:
                logger.debug("broadcast log write failed", exc_info=True)

        dead: list[tuple[queue.Queue, int | None]] = []
        for q, filter_id in self._log_queues:
            if filter_id is not None and filter_id != task_id:
                continue
            try:
                q.put_nowait(line)
            except queue.Full:
                dead.append((q, filter_id))
        for entry in dead:
            self._log_queues.remove(entry)

    def add_log_queue(self, task_id: int | None = None) -> queue.Queue:
        """创建日志队列。task_id=None 接收全部日志，否则只接收指定任务的日志"""
        q: queue.Queue = queue.Queue(maxsize=500)
        self._log_queues.append((q, task_id))
        return q

    def remove_log_queue(self, q: queue.Queue) -> None:
        self._log_queues = [
            (stored_q, tid) for stored_q, tid in self._log_queues if stored_q is not q
        ]

    def get_task_log_lines(self, task_id: int) -> list[str]:
        """读取任务最新一次启动的历史日志（服务器全量日志）"""
        # 优先使用当前运行 worker 的 log_file
        worker = self._workers.get(task_id)
        if worker and worker.log_file and worker.log_file.exists():
            log_file = worker.log_file
        else:
            # 查找最新的 {ts}_task{id}.log
            candidates = sorted(self._logs_dir.glob(f"*_task{task_id}.log"))
            if not candidates:
                legacy = self._logs_dir / f"task_{task_id}.log"
                if legacy.exists():
                    log_file = legacy
                else:
                    return []
            else:
                log_file = candidates[-1]
        try:
            return log_file.read_text(encoding="utf-8").splitlines()
        except Exception:
            return []

    # ── CRUD ─────────────────────────────────────────────────────────

    def create_task(
        self,
        url: str,
        name: str | None = None,
        quality: str = "origin",
        segment_min: int = 30,
        enable_record: bool = True,
        enable_screenshot: bool = False,
        cookies: str | None = None,
        enable_segment: bool = True,
        segment_sec: int = 1800,
        poll_interval: int = 180,
        show_countdown: bool = True,
        max_threads: int = 3,
        schedule_enabled: bool = False,
        schedule_timezone: str = "America/Los_Angeles",
        schedule_start: str = "00:00",
        schedule_stop: str = "23:59",
        schedule_run_until_end: bool = False,
        custom_name: str | None = None,
        enable_danmu: bool = False,
        danmu_cdn_delay: int = 6,
        danmu_merge_types: str = "danmaku,gift",
        danmu_burn_min_vbitrate: int = 2166,
        auto_quality_fallback: bool = False,
    ) -> RecordingTask:
        task = RecordingTask(
            url=url,
            name=name,
            quality=quality,
            segment_min=segment_min,
            enable_record=enable_record,
            enable_screenshot=enable_screenshot,
            cookies=cookies,
            enable_segment=enable_segment,
            segment_sec=segment_sec,
            poll_interval=poll_interval,
            show_countdown=show_countdown,
            max_threads=max_threads,
            schedule_enabled=schedule_enabled,
            schedule_timezone=schedule_timezone,
            schedule_start=schedule_start,
            schedule_stop=schedule_stop,
            schedule_run_until_end=schedule_run_until_end,
            custom_name=custom_name,
            enable_danmu=enable_danmu,
            danmu_cdn_delay=danmu_cdn_delay,
            danmu_merge_types=danmu_merge_types,
            danmu_burn_min_vbitrate=danmu_burn_min_vbitrate,
            auto_quality_fallback=auto_quality_fallback,
        )
        with Session(self.engine) as session:
            session.add(task)
            session.commit()
            session.refresh(task)
        return task

    def list_tasks(self) -> list[RecordingTask]:
        with Session(self.engine) as session:
            stmt = select(RecordingTask).order_by(RecordingTask.id)
            return list(session.exec(stmt).all())

    def get_task(self, task_id: int) -> RecordingTask | None:
        with Session(self.engine) as session:
            return session.get(RecordingTask, task_id)

    def delete_task(self, task_id: int) -> bool:
        with Session(self.engine) as session:
            task = session.get(RecordingTask, task_id)
            if task is None:
                return False
            if task.status == "running":
                return False  # 不能删除运行中的任务
            session.delete(task)
            session.commit()
            return True

    def _update_task_status(
        self,
        task_id: int,
        status: str,
        error_msg: str | None = None,
    ) -> None:
        with Session(self.engine) as session:
            task = session.get(RecordingTask, task_id)
            if task is None:
                return
            task.status = status
            task.error_msg = error_msg
            if status == "running":
                task.started_at = datetime.now()
            if status == "stopped":
                task.stopped_at = datetime.now()
            session.add(task)
            session.commit()

    def _update_task_name(self, task_id: int, name: str) -> None:
        with Session(self.engine) as session:
            task = session.get(RecordingTask, task_id)
            if task is None:
                return
            task.name = name
            session.add(task)
            session.commit()

    # ── 执行控制 ─────────────────────────────────────────────────────

    def start_task(self, task_id: int) -> None:
        """启动指定任务的 worker 线程"""
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"任务 {task_id} 不存在")
        if task.status == "running":
            raise ValueError(f"任务 {task_id} 已在运行")

        with self._lock:
            if task_id in self._workers and self._workers[task_id].thread is not None:
                w = self._workers[task_id]
                if w.thread.is_alive():
                    if w.stop_event.is_set():
                        # stop 已请求但线程尚未退出，等它自然结束（最多 15s）
                        w.thread.join(timeout=15)
                    if w.thread.is_alive():
                        raise ValueError(f"任务 {task_id} 线程仍在运行")

            ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            worker = TaskWorker(
                log_file=self._logs_dir / f"{ts}_task{task_id}.log"
            )
            self._workers[task_id] = worker

        self._update_task_status(task_id, "running")

        thread = threading.Thread(
            target=self._task_worker,
            args=(task_id, worker),
            daemon=True,
            name=f"task-{task_id}",
        )
        worker.thread = thread
        thread.start()

    def stop_task(self, task_id: int) -> None:
        """停止指定任务：主动停子组件 → 更新 DB 状态"""
        with self._lock:
            worker = self._workers.get(task_id)
        if worker is None:
            self._update_task_status(task_id, "stopped")
            return

        # 1. 先通知 worker 线程退出循环
        worker.stop_event.set()

        # 2. 直接停止各子组件（后台线程，不阻塞 API 响应）
        launcher = worker.launcher
        danmu = worker.danmu_worker

        def _do_stop():
            if danmu is not None:
                try:
                    danmu.stop()
                except Exception:
                    pass
            if launcher is not None:
                try:
                    launcher.stop()
                except Exception:
                    pass

        threading.Thread(target=_do_stop, daemon=True,
                         name=f"stop-{task_id}").start()

        # 3. 立即更新 DB，UI 下次轮询即可反映
        self._update_task_status(task_id, "stopped")

    def start_all_pending(self) -> None:
        """启动所有 pending 状态的任务"""
        for task in self.list_tasks():
            if task.status == "pending":
                try:
                    self.start_task(task.id)
                except ValueError:
                    pass

    def stop_all(self) -> None:
        """停止所有运行中的任务"""
        with self._lock:
            worker_ids = list(self._workers.keys())
        for task_id in worker_ids:
            self.stop_task(task_id)

    # ── 预览控制 ─────────────────────────────────────────────────────

    def set_preview(self, task_id: int | None) -> None:
        """切换当前预览的任务 (None 表示关闭预览)"""
        self._preview_task_id = task_id

    def get_preview_task_id(self) -> int | None:
        return self._preview_task_id

    def get_preview_frame(self) -> bytes | None:
        """获取当前预览任务的最新帧"""
        task_id = self._preview_task_id
        if task_id is None:
            return None
        with self._lock:
            worker = self._workers.get(task_id)
        if worker is None:
            return None
        with worker.preview_lock:
            return worker.preview_frame

    # ── 获取运行时状态 ─────────────────────────────────────────────────

    def get_worker_status(self, task_id: int) -> str:
        """获取 worker 的实时状态文本"""
        with self._lock:
            worker = self._workers.get(task_id)
        if worker is None:
            return ""
        return worker.status_text

    def get_worker_recording_started_at(self, task_id: int) -> str | None:
        """获取当前录制开始时间（ISO 格式），未录制时返回 None"""
        with self._lock:
            worker = self._workers.get(task_id)
        if worker is None or worker.recording_started_at is None:
            return None
        return worker.recording_started_at.isoformat()

    # ── 定时调度 ──────────────────────────────────────────────────

    @staticmethod
    def _is_in_schedule(task: RecordingTask) -> bool:
        """判断当前时刻是否在任务的定时窗口内。schedule_enabled=False 时始终返回 True。"""
        if not task.schedule_enabled:
            return True
        try:
            tz = ZoneInfo(task.schedule_timezone)
        except Exception:
            tz = ZoneInfo("America/Los_Angeles")
        now = datetime.now(tz).time()
        start_parts = task.schedule_start.split(":")
        stop_parts = task.schedule_stop.split(":")
        from datetime import time as dt_time
        start = dt_time(int(start_parts[0]), int(start_parts[1]))
        stop = dt_time(int(stop_parts[0]), int(stop_parts[1]))
        if start <= stop:
            # 同日: 例如 09:00 ~ 18:00
            return start <= now <= stop
        else:
            # 跨午夜: 例如 22:00 ~ 03:00
            return now >= start or now <= stop

    @staticmethod
    def _seconds_until_schedule_start(task: RecordingTask) -> float:
        """计算从当前时刻到下一个 schedule_start 的秒数"""
        try:
            tz = ZoneInfo(task.schedule_timezone)
        except Exception:
            tz = ZoneInfo("America/Los_Angeles")
        now = datetime.now(tz)
        start_parts = task.schedule_start.split(":")
        from datetime import time as dt_time
        start_time = dt_time(int(start_parts[0]), int(start_parts[1]))
        # 今天的 start 时间点
        today_start = now.replace(
            hour=start_time.hour, minute=start_time.minute, second=0, microsecond=0,
        )
        if today_start > now:
            return (today_start - now).total_seconds()
        # 明天的 start 时间点
        from datetime import timedelta
        tomorrow_start = today_start + timedelta(days=1)
        return (tomorrow_start - now).total_seconds()

    # ── Worker 线程 ──────────────────────────────────────────────────

    def _task_worker(self, task_id: int, worker: TaskWorker) -> None:
        """单个任务的工作线程：启动 DLR 子进程录制 → 退出后重试"""
        task = self.get_task(task_id)
        if task is None:
            return

        task_name = task.name or f"任务{task_id}"
        # task 级 cookies 优先；为空时 fallback 到 config.yaml input.cookies
        cookies = task.cookies or self._config.input.cookies

        _danmu_ref: list[_DanmuWorker | None] = [None]  # 供 log() 触发 sync_start()
        _ass_base_ref: list[Path | None] = [None]       # 每次 DLR 启动时设置
        _dlr_stream_ended_ref: list[bool] = [False]     # DLR 报告录制结束/出错时置 True → 触发重启
        _dlr_quick_restart_ref: list[bool] = [False]   # 同上，且跳过首次 30s 等待直接查状态
        _dlr_session_ts_ref: list[str | None] = [None]  # 当前 DLR session 的 TS 时间戳（如"2026-03-18_10-33-50"）
        _dlr_recording_active: list[bool] = [False]     # True = DLR ffmpeg 正在写入文件

        def log(msg: str) -> None:
            self.broadcast(msg, task_name=task_name, task_id=task_id)
            # DLR 录制结束或出错（含 rc=-11）→ 标记需要重启 DLR 进程，并尝试快速重连
            if '[DLR]' in msg and ('直播录制出错' in msg or '直播录制完成' in msg):
                _dlr_stream_ended_ref[0] = True
                _dlr_quick_restart_ref[0] = True
                _dlr_recording_active[0] = False
                _dlr_session_ts_ref[0] = None
            # DLR 日志"准备开始录制视频"= ffmpeg 即将写入第一帧
            # → 创建与 TS 文件同名的录制日志（时间戳从路径提取）
            if '[DLR]' in msg and '准备开始录制视频' in msg:
                _dlr_recording_active[0] = True
                m = re.search(r'(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})', msg)
                rec_ts = m.group(1) if m else datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
                _dlr_session_ts_ref[0] = rec_ts  # 记录 session ts，供外部崩溃重建时保持文件名一致
                _rec_display = task.custom_name or task_dir_name(task_id, task_name)
                _rec_dir = self._output_dir.resolve() / "抖音直播" / _rec_display
                _rec_dir.mkdir(parents=True, exist_ok=True)
                worker.rec_log_file = _rec_dir / f"{_rec_display}_{rec_ts}.log"
            # → 此时才开始连接弹幕 WS（避免等待开播期间空连）
            if task.enable_danmu and '准备开始录制视频' in msg and _ass_base_ref[0] is not None:
                dw = _danmu_ref[0]
                if dw is not None and dw.is_alive():
                    dw.sync_start()
                else:
                    new_dw = _DanmuWorker(
                        url=task.url,
                        ass_base=_ass_base_ref[0],
                        cookies=cookies,
                        cdn_delay=task.danmu_cdn_delay,
                        log_fn=log,
                        segment_sec=task.segment_sec if task.enable_segment else 0,
                        anchor_name=task_name,
                    )
                    _danmu_ref[0] = new_dw
                    worker.danmu_worker = new_dw
                    try:
                        new_dw.start()
                        new_dw.sync_start()
                    except Exception as e:
                        self.broadcast(f"[弹幕] 启动失败: {e}", task_name=task_name, task_id=task_id)
                        _danmu_ref[0] = None
                        worker.danmu_worker = None

        # 后台抓取主播名（未设置时存 DB）
        def _fetch_name():
            try:
                from src.input.douyin_spider import get_douyin_stream_data_by_method as get_douyin_stream_data
                data = asyncio.run(get_douyin_stream_data(task.url, cookies=cookies, method=self._config.input.spider_method))
                name = data.get('anchor_name') or ''
                if name and not task.name:
                    self._update_task_name(task_id, name)
                    nonlocal task_name
                    task_name = name
            except Exception as e:
                logger.warning('获取主播名失败: %s', e)
        _fetch_name_thread = threading.Thread(
            target=_fetch_name, daemon=True, name=f"fetch-name-{task_id}"
        )
        _fetch_name_thread.start()
        _fetch_name_thread.join(timeout=10)  # 等主播名获取完再进主循环，避免用"任务N"命名目录

        try:
            log(f"主播名: {task_name}")
            features = []
            if task.enable_record:
                features.append("录制")
            if task.enable_screenshot:
                features.append("截图")
            if task.enable_danmu:
                features.append("弹幕")
            log(f"已启用: {', '.join(features)}")
            log(f"URL: {task.url}")
            log(f"画质: {task.quality} | Cookie: {'有' if cookies else '无'}")

            segment_sec = task.segment_sec if task.enable_segment else 0
            poll_interval = task.poll_interval
            output_dir = str(self._output_dir.resolve())

            log(f"分段: {'开启 (' + str(segment_sec) + 's)' if segment_sec > 0 else '关闭'} | 断流重检间隔: {poll_interval}s")

            while not worker.stop_event.is_set():
                # ── 定时窗口检查 ──
                if task.schedule_enabled and not self._is_in_schedule(task):
                    worker.status_text = "定时等待"
                    wait_secs = self._seconds_until_schedule_start(task)
                    wait_min = int(wait_secs // 60)
                    log(f"[定时] 当前不在窗口 ({task.schedule_start}~{task.schedule_stop})，距开始还有 {wait_min}m{int(wait_secs%60)}s")
                    worker.stop_event.wait(min(wait_secs, 60))
                    continue

                if not task.enable_record:
                    worker.stop_event.wait(poll_interval)
                    continue

                # ── 等待开播（快速轮询，30s 间隔） ──────────────────────────
                LIVE_POLL_INTERVAL = 30
                worker.status_text = "等待开播"
                _poll_count = 0
                _wait_start = time.time()
                log("[检测] 开始轮询开播状态（间隔 30s）...")
                while not worker.stop_event.is_set():
                    _poll_count += 1
                    _elapsed = int(time.time() - _wait_start)
                    try:
                        from src.input.douyin_spider import get_douyin_stream_data_by_method as get_douyin_stream_data
                        log(f"[检测] 第 {_poll_count} 次查询直播状态（已等待 {_elapsed}s）...")
                        data = asyncio.run(get_douyin_stream_data(task.url, cookies=cookies, method=self._config.input.spider_method))
                        status = data.get('status')
                        anchor = data.get('anchor_name', '')
                        title = data.get('title', '')
                        if status == 2:
                            desc = f"{anchor}" + (f" 《{title}》" if title else "")
                            log(f"[检测] ✓ 已开播: {desc}")
                            break
                        else:
                            status_text = {4: "未开播", 3: "直播结束", 2: "直播中"}.get(status, f"status={status}")
                            log(f"[检测] {status_text}，{LIVE_POLL_INTERVAL}s 后重试（第 {_poll_count} 次）")
                    except Exception as e:
                        log(f"[检测] 查询失败: {type(e).__name__}: {e}，{LIVE_POLL_INTERVAL}s 后重试")
                    worker.stop_event.wait(LIVE_POLL_INTERVAL)

                if worker.stop_event.is_set():
                    break

                worker.status_text = "运行中（DLR）"
                _dlr_start_time = time.time()
                _dlr_stream_ended_ref[0] = False   # 每次启动新 DLR 前清标志
                _dlr_quick_restart_ref[0] = False
                display_name = task.custom_name or task_dir_name(task_id, task_name)
                log(f"[DLR] 正在启动录制进程... (输出目录: {display_name})")
                if task.enable_danmu:
                    recording_dir = self._output_dir.resolve() / "抖音直播" / display_name
                    _ass_base_ref[0] = recording_dir / display_name
                launcher = DlrLauncher(
                    task_id=task_id,
                    url=task.url,
                    name=task_name,
                    quality=task.quality,
                    output_dir=output_dir,
                    segment_sec=segment_sec,
                    poll_interval=poll_interval,
                    max_threads=task.max_threads,
                    cookies=cookies,
                    custom_name=display_name,
                    spider_method=self._config.input.spider_method,
                    log_callback=log,
                )
                launcher.start()
                worker.launcher = launcher
                log(f"[DLR] 进程已启动 (PID={launcher._process.pid if launcher._process else '?'})")

                # DLR 启动后，复用已有的开播检测 data，不再重复请求（避免与 DLR 并发触发风控）
                def _log_stream_meta(_data=data):
                    try:
                        import json as _json
                        data = _data
                        title = data.get('title', '')
                        if title:
                            log(f"直播标题: {title}")

                        # 从 stream_url.extra 取分辨率和编码标志
                        extra = data.get('stream_url', {}).get('extra', {})
                        if not extra:
                            return
                        w, h = extra.get('width', 0), extra.get('height', 0)
                        hw_enc = extra.get('hardware_encode', False)
                        h265 = extra.get('h265_enable', False)
                        bytevc1 = extra.get('bytevc1_enable', False)

                        # 从 origin sdk_params 取实际 fps / 码率（extra 经常返回 0）
                        sdk: dict = {}
                        try:
                            lc = data.get('stream_url', {}).get('live_core_sdk_data', {})
                            sd_str = lc.get('pull_data', {}).get('stream_data', '')
                            if sd_str:
                                sd = _json.loads(sd_str)
                                origin_main = sd.get('data', {}).get('origin', {}).get('main', {})
                                sp_raw = origin_main.get('sdk_params', '{}')
                                sdk = _json.loads(sp_raw) if isinstance(sp_raw, str) else sp_raw
                        except Exception:
                            pass

                        vcodec = (sdk.get('VCodec') or data.get('_vcodec', '')).upper()
                        fps = sdk.get('fps') or extra.get('fps', 0)
                        vbitrate = sdk.get('vbitrate', 0)  # bps
                        resolution = sdk.get('resolution', '') or (f"{w}x{h}" if w and h else '')

                        parts = []
                        if resolution:
                            parts.append(resolution)
                        if fps:
                            parts.append(f"{fps}fps")
                        if vbitrate:
                            parts.append(f"码率 {vbitrate//1000}k")
                        codec_flags = []
                        if vcodec:
                            codec_flags.append(vcodec)
                        if hw_enc:
                            codec_flags.append("硬件编码")
                        if h265:
                            codec_flags.append("H265")
                        if bytevc1:
                            codec_flags.append("ByteVC1")
                        if codec_flags:
                            parts.append(' '.join(codec_flags))
                        if parts:
                            log(f"流信息: {' | '.join(parts)}")

                        # 从 FLV 流 onMetaData 读取 Encoder（直播设备/推流软件）
                        # biliLive-tools 同款：bytedmediasdkios=iPhone, bytedmediasdk=Android, obs=OBS
                        encoder_raw = ''
                        try:
                            flv_url = (
                                data.get('_quality_urls', {}).get('origin', {}).get('flv')
                                or data.get('stream_url', {}).get('flv_pull_url', {}).get('ORIGIN', '')
                            )
                            if flv_url:
                                probe = subprocess.run(
                                    [
                                        'ffprobe', '-v', 'quiet',
                                        '-print_format', 'json',
                                        '-show_format',
                                        '-probesize', '65536',
                                        '-analyzeduration', '0',
                                        '-headers', 'User-Agent: Mozilla/5.0\r\n',
                                        flv_url,
                                    ],
                                    capture_output=True, text=True, timeout=15,
                                )
                                if probe.returncode == 0 and probe.stdout:
                                    fmt = _json.loads(probe.stdout).get('format', {})
                                    tags = fmt.get('tags', {})
                                    encoder_raw = tags.get('encoder') or tags.get('Encoder', '')
                                    if encoder_raw:
                                        enc_lower = encoder_raw.lower()
                                        if 'bytedmediasdkios' in enc_lower:
                                            device = 'iOS（iPhone/iPad）'
                                        elif 'bytedmediasdk' in enc_lower:
                                            device = 'Android'
                                        elif 'obs' in enc_lower:
                                            device = 'OBS'
                                        elif 'fmle' in enc_lower or 'flash' in enc_lower:
                                            device = 'Flash Media Encoder'
                                        elif 'xsplit' in enc_lower:
                                            device = 'XSplit'
                                        else:
                                            device = encoder_raw.split(':')[0]
                                        log(f"直播设备: {device}")
                        except subprocess.TimeoutExpired:
                            logger.debug('ffprobe 超时，跳过直播设备检测')
                        except Exception as e:
                            logger.debug('直播设备检测失败: %s', e)

                        # 将原始值持久化到 DB（每次开播覆盖写入）
                        try:
                            with Session(self.engine) as sess:
                                db_task = sess.get(RecordingTask, task_id)
                                if db_task:
                                    if title:
                                        db_task.stream_title = title
                                    if resolution:
                                        db_task.stream_resolution = resolution
                                    if fps:
                                        db_task.stream_fps = int(fps)
                                    if vbitrate:
                                        db_task.stream_vbitrate = int(vbitrate)
                                    if vcodec:
                                        db_task.stream_vcodec = vcodec
                                    if encoder_raw:
                                        db_task.stream_encoder = encoder_raw
                                    sess.add(db_task)
                                    sess.commit()
                        except Exception as e:
                            logger.debug('流元数据写入 DB 失败: %s', e)
                    except Exception as e:
                        logger.debug('获取流元数据失败: %s', e)
                threading.Thread(target=_log_stream_meta, daemon=True,
                                 name=f"stream-meta-{task_id}").start()

                # 弹幕 worker 在"准备开始录制视频"信号触发时由 log() 回调懒启动
                _schedule_end_logged = False
                _heartbeat_last = time.time()
                HEARTBEAT_INTERVAL = 300  # 每 5 分钟输出一次心跳
                try:
                    while not worker.stop_event.is_set() and launcher.is_running:
                        # DLR 录制结束/出错 → 重启 DLR 进程（避免 DLR 内部 rc=-11 重试循环）
                        if _dlr_stream_ended_ref[0]:
                            log("[DLR] 检测到录制结束，终止当前进程并重启...")
                            break

                        # 定时窗口检查
                        if task.schedule_enabled and not self._is_in_schedule(task):
                            if not task.schedule_run_until_end:
                                log(f"[定时] 窗口结束 ({task.schedule_stop})，停止录制")
                                break
                            elif not _schedule_end_logged:
                                log(f"[定时] 窗口结束 ({task.schedule_stop})，等待直播结束后停止...")
                                _schedule_end_logged = True

                        # 周期性心跳（每 5 分钟）
                        now = time.time()
                        if now - _heartbeat_last >= HEARTBEAT_INTERVAL:
                            elapsed = int(now - _dlr_start_time)
                            h, m, s = elapsed // 3600, (elapsed % 3600) // 60, elapsed % 60
                            log(f"[DLR] 录制进行中，已运行 {h:02d}:{m:02d}:{s:02d}")
                            _heartbeat_last = now

                        # 弹幕 worker 线程意外崩溃时重建（正常 WS 断线由内部重连处理，不触发此处）
                        dw = _danmu_ref[0]
                        if dw is not None and not dw.is_alive():
                            _danmu_crash_count = getattr(worker, '_danmu_crash_count', 0) + 1
                            worker._danmu_crash_count = _danmu_crash_count
                            log(f"[弹幕] 线程意外退出，第 {_danmu_crash_count} 次重建...")
                            new_dw = _DanmuWorker(
                                url=task.url,
                                ass_base=_ass_base_ref[0],
                                cookies=cookies,
                                cdn_delay=task.danmu_cdn_delay,
                                log_fn=log,
                                segment_sec=task.segment_sec if task.enable_segment else 0,
                                anchor_name=task_name,
                            )
                            _danmu_ref[0] = new_dw
                            try:
                                new_dw.start()
                                if _dlr_recording_active[0]:
                                    # DLR 正在录制 → 立刻 sync_start()，ts_override 保持文件名与原 session 一致
                                    new_dw.sync_start(ts_override=_dlr_session_ts_ref[0])
                                    log(f"[弹幕] 第 {_danmu_crash_count} 次重建已启动（DLR 录制中，ts={_dlr_session_ts_ref[0]}）")
                                else:
                                    # DLR 尚未开始录制 → 等"准备开始录制视频"信号
                                    log(f"[弹幕] 第 {_danmu_crash_count} 次重建已启动（等待 DLR 信号后开始写入）")
                                worker.danmu_worker = new_dw
                            except Exception as e:
                                log(f"[弹幕] 第 {_danmu_crash_count} 次重建失败: {type(e).__name__}: {e}")
                                _danmu_ref[0] = None
                                worker.danmu_worker = None
                        worker.stop_event.wait(5)
                finally:
                    exit_code = launcher.exit_code
                    elapsed = int(time.time() - _dlr_start_time)
                    h, m, s = elapsed // 3600, (elapsed % 3600) // 60, elapsed % 60
                    log(f"[DLR] 进程结束 — 运行时长 {h:02d}:{m:02d}:{s:02d}，退出码: {exit_code}")
                    launcher.stop()
                    worker.launcher = None
                    dw = _danmu_ref[0]
                    if dw is not None:
                        log("[弹幕] 正在停止弹幕录制...")
                        try:
                            dw.stop()
                            log("[弹幕] 弹幕录制已停止")
                        except Exception as e:
                            log(f"[弹幕] 停止时出错: {e}")
                    worker.danmu_worker = None
                    _danmu_ref[0] = None
                    _ass_base_ref[0] = None
                    _dlr_session_ts_ref[0] = None

                if worker.stop_event.is_set():
                    log("[用户] 停止任务")
                    break

                # 快速重连：DLR 录制出错/完成后立刻查一次状态，在线则跳过轮询直接重启
                if _dlr_quick_restart_ref[0]:
                    _dlr_quick_restart_ref[0] = False
                    log("[检测] 录制中断，立刻检查直播状态...")
                    try:
                        from src.input.douyin_spider import get_douyin_stream_data_by_method as get_douyin_stream_data
                        data = asyncio.run(get_douyin_stream_data(task.url, cookies=cookies, method=self._config.input.spider_method))
                        if data.get('status') == 2:
                            anchor = data.get('anchor_name', '')
                            title = data.get('title', '')
                            desc = f"{anchor}" + (f" 《{title}》" if title else "")
                            log(f"[检测] ✓ 直播仍在线: {desc}，立刻重启 DLR")
                            continue  # 直接跳到外层 while 顶部 → 启动新 DLR
                        else:
                            status_text = {4: "未开播", 3: "直播结束"}.get(data.get('status'), "离线")
                            log(f"[检测] {status_text}，进入轮询等待...")
                    except Exception as e:
                        log(f"[检测] 状态查询失败: {e}，进入轮询等待...")
                else:
                    log("[检测] DLR 已退出，重新进入开播检测...")

        except Exception as e:
            logger.exception("task_worker %d (%s) 异常退出:", task_id, task_name)
            log(f"[系统] 任务出错: {type(e).__name__}: {e}")
            self._update_task_status(task_id, "error", error_msg=str(e))
            return
        finally:
            worker.stream_url = None
            worker.recording_started_at = None
            worker.status_text = ""
            with worker.preview_lock:
                worker.preview_frame = None

        self._update_task_status(task_id, "stopped")
        log("[用户] 任务已停止")

    def _preview_worker(self, worker: TaskWorker) -> None:
        """后台线程：持续读帧排空缓冲，保持最新 JPEG 供 MJPEG 流"""
        import cv2

        cap = None
        current_url = None
        TARGET_FPS = 5
        interval = 1.0 / TARGET_FPS

        while not worker.stop_event.is_set():
            url = worker.stream_url
            if url != current_url:
                if cap is not None:
                    cap.release()
                    cap = None
                current_url = url
                if url:
                    cap = cv2.VideoCapture(url)
                    if cap.isOpened():
                        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    else:
                        cap = None

            if cap is None:
                with worker.preview_lock:
                    worker.preview_frame = None
                if url is None:
                    break  # 流地址被清空，退出预览线程
                time.sleep(1)
                continue

            # 连续 grab 排空缓冲区，只 retrieve 最后一帧
            grabbed = False
            for _ in range(5):
                grabbed = cap.grab()
                if not grabbed:
                    break

            if not grabbed:
                cap.release()
                cap = None
                current_url = None
                with worker.preview_lock:
                    worker.preview_frame = None
                time.sleep(1)
                continue

            ret, frame = cap.retrieve()
            if ret:
                _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 65])
                with worker.preview_lock:
                    worker.preview_frame = buf.tobytes()

            time.sleep(interval)

        if cap is not None:
            cap.release()
        with worker.preview_lock:
            worker.preview_frame = None

    def _screenshot_worker(
        self,
        source: DouyinLiveSource,
        storage: StorageManager,
        worker: TaskWorker,
        task_name: str,
        task_id: int = 0,
    ) -> None:
        """后台截图线程"""
        import cv2
        from src.extract.extractor import FrameExtractor
        from src.filter.pipeline import FilterPipeline

        config = self._config
        pipeline = FilterPipeline(config)
        extractor = FrameExtractor(fps=config.input.extract_fps)

        batch_scores = []
        saved_count = 0

        def log(msg: str) -> None:
            self.broadcast(msg, task_name=task_name, task_id=task_id)

        log("截图功能已启动")
        try:
            for frame_info in extractor.extract_frames(source):
                if worker.stop_event.is_set():
                    break

                score, details = pipeline.process_frame_detailed(frame_info)
                if score is not None:
                    batch_scores.append(score)

                if len(batch_scores) >= 50:
                    top = pipeline.select_top_k(batch_scores, config.aesthetic.top_k)
                    for s in top:
                        storage.save_screenshot(s, category="portrait")
                        saved_count += 1
                    log(f"截图批次保存 {len(top)} 张 (总计: {saved_count})")
                    batch_scores.clear()
        except Exception as e:
            log(f"截图出错: {e}")

        # 保存剩余
        if batch_scores:
            top = pipeline.select_top_k(batch_scores, config.aesthetic.top_k)
            for s in top:
                storage.save_screenshot(s, category="portrait")
                saved_count += 1

        log(f"截图结束，共保存 {saved_count} 张")

    # ── 本地视频任务 ────────────────────────────────────────────────

    def _recover_running_local_tasks(self) -> None:
        with Session(self.engine) as session:
            stmt = select(LocalVideoTask).where(LocalVideoTask.status == "running")
            tasks = list(session.exec(stmt).all())
            for task in tasks:
                task.status = "error"
                task.error_msg = "服务重启，任务中断"
                task.finished_at = datetime.now()
                session.add(task)
            session.commit()

    # ── 本地视频 CRUD ─────────────────────────────────────────────

    def create_local_task(
        self,
        video_path: str,
        task_type: str = "portrait",
        name: str | None = None,
        ai_backend: str | None = None,
    ) -> LocalVideoTask:
        p = Path(video_path)
        if not p.exists():
            raise FileNotFoundError(f"文件不存在: {video_path}")
        if name is None:
            name = p.stem
        task = LocalVideoTask(
            video_path=str(p.resolve()),
            name=name,
            task_type=task_type,
            ai_backend=ai_backend,
        )
        with Session(self.engine) as session:
            session.add(task)
            session.commit()
            session.refresh(task)
        return task

    def list_local_tasks(self) -> list[LocalVideoTask]:
        with Session(self.engine) as session:
            stmt = select(LocalVideoTask).order_by(LocalVideoTask.id)
            return list(session.exec(stmt).all())

    def get_local_task(self, task_id: int) -> LocalVideoTask | None:
        with Session(self.engine) as session:
            return session.get(LocalVideoTask, task_id)

    def delete_local_task(self, task_id: int) -> bool:
        with Session(self.engine) as session:
            task = session.get(LocalVideoTask, task_id)
            if task is None:
                return False
            if task.status == "running":
                return False
            session.delete(task)
            session.commit()
            return True

    def _update_local_task(self, task_id: int, **kwargs: object) -> None:
        with Session(self.engine) as session:
            task = session.get(LocalVideoTask, task_id)
            if task is None:
                return
            for key, value in kwargs.items():
                setattr(task, key, value)
            session.add(task)
            session.commit()

    # ── 本地视频执行控制 ──────────────────────────────────────────

    def start_local_task(self, task_id: int) -> None:
        task = self.get_local_task(task_id)
        if task is None:
            raise ValueError(f"本地任务 {task_id} 不存在")
        if task.status == "running":
            raise ValueError(f"本地任务 {task_id} 已在运行")

        with self._lock:
            if task_id in self._local_workers:
                w = self._local_workers[task_id]
                if w.thread is not None and w.thread.is_alive():
                    raise ValueError(f"本地任务 {task_id} 线程仍在运行")
            worker = LocalVideoWorker()
            self._local_workers[task_id] = worker

        self._update_local_task(task_id, status="running", progress=0.0, progress_text="", error_msg=None, finished_at=None)

        thread = threading.Thread(
            target=self._local_video_worker,
            args=(task_id, worker),
            daemon=True,
            name=f"local-task-{task_id}",
        )
        worker.thread = thread
        thread.start()

    def stop_local_task(self, task_id: int) -> None:
        with self._lock:
            worker = self._local_workers.get(task_id)
        if worker is None:
            self._update_local_task(task_id, status="error", error_msg="用户停止", finished_at=datetime.now())
            return
        worker.stop_event.set()

    # ── 本地视频 Worker ──────────────────────────────────────────

    def _local_video_worker(self, task_id: int, worker: LocalVideoWorker) -> None:
        task = self.get_local_task(task_id)
        if task is None:
            return

        log_id = task_id + LOCAL_ID_OFFSET
        task_name = task.name or f"本地任务{task_id}"

        def log(msg: str) -> None:
            self.broadcast(msg, task_name=task_name, task_id=log_id)

        try:
            log(f"开始处理: {task.video_path} (类型: {task.task_type})")

            if task.task_type == "portrait":
                self._run_portrait(task_id, task, worker, log)
            elif task.task_type == "highlight":
                self._run_highlight(task_id, task, worker, log)
            else:
                raise ValueError(f"未知任务类型: {task.task_type}")

            if worker.stop_event.is_set():
                log("用户停止")
                self._update_local_task(task_id, status="error", error_msg="用户停止", finished_at=datetime.now())
                return

            self._update_local_task(task_id, status="completed", progress=100.0, finished_at=datetime.now())
            log("处理完成")

        except Exception as e:
            log(f"任务出错: {e}")
            self._update_local_task(task_id, status="error", error_msg=str(e), finished_at=datetime.now())

    def _run_portrait(
        self,
        task_id: int,
        task: LocalVideoTask,
        worker: LocalVideoWorker,
        log: object,
    ) -> None:
        from src.extract.extractor import FrameExtractor
        from src.filter.pipeline import FilterPipeline
        from src.input.local import LocalVideoSource

        config = self._config
        pipeline = FilterPipeline(config)
        extractor = FrameExtractor(fps=config.input.extract_fps)

        video_name = Path(task.video_path).stem
        storage = StorageManager(dc_replace(config.storage, output_dir=str(self._output_dir)), name=video_name)

        source = LocalVideoSource(task.video_path)
        source.open()

        total_frames = source.total_frames or 0
        log(f"视频帧数: {total_frames}, FPS: {source.fps:.2f}")

        batch_scores = []
        saved_count = 0
        processed = 0

        try:
            for frame_info in extractor.extract_frames(source):
                if worker.stop_event.is_set():
                    break

                processed += 1
                score, details = pipeline.process_frame_detailed(frame_info)
                if score is not None:
                    batch_scores.append(score)

                if len(batch_scores) >= 50:
                    top = pipeline.select_top_k(batch_scores, config.aesthetic.top_k)
                    for s in top:
                        storage.save_screenshot(s, category="portrait")
                        saved_count += 1
                    log(f"批次保存 {len(top)} 张 (总计: {saved_count})")
                    batch_scores.clear()

                if processed % 20 == 0 and total_frames > 0:
                    progress = min(frame_info.frame_index / total_frames * 100, 99.0)
                    self._update_local_task(
                        task_id,
                        progress=progress,
                        progress_text=f"帧处理: {frame_info.frame_index}/{total_frames}",
                    )
        finally:
            source.close()

        # 保存剩余
        if batch_scores and not worker.stop_event.is_set():
            top = pipeline.select_top_k(batch_scores, config.aesthetic.top_k)
            for s in top:
                storage.save_screenshot(s, category="portrait")
                saved_count += 1

        summary = f"保存 {saved_count} 张照片"
        self._update_local_task(task_id, result_summary=summary, progress_text=summary)
        log(summary)

    def _run_highlight(
        self,
        task_id: int,
        task: LocalVideoTask,
        worker: LocalVideoWorker,
        log: object,
    ) -> None:
        import tempfile

        import cv2

        from src.highlight.audio import AudioAnalyzer
        from src.ai.factory import create_analyzer
        from src.models import FrameInfo

        ai_cfg = self._config.ai
        if task.ai_backend:
            ai_cfg = dc_replace(ai_cfg, default_backend=task.ai_backend)

        video_name = Path(task.video_path).stem
        storage = StorageManager(dc_replace(self._config.storage, output_dir=str(self._output_dir)), name=video_name)

        audio_analyzer = AudioAnalyzer(self._config.highlight, self._config.whisper)
        ai_analyzer = create_analyzer(ai_cfg)
        log(f"使用 AI 后端: {ai_cfg.default_backend}")

        # 1. 提取音频
        log("提取音频...")
        self._update_local_task(task_id, progress=5.0, progress_text="提取音频")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            audio_path = tmp.name
        audio_analyzer.extract_audio(task.video_path, audio_path)

        if worker.stop_event.is_set():
            return

        # 2. 检测音量突变
        log("检测音量突变...")
        self._update_local_task(task_id, progress=15.0, progress_text="检测音量突变")
        segments = audio_analyzer.detect_volume_spikes(
            audio_path, config.highlight.volume_spike_ratio
        )

        if not segments:
            log("未检测到音量突变")
            self._update_local_task(task_id, result_summary="未检测到高能时刻", progress_text="未检测到高能时刻")
            return

        log(f"发现 {len(segments)} 个候选片段")
        self._update_local_task(task_id, progress=20.0, progress_text=f"分析 {len(segments)} 个候选")

        if worker.stop_event.is_set():
            return

        # 3. 获取视频元数据
        cap = cv2.VideoCapture(task.video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = total_frames_count / fps if fps > 0 else 0
        cap.release()

        # 4. AI 分析每个候选
        moments = []
        for seg_idx, seg in enumerate(segments):
            if worker.stop_event.is_set():
                break

            start = max(0.0, seg.start_time)
            end = min(duration, seg.end_time)
            if end <= start:
                continue

            # 提取帧
            frames = self._extract_highlight_frames(
                task.video_path, start, end, fps,
                config.highlight.frames_per_segment,
            )
            if not frames:
                continue

            # 转录
            transcript = None
            try:
                transcript = audio_analyzer.transcribe(audio_path, start, end)
                if not transcript:
                    transcript = None
            except Exception:
                pass

            # AI 分析
            raw_frames = [f.frame for f in frames]
            result = ai_analyzer.analyze_frames(raw_frames, transcript)

            if result.is_highlight:
                # 顺序读取片段所有帧，按 Laplacian 方差选最清晰的 top-K
                save_frames = self._select_sharpest_frames(
                    task.video_path, start, end,
                    config.highlight.key_frames_per_segment,
                )
                if not save_frames:
                    save_frames = frames  # fallback: 用 AI 分析的帧

                from src.models import HighlightMoment
                moment = HighlightMoment(
                    start_time=start,
                    end_time=end,
                    frames=save_frames,
                    result=result,
                    audio_segment=seg,
                )
                moments.append(moment)
                storage.save_highlight(moment)
                log(f"高能时刻: [{start:.1f}s-{end:.1f}s] {result.category.value} (评分: {result.score})")

            progress = 20 + (seg_idx + 1) / len(segments) * 75
            self._update_local_task(
                task_id,
                progress=min(progress, 95.0),
                progress_text=f"分析候选: {seg_idx + 1}/{len(segments)}",
            )

        moments.sort(key=lambda m: m.result.score, reverse=True)
        summary = f"检测到 {len(moments)} 个高能时刻"
        self._update_local_task(task_id, result_summary=summary, progress_text=summary)
        log(summary)

    @staticmethod
    def _extract_highlight_frames(
        video_path: str, start: float, end: float, fps: float, n: int,
    ) -> list:
        import cv2
        from src.models import FrameInfo

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return []

        frames = []
        duration = end - start
        interval = duration / max(n, 1)

        for i in range(n):
            t = start + interval * (i + 0.5)
            frame_idx = int(t * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if not ret:
                continue
            frames.append(FrameInfo(
                frame=frame, timestamp=t, frame_index=frame_idx, source=video_path,
            ))

        cap.release()
        return frames

    @staticmethod
    def _select_sharpest_frames(
        video_path: str, start: float, end: float, top_k: int,
    ) -> list:
        """顺序读取片段内所有帧，用 min-heap 保留清晰度最高的 top_k 张。"""
        import heapq
        import cv2
        from src.filter.blur import BlurDetector
        from src.models import FrameInfo

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return []
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)

        blur_det = BlurDetector()
        heap: list = []
        counter = 0

        while True:
            pos_s = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if pos_s >= end:
                break
            ret, frame = cap.read()
            if not ret:
                break
            score = blur_det.detect(frame)
            fi = FrameInfo(
                frame=frame,
                timestamp=pos_s,
                frame_index=int(cap.get(cv2.CAP_PROP_POS_FRAMES) - 1),
                source=video_path,
            )
            if len(heap) < top_k:
                heapq.heappush(heap, (score, counter, fi))
            elif score > heap[0][0]:
                heapq.heapreplace(heap, (score, counter, fi))
            counter += 1

        cap.release()
        return [fi for _, _, fi in sorted(heap, key=lambda x: -x[0])]
