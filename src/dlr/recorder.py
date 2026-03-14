"""DLR 风格 ffmpeg 录制命令构建与停止（对齐 DouyinLiveRecorder main.py lines 1175-1195）"""

import os
import signal
import subprocess

_DLR_UA = (
    "Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 "
    "(KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36"
)


def build_ffmpeg_command(
    stream_url: str,
    output_path: str,
    segment_duration: int = 0,
    cookies: str | None = None,
) -> list[str]:
    """构建 DLR 风格 ffmpeg 命令（main.py lines 1175-1195 + TS 输出）"""
    cmd = [
        "ffmpeg", "-y",
        "-rw_timeout", "15000000",
        "-loglevel", "debug",
        "-hide_banner",
        "-user_agent", _DLR_UA,
        "-protocol_whitelist", "rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy",
        "-thread_queue_size", "1024",
        "-analyzeduration", "20000000",
        "-probesize", "10000000",
        "-fflags", "+discardcorrupt",
    ]
    if cookies:
        cmd += ["-headers", f"Cookie:{cookies}\r\n"]
    cmd += [
        "-i", stream_url,
        "-bufsize", "8000k",
        "-sn", "-dn",
        "-reconnect_delay_max", "60",
        "-reconnect_streamed", "-reconnect_at_eof",
        "-max_muxing_queue_size", "1024",
        "-correct_ts_overflow", "1",
        "-avoid_negative_ts", "1",
    ]
    if segment_duration > 0:
        cmd += [
            "-c:v", "copy",
            "-c:a", "copy",
            "-map", "0",
            "-f", "segment",
            "-segment_time", str(segment_duration),
            "-segment_format", "mpegts",
            "-reset_timestamps", "1",
            output_path,
        ]
    else:
        cmd += [
            "-c:v", "copy",
            "-c:a", "copy",
            "-map", "0",
            "-f", "mpegts",
            output_path,
        ]
    return cmd


def stop_ffmpeg(process: subprocess.Popen, timeout: int = 10) -> None:
    """DLR 风格停止 ffmpeg（check_subprocess lines 441-447）"""
    try:
        if os.name == "nt":
            process.stdin.write(b"q")
            process.stdin.close()
        else:
            process.send_signal(signal.SIGINT)
    except (OSError, BrokenPipeError):
        pass
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
