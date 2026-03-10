"""抖音直播流源

使用 streamget (https://github.com/ihmily/streamget) 提取直播流地址，
支持 live.douyin.com、v.douyin.com 短链接、用户主页链接等各种 URL 格式。
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

import cv2

from src.config import InputConfig
from src.models import FrameInfo

logger = logging.getLogger(__name__)


class LiveNotStarted(Exception):
    """直播间未开播"""


_MAX_RECONNECT_ATTEMPTS = 5
_RECONNECT_DELAY = 3.0  # 秒

# streamget 画质代码 ↔ 本项目画质名称
_QUALITY_MAP = {
    "origin": "OD",
    "uhd": "UHD",
    "hd": "HD",
    "sd": "SD",
    "ld": "LD",
}


def _run_async(coro):
    """在同步上下文中运行 async 函数"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        # 已在 event loop 中（例如 uvicorn），用新线程跑
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
        self._flv_url: str | None = None  # FLV 备用地址（ByteVC1 fallback 用）
        self._cap: cv2.VideoCapture | None = None
        self._frame_index = 0
        self.streamer_name: str | None = None  # 主播昵称 (连接后可用)

    # -- streamget 封装 -------------------------------------------------------

    def _get_douyin_client(self):
        from streamget import DouyinLiveStream
        cookies = self._get_cookie_string()
        return DouyinLiveStream(cookies=cookies or "")

    def _fetch_stream_data(self) -> dict:
        """用 streamget 获取直播间数据（供 extract_streamer_info 使用）

        优先 fetch_app_stream_data（支持短链接/用户主页，且 ORIGIN 画质更可靠），
        失败时回退 fetch_web_stream_data（仅支持 live.douyin.com 直链，ORIGIN 可能缺失）。
        """
        client = self._get_douyin_client()

        async def _fetch():
            try:
                return await client.fetch_app_stream_data(self._url)
            except Exception as e:
                logger.warning("App API 失败 (%s)，回退 Web API（ORIGIN 画质可能降级）", e)
            return await client.fetch_web_stream_data(self._url)

        data = _run_async(_fetch())
        if not data:
            raise RuntimeError(f"streamget 返回数据为空: {self._url}")
        return data

    # -- 等待开播 ---------------------------------------------------------------

    def extract_streamer_info(self) -> str | None:
        """提取主播昵称（不要求开播），返回昵称或 None。"""
        try:
            data = self._fetch_stream_data()
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
                url = self._extract_stream_url()
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

    # -- internal helpers ----------------------------------------------------

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

    def _extract_stream_url(self) -> str:
        """提取直播流地址：合并两次 API 调用，共享同一客户端实例"""
        quality = _QUALITY_MAP.get(self._config.quality.lower(), "OD")

        async def _fetch():
            client = self._get_douyin_client()
            # App API 优先：支持短链接，且总能可靠提取 ORIGIN 画质
            data = None
            try:
                data = await client.fetch_app_stream_data(self._url)
            except Exception as e:
                logger.warning("App API 失败 (%s)，回退 Web API（ORIGIN 画质可能降级）", e)
            if data is None:
                try:
                    data = await client.fetch_web_stream_data(self._url)
                except Exception as e:
                    # 两个 API 均失败：streamget 无法解析页面，通常表示主播未开播
                    logger.debug("Web API 也失败 (%s)，视为未开播", e)
                    raise LiveNotStarted(f"无法获取直播间数据（可能未开播）: {self._url}") from e
            if not data:
                raise LiveNotStarted(f"streamget 返回数据为空: {self._url}")
            # 未开播时直接返回，无需提取流地址
            if data.get("status", 0) == 4:
                return data, None
            # 同一客户端、同一 async 上下文，避免重复开销
            stream = await client.fetch_stream_url(data, quality)
            return data, stream

        data, stream = _run_async(_fetch())

        # 提取主播昵称
        nickname = data.get("anchor_name")
        if nickname:
            self.streamer_name = nickname
            logger.info("主播: %s", nickname)

        # 检查是否开播 (status=2 开播, status=4 未开播)
        if data.get("status", 0) == 4:
            raise LiveNotStarted(f"直播间未开播: {self._url}")

        flv_url    = getattr(stream, "flv_url",    None)
        record_url = getattr(stream, "record_url", None)
        m3u8_url   = getattr(stream, "m3u8_url",   None)
        self._flv_url = flv_url  # 存储供 ByteVC1 fallback 使用

        # URL 选择策略：
        #
        # FLV URL 中的 codec 参数不可信 —— 某些 CDN 节点实际推送 ByteVC1（抖音私有
        # H.265 变体），但 URL 仍标注 codec=h264，导致 ffmpeg SIGSEGV (rc=-11)。
        #
        # 录制优先 FLV：FLV 是连续流，无分段开销，实测码率比同画质 HLS 更高更稳定。
        # ByteVC1 崩溃由 task_manager 断流重连循环兜底（检测到 rc=-11 则换 record_url）。
        #   1. flv_url codec=h264  → 优先（最高码率）
        #   2. record_url codec=h264（M3U8，streamget 已验证）→ FLV 不可用时次选
        #   3. flv_url（H265/ByteVC1）→ 再次选
        #   4. 兜底：任意可用地址
        _H265_CODECS = {"h265", "hevc", "bytevc1", "bytevc2"}

        def _codec(u: str | None) -> str:
            if not u:
                return ""
            m = re.search(r"[?&]codec=([^&]+)", u)
            return m.group(1).lower() if m else ""

        flv_codec = _codec(flv_url)
        if flv_url and flv_codec == "h264":
            url = flv_url                              # FLV 明确 H.264，码率最高最稳定
        elif record_url and _codec(record_url) not in _H265_CODECS:
            url = record_url                           # M3U8，streamget 已验证；FLV codec 未知时优先此项
        elif flv_url and flv_codec not in _H265_CODECS:
            url = flv_url                              # FLV codec 未知，无 M3U8 时才选
        elif flv_url:
            url = flv_url                              # H265 FLV 最后兜底
        else:
            url = record_url or m3u8_url               # 最终兜底

        if not url:
            raise RuntimeError(f"streamget 未返回可用流地址 (画质={quality})")

        proto = "M3U8" if url.split("?")[0].lower().endswith(".m3u8") else "FLV"
        codec = _codec(url) or "?"
        logger.info("获取到流地址: %s codec=%s 画质=%s", proto, codec, quality)
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
