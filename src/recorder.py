"""直播流录制器 — 使用 ffmpeg -c copy 保存为 .ts 文件"""

from __future__ import annotations

import logging
import subprocess
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


class StreamRecorder:
    """将直播流保存为 .ts 文件（不重编码，CPU 占用极低）

    segment_duration > 0 时使用 ffmpeg segment muxer 自动分段。
    """

    def __init__(
        self,
        stream_url: str,
        output_path: str | Path,
        segment_duration: int = 0,
    ) -> None:
        self._stream_url = stream_url
        self._output_path = str(output_path)
        self._segment_duration = segment_duration
        self._process: subprocess.Popen | None = None

    # -- public API ----------------------------------------------------------

    def start(self) -> None:
        if self._process is not None:
            return
        Path(self._output_path).parent.mkdir(parents=True, exist_ok=True)

        if self._segment_duration > 0:
            cmd = [
                "ffmpeg", "-y",
                "-i", self._stream_url,
                "-c", "copy",
                "-f", "segment",
                "-segment_time", str(self._segment_duration),
                "-segment_format", "mpegts",
                "-reset_timestamps", "1",
                self._output_path,
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-i", self._stream_url,
                "-c", "copy",
                "-f", "mpegts",
                self._output_path,
            ]

        logger.info("开始录制: %s", self._output_path)
        self._process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

    def stop(self) -> None:
        if self._process is None:
            return
        logger.info("正在停止录制...")
        try:
            self._process.stdin.write(b"q")
            self._process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            logger.warning("ffmpeg 未响应，强制终止")
            self._process.terminate()
            try:
                self._process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._process.kill()
        logger.info("录制已停止: %s", self._output_path)
        self._process = None

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    # -- context manager -----------------------------------------------------

    def __enter__(self) -> StreamRecorder:
        self.start()
        return self

    def __exit__(self, *args: object) -> None:
        self.stop()

    # -- helpers -------------------------------------------------------------

    @staticmethod
    def make_output_path(
        name: str, output_dir: Path, segment: bool = False,
    ) -> tuple[str, str]:
        """生成输出路径和显示名。

        返回 (path_or_pattern, display_name):
        - 分段模式: ("{dir}/{name}_2026-02-26_12-30-05_%03d.ts", "name_2026-02-26_12-30-05")
        - 非分段:   ("{dir}/{name}_2026-02-26_12-30-05.ts", 同上)
        """
        now = datetime.now()
        base = f"{name}_{now:%Y-%m-%d}_{now:%H-%M-%S}"
        output_dir.mkdir(parents=True, exist_ok=True)
        if segment:
            pattern = str(output_dir / f"{base}_%03d.ts")
            return pattern, base
        path = str(output_dir / f"{base}.ts")
        return path, base
