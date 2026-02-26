"""任务管理器 — DB 持久化 + 多任务并发执行"""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine, select

from src.config import load_config
from src.input.live import DouyinLiveSource
from src.recorder import StreamRecorder
from src.storage.database import RecordingTask
from src.storage.manager import StorageManager

logger = logging.getLogger(__name__)

DEFAULT_DB_PATH = "./output/tasks.db"


@dataclass
class TaskWorker:
    """单个任务的运行时状态"""

    thread: threading.Thread | None = None
    stop_event: threading.Event = field(default_factory=threading.Event)
    preview_frame: bytes | None = None
    preview_lock: threading.Lock = field(default_factory=threading.Lock)
    stream_url: str | None = None
    status_text: str = ""


class TaskManager:
    """集中管理任务 DB 操作和运行状态"""

    def __init__(self, db_path: str = DEFAULT_DB_PATH) -> None:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(f"sqlite:///{db_path}")
        SQLModel.metadata.create_all(self.engine)
        self._workers: dict[int, TaskWorker] = {}  # task_id → worker
        self._preview_task_id: int | None = None  # 当前预览的任务 ID
        self._lock = threading.Lock()
        self._log_queues: list[queue.Queue] = []  # SSE 日志队列

        # 启动时将所有 running 状态恢复为 stopped（上次异常退出）
        self._recover_running_tasks()

    def _recover_running_tasks(self) -> None:
        with Session(self.engine) as session:
            stmt = select(RecordingTask).where(RecordingTask.status == "running")
            tasks = list(session.exec(stmt).all())
            for task in tasks:
                task.status = "stopped"
                task.stopped_at = datetime.now()
                session.add(task)
            session.commit()

    # ── 日志广播 ─────────────────────────────────────────────────────

    def broadcast(self, msg: str, task_name: str | None = None) -> None:
        """向所有 SSE 客户端推送一条日志"""
        ts = datetime.now().strftime("%H:%M:%S")
        prefix = f"[{task_name}] " if task_name else ""
        line = f"[{ts}] {prefix}{msg}"
        logger.info("%s%s", prefix, msg)
        dead: list[queue.Queue] = []
        for q in self._log_queues:
            try:
                q.put_nowait(line)
            except queue.Full:
                dead.append(q)
        for q in dead:
            self._log_queues.remove(q)

    def add_log_queue(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=500)
        self._log_queues.append(q)
        return q

    def remove_log_queue(self, q: queue.Queue) -> None:
        if q in self._log_queues:
            self._log_queues.remove(q)

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
    ) -> RecordingTask:
        task = RecordingTask(
            url=url,
            name=name,
            quality=quality,
            segment_min=segment_min,
            enable_record=enable_record,
            enable_screenshot=enable_screenshot,
            cookies=cookies,
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

            worker = TaskWorker()
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

    # ── Worker 线程 ──────────────────────────────────────────────────

    def _task_worker(self, task_id: int, worker: TaskWorker) -> None:
        """单个任务的工作线程：等待开播 → 录制/截图 → 下播 → 重新等待"""
        task = self.get_task(task_id)
        if task is None:
            return

        task_name = task.name or f"任务{task_id}"

        def log(msg: str) -> None:
            self.broadcast(msg, task_name=task_name)

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
                if not task.name:
                    self._update_task_name(task_id, source.streamer_name)
                log(f"主播: {task_name}")

            features = []
            if task.enable_record:
                features.append("录制")
            if task.enable_screenshot:
                features.append("截图")
            log(f"已启用: {', '.join(features)}")

            storage = StorageManager(config.storage, name=task_name)
            segment_sec = task.segment_min * 60 if task.segment_min > 0 else 0

            while not worker.stop_event.is_set():
                # ── 等待开播 ──
                worker.status_text = "等待开播"
                log("等待直播开播...")
                try:
                    stream_url = source.wait_for_live(
                        poll_interval=180,
                        on_status=log,
                        stop_event=worker.stop_event,
                    )
                except InterruptedError:
                    break

                if worker.stop_event.is_set():
                    break

                # ── 开播 ──
                worker.status_text = "直播中"
                worker.stream_url = stream_url

                # 启动预览抓帧线程
                preview_thread = threading.Thread(
                    target=self._preview_worker,
                    args=(worker,),
                    daemon=True,
                )
                preview_thread.start()

                recorder = None
                screenshot_thread = None

                # 启动录制
                if task.enable_record:
                    path_or_pattern, display = StreamRecorder.make_output_path(
                        task_name, storage.output_dir, segment=segment_sec > 0,
                    )
                    log(f"开始录制: {display}")
                    recorder = StreamRecorder(
                        stream_url, path_or_pattern, segment_duration=segment_sec,
                    )
                    recorder.start()

                # 启动截图
                if task.enable_screenshot:
                    source._stream_url = stream_url
                    try:
                        source.open()
                        screenshot_thread = threading.Thread(
                            target=self._screenshot_worker,
                            args=(source, storage, worker, task_name),
                            daemon=True,
                        )
                        screenshot_thread.start()
                    except Exception as e:
                        log(f"截图连接失败: {e}")

                # 等待结束
                while not worker.stop_event.is_set():
                    if recorder and not recorder.is_running:
                        break
                    if not recorder and screenshot_thread and not screenshot_thread.is_alive():
                        break
                    time.sleep(1)

                if recorder:
                    recorder.stop()
                if screenshot_thread and screenshot_thread.is_alive():
                    screenshot_thread.join(timeout=5)
                try:
                    source.close()
                except Exception:
                    pass

                worker.stream_url = None

                if worker.stop_event.is_set():
                    log("用户停止")
                    break

                log("直播流断开，将重新等待开播...")

        except Exception as e:
            log(f"任务出错: {e}")
            self._update_task_status(task_id, "error", error_msg=str(e))
            return
        finally:
            worker.stream_url = None
            worker.status_text = ""
            with worker.preview_lock:
                worker.preview_frame = None

        self._update_task_status(task_id, "stopped")
        log("任务结束")

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
            self.broadcast(msg, task_name=task_name)

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
