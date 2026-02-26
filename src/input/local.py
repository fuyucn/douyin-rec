"""本地视频文件源"""

from __future__ import annotations

import logging
from pathlib import Path

import cv2

from src.models import FrameInfo

logger = logging.getLogger(__name__)


class LocalVideoSource:
    """从本地视频文件读取帧"""

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._cap: cv2.VideoCapture | None = None
        self._frame_index = 0

    # -- public API ----------------------------------------------------------

    def open(self) -> None:
        if self._cap is not None:
            return
        cap = cv2.VideoCapture(self._path)
        if not cap.isOpened():
            raise FileNotFoundError(f"无法打开视频文件: {self._path}")
        self._cap = cap
        self._frame_index = 0
        logger.info(
            "已打开视频 %s  fps=%.2f  total_frames=%s",
            self._path,
            self.fps,
            self.total_frames,
        )

    def read_frame(self) -> FrameInfo | None:
        if self._cap is None:
            raise RuntimeError("视频源尚未打开，请先调用 open()")
        ret, frame = self._cap.read()
        if not ret:
            return None
        timestamp = self._cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        info = FrameInfo(
            frame=frame,
            timestamp=timestamp,
            frame_index=self._frame_index,
            source=self._path,
        )
        self._frame_index += 1
        return info

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None
            logger.info("已关闭视频 %s", self._path)

    def seek(self, timestamp: float) -> None:
        """跳转到指定时间戳（秒）"""
        if self._cap is None:
            raise RuntimeError("视频源尚未打开，请先调用 open()")
        self._cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
        self._frame_index = int(self._cap.get(cv2.CAP_PROP_POS_FRAMES))

    # -- properties ----------------------------------------------------------

    @property
    def fps(self) -> float:
        if self._cap is None:
            raise RuntimeError("视频源尚未打开，请先调用 open()")
        return float(self._cap.get(cv2.CAP_PROP_FPS))

    @property
    def total_frames(self) -> int | None:
        if self._cap is None:
            raise RuntimeError("视频源尚未打开，请先调用 open()")
        count = int(self._cap.get(cv2.CAP_PROP_FRAME_COUNT))
        return count if count > 0 else None

    # -- context manager -----------------------------------------------------

    def __enter__(self) -> LocalVideoSource:
        self.open()
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
