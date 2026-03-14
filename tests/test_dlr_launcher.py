"""测试 DlrLauncher"""

import configparser
import os
import signal
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.dlr_launcher import DlrLauncher, write_dlr_config


# ── write_dlr_config 测试 ──────────────────────────────────────────


def test_write_dlr_config_creates_files(tmp_path):
    """write_dlr_config 创建 config.ini 和 URL_config.ini"""
    write_dlr_config(
        task_dir=tmp_path,
        url="https://live.douyin.com/123",
        name="测试主播",
        quality="origin",
        output_dir="/tmp/output",
        segment_sec=1800,
        poll_interval=180,
        max_threads=3,
    )
    assert (tmp_path / "config" / "config.ini").exists()
    assert (tmp_path / "config" / "URL_config.ini").exists()


def test_write_dlr_config_quality_mapping(tmp_path):
    """质量映射正确写入"""
    quality_cases = [
        ("origin", "原画"),
        ("uhd", "超清"),
        ("hd", "高清"),
        ("sd", "标清"),
        ("ld", "流畅"),
    ]
    for quality, expected_zh in quality_cases:
        write_dlr_config(
            task_dir=tmp_path,
            url="https://live.douyin.com/123",
            name="主播",
            quality=quality,
            output_dir="/tmp/out",
            segment_sec=1800,
            poll_interval=180,
            max_threads=3,
        )
        cfg = configparser.RawConfigParser()
        cfg.optionxform = str
        cfg.read(str(tmp_path / "config" / "config.ini"), encoding="utf-8-sig")
        assert cfg.get("录制设置", "原画|超清|高清|标清|流畅") == expected_zh


def test_write_dlr_config_segment_enabled(tmp_path):
    """分段开启时正确写入"""
    write_dlr_config(
        task_dir=tmp_path,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=900,
        poll_interval=180,
        max_threads=3,
    )
    cfg = configparser.RawConfigParser()
    cfg.optionxform = str
    cfg.read(str(tmp_path / "config" / "config.ini"), encoding="utf-8-sig")
    assert cfg.get("录制设置", "分段录制是否开启") == "是"
    assert cfg.get("录制设置", "视频分段时间(秒)") == "900"


def test_write_dlr_config_segment_disabled(tmp_path):
    """分段关闭时正确写入"""
    write_dlr_config(
        task_dir=tmp_path,
        url="https://live.douyin.com/123",
        name="主播",
        quality="hd",
        output_dir="/tmp/out",
        segment_sec=0,
        poll_interval=180,
        max_threads=3,
    )
    cfg = configparser.RawConfigParser()
    cfg.optionxform = str
    cfg.read(str(tmp_path / "config" / "config.ini"), encoding="utf-8-sig")
    assert cfg.get("录制设置", "分段录制是否开启") == "否"


def test_write_dlr_config_output_dir(tmp_path):
    """直播保存路径正确写入"""
    write_dlr_config(
        task_dir=tmp_path,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/custom/output/path",
        segment_sec=1800,
        poll_interval=180,
        max_threads=3,
    )
    cfg = configparser.RawConfigParser()
    cfg.optionxform = str
    cfg.read(str(tmp_path / "config" / "config.ini"), encoding="utf-8-sig")
    assert cfg.get("录制设置", "直播保存路径(不填则默认)") == "/custom/output/path"


def test_write_dlr_config_cookies(tmp_path):
    """cookies 写入 Cookie section"""
    write_dlr_config(
        task_dir=tmp_path,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=1800,
        poll_interval=180,
        max_threads=3,
        cookies="sid=abc123",
    )
    cfg = configparser.RawConfigParser()
    cfg.optionxform = str
    cfg.read(str(tmp_path / "config" / "config.ini"), encoding="utf-8-sig")
    assert cfg.get("Cookie", "抖音cookie") == "sid=abc123"


def test_write_dlr_config_no_cookies(tmp_path):
    """无 cookies 时写入空字符串"""
    write_dlr_config(
        task_dir=tmp_path,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=1800,
        poll_interval=180,
        max_threads=3,
        cookies=None,
    )
    cfg = configparser.RawConfigParser()
    cfg.optionxform = str
    cfg.read(str(tmp_path / "config" / "config.ini"), encoding="utf-8-sig")
    assert cfg.get("Cookie", "抖音cookie") == ""


def test_write_dlr_config_url_config(tmp_path):
    """URL_config.ini 包含 url,name 格式"""
    write_dlr_config(
        task_dir=tmp_path,
        url="https://live.douyin.com/999",
        name="浣浣",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=1800,
        poll_interval=180,
        max_threads=3,
    )
    content = (tmp_path / "config" / "URL_config.ini").read_text(encoding="utf-8-sig")
    assert "https://live.douyin.com/999" in content
    assert "浣浣" in content


def test_write_dlr_config_proxy_disabled(tmp_path):
    """代理默认关闭"""
    write_dlr_config(
        task_dir=tmp_path,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=1800,
        poll_interval=180,
        max_threads=3,
    )
    cfg = configparser.RawConfigParser()
    cfg.optionxform = str
    cfg.read(str(tmp_path / "config" / "config.ini"), encoding="utf-8-sig")
    assert cfg.get("录制设置", "是否使用代理ip(是/否)") == "否"


# ── DlrLauncher 测试 ──────────────────────────────────────────────


def test_dlr_launcher_start_calls_popen_with_new_session():
    """start() 以 start_new_session=True 调用 subprocess.Popen"""
    mock_proc = MagicMock()
    mock_proc.poll.return_value = None
    mock_proc.stdout = iter([])

    with patch("src.dlr_launcher.write_dlr_config") as mock_cfg, \
         patch("subprocess.Popen", return_value=mock_proc) as mock_popen, \
         patch("tempfile.mkdtemp", return_value="/tmp/dlr_task1_abc"), \
         patch("pathlib.Path.write_text"), \
         patch("pathlib.Path.mkdir"), \
         patch("pathlib.Path.symlink_to"):
        launcher = DlrLauncher(
            task_id=1,
            url="https://live.douyin.com/123",
            name="主播",
            quality="origin",
            output_dir="/tmp/out",
            segment_sec=1800,
            poll_interval=180,
        )
        launcher.start()

        mock_popen.assert_called_once()
        kwargs = mock_popen.call_args[1]
        assert kwargs.get("start_new_session") is True
        assert kwargs.get("stdout") == subprocess.PIPE
        assert kwargs.get("stderr") == subprocess.STDOUT

    launcher._process = None


def test_dlr_launcher_stop_calls_killpg():
    """stop() 调用 os.killpg(pgid, SIGTERM)"""
    mock_proc = MagicMock()
    mock_proc.poll.return_value = None  # 进程在运行
    mock_proc.wait.return_value = 0

    launcher = DlrLauncher(
        task_id=1,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=1800,
        poll_interval=180,
    )
    launcher._process = mock_proc
    launcher._tmpdir = None  # 跳过清理

    with patch("os.getpgid", return_value=12345) as mock_getpgid, \
         patch("os.killpg") as mock_killpg:
        launcher.stop()

    mock_killpg.assert_called_once_with(12345, signal.SIGTERM)
    assert launcher._process is None


def test_dlr_launcher_stop_no_process():
    """stop() 无进程时不报错"""
    launcher = DlrLauncher(
        task_id=1,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=1800,
        poll_interval=180,
    )
    launcher.stop()  # should not raise


def test_dlr_launcher_is_running_true():
    """is_running: 进程在运行时返回 True"""
    mock_proc = MagicMock()
    mock_proc.poll.return_value = None  # still running

    launcher = DlrLauncher(
        task_id=1,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=1800,
        poll_interval=180,
    )
    launcher._process = mock_proc
    assert launcher.is_running is True


def test_dlr_launcher_is_running_false_no_process():
    """is_running: 无进程时返回 False"""
    launcher = DlrLauncher(
        task_id=1,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=1800,
        poll_interval=180,
    )
    assert launcher.is_running is False


def test_dlr_launcher_is_running_false_exited():
    """is_running: 进程已退出时返回 False"""
    mock_proc = MagicMock()
    mock_proc.poll.return_value = 0  # exited

    launcher = DlrLauncher(
        task_id=1,
        url="https://live.douyin.com/123",
        name="主播",
        quality="origin",
        output_dir="/tmp/out",
        segment_sec=1800,
        poll_interval=180,
    )
    launcher._process = mock_proc
    assert launcher.is_running is False


def test_dlr_launcher_log_callback_called(tmp_path):
    """start() 后日志转发到 log_callback"""
    logs = []
    mock_proc = MagicMock()
    mock_proc.poll.return_value = None
    mock_proc.stdout = iter(["录制开始\n", "准备录制\n"])

    with patch("src.dlr_launcher.write_dlr_config"), \
         patch("subprocess.Popen", return_value=mock_proc), \
         patch("tempfile.mkdtemp", return_value=str(tmp_path)), \
         patch("pathlib.Path.write_text"), \
         patch("pathlib.Path.mkdir"), \
         patch("pathlib.Path.symlink_to"):
        launcher = DlrLauncher(
            task_id=2,
            url="https://live.douyin.com/123",
            name="主播",
            quality="hd",
            output_dir="/tmp/out",
            segment_sec=1800,
            poll_interval=180,
            log_callback=logs.append,
        )
        launcher.start()
        # 等待日志线程读完
        if launcher._log_thread:
            launcher._log_thread.join(timeout=2)

    dlr_logs = [l for l in logs if "[DLR]" in l]
    assert any("录制开始" in l for l in dlr_logs)

    launcher._process = None
