"""抖音直播流源

使用自实现的 DouyinSpider（移植自 DouyinLiveRecorder）提取直播流地址，
支持 live.douyin.com、v.douyin.com 短链接、用户主页链接等各种 URL 格式。

不依赖 streamget，不依赖 execjs / Node.js。
"""

from __future__ import annotations

import asyncio
import logging
import time

import cv2

from src.config import InputConfig
from src.models import FrameInfo
from src.input.douyin_spider import (
    get_douyin_stream_data,
    get_douyin_stream_url,
)

logger = logging.getLogger(__name__)


class LiveNotStarted(Exception):
    """直播间未开播"""


_MAX_RECONNECT_ATTEMPTS = 5
_RECONNECT_DELAY = 3.0  # 秒


def _run_async(coro):
    """在同步上下文中运行 async 函数"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, coro).result()
    return asyncio.run(coro)


class DouyinLiveSource:
    """从抖音直播页面抓取视频帧

    支持两种 cookie 配置方式:
    1. cookies: 原始 cookie 字符串 (从浏览器复制, 如 "ttwid=xxx; sessionid=yyy")
    2. cookies_file: Netscape 格式 cookies.txt 文件路径
    """

    def __init__(self, url: str, config: InputConfig | None = None) -> None:
        self._url = url
        self._config = config or InputConfig()
        self._stream_url: str | None = None
        self._flv_url: str | None = None
        self._m3u8_url: str | None = None
        self._cap: cv2.VideoCapture | None = None
        self._frame_index = 0
        self.streamer_name: str | None = None  # 主播昵称 (连接后可用)

    # -- 内部方法 ---------------------------------------------------------------

    def _get_cookie_string(self) -> str | None:
        """获取 cookie 字符串"""
        if self._config.cookies:
            return self._config.cookies
        if self._config.cookies_file:
            return self._load_cookies_from_file(self._config.cookies_file)
        return None

    @staticmethod
    def _load_cookies_from_file(path: str) -> str:
        """从 Netscape cookies.txt 文件读取并转换为 cookie 字符串"""
        cookies = []
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) >= 7:
                    cookies.append(f"{parts[5]}={parts[6]}")
        return "; ".join(cookies)

    def _fetch_room_data(self) -> dict:
        """获取直播间原始数据"""
        cookies = self._get_cookie_string()
        return _run_async(get_douyin_stream_data(self._url, cookies=cookies))

    def _extract_stream_url(self, log_fn=None) -> str:
        """提取直播流地址，更新 streamer_name 和 _flv_url。
        log_fn: 可选回调 (str) -> None，将关键决策路由到任务日志。
        与 biliLive-tools 一致：FLV 优先，HLS 作 fallback，不做 codec 检测。
        """
        def _log(msg: str) -> None:
            logger.info(msg)
            if log_fn:
                log_fn(msg)

        cookies = self._get_cookie_string()
        quality = self._config.quality.lower()

        async def _fetch():
            room_data = await get_douyin_stream_data(self._url, cookies=cookies)
            stream_info = await get_douyin_stream_url(room_data, quality=quality)
            return room_data, stream_info

        room_data, stream_info = _run_async(_fetch())

        # 提取主播昵称
        nickname = room_data.get("anchor_name")
        if nickname:
            self.streamer_name = nickname
            logger.info("主播: %s", nickname)

        # 检查是否开播 (status=2 开播, status=4 未开播)
        if room_data.get("status", 0) == 4 or not stream_info.get("is_live"):
            raise LiveNotStarted(f"直播间未开播: {self._url}")

        flv_url = stream_info.get("flv_url")
        m3u8_url = stream_info.get("m3u8_url")
        self._flv_url = flv_url
        self._m3u8_url = m3u8_url

        def _url_base(u: str | None) -> str:
            return u.split("?")[0] if u else "(无)"

        # URL 选择策略（FLV 优先，HLS fallback）
        # macOS 特殊处理：_Stage0T000*.flv 是 ByteVC1 passthrough，在 macOS ffmpeg 上必 SIGSEGV
        # biliLive-tools 在 Win/Linux 无此问题，但我们需要绕过
        def _is_bytevc1_path(u: str | None) -> bool:
            if not u:
                return False
            path = u.split("?")[0]
            return "_Stage0T000" in path

        if flv_url and not _is_bytevc1_path(flv_url):
            url = flv_url
        elif m3u8_url:
            if _is_bytevc1_path(flv_url):
                _log(f"[流] FLV 为 ByteVC1 (_Stage0T000)，改用 M3U8")
            url = m3u8_url
        elif flv_url:
            url = flv_url  # 最后兜底，即使是 ByteVC1 也尝试
        else:
            raise RuntimeError(f"未能获取到可用流地址 (画质={quality})")

        proto = "M3U8" if url.split("?")[0].lower().endswith(".m3u8") else "FLV"
        _log(f"[流] 选择: {proto} | 画质={quality}")
        _log(f"[URL] {proto}: {_url_base(url)}")
        return url

    def _open_stream(self) -> cv2.VideoCapture:
        cap = cv2.VideoCapture(self._stream_url)
        if not cap.isOpened():
            raise ConnectionError(f"无法连接直播流: {self._stream_url}")
        return cap

    def _reconnect(self) -> bool:
        """尝试重连直播流，成功返回 True"""
        for attempt in range(1, _MAX_RECONNECT_ATTEMPTS + 1):
            logger.warning("直播流断开，第 %d 次重连…", attempt)
            if self._cap is not None:
                self._cap.release()
                self._cap = None
            time.sleep(_RECONNECT_DELAY)
            try:
                self._stream_url = self._extract_stream_url()
                self._cap = self._open_stream()
                logger.info("重连成功")
                return True
            except Exception:
                logger.exception("重连失败")
        logger.error("已达最大重连次数 %d，放弃", _MAX_RECONNECT_ATTEMPTS)
        return False

    # -- 等待开播 ---------------------------------------------------------------

    def extract_streamer_info(self) -> str | None:
        """提取主播昵称（不要求开播），返回昵称或 None。"""
        try:
            data = self._fetch_room_data()
            nickname = data.get("anchor_name")
            if nickname:
                self.streamer_name = nickname
                logger.info("主播: %s", nickname)
                return nickname
        except Exception as e:
            logger.debug("获取主播信息失败: %s", e)
        return None

    def wait_for_live(
        self,
        poll_interval: float = 180,
        on_status=None,
        stop_event=None,
        show_countdown: bool = False,
        schedule_check=None,
    ) -> str:
        """轮询等待直播开播，返回 stream_url。

        on_status: 可选回调 (message: str) -> None，用于 UI 显示状态。
        stop_event: 可选 threading.Event，被 set 时中止等待。
        show_countdown: 是否通过 on_status 显示倒计时秒数。
        schedule_check: 可选回调 () -> bool，返回 False 时中止等待（定时窗口结束）。
        """
        while True:
            if stop_event and stop_event.is_set():
                raise InterruptedError("用户取消等待")
            if schedule_check and not schedule_check():
                raise InterruptedError("定时窗口结束")
            try:
                url = self._extract_stream_url(log_fn=on_status)
                if on_status:
                    on_status("直播已开播，获取到流地址")
                return url
            except LiveNotStarted:
                msg = f"直播间未开播，{int(poll_interval)} 秒后重试..."
                logger.info(msg)
                if on_status:
                    on_status(msg)
            except Exception as e:
                msg = f"获取流地址出错: {e}，{int(poll_interval)} 秒后重试..."
                logger.warning(msg)
                if on_status:
                    on_status(msg)
            # 分段 sleep 以便及时响应 stop_event 和 schedule_check
            elapsed = 0.0
            while elapsed < poll_interval:
                if stop_event and stop_event.is_set():
                    raise InterruptedError("用户取消等待")
                if schedule_check and not schedule_check():
                    raise InterruptedError("定时窗口结束")
                time.sleep(min(1.0, poll_interval - elapsed))
                elapsed += 1.0
                if show_countdown and on_status:
                    remaining = int(poll_interval - elapsed)
                    if remaining > 0 and int(elapsed) % 10 == 0:
                        on_status(f"距下次检测还有 {remaining} 秒")

    # -- public API ----------------------------------------------------------

    def open(self) -> None:
        if self._cap is not None:
            return
        logger.info("正在提取直播流地址: %s", self._url)
        self._stream_url = self._extract_stream_url()
        logger.info("直播流地址: %s", self._stream_url)
        self._cap = self._open_stream()
        self._frame_index = 0
        logger.info("已连接直播流  fps=%.2f", self.fps)

    def read_frame(self) -> FrameInfo | None:
        if self._cap is None:
            raise RuntimeError("直播源尚未打开，请先调用 open()")
        ret, frame = self._cap.read()
        if not ret:
            if not self._reconnect():
                return None
            ret, frame = self._cap.read()
            if not ret:
                return None
        timestamp = self._frame_index / max(self.fps, 1.0)
        info = FrameInfo(
            frame=frame,
            timestamp=timestamp,
            frame_index=self._frame_index,
            source=self._url,
        )
        self._frame_index += 1
        return info

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None
            logger.info("已关闭直播流 %s", self._url)

    # -- properties ----------------------------------------------------------

    @property
    def stream_url(self) -> str | None:
        """直播流地址（open() 后可用）"""
        return self._stream_url

    @property
    def fps(self) -> float:
        if self._cap is None:
            raise RuntimeError("直播源尚未打开，请先调用 open()")
        return float(self._cap.get(cv2.CAP_PROP_FPS)) or 25.0

    @property
    def total_frames(self) -> int | None:
        return None  # 直播流没有总帧数

    # -- context manager -----------------------------------------------------

    def __enter__(self) -> DouyinLiveSource:
        self.open()
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
