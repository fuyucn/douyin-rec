"""任务管理器 — DB 持久化 + 多任务并发执行"""

from __future__ import annotations

import logging
import os
import queue
import random
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import text as sa_text
from sqlmodel import Session, SQLModel, create_engine, select

from src.config import load_config
from src.danmu.recorder import DanmuRecorder
from src.input.live import DouyinLiveSource
from src.recorder import StreamRecorder
from src.storage.database import LocalVideoTask, RecordingSession, RecordingTask
from src.storage.manager import StorageManager

logger = logging.getLogger(__name__)

DEFAULT_OUTPUT_DIR = "./output"


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
    log_file: "Path | None" = None


@dataclass
class LocalVideoWorker:
    """本地视频任务的运行时状态"""

    thread: threading.Thread | None = None
    stop_event: threading.Event = field(default_factory=threading.Event)


# 本地任务日志 ID 偏移，避免与录制任务 ID 冲突
LOCAL_ID_OFFSET = 1_000_000


class TaskManager:
    """集中管理任务 DB 操作和运行状态"""

    def __init__(
        self,
        output_dir: str = DEFAULT_OUTPUT_DIR,
        *,
        db_path: str | None = None,
    ) -> None:
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
        # 串行化 ffmpeg 启动：防止多任务同时初始化 ByteVC1 流触发并发 SIGSEGV
        self._ffmpeg_start_lock = threading.Lock()
        self._log_queues: list[tuple[queue.Queue, int | None]] = []  # (queue, task_id_filter)
        self._logs_dir = self._output_dir / "logs"
        self._logs_dir.mkdir(parents=True, exist_ok=True)

        # 启动时处理上次遗留的孤儿录制会话，再恢复任务状态
        self._handle_orphan_sessions()
        self._recover_running_tasks()
        self._recover_running_local_tasks()

    def _migrate_db(self) -> None:
        """为旧 DB 补充缺失的列"""
        migrations = [
            ("enable_segment", "BOOLEAN NOT NULL DEFAULT 1"),
            ("segment_sec", "INTEGER NOT NULL DEFAULT 1800"),
            ("poll_interval", "INTEGER NOT NULL DEFAULT 180"),
            ("show_countdown", "BOOLEAN NOT NULL DEFAULT 1"),
            ("max_threads", "INTEGER NOT NULL DEFAULT 3"),
            ("schedule_enabled", "BOOLEAN NOT NULL DEFAULT 0"),
            ("schedule_timezone", "TEXT NOT NULL DEFAULT 'Asia/Shanghai'"),
            ("schedule_start", "TEXT NOT NULL DEFAULT '00:00'"),
            ("schedule_stop", "TEXT NOT NULL DEFAULT '23:59'"),
            ("schedule_run_until_end", "BOOLEAN NOT NULL DEFAULT 0"),
            ("started_at", "DATETIME"),
            ("custom_name", "TEXT"),
            ("enable_danmu", "BOOLEAN NOT NULL DEFAULT 0"),
            ("danmu_cdn_delay", "INTEGER NOT NULL DEFAULT 6"),
            ("auto_quality_fallback", "BOOLEAN NOT NULL DEFAULT 0"),
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
                log_file = worker.log_file if (worker and worker.log_file) else None
                if log_file:
                    log_file.parent.mkdir(parents=True, exist_ok=True)
                    with open(log_file, "a", encoding="utf-8") as f:
                        f.write(line + "\n")
            except Exception:
                pass

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
        """读取任务最新一次启动的历史日志文件"""
        # 优先使用当前运行 worker 的 log_file
        worker = self._workers.get(task_id)
        if worker and worker.log_file and worker.log_file.exists():
            log_file = worker.log_file
        else:
            # 查找最新的 *_task{id}.log（文件名含时间戳，字典序即时间序）
            candidates = sorted(self._logs_dir.glob(f"*_task{task_id}.log"))
            if not candidates:
                # 兼容旧格式 task_{id}.log
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
        schedule_timezone: str = "Asia/Shanghai",
        schedule_start: str = "00:00",
        schedule_stop: str = "23:59",
        schedule_run_until_end: bool = False,
        custom_name: str | None = None,
        enable_danmu: bool = False,
        danmu_cdn_delay: int = 6,
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
        """停止指定任务"""
        with self._lock:
            worker = self._workers.get(task_id)
        if worker is None:
            # 任务可能不在内存中但 DB 中状态为 running
            self._update_task_status(task_id, "stopped")
            return
        worker.stop_event.set()

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
            tz = ZoneInfo("Asia/Shanghai")
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
            tz = ZoneInfo("Asia/Shanghai")
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
        """单个任务的工作线程：等待开播 → 录制/截图 → 下播 → 重新等待"""
        task = self.get_task(task_id)
        if task is None:
            return

        task_name = task.name or f"任务{task_id}"

        def log(msg: str) -> None:
            self.broadcast(msg, task_name=task_name, task_id=task_id)

        try:
            config = load_config()
            if task.cookies:
                config.input.cookies = task.cookies
            config.input.quality = task.quality

            source = DouyinLiveSource(task.url, config=config.input)

            # 获取主播名
            log("正在获取主播信息...")
            worker.status_text = "获取主播信息"
            source.extract_streamer_info()
            if source.streamer_name:
                task_name = source.streamer_name
                self._update_task_name(task_id, source.streamer_name)
                log(f"主播: {task_name}")

            features = []
            if task.enable_record:
                features.append("录制")
            if task.enable_screenshot:
                features.append("截图")
            log(f"已启用: {', '.join(features)}")

            # 文件夹按任务 ID 分类，文件名仍用主播名
            config.storage.output_dir = str(self._output_dir)
            storage = StorageManager(config.storage, name=f"task_{task_id}")
            segment_sec = task.segment_sec if task.enable_segment else 0
            poll_interval = task.poll_interval

            log(f"轮询间隔: {poll_interval}s, 分段: {'开启 (' + str(segment_sec) + 's)' if segment_sec > 0 else '关闭'}")

            # 定时调度检查回调 (供 wait_for_live 在每次轮询前调用)
            def schedule_check() -> bool:
                return self._is_in_schedule(task)

            _quick_fail_count = 0  # 连续快速断开（<30s）计数
            _last_rc: int | None = None  # 上次 ffmpeg 退出码
            _rc11_count = 0             # 连续 rc=-11 次数
            # rc=-11 处理策略：
            #   第1次：重置状态，重新拉 URL（CDN 可能换一条 H.264 流）
            #   第2次：force_m3u8=True（确认是 ByteVC1，换 M3U8）
            #   第3次+：逐级降画质 origin→uhd→hd→sd→ld
            _QUALITY_FALLBACK = ["origin", "uhd", "hd", "sd", "ld"]

            while not worker.stop_event.is_set():
                # ── 定时窗口检查 ──
                if task.schedule_enabled and not self._is_in_schedule(task):
                    worker.status_text = "定时等待"
                    log(f"当前不在定时窗口 ({task.schedule_start}~{task.schedule_stop})，等待...")
                    wait_secs = self._seconds_until_schedule_start(task)
                    worker.stop_event.wait(min(wait_secs, 60))
                    continue

                # ── 等待开播 ──
                worker.status_text = "等待开播"
                log("等待直播开播...")
                try:
                    stream_url = source.wait_for_live(
                        poll_interval=poll_interval,
                        on_status=log,
                        stop_event=worker.stop_event,
                        show_countdown=task.show_countdown,
                        schedule_check=schedule_check if task.schedule_enabled else None,
                    )
                except InterruptedError as ie:
                        if worker.stop_event.is_set():
                            log(f"[用户] 停止任务")
                            break
                        # 定时窗口结束，回到循环顶部重新判断
                        log(f"[定时] {ie}")
                        continue

                if worker.stop_event.is_set():
                    break

                # ── 开播 ──
                worker.status_text = "直播中"
                worker.stream_url = stream_url
                proto = "M3U8" if stream_url.split("?")[0].lower().endswith(".m3u8") else "FLV"
                log(f"[流] {proto}")

                # 启动预览抓帧线程
                preview_thread = threading.Thread(
                    target=self._preview_worker,
                    args=(worker,),
                    daemon=True,
                )
                preview_thread.start()

                recorder = None
                screenshot_thread = None
                _session_started_at = datetime.now()
                session_id: int | None = None

                # 启动录制（统一输出 TS 分段，FLV/M3U8 均走 StreamRecorder + ffmpeg）
                if task.enable_record:
                    path_or_pattern, display = StreamRecorder.make_output_path(
                        task_name, storage.output_dir, segment=segment_sec > 0,
                    )
                    log(f"开始录制: {display}")
                    recorder = StreamRecorder(
                        stream_url, path_or_pattern, segment_duration=segment_sec,
                        log_callback=log,
                        cookies=task.cookies or config.input.cookies,
                    )
                    # 串行化启动：同一时刻只允许一个 ffmpeg 进程完成初始化
                    # 防止多任务并发探针 ByteVC1 流时触发 SIGSEGV（macOS 竞争条件）
                    with self._ffmpeg_start_lock:
                        recorder.start()
                        time.sleep(3)  # 等待 ByteVC1 parser 初始化完成后再放开锁
                    worker.recording_started_at = datetime.now()
                    if recorder.pid:
                        with Session(self.engine) as db:
                            sess = RecordingSession(
                                task_id=task.id,
                                ffmpeg_pid=recorder.pid,
                                output_path=path_or_pattern,
                                started_at=worker.recording_started_at,
                            )
                            db.add(sess)
                            db.commit()
                            db.refresh(sess)
                            session_id = sess.id
                        worker.active_session_id = session_id

                # 初始化弹幕录制器（延迟启动：等 ffmpeg 确认有 .ts 输出后再 start()）
                # 防止 watchdog 触发时留下无对应 TS 的孤立 ASS 文件
                danmu_recorder = None
                _danmu_started = False
                _danmu_ass_path: Path | None = None
                if task.enable_danmu and task.enable_record and worker.recording_started_at:
                    if segment_sec > 0:
                        _danmu_ass_path = storage.output_dir / f"{display}_%03d_danmu.ass"
                    else:
                        _danmu_ass_path = storage.output_dir / f"{display}_danmu.ass"
                    _danmu_cookies = task.cookies or config.input.cookies
                    danmu_recorder = DanmuRecorder(
                        url=task.url,
                        started_at=worker.recording_started_at,
                        output_path=_danmu_ass_path,
                        cdn_delay=task.danmu_cdn_delay,
                        segment_duration=segment_sec,
                        cookies=_danmu_cookies,
                        log_callback=log,
                    )
                    # 注意：start() 延迟到确认有 .ts 输出后调用（见等待循环）

                # 启动截图
                if task.enable_screenshot:
                    source._stream_url = stream_url
                    try:
                        source.open()
                        screenshot_thread = threading.Thread(
                            target=self._screenshot_worker,
                            args=(source, storage, worker, task_name, task_id),
                            daemon=True,
                        )
                        screenshot_thread.start()
                    except Exception as e:
                        log(f"截图连接失败: {e}")

                # 等待结束
                _WATCHDOG_TIMEOUT_SEC = 90  # ffmpeg 启动后若此时间内无 .ts 输出，视为卡死
                _watchdog_triggered = False
                while not worker.stop_event.is_set():
                    if recorder and not recorder.is_running:
                        break
                    if not recorder and screenshot_thread and not screenshot_thread.is_alive():
                        break
                    # 定时窗口结束时主动停止录制
                    if task.schedule_enabled and not self._is_in_schedule(task):
                        if task.schedule_run_until_end:
                            pass  # 继续录制直到直播自然结束
                        else:
                            log(f"定时窗口结束 ({task.schedule_stop})，停止录制")
                            break
                    # TS 确认检查（复用 watchdog 计算）：
                    #   有 .ts → 启动弹幕（首次）；无 .ts 且超时 → watchdog kill
                    if recorder and not _watchdog_triggered:
                        _out = Path(path_or_pattern)
                        if segment_sec > 0:
                            _stem_prefix = _out.stem.replace("%03d", "")
                            ts_ready = list(_out.parent.glob(f"{_stem_prefix}*.ts"))
                        else:
                            ts_ready = [_out] if _out.exists() and _out.stat().st_size > 0 else []
                        if ts_ready:
                            # ffmpeg 已有输出：启动弹幕（仅一次）
                            if danmu_recorder is not None and not _danmu_started:
                                try:
                                    _danmu_cookies = task.cookies or config.input.cookies
                                    log(f"[弹幕] cookies: {'任务配置' if task.cookies else ('config.yaml' if config.input.cookies else '无（匿名）')}")
                                    danmu_recorder.start()
                                    _danmu_started = True
                                    log(f"[弹幕] 录制已启动 → {_danmu_ass_path.name}")
                                except Exception as e:
                                    log(f"[弹幕] 启动失败: {e}")
                                    danmu_recorder = None
                        else:
                            _elapsed = (datetime.now() - _session_started_at).total_seconds()
                            if _elapsed >= _WATCHDOG_TIMEOUT_SEC:
                                _watchdog_triggered = True
                                log(f"[系统] Watchdog: ffmpeg 已运行 {_elapsed:.0f}s 无 .ts 输出，强制重连...")
                                recorder.stop()
                                break
                    time.sleep(1)

                _last_rc = None
                if recorder:
                    _last_rc = recorder.last_exit_code  # 捕获退出码（stop() 前读取最可靠）
                    _end_reason = "user_stop" if worker.stop_event.is_set() else "stream_end"
                    recorder.stop()
                    if session_id:
                        with Session(self.engine) as db:
                            sess = db.get(RecordingSession, session_id)
                            if sess and sess.status == "active":
                                sess.status = "stopped"
                                sess.end_reason = _end_reason
                                sess.ended_at = datetime.now()
                                if sess.started_at:
                                    sess.duration_sec = (sess.ended_at - sess.started_at).total_seconds()
                                db.add(sess)
                                db.commit()
                        worker.active_session_id = None
                        session_id = None
                    worker.recording_started_at = None
                if danmu_recorder and _danmu_started:
                    danmu_recorder.stop()
                    danmu_recorder = None
                if screenshot_thread and screenshot_thread.is_alive():
                    screenshot_thread.join(timeout=5)
                try:
                    source.close()
                except Exception:
                    pass

                worker.stream_url = None

                if worker.stop_event.is_set():
                    log("[用户] 停止任务")
                    break

                if task.schedule_enabled and not self._is_in_schedule(task):
                    log(f"[定时] 当前不在窗口内，等待下次开播窗口 ({task.schedule_start})")
                    continue

                _session_sec = (datetime.now() - _session_started_at).total_seconds()
                if _session_sec < 30:
                    _quick_fail_count += 1
                    _cooldown = random.uniform(15, 40)
                    _rc_info = f", rc={_last_rc}" if _last_rc is not None else ""
                    log(f"[系统] 直播流快速断开 ({_session_sec:.0f}s{_rc_info})，{_cooldown:.0f} 秒后重连...")
                    _url_short = (stream_url[:80] + "...") if len(stream_url) > 80 else stream_url
                    log(f"[系统] 断流地址: {_url_short}")
                    # rc=-11 = ffmpeg SIGSEGV（ByteVC1 在 macOS 崩溃）
                    if _last_rc == -11:
                        _rc11_count += 1
                        if _rc11_count == 1:
                            # 第1次：重置所有 ByteVC1 状态，重新拉 URL
                            # CDN 每次返回的 stream URL 可能不同，下次可能是 H.264
                            source.force_m3u8 = False
                            source.force_quality = None
                            log("[系统] rc=-11 (ByteVC1/SIGSEGV)，重新获取流地址（CDN 可能换流）...")
                        elif _rc11_count == 2:
                            # 第2次：确认是 ByteVC1，切换到 M3U8
                            source.force_m3u8 = True
                            source.force_quality = None
                            log("[系统] 连续 rc=-11，切换到 M3U8 流")
                        else:
                            # 第3次+：M3U8 也崩溃，逐级降画质
                            cur_q = source.force_quality or task.quality or "origin"
                            try:
                                next_q = _QUALITY_FALLBACK[_QUALITY_FALLBACK.index(cur_q) + 1]
                                source.force_quality = next_q
                                log(f"[系统] M3U8 仍 rc=-11，画质降级: {cur_q} → {next_q}")
                            except (ValueError, IndexError):
                                # 全部画质均 ByteVC1：重置降级链，等待下次开播时重试
                                # 主播可能之后切换回 H.264，不直接停止任务
                                log("[系统] 所有画质均 ByteVC1 rc=-11，重置状态，等待下次开播重试...")
                                source.force_m3u8 = False
                                source.force_quality = None
                                _rc11_count = 0
                    else:
                        _rc11_count = 0
                        if _quick_fail_count == 3:
                            log("[系统] 连续快速断开 3 次，CDN 可能需要 cookie 鉴权，建议在任务设置中填写 cookies")
                    if worker.stop_event.wait(_cooldown):
                        break
                else:
                    _quick_fail_count = 0  # 成功录制超 30s，重置计数
                    _rc11_count = 0
                log("[系统] 直播流断开，将重新等待开播...")

        except Exception as e:
            log(f"[系统] 任务出错: {e}")
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

        config = load_config()
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

        config = load_config()
        pipeline = FilterPipeline(config)
        extractor = FrameExtractor(fps=config.input.extract_fps)

        config.storage.output_dir = str(self._output_dir)
        video_name = Path(task.video_path).stem
        storage = StorageManager(config.storage, name=video_name)

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

        config = load_config()
        if task.ai_backend:
            config.ai.default_backend = task.ai_backend

        config.storage.output_dir = str(self._output_dir)
        video_name = Path(task.video_path).stem
        storage = StorageManager(config.storage, name=video_name)

        audio_analyzer = AudioAnalyzer(config.highlight, config.whisper)
        ai_analyzer = create_analyzer(config.ai)
        log(f"使用 AI 后端: {config.ai.default_backend}")

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
