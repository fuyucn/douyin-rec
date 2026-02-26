"""视频源协议定义"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from src.models import FrameInfo


@runtime_checkable
class VideoSource(Protocol):
    """视频源统一接口"""

    def open(self) -> None: ...

    def read_frame(self) -> FrameInfo | None: ...

    def close(self) -> None: ...

    @property
    def fps(self) -> float: ...

    @property
    def total_frames(self) -> int | None:
        """总帧数，直播流返回 None"""
        ...

    def __enter__(self) -> VideoSource: ...

    def __exit__(self, *args: object) -> None: ...
