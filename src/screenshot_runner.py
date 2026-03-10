"""统一截图管线逻辑"""

from __future__ import annotations

import threading
from typing import Callable

from src.config import AppConfig
from src.extract.extractor import FrameExtractor
from src.filter.pipeline import FilterPipeline
from src.input.source import VideoSource
from src.storage.manager import StorageManager


class ScreenshotRunner:
    """统一截图管线：抽帧 → 过滤 → 分批 top-k → 保存"""

    BATCH_FLUSH_SIZE = 50

    def __init__(
        self,
        pipeline: FilterPipeline,
        extractor: FrameExtractor,
        storage: StorageManager,
        config: AppConfig,
        stop_event: threading.Event | None = None,
        log_fn: Callable[[str], None] | None = None,
        category: str = "portrait",
    ) -> None:
        self.pipeline = pipeline
        self.extractor = extractor
        self.storage = storage
        self.config = config
        self.stop_event = stop_event
        self.log_fn = log_fn
        self.category = category

    def run(self, source: VideoSource) -> int:
        """运行截图管线，返回保存张数"""
        batch_scores = []
        saved_count = 0

        try:
            for frame_info in self.extractor.extract_frames(source):
                if self.stop_event and self.stop_event.is_set():
                    break
                score = self.pipeline.process_frame(frame_info)
                if score is not None:
                    batch_scores.append(score)
                if len(batch_scores) >= self.BATCH_FLUSH_SIZE:
                    saved_count += self._flush(batch_scores)
                    batch_scores.clear()
        except Exception:
            pass  # 流关闭或意外中断，下方继续 flush 剩余帧

        if batch_scores:
            saved_count += self._flush(batch_scores)

        if self.log_fn:
            self.log_fn(f"截图结束，共保存 {saved_count} 张")
        return saved_count

    def _flush(self, scores: list) -> int:
        top = self.pipeline.select_top_k(scores, self.config.aesthetic.top_k)
        for s in top:
            self.storage.save_screenshot(s, self.category)
        if self.log_fn and top:
            self.log_fn(f"保存 {len(top)} 张 (候选 {len(scores)})")
        return len(top)
