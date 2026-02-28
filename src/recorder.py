"""直播流录制器 — 使用 ffmpeg -c copy 保存为 .ts 文件"""

from __future__ import annotations

import logging
import subprocess
import threading
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
        self._stderr_thread: threading.Thread | None = None

    # -- public API ----------------------------------------------------------

    def start(self) -> None:
        if self._process is not None:
            return
        Path(self._output_path).parent.mkdir(parents=True, exist_ok=True)

        # 判断 FLV 还是 HLS，以选择合适的 demuxer 和重连策略
        url_path = self._stream_url.split("?")[0].lower()
        is_flv = url_path.endswith(".flv")

        # 通用选项：超时 + 抖音 CDN Referer + 丢弃损坏包
        common_opts: list[str] = [
            "-rw_timeout", "10000000",       # 10 秒读写超时（防 CDN 卡死挂进程）
            "-headers", "Referer: https://live.douyin.com\r\n",  # CDN 403 防护
            "-fflags", "+discardcorrupt",    # 静默丢弃损坏包，不崩溃
        ]

        if is_flv:
            # FLV 是单一 HTTP 流，-reconnect* 有效
            input_opts = [
                "-reconnect", "1",
                "-reconnect_at_eof", "1",
                "-reconnect_streamed", "1",
                "-reconnect_delay_max", "5",
                "-reconnect_on_network_error", "1",
            ] + common_opts + ["-f", "live_flv"]
        else:
            # HLS：demuxer 内部处理 playlist 刷新，-reconnect_at_eof 会干扰导致无限重连 M3U8
            input_opts = common_opts

        if self._segment_duration > 0:
            output_opts = [
                "-c", "copy",
                "-f", "segment",
                "-segment_time", str(self._segment_duration),
                "-segment_format", "mpegts",
                "-reset_timestamps", "1",
            ]
        else:
            output_opts = ["-c", "copy", "-f", "mpegts"]

        cmd = (
            ["ffmpeg", "-y"]
            + input_opts
            + ["-i", self._stream_url]
            + output_opts
            + ["-progress", "pipe:2", "-nostats", self._output_path]
        )

        logger.info("开始录制 (%s): %s", "FLV" if is_flv else "HLS", self._output_path)
        logger.debug("ffmpeg cmd: %s", " ".join(cmd))
        self._process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

        # 后台读取 stderr，防止 pipe buffer 满 + 监控丢帧
        self._stderr_thread = threading.Thread(
            target=self._monitor_stderr,
            args=(self._process,),
            daemon=True,
        )
        self._stderr_thread.start()

    def _monitor_stderr(self, process: subprocess.Popen) -> None:
        """持续读取 ffmpeg stderr，记录错误和丢帧"""
        last_drop = 0
        lines: list[str] = []
        try:
            for raw in process.stderr:
                line = raw.decode(errors="replace").strip()
                if not line:
                    continue
                lines.append(line)
                if line.startswith("drop_frames="):
                    try:
                        drop = int(line.split("=", 1)[1])
                        if drop > last_drop:
                            logger.warning("录制丢帧: 累计 %d 帧", drop)
                            last_drop = drop
                    except ValueError:
                        pass
                elif any(k in line.lower() for k in ("error", "invalid", "failed", "unable", "no such")):
                    logger.warning("ffmpeg: %s", line)
        except Exception:
            pass
        rc = process.poll()
        if rc not in (None, 0, 255):  # 255 = ffmpeg quit gracefully via 'q'
            # 打印最后 20 行帮助诊断
            tail = lines[-20:] if len(lines) > 20 else lines
            logger.error("ffmpeg 异常退出 (rc=%d):\n%s", rc, "\n".join(tail))

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

    @property
    def pid(self) -> int | None:
        """返回 ffmpeg 进程 PID（录制中才有效）"""
        return self._process.pid if self._process else None

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
