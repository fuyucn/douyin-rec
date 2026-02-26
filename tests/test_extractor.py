"""测试帧提取器"""

import numpy as np

from src.extract.extractor import FrameExtractor
from src.models import FrameInfo


class FakeSource:
    """模拟视频源"""

    def __init__(self, num_frames: int, fps: float = 30.0):
        self._fps = fps
        self._total = num_frames
        self._index = 0
        self._frame = np.zeros((100, 100, 3), dtype=np.uint8)

    @property
    def fps(self) -> float:
        return self._fps

    @property
    def total_frames(self) -> int:
        return self._total

    def open(self) -> None:
        pass

    def close(self) -> None:
        pass

    def read_frame(self) -> FrameInfo | None:
        if self._index >= self._total:
            return None
        info = FrameInfo(
            frame=self._frame,
            timestamp=self._index / self._fps,
            frame_index=self._index,
            source="fake",
        )
        self._index += 1
        return info

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *args):
        self.close()


def test_extract_frames_basic():
    """按目标 FPS 提取帧"""
    source = FakeSource(num_frames=60, fps=30.0)
    extractor = FrameExtractor(fps=2.0)  # 30fps -> 每 15 帧取一帧
    frames = list(extractor.extract_frames(source))
    # 60 帧 / 15 间隔 = 4 帧
    assert len(frames) == 4
    assert frames[0].frame_index == 0
    assert frames[1].frame_index == 15


def test_extract_frames_higher_fps():
    """目标 FPS 等于源 FPS 时全部提取"""
    source = FakeSource(num_frames=10, fps=10.0)
    extractor = FrameExtractor(fps=10.0)
    frames = list(extractor.extract_frames(source))
    assert len(frames) == 10


def test_extract_frames_custom_fps():
    """可覆盖默认 FPS"""
    source = FakeSource(num_frames=30, fps=30.0)
    extractor = FrameExtractor(fps=1.0)  # 默认 1fps
    frames = list(extractor.extract_frames(source, fps=10.0))  # 覆盖为 10fps
    # 30fps / 10fps = 每 3 帧取一帧 → 10 帧
    assert len(frames) == 10


def test_scene_change_detection():
    """场景切换检测"""
    black = np.zeros((100, 100, 3), dtype=np.uint8)
    white = np.ones((100, 100, 3), dtype=np.uint8) * 255
    similar = np.ones((100, 100, 3), dtype=np.uint8) * 5

    assert FrameExtractor.detect_scene_change(black, white) is True
    assert FrameExtractor.detect_scene_change(black, similar) is False
