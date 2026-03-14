"""DlrLauncher — 将 DouyinLiveRecorder 作为隔离子进程运行"""

from __future__ import annotations

import configparser
import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

# vendor/DouyinLiveRecorder — git submodule，路径相对于本文件位置
_DLR_ROOT = Path(__file__).resolve().parent.parent / "vendor" / "DouyinLiveRecorder"
# 使用当前 venv 的 Python（已包含 DLR 所需的所有依赖）
_DLR_PYTHON = Path(sys.executable)

_QUALITY_MAP = {
    "origin": "原画",
    "uhd": "超清",
    "hd": "高清",
    "sd": "标清",
    "ld": "流畅",
}


def write_dlr_config(
    task_dir: Path,
    url: str,
    name: str,
    quality: str,
    output_dir: str,
    segment_sec: int,
    poll_interval: int,
    max_threads: int,
    cookies: str | None = None,
    custom_name: str | None = None,
) -> None:
    """在 task_dir/config/ 写入 DLR 所需的 config.ini 和 URL_config.ini"""
    cfg_dir = task_dir / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)

    quality_zh = _QUALITY_MAP.get(quality, "原画")
    segment_enabled = "是" if segment_sec > 0 else "否"

    config = configparser.RawConfigParser()
    config.optionxform = str  # 保留 key 大小写（含中文）

    config["录制设置"] = {
        "language(zh_cn/en)": "zh_cn",
        "是否跳过代理检测(是/否)": "是",
        "直播保存路径(不填则默认)": output_dir,
        "保存文件夹是否以作者区分": "否",
        "保存文件夹是否以时间区分": "否",
        "保存文件夹是否以标题区分": "否",
        "保存文件名是否包含标题": "否",
        "是否去除名称中的表情符号": "是",
        "视频保存格式ts|mkv|flv|mp4|mp3音频|m4a音频": "ts",
        "原画|超清|高清|标清|流畅": quality_zh,
        "是否使用代理ip(是/否)": "否",
        "代理地址": "",
        "同一时间访问网络的线程数": str(max_threads),
        "循环时间(秒)": str(poll_interval),
        "排队读取网址时间(秒)": "0",
        "是否显示循环秒数": "是",
        "是否显示直播源地址": "是",
        "分段录制是否开启": segment_enabled,
        "是否强制启用https录制": "否",
        "录制空间剩余阈值(gb)": "1.0",
        "视频分段时间(秒)": str(segment_sec) if segment_sec > 0 else "1800",
        "录制完成后自动转为mp4格式": "否",
        "mp4格式重新编码为h264": "否",
        "追加格式后删除原文件": "是",
        "生成时间字幕文件": "否",
        "是否录制完成后执行自定义脚本": "否",
        "自定义脚本执行命令": "",
        "使用代理录制的平台(逗号分隔)": "",
        "额外使用代理录制的平台(逗号分隔)": "",
    }

    config["推送配置"] = {
        "直播状态推送渠道": "",
    }

    config["Cookie"] = {
        "抖音cookie": cookies or "",
    }

    config["Authorization"] = {
        "popkontv_token": "",
    }

    config["账号密码"] = {
        "sooplive账号": "",
        "sooplive密码": "",
    }

    cfg_path = cfg_dir / "config.ini"
    with open(cfg_path, "w", encoding="utf-8-sig") as f:
        config.write(f)

    # URL_config.ini: one line per URL
    # custom_name 优先：有则用自定义名，无则用自动抓取的主播名
    url_cfg_path = cfg_dir / "URL_config.ini"
    display_name = custom_name or name or "主播"
    with open(url_cfg_path, "w", encoding="utf-8-sig") as f:
        f.write(f"{url},{display_name}\n")


class DlrLauncher:
    """运行 DouyinLiveRecorder 的隔离子进程"""

    def __init__(
        self,
        task_id: int,
        url: str,
        name: str | None,
        quality: str,
        output_dir: str,
        segment_sec: int,
        poll_interval: int,
        max_threads: int = 3,
        cookies: str | None = None,
        custom_name: str | None = None,
        log_callback: Callable[[str], None] | None = None,
    ) -> None:
        self._task_id = task_id
        self._url = url
        self._name = name or f"任务{task_id}"
        self._quality = quality
        self._output_dir = output_dir
        self._segment_sec = segment_sec
        self._poll_interval = poll_interval
        self._max_threads = max_threads
        self._cookies = cookies
        self._custom_name = custom_name
        self._log_callback = log_callback or (lambda msg: None)
        self._process: subprocess.Popen | None = None
        self._tmpdir: str | None = None
        self._log_thread: threading.Thread | None = None

    def start(self) -> None:
        """启动 DLR 子进程"""
        # resolve() 确保路径与 DLR os.path.realpath(sys.argv[0]) 解析后一致
        # macOS 上 /var → /private/var，不 resolve 会导致 DLR 找不到 config 目录
        self._tmpdir = str(Path(tempfile.mkdtemp(prefix=f"dlr_task{self._task_id}_")).resolve())
        task_dir = Path(self._tmpdir)

        write_dlr_config(
            task_dir=task_dir,
            url=self._url,
            name=self._name,
            quality=self._quality,
            output_dir=self._output_dir,
            segment_sec=self._segment_sec,
            poll_interval=self._poll_interval,
            max_threads=self._max_threads,
            cookies=self._cookies,
            custom_name=self._custom_name,
        )

        dlr_main = str(_DLR_ROOT / "main.py")
        runner_path = task_dir / "runner.py"
        dlr_root = str(_DLR_ROOT)
        # 注意：不能用 runpy.run_path()，它会把 sys.argv[0] 强制设成 main.py 路径，
        # 导致 DLR 的 script_path 指向 DLR 安装目录而不是 tmpdir。
        # 改用 exec() 直接执行 main.py 代码，sys.argv[0] 保持 runner.py 路径不变。
        runner_path.write_text(
            f"import sys\n"
            f"sys.argv[0] = __file__  # DLR 用此路径确定 config 目录（= tmpdir/runner.py）\n"
            f"if {dlr_root!r} not in sys.path:\n"
            f"    sys.path.insert(0, {dlr_root!r})\n"
            f"with open({dlr_main!r}, encoding='utf-8') as _f:\n"
            f"    exec(compile(_f.read(), {dlr_main!r}, 'exec'), {{'__name__': '__main__', '__file__': {dlr_main!r}, '__builtins__': __builtins__}})\n",
            encoding="utf-8",
        )

        # 确保 output 目录存在，DLR 的 check_disk_capacity 会用 shutil.disk_usage(output_dir)
        Path(self._output_dir).mkdir(parents=True, exist_ok=True)

        self._log_callback(f"[DLR] 启动子进程 (tmpdir={self._tmpdir})")
        self._process = subprocess.Popen(
            [str(_DLR_PYTHON), str(runner_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self._log_thread = threading.Thread(
            target=self._forward_logs,
            daemon=True,
        )
        self._log_thread.start()

    def stop(self) -> None:
        """停止 DLR 子进程及其进程组"""
        if self._process is None:
            return
        if self._process.poll() is not None:
            self._process = None
            self._cleanup_tmpdir()
            return

        try:
            pgid = os.getpgid(self._process.pid)
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception as e:
            logger.warning("DLR stop SIGTERM failed: %s", e)

        try:
            self._process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                pgid = os.getpgid(self._process.pid)
                os.killpg(pgid, signal.SIGKILL)
            except Exception:
                pass
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

        self._process = None
        self._cleanup_tmpdir()

    def _cleanup_tmpdir(self) -> None:
        if self._tmpdir:
            try:
                shutil.rmtree(self._tmpdir, ignore_errors=True)
            except Exception:
                pass
            self._tmpdir = None

    @property
    def is_running(self) -> bool:
        if self._process is None:
            return False
        return self._process.poll() is None

    def _forward_logs(self) -> None:
        """读取子进程 stdout，转发给 log_callback"""
        if self._process is None or self._process.stdout is None:
            return
        try:
            for line in self._process.stdout:
                line = line.rstrip("\n")
                if line:
                    self._log_callback(f"[DLR] {line}")
        except Exception:
            pass
