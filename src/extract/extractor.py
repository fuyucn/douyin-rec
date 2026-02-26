"""帧提取模块"""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np

from src.input.source import VideoSource
from src.models import FrameInfo


class FrameExtractor:
    """从视频源中按指定 FPS 提取帧"""

    def __init__(self, fps: float = 2.0) -> None:
        self.fps = fps

    def extract_frames(
        self, source: VideoSource, fps: float | None = None
    ) -> Iterator[FrameInfo]:
        """按指定 FPS 从视频源中逐帧提取。

        每隔 1/target_fps 秒产出一帧，跳过中间帧以降低处理量。
        """
        target_fps = fps if fps is not None else self.fps
        source_fps = source.fps
        # 每隔 frame_interval 帧取一帧
        frame_interval = max(1, int(round(source_fps / target_fps)))

        frame_index = 0
        while True:
            frame_info = source.read_frame()
            if frame_info is None:
                break
            if frame_index % frame_interval == 0:
                yield FrameInfo(
                    frame=frame_info.frame,
                    timestamp=frame_index / source_fps,
                    frame_index=frame_index,
                    source=frame_info.source,
                )
            frame_index += 1

    def extract_range(
        self,
        source: VideoSource,
        start: float,
        end: float,
        num_frames: int,
    ) -> list[FrameInfo]:
        """在 [start, end] 时间区间内均匀提取 num_frames 帧。

        用于高能时刻检测——从候选音频区间中抽取代表帧。
        """
        if num_frames <= 0:
            return []

        source_fps = source.fps
        start_frame = int(start * source_fps)
        end_frame = int(end * source_fps)
        total_range = end_frame - start_frame

        if num_frames == 1:
            target_indices = {start_frame + total_range // 2}
        else:
            step = total_range / (num_frames - 1)
            target_indices = {
                int(round(start_frame + i * step)) for i in range(num_frames)
            }

        results: list[FrameInfo] = []
        frame_index = 0
        while True:
            frame_info = source.read_frame()
            if frame_info is None:
                break
            if frame_index in target_indices:
                results.append(
                    FrameInfo(
                        frame=frame_info.frame,
                        timestamp=frame_index / source_fps,
                        frame_index=frame_index,
                        source=frame_info.source,
                    )
                )
                if len(results) == num_frames:
                    break
            frame_index += 1

        return results

    @staticmethod
    def detect_scene_change(
        prev_frame: np.ndarray,
        curr_frame: np.ndarray,
        threshold: float = 30.0,
    ) -> bool:
        """通过帧间平均绝对差检测场景切换。

        将两帧转为 float 计算逐像素差的均值，超过阈值即判定为场景变化。
        """
        diff = np.mean(np.abs(prev_frame.astype(np.float32) - curr_frame.astype(np.float32)))
        return bool(diff > threshold)
