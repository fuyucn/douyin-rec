"""测试直播流源"""

import tempfile
import threading
from unittest.mock import patch, MagicMock, AsyncMock

from src.config import InputConfig
from src.input.live import DouyinLiveSource, LiveNotStarted, _run_async
from src.input.douyin_spider import QUALITY_MAP as _QUALITY_MAP


def test_quality_map():
    """画质映射完整性"""
    assert _QUALITY_MAP["origin"] == "OD"
    assert _QUALITY_MAP["uhd"] == "UHD"
    assert _QUALITY_MAP["hd"] == "HD"
    assert _QUALITY_MAP["sd"] == "SD"
    assert _QUALITY_MAP["ld"] == "LD"


def test_init_defaults():
    """DouyinLiveSource 默认初始化"""
    source = DouyinLiveSource("https://live.douyin.com/123")
    assert source._url == "https://live.douyin.com/123"
    assert source._stream_url is None
    assert source._cap is None
    assert source.streamer_name is None
    assert source.stream_url is None
    assert source.total_frames is None


def test_init_with_config():
    """使用自定义配置"""
    config = InputConfig(quality="hd", cookies="test=1")
    source = DouyinLiveSource("https://live.douyin.com/123", config=config)
    assert source._config.quality == "hd"
    assert source._config.cookies == "test=1"


def test_get_cookie_string_from_config():
    """从 config.cookies 获取 cookie"""
    config = InputConfig(cookies="ttwid=xxx; sessionid=yyy")
    source = DouyinLiveSource("http://test", config=config)
    assert source._get_cookie_string() == "ttwid=xxx; sessionid=yyy"


def test_get_cookie_string_from_file():
    """从 cookies.txt 文件读取 cookie"""
    content = """# Netscape HTTP Cookie File
.douyin.com\tTRUE\t/\tFALSE\t0\tttwid\tvalue1
.douyin.com\tTRUE\t/\tFALSE\t0\tsid\tvalue2
"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write(content)
        f.flush()
        config = InputConfig(cookies_file=f.name)
        source = DouyinLiveSource("http://test", config=config)
        result = source._get_cookie_string()
        assert "ttwid=value1" in result
        assert "sid=value2" in result


def test_get_cookie_string_none():
    """无 cookie 配置时返回 None"""
    source = DouyinLiveSource("http://test")
    assert source._get_cookie_string() is None


def test_run_async():
    """_run_async 能正常执行异步函数"""
    async def add(a, b):
        return a + b
    result = _run_async(add(1, 2))
    assert result == 3


def test_extract_stream_url_live_not_started():
    """status == 4 时应抛出 LiveNotStarted，且主播名已设置"""
    source = DouyinLiveSource("https://live.douyin.com/123")
    mock_room = {"anchor_name": "测试主播", "status": 4}
    mock_stream = {"is_live": False}

    with patch("src.input.live.get_douyin_stream_data", return_value=mock_room), \
         patch("src.input.live.get_douyin_stream_url", return_value=mock_stream):
        try:
            source._extract_stream_url()
            assert False, "应抛出 LiveNotStarted"
        except LiveNotStarted:
            assert source.streamer_name == "测试主播"


def test_extract_streamer_info_success():
    """提取主播昵称"""
    source = DouyinLiveSource("https://live.douyin.com/123")
    mock_data = {"anchor_name": "一勺小苏打"}

    with patch.object(source, "_fetch_room_data", return_value=mock_data):
        name = source.extract_streamer_info()
        assert name == "一勺小苏打"
        assert source.streamer_name == "一勺小苏打"


def test_extract_streamer_info_failure():
    """提取主播信息失败返回 None"""
    source = DouyinLiveSource("https://live.douyin.com/123")

    with patch.object(source, "_fetch_room_data", side_effect=RuntimeError("fail")):
        name = source.extract_streamer_info()
        assert name is None


def test_wait_for_live_immediate():
    """直播已开播时立即返回"""
    source = DouyinLiveSource("https://live.douyin.com/123")

    with patch.object(source, "_extract_stream_url", return_value="http://stream.url"):
        url = source.wait_for_live(poll_interval=1)
        assert url == "http://stream.url"


def test_wait_for_live_stop_event():
    """stop_event 被设置时中断等待"""
    source = DouyinLiveSource("https://live.douyin.com/123")
    stop = threading.Event()
    stop.set()

    with patch.object(source, "_extract_stream_url", side_effect=LiveNotStarted("未开播")):
        try:
            source.wait_for_live(poll_interval=1, stop_event=stop)
            assert False, "应抛出 InterruptedError"
        except InterruptedError:
            pass
