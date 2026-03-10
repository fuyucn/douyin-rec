"""直接 HTTP 字节流下载器 — 绕过 ffmpeg，用于 ByteVC1 等 ffmpeg 不兼容的流

参考 StreamCap DirectStreamDownloader 实现，适配为同步 threading 模型。
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

_DEFAULT_HEADERS = {
    "Referer": "https://live.douyin.com",
    "User-Agent": (
        "Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36"
    ),
}


class DirectStreamDownloader:
    """用 httpx 直接 HTTP GET 下载 FLV 流，原始字节写入文件。

    不依赖 ffmpeg，不解析 codec，ByteVC1 完全透明。
    接口与 StreamRecorder 保持兼容（start/stop/is_running/last_exit_code/pid）。
    """

    def __init__(
        self,
        stream_url: str,
        output_path: str | Path,
        cookies: str | None = None,
        log_callback=None,
        chunk_size: int = 16 * 1024,  # 16 KB
    ) -> None:
        self._url = stream_url
        self._output_path = Path(output_path)
        self._cookies = cookies
        self._log = log_callback or (lambda msg: logger.info(msg))
        self._chunk_size = chunk_size

        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False

    # -- public API (StreamRecorder compatible) --------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._output_path.parent.mkdir(parents=True, exist_ok=True)
        self._stop_event.clear()
        self._running = True
        self._thread = threading.Thread(target=self._download, daemon=True, name="direct-dl")
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=10)
        self._running = False
        self._log(f"[直下] 已停止 → {self._output_path.name}")

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def last_exit_code(self) -> int | None:
        """直接下载无 subprocess，始终返回 None（不触发 ByteVC1 循环）"""
        return None

    @property
    def pid(self) -> int | None:
        """无子进程"""
        return None

    # -- internal --------------------------------------------------------------

    def _download(self) -> None:
        try:
            import httpx
        except ImportError:
            self._log("[直下] 缺少 httpx，请运行: uv add httpx")
            self._running = False
            return

        headers = dict(_DEFAULT_HEADERS)
        if self._cookies:
            headers["Cookie"] = self._cookies

        total_bytes = 0
        self._log(f"[直下] 开始下载: {self._url[:80]}...")
        try:
            with httpx.Client(headers=headers, timeout=None, follow_redirects=True) as client:
                with client.stream("GET", self._url) as resp:
                    if resp.status_code != 200:
                        self._log(f"[直下] HTTP {resp.status_code}，下载失败")
                        return
                    with open(self._output_path, "wb") as f:
                        for chunk in resp.iter_bytes(self._chunk_size):
                            if self._stop_event.is_set():
                                break
                            f.write(chunk)
                            total_bytes += len(chunk)
            mb = total_bytes / 1024 / 1024
            self._log(f"[直下] 完成，共 {mb:.1f} MB → {self._output_path.name}")
        except Exception as e:
            if not self._stop_event.is_set():
                self._log(f"[直下] 下载中断: {e}")
        finally:
            self._running = False
