"""视频分段合并器：将 ffmpeg segment muxer 生成的 .ts 分段合并为 .mp4，支持弹幕烧录"""

from __future__ import annotations

import logging
import re
import subprocess
import tempfile
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

_SEGMENT_RE = re.compile(r"^(.+)_(\d+)\.ts$")
_ASS_TIME_RE = re.compile(r"(\d+):(\d{2}):(\d{2}\.\d{2})")


# ── ASS 时间处理（与 ass_writer.py 格式完全一致） ────────────────────────────

def _sec2hms(sec: float) -> tuple[int, int, float]:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return h, m, s


def _parse_ass_time(s: str) -> float:
    """'00:01:05.23' → 秒（float）"""
    m = _ASS_TIME_RE.match(s.strip())
    if not m:
        return 0.0
    h, mi, se = int(m[1]), int(m[2]), float(m[3])
    return h * 3600 + mi * 60 + se


def _format_ass_time(sec: float) -> str:
    """秒 → '00:01:05.23'，与 ass_writer.py 格式完全一致"""
    h, m, s = _sec2hms(sec)
    return '%02d:%02d:%05.2f' % (h, m, s)


# ── 数据结构 ─────────────────────────────────────────────────────────────────

@dataclass
class RecordingGroup:
    prefix: str              # e.g. "树.🌱_2026-03-10_12-02-41"
    output_dir: Path
    ts_files: list[Path]     # 排序后的 .ts 分段（完整列表）
    ass_map: dict[int, Path] = field(default_factory=dict)  # 段索引 → ass 路径

    @property
    def merged_mp4(self) -> Path:
        return self.output_dir / f"{self.prefix}.mp4"

    @property
    def merged_ass(self) -> Path:
        return self.output_dir / f"{self.prefix}_danmu.ass"

    @property
    def merged_danmu_mp4(self) -> Path:
        return self.output_dir / f"{self.prefix}_danmu.mp4"

    @property
    def already_merged(self) -> bool:
        return self.merged_mp4.exists()


# ── 录制组发现 ───────────────────────────────────────────────────────────────

def discover_groups(output_dir: Path, exclude_last: bool = False) -> list[RecordingGroup]:
    """
    扫描目录，按前缀分组，返回可合并的录制组。
    exclude_last=True 时每组排除最后一段（录制中的任务，防止合并未完成的段）。
    """
    raw: dict[str, list[tuple[int, Path]]] = defaultdict(list)
    for ts in output_dir.glob("*.ts"):
        m = _SEGMENT_RE.match(ts.name)
        if not m:
            continue
        prefix, idx = m.group(1), int(m.group(2))
        raw[prefix].append((idx, ts))

    result = []
    for prefix in sorted(raw.keys()):
        items = sorted(raw[prefix])
        all_ts = [p for _, p in items]

        if exclude_last and len(all_ts) > 1:
            all_ts = all_ts[:-1]  # 排除正在写入的最后一段

        ass_map: dict[int, Path] = {}
        for i, ts in enumerate(all_ts):
            ass = output_dir / (ts.stem + "_danmu.ass")
            if ass.exists():
                ass_map[i] = ass

        result.append(RecordingGroup(
            prefix=prefix,
            output_dir=output_dir,
            ts_files=all_ts,
            ass_map=ass_map,
        ))

    return result


# ── ffprobe 时长 ─────────────────────────────────────────────────────────────

def get_segment_duration(ts_path: Path) -> float:
    """用 ffprobe 获取 .ts 文件实际时长（秒）。失败时抛出 RuntimeError。"""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(ts_path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe 失败 ({ts_path.name}): {result.stderr.strip()[:200]}")
    try:
        return float(result.stdout.strip())
    except ValueError:
        raise RuntimeError(f"ffprobe 输出无法解析 ({ts_path.name}): {result.stdout.strip()[:100]}")


# ── ASS 合并 ─────────────────────────────────────────────────────────────────

def merge_ass_files(
    ts_files: list[Path],
    ass_map: dict[int, Path],
    output_path: Path,
    log_fn: Callable[[str], None] | None = None,
) -> None:
    """
    两阶段合并 ASS 弹幕文件。
    阶段 1：从第一个存在的 ASS 文件复制头部（到 [Events] Format 行为止）。
    阶段 2：对每段的 Dialogue 行加累计时间偏移后写入。
    """
    if not ass_map:
        return

    # 获取所有段时长，计算累计偏移
    durations: list[float] = []
    for ts in ts_files:
        try:
            durations.append(get_segment_duration(ts))
        except RuntimeError as e:
            if log_fn:
                log_fn(f"[弹幕] 警告: {e}，弹幕时间偏移可能不准确")
            durations.append(0.0)

    offsets = [0.0]
    for d in durations[:-1]:
        offsets.append(offsets[-1] + d)

    dialogue_count = 0
    with open(output_path, "w", encoding="utf-8") as out:
        # 阶段 1：写头部（取 ass_map 中索引最小的文件）
        first_idx = min(ass_map.keys())
        header_done = False
        for line in ass_map[first_idx].read_text(encoding="utf-8").splitlines():
            if not header_done:
                out.write(line + "\n")
                if line.startswith("Format: Layer, Start, End,"):
                    header_done = True

        # 阶段 2：按段顺序写 Dialogue 行（加偏移）
        for i, ts in enumerate(ts_files):
            if i not in ass_map:
                continue
            offset = offsets[i]
            for line in ass_map[i].read_text(encoding="utf-8").splitlines():
                if not line.startswith("Dialogue:"):
                    continue
                # split maxsplit=9：保留 Text 字段中的逗号（\move tag 等）
                parts = line.split(",", 9)
                if len(parts) >= 3:
                    parts[1] = _format_ass_time(_parse_ass_time(parts[1]) + offset)
                    parts[2] = _format_ass_time(_parse_ass_time(parts[2]) + offset)
                out.write(",".join(parts) + "\n")
                dialogue_count += 1

    if log_fn:
        log_fn(f"[弹幕] 合并 {len(ass_map)} 段，共 {dialogue_count} 条 → {output_path.name}")


# ── 核心合并 ─────────────────────────────────────────────────────────────────

def merge_group(
    group: RecordingGroup,
    log_fn: Callable[[str], None] | None = None,
    do_plain: bool = True,
    do_danmu: bool = True,
    overwrite: bool = False,
) -> dict:
    """
    合并一个录制组。
    do_plain: 生成 {prefix}.mp4（-c copy，无损）
    do_danmu: 生成 {prefix}_danmu.mp4（h264_videotoolbox 硬件编码烧录弹幕，依赖 plain mp4）
    若 do_danmu=True 但 plain mp4 不存在，自动先执行 plain merge。
    返回 {"plain_mp4": str | None, "danmu_mp4": str | None}
    """
    def _log(msg: str) -> None:
        if log_fn:
            log_fn(msg)
        else:
            logger.info(msg)

    if not group.ts_files:
        _log("[合并] 没有 .ts 文件，跳过")
        return {"plain_mp4": None, "danmu_mp4": None}

    plain_mp4: str | None = None
    danmu_mp4: str | None = None

    # ── Step 1: Plain merge ──────────────────────────────────────────────────
    need_plain = do_plain or (do_danmu and not group.merged_mp4.exists())
    if need_plain:
        if group.merged_mp4.exists() and not overwrite:
            _log(f"[合并] 已存在: {group.merged_mp4.name}，跳过（传 overwrite=True 强制覆盖）")
            plain_mp4 = str(group.merged_mp4)
        else:
            _log(f"[合并] 开始合并 {len(group.ts_files)} 段 → {group.merged_mp4.name}")
            tmp: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w", suffix=".txt", delete=False, encoding="utf-8"
                ) as f:
                    tmp = Path(f.name)
                    for ts in group.ts_files:
                        f.write(f"file '{ts.resolve()}'\n")

                proc = subprocess.run(
                    [
                        "ffmpeg", "-y",
                        "-f", "concat", "-safe", "0",
                        "-i", str(tmp),
                        "-c", "copy",
                        "-movflags", "+faststart",
                        str(group.merged_mp4),
                    ],
                    capture_output=True,
                )
                if proc.returncode != 0:
                    group.merged_mp4.unlink(missing_ok=True)
                    err = proc.stderr.decode(errors="replace")[-600:]
                    raise RuntimeError(f"ffmpeg 合并失败:\n{err}")

                # 校验输出文件
                check = subprocess.run(
                    ["ffprobe", "-v", "error", str(group.merged_mp4)],
                    capture_output=True,
                )
                if check.returncode != 0:
                    group.merged_mp4.unlink(missing_ok=True)
                    raise RuntimeError("合并输出文件校验失败")

                size_mb = group.merged_mp4.stat().st_size / 1024 / 1024
                plain_mp4 = str(group.merged_mp4)
                _log(f"[合并] 完成: {group.merged_mp4.name} ({size_mb:.1f} MB)")

            except Exception as e:
                _log(f"[合并] 失败: {e}")
                raise
            finally:
                if tmp and tmp.exists():
                    tmp.unlink(missing_ok=True)

    # ── Step 2: Danmu merge ──────────────────────────────────────────────────
    if do_danmu:
        if not group.ass_map:
            _log("[合并] 无弹幕文件，跳过弹幕烧录")
        elif not group.merged_mp4.exists():
            _log("[合并] plain mp4 不存在，无法烧录弹幕")
        elif group.merged_danmu_mp4.exists() and not overwrite:
            _log(f"[合并] 弹幕版已存在: {group.merged_danmu_mp4.name}")
            danmu_mp4 = str(group.merged_danmu_mp4)
        else:
            try:
                _log(f"[合并] 合并弹幕 ({len(group.ass_map)} 段)...")
                merge_ass_files(group.ts_files, group.ass_map, group.merged_ass, log_fn=log_fn)

                _log(f"[合并] 烧录弹幕 → {group.merged_danmu_mp4.name}（VideoToolbox 硬件编码）")
                proc = subprocess.run(
                    [
                        "ffmpeg", "-y",
                        "-i", str(group.merged_mp4),
                        "-vf", f"ass={group.merged_ass.name}",
                        "-c:v", "h264_videotoolbox", "-q:v", "65",
                        "-c:a", "copy",
                        "-movflags", "+faststart",
                        str(group.merged_danmu_mp4),
                    ],
                    capture_output=True,
                    cwd=str(group.output_dir),  # cwd = ASS 所在目录，避免中文路径转义
                )
                if proc.returncode != 0:
                    group.merged_danmu_mp4.unlink(missing_ok=True)
                    err = proc.stderr.decode(errors="replace")[-600:]
                    raise RuntimeError(f"ffmpeg 弹幕烧录失败:\n{err}")

                size_mb = group.merged_danmu_mp4.stat().st_size / 1024 / 1024
                danmu_mp4 = str(group.merged_danmu_mp4)
                _log(f"[合并] 弹幕版完成: {group.merged_danmu_mp4.name} ({size_mb:.1f} MB)")

            except Exception as e:
                _log(f"[合并] 弹幕烧录失败: {e}")
                raise

    return {"plain_mp4": plain_mp4, "danmu_mp4": danmu_mp4}
