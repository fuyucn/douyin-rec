"""弹幕录制器：对接 TaskManager 的启停，在独立线程运行 asyncio 循环"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime
from pathlib import Path

from .ass_writer import AssWriter
from .client import DouyinDanmakuClient
from .models import SimpleDanmaku

logger = logging.getLogger(__name__)


class DanmuRecorder:
    """
    与 StreamRecorder 并行运行，录制弹幕并写入 ASS 文件。

    时间对齐公式：
        video_offset = danmu.timestamp - part_start_time - cdn_delay

    分段模式（segment_duration > 0）：
        每 segment_duration 秒自动切换到下一个 .ass 文件，时间轴重置为 t=0，
        与视频分段文件一一对应（_000_danmu.ass / _001_danmu.ass / ...）。
        output_path 需包含 %03d 占位符，例如：主播名_2026-01-01_%03d_danmu.ass
    """

    def __init__(
        self,
        url: str,
        started_at: datetime,
        output_path: Path,
        cdn_delay: int = 6,
        segment_duration: int = 0,
        cookies: str | None = None,
        log_callback=None,
        width: int = 1920,
        height: int = 1080,
    ) -> None:
        self._url = url
        self._started_at = started_at.timestamp()
        self._output_path = Path(output_path)
        self._cdn_delay = cdn_delay
        self._segment_duration = segment_duration
        self._cookies = cookies
        self._log = log_callback or (lambda msg: logger.info(msg))

        self._writer = AssWriter(width=width, height=height)
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

        # 分段状态
        self._part_index: int = 0
        self._part_start_time: float = self._started_at  # 当前分段的 t=0 挂钟时间
        self._part_lock = threading.Lock()

    # ── public API ──────────────────────────────────────────────────────────

    def start(self) -> None:
        self._output_path.parent.mkdir(parents=True, exist_ok=True)
        current_path = self._current_part_path()
        self._writer.open(current_path)
        self._thread = threading.Thread(target=self._run, daemon=True, name='danmu-recorder')
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(timeout=8)
        self._writer.close()
        self._log(f'[弹幕] 已保存 → {self._current_part_path().name}')

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ── 分段 ──────────────────────────────────────────────────────────────────

    def _current_part_path(self) -> Path:
        p = str(self._output_path)
        if '%03d' in p:
            return Path(p % self._part_index)
        return self._output_path

    def _split(self) -> None:
        """切换到下一个分段 .ass 文件，重置时间轴"""
        with self._part_lock:
            self._writer.close()
            self._part_index += 1
            self._part_start_time = time.time()
            new_path = self._current_part_path()
            self._writer.open(new_path)
            self._log(f'[弹幕] 分段切换 → {new_path.name}')

    # ── internal ─────────────────────────────────────────────────────────────

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._record())
        except Exception as e:
            logger.exception(f'弹幕录制线程异常: {e}')
        finally:
            self._loop.close()

    async def _record(self) -> None:
        queue: asyncio.Queue[SimpleDanmaku] = asyncio.Queue()
        client = DouyinDanmakuClient(self._url, queue, cookies=self._cookies)
        count = 0
        retry = 0

        async def _consume() -> None:
            nonlocal count
            while not self._stop_event.is_set():
                try:
                    dm = queue.get_nowait()
                except asyncio.QueueEmpty:
                    await asyncio.sleep(0.05)
                    continue
                with self._part_lock:
                    part_start = self._part_start_time
                video_offset = dm.timestamp - part_start - self._cdn_delay
                if video_offset < 0:
                    continue
                dm.time = video_offset
                if self._writer.add(dm):
                    count += 1

        async def _segment_timer() -> None:
            """按 segment_duration 定时切分 .ass"""
            if not self._segment_duration:
                return
            while not self._stop_event.is_set():
                await asyncio.sleep(self._segment_duration)
                if not self._stop_event.is_set():
                    self._split()

        async def _connect() -> None:
            nonlocal retry
            while not self._stop_event.is_set():
                try:
                    await client.start()
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    if self._stop_event.is_set():
                        break
                    retry += 1
                    wait = min(15 * retry, 60)
                    self._log(f'[弹幕] 连接断开，{wait}s 后重连: {e}')
                    await asyncio.sleep(wait)

        self._log(f'[弹幕] 开始录制弹幕...')
        try:
            await asyncio.gather(_connect(), _consume(), _segment_timer())
        finally:
            await client.stop()
            self._log(f'[弹幕] 共录制 {count} 条弹幕')
