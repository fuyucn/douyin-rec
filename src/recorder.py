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
        log_callback=None,
        cookies: str | None = None,
    ) -> None:
        self._stream_url = stream_url
        self._output_path = str(output_path)
        self._segment_duration = segment_duration
        self._log_callback = log_callback  # 可选: (msg: str) -> None，转发 ffmpeg 错误到 task log
        self._cookies = cookies  # 可选: 传给 ffmpeg -headers "Cookie: xxx"
        self._process: subprocess.Popen | None = None
        self._stderr_thread: threading.Thread | None = None
        self._last_exit_code: int | None = None

    # -- public API ----------------------------------------------------------

    def start(self) -> None:
        if self._process is not None:
            return
        Path(self._output_path).parent.mkdir(parents=True, exist_ok=True)

        # ffmpeg 参数与 biliLive-tools DouYinRecorder 完全对齐
        # 参考: packages/DouYinRecorder/src/index.ts + packages/liveManager/src/downloader/FFmpegDownloader.ts
        user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/73.0.3683.86 Safari/537.36"
        )

        url_path = self._stream_url.split("?")[0].lower()
        is_m3u8 = url_path.endswith(".m3u8")

        # 输入参数（ffmpegInputOptions from DouYinRecorder index.ts）
        # -loglevel debug: biliLive-tools 实测必加，防止从 Python subprocess 启动时 SIGSEGV (rc=-11)
        input_opts: list[str] = [
            "-loglevel", "debug",
            "-rw_timeout", "10000000",
            "-timeout", "10000000",
            "-user_agent", user_agent,
        ]
        # Cookie header（若提供）
        if self._cookies:
            input_opts += ["-headers", f"Cookie:{self._cookies}\r\n"]
        # HLS reconnect（FFmpegDownloader.ts createCommand: isHls 时追加）
        if is_m3u8:
            input_opts += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "3"]

        # 输出参数（FFmpegDownloader.ts buildOutputOptions）
        output_opts: list[str] = [
            "-c", "copy",
            "-movflags", "+frag_keyframe+empty_moov+separate_moof",
            "-fflags", "+genpts+igndts",
            "-min_frag_duration", "10000000",
        ]
        if self._segment_duration > 0:
            output_opts += [
                "-f", "segment",
                "-segment_time", str(self._segment_duration),
                "-reset_timestamps", "1",
            ]

        cmd = (
            ["ffmpeg", "-y"]
            + input_opts
            + ["-i", self._stream_url]
            + output_opts
            + [self._output_path]
        )

        proto_label = "HLS" if url_path.endswith(".m3u8") else "FLV"
        logger.info("开始录制 (%s): %s", proto_label, self._output_path)
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
            args=(self._process, self._log_callback),
            daemon=True,
        )
        self._stderr_thread.start()

    def _monitor_stderr(self, process: subprocess.Popen, log_callback=None) -> None:
        """持续读取 ffmpeg stderr，记录错误行"""
        lines: list[str] = []
        try:
            for raw in process.stderr:
                line = raw.decode(errors="replace").strip()
                if not line:
                    continue
                # 跳过进度行（frame= / fps= / time= 等）
                if any(line.startswith(k) for k in ("frame=", "fps=", "size=", "time=", "bitrate=", "speed=", "video:", "audio:", "  ")):
                    continue
                lines.append(line)
                if any(k in line.lower() for k in ("error", "invalid", "failed", "unable", "no such")):
                    logger.warning("ffmpeg: %s", line)
                    if log_callback:
                        log_callback(f"[ffmpeg] {line}")
        except Exception:
            pass
        rc = process.poll()
        self._last_exit_code = rc
        if rc not in (None, 0, 255):  # 255 = ffmpeg quit gracefully via 'q'
            err_lines = [l for l in lines if any(k in l.lower() for k in ("error", "invalid", "failed", "unable", "no such", "moov", "broken", "corrupt", "refused", "403", "404", "connection"))]
            tail = (err_lines[-5:] if err_lines else lines[-5:]) if lines else []
            msg = f"ffmpeg 异常退出 (rc={rc}): {'; '.join(tail)}" if tail else f"ffmpeg 异常退出 (rc={rc}): (无输出)"
            logger.error(msg)
            if log_callback:
                log_callback(f"[ffmpeg] {msg}")

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
    def last_exit_code(self) -> int | None:
        """ffmpeg 最近一次退出码（None = 未退出）"""
        return self._last_exit_code

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
        name: str, output_dir: Path, segment: bool = False, ext: str = "ts",
    ) -> tuple[str, str]:
        """生成输出路径和显示名。

        返回 (path_or_pattern, display_name):
        - 分段模式: ("{dir}/{name}_2026-02-26_12-30-05_%03d.ts", "name_2026-02-26_12-30-05")
        - 非分段:   ("{dir}/{name}_2026-02-26_12-30-05.ts", 同上)
        ext: 扩展名，默认 "ts"
        """
        now = datetime.now()
        base = f"{name}_{now:%Y-%m-%d}_{now:%H-%M-%S}"
        output_dir.mkdir(parents=True, exist_ok=True)
        if segment:
            pattern = str(output_dir / f"{base}_%03d.{ext}")
            return pattern, base
        path = str(output_dir / f"{base}.{ext}")
        return path, base
