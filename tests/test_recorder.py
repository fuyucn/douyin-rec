"""测试 StreamRecorder"""

import re
import signal
from pathlib import Path
from unittest.mock import patch, MagicMock

from src.recorder import StreamRecorder
from src.dlr.recorder import build_ffmpeg_command


def test_make_output_path_no_segment(tmp_path):
    """非分段模式返回 .ts 文件路径"""
    path, display = StreamRecorder.make_output_path("主播", tmp_path, segment=False)
    assert path.endswith(".ts")
    assert "%03d" not in path
    assert "主播" in path
    assert "主播" in display
    # 日期格式: YYYY-MM-DD_HH-MM-SS
    assert re.search(r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}", path)


def test_make_output_path_with_segment(tmp_path):
    """分段模式返回模式串 (含 %03d)"""
    path, display = StreamRecorder.make_output_path("主播", tmp_path, segment=True)
    assert "%03d" in path
    assert path.endswith(".ts")
    assert "主播" in display


def test_make_output_path_creates_dir(tmp_path):
    """输出目录不存在时自动创建"""
    out = tmp_path / "sub" / "dir"
    assert not out.exists()
    StreamRecorder.make_output_path("test", out, segment=False)
    assert out.exists()


def test_recorder_init():
    """StreamRecorder 初始化"""
    rec = StreamRecorder("http://example.com/stream", "/tmp/test.ts", segment_duration=1800)
    assert rec._stream_url == "http://example.com/stream"
    assert rec._output_path == "/tmp/test.ts"
    assert rec._segment_duration == 1800
    assert rec._process is None
    assert rec.is_running is False


def test_recorder_start_segment(tmp_path):
    """分段模式下 ffmpeg 命令包含 segment 参数"""
    out = str(tmp_path / "test_%03d.ts")
    rec = StreamRecorder("http://example.com/stream", out, segment_duration=1800)

    mock_proc = MagicMock()
    mock_proc.poll.return_value = None

    with patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
        rec.start()
        cmd = mock_popen.call_args[0][0]
        assert "-f" in cmd
        idx = cmd.index("-f")
        assert cmd[idx + 1] == "segment"
        assert "-segment_time" in cmd
        assert "1800" in cmd
        assert "-segment_format" in cmd
        idx2 = cmd.index("-segment_format")
        assert cmd[idx2 + 1] == "mpegts"
        assert "-fflags" in cmd
        idx3 = cmd.index("-fflags")
        assert "+discardcorrupt" in cmd[idx3 + 1]
        assert "-movflags" not in cmd
        rec._process = None  # cleanup


def test_recorder_start_no_segment(tmp_path):
    """非分段模式下 ffmpeg 命令不包含 -segment_time，使用 -c:v copy"""
    out = str(tmp_path / "test.ts")
    rec = StreamRecorder("http://example.com/stream", out, segment_duration=0)

    mock_proc = MagicMock()
    mock_proc.poll.return_value = None

    with patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
        rec.start()
        cmd = mock_popen.call_args[0][0]
        assert "-segment_time" not in cmd
        assert "-c:v" in cmd
        idx = cmd.index("-c:v")
        assert cmd[idx + 1] == "copy"
        assert "-movflags" not in cmd
        rec._process = None  # cleanup


def test_recorder_stop():
    """stop() 发送 SIGINT 停止 ffmpeg 进程（非 Windows）"""
    rec = StreamRecorder("http://example.com/stream", "/tmp/test.ts")
    mock_proc = MagicMock()
    mock_proc.stdin = MagicMock()
    mock_proc.wait.return_value = 0
    rec._process = mock_proc

    with patch("os.name", "posix"):
        rec.stop()

    mock_proc.send_signal.assert_called_once_with(signal.SIGINT)
    mock_proc.wait.assert_called()
    assert rec._process is None


def test_recorder_is_running():
    """is_running 属性"""
    rec = StreamRecorder("http://example.com/stream", "/tmp/test.ts")
    assert rec.is_running is False

    mock_proc = MagicMock()
    mock_proc.poll.return_value = None  # 进程还在跑
    rec._process = mock_proc
    assert rec.is_running is True

    mock_proc.poll.return_value = 0  # 进程已退出
    assert rec.is_running is False


def test_build_ffmpeg_command_dlr_params():
    """build_ffmpeg_command 包含所有 DLR 关键参数"""
    cmd = build_ffmpeg_command("http://example.com/live.flv", "/tmp/out.ts")
    assert "-rw_timeout" in cmd
    assert "15000000" in cmd
    assert "-fflags" in cmd
    assert "+discardcorrupt" in cmd
    assert "-analyzeduration" in cmd
    assert "-probesize" in cmd
    assert "-correct_ts_overflow" in cmd
    assert "-avoid_negative_ts" in cmd
    assert "-movflags" not in cmd


def test_build_ffmpeg_command_with_cookies():
    """cookies 参数正确注入为 -headers"""
    cmd = build_ffmpeg_command("http://example.com/live.flv", "/tmp/out.ts", cookies="sid=abc")
    assert "-headers" in cmd
    idx = cmd.index("-headers")
    assert "Cookie:sid=abc" in cmd[idx + 1]


def test_build_ffmpeg_command_segment():
    """分段模式包含 -segment_format mpegts"""
    cmd = build_ffmpeg_command("http://example.com/live.flv", "/tmp/out_%03d.ts", segment_duration=1800)
    assert "-segment_format" in cmd
    idx = cmd.index("-segment_format")
    assert cmd[idx + 1] == "mpegts"
    assert "-reset_timestamps" in cmd
