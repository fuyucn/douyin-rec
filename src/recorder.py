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
        self._cookies = cookies  # 可选: 浏览器 cookie 字符串，用于 CDN 鉴权
        self._process: subprocess.Popen | None = None
        self._stderr_thread: threading.Thread | None = None
        self._last_exit_code: int | None = None

    # -- public API ----------------------------------------------------------

    def start(self) -> None:
        if self._process is not None:
            return
        Path(self._output_path).parent.mkdir(parents=True, exist_ok=True)

        # 判断 FLV 还是 HLS，以选择合适的 demuxer 和重连策略
        url_path = self._stream_url.split("?")[0].lower()
        is_flv = url_path.endswith(".flv")

        # 通用选项：超时 + 抖音 CDN Referer + 浏览器 UA + 丢弃损坏包
        headers = (
            "Referer: https://live.douyin.com\r\n"
            "User-Agent: Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36\r\n"
        )
        if self._cookies:
            headers += f"Cookie: {self._cookies}\r\n"

        # 基础 ffmpeg 参数（参考 StreamCap ffmpeg_builders/base.py）
        base_opts: list[str] = [
            "-loglevel", "error",
            "-hide_banner",
            "-rw_timeout", "15000000",           # 15 秒读写超时
            "-analyzeduration", "20000000",       # 提高流分析时长
            "-probesize", "10000000",             # 提高 probe 大小
            "-protocol_whitelist", "rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy",
            "-thread_queue_size", "1024",
            "-headers", headers,
            "-fflags", "+discardcorrupt+igndts",  # 丢弃损坏包 + 忽略 DTS 错误
        ]

        if is_flv:
            # FLV：不使用 ffmpeg 内置 -reconnect，由 task_manager 断流重连循环负责。
            # 内置重连会在重连后写入 CDN 绝对时间戳，造成 PTS 跳跃污染同一个 ts 文件。
            input_opts = base_opts + ["-f", "live_flv"]
        else:
            # HLS：启用 EOF 重连，demuxer 自动刷新 playlist
            input_opts = base_opts + [
                "-reconnect_streamed", "1",
                "-reconnect_at_eof", "1",
                "-reconnect_delay_max", "60",
            ]

        # 输出参数
        output_opts: list[str] = [
            "-bufsize", "8000k",
            "-sn", "-dn",                         # 跳过字幕和数据流
            "-max_muxing_queue_size", "1024",
            "-correct_ts_overflow", "1",
            "-avoid_negative_ts", "1",
            "-flush_packets", "1",
        ]
        if self._segment_duration > 0:
            output_opts += [
                "-c", "copy",
                "-f", "segment",
                "-segment_time", str(self._segment_duration),
                "-segment_format", "mpegts",
                "-reset_timestamps", "1",
                "-mpegts_flags", "+resend_headers",
            ]
        else:
            output_opts += ["-c", "copy", "-f", "mpegts"]

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
            args=(self._process, self._log_callback),
            daemon=True,
        )
        self._stderr_thread.start()

    def _monitor_stderr(self, process: subprocess.Popen, log_callback=None) -> None:
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
                    if log_callback:
                        log_callback(f"[ffmpeg] {line}")
        except Exception:
            pass
        rc = process.poll()
        self._last_exit_code = rc
        if rc not in (None, 0, 255):  # 255 = ffmpeg quit gracefully via 'q'
            tail = lines[-10:] if len(lines) > 10 else lines
            msg = f"ffmpeg 异常退出 (rc={rc}): {'; '.join(tail)}"
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
        ext: 扩展名，默认 "ts"，直接下载时传 "flv"
        """
        now = datetime.now()
        base = f"{name}_{now:%Y-%m-%d}_{now:%H-%M-%S}"
        output_dir.mkdir(parents=True, exist_ok=True)
        if segment:
            pattern = str(output_dir / f"{base}_%03d.{ext}")
            return pattern, base
        path = str(output_dir / f"{base}.{ext}")
        return path, base
