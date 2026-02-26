"""视频输入模块"""

from src.input.live import DouyinLiveSource
from src.input.local import LocalVideoSource
from src.input.source import VideoSource

__all__ = ["DouyinLiveSource", "LocalVideoSource", "VideoSource"]
