#!/usr/bin/env python3
"""
录制片段合并工具

用法:
  python tools/merge_recording.py <任务目录> [选项]

示例:
  # 合并最新会话（自动检测），生成 MP4 + 弹幕 MP4
  python tools/merge_recording.py output/抖音直播/task42_MiiiX大鹏

  # 指定会话时间戳前缀
  python tools/merge_recording.py output/抖音直播/task42_MiiiX大鹏 --session 2026-03-14_15-46-01

  # 只合并视频，不烧录弹幕
  python tools/merge_recording.py output/抖音直播/task42_MiiiX大鹏 --no-danmu

  # 指定输出文件名（不含扩展名）
  python tools/merge_recording.py output/抖音直播/task42_MiiiX大鹏 --output MiiiX大鹏_2026-03-14
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

# 让 tools/ 下的脚本能 import src.danmu
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


# ── ASS 工具 ───────────────────────────────────────────────────────────────


def _hhmmsscs_to_sec(t: str) -> float:
    """'HH:MM:SS.cc' → 秒（百分之一秒精度）"""
    h, m, rest = t.split(":")
    s, cs = rest.split(".")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(cs) / 100


def _sec_to_hhmmsscs(sec: float) -> str:
    """秒 → 'HH:MM:SS.cc'（两位小时，与 ass_writer.py 一致）"""
    sec = max(0.0, sec)
    cs = round((sec % 1) * 100)
    total_s = int(sec)
    h = total_s // 3600
    m = (total_s % 3600) // 60
    s = total_s % 60
    return f"{h:02d}:{m:02d}:{s:02d}.{cs:02d}"


def _shift_dialogue_line(line: str, offset_sec: float) -> str:
    """对单条 Dialogue: 行的 Start/End 加偏移"""
    # 时间格式：HH:MM:SS.cc（两位及以上小时）
    m = re.match(
        r"(Dialogue:\s*\d+,\s*)(\d+:\d{2}:\d{2}\.\d{2})(,)(\d+:\d{2}:\d{2}\.\d{2})(,.*)",
        line,
    )
    if not m:
        return line
    prefix, start, comma, end, rest = m.groups()
    new_start = _sec_to_hhmmsscs(_hhmmsscs_to_sec(start) + offset_sec)
    new_end = _sec_to_hhmmsscs(_hhmmsscs_to_sec(end) + offset_sec)
    return f"{prefix}{new_start}{comma}{new_end}{rest}"


def merge_ass_files(
    ass_files: list[Path], offsets_sec: list[float], out_path: Path
) -> None:
    """将多个 ASS 文件按偏移合并。第一个文件的 header 作为输出 header。"""
    header_lines: list[str] = []
    all_dialogues: list[str] = []

    for i, (ass, offset) in enumerate(zip(ass_files, offsets_sec)):
        text = ass.read_text(encoding="utf-8-sig", errors="replace")
        lines = text.splitlines()
        in_events = False
        for line in lines:
            stripped = line.strip()
            if stripped.lower().startswith("[events]"):
                in_events = True
                if i == 0:
                    header_lines.append(line)
                continue
            if in_events:
                if stripped.lower().startswith("dialogue:"):
                    all_dialogues.append(_shift_dialogue_line(line, offset))
                elif stripped.lower().startswith("format:"):
                    if i == 0:
                        header_lines.append(line)
                # comment or other event lines
                elif stripped.startswith(";") and i == 0:
                    header_lines.append(line)
            else:
                if i == 0:
                    header_lines.append(line)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8-sig") as f:
        f.write("\n".join(header_lines))
        f.write("\n")
        f.write("\n".join(all_dialogues))
        f.write("\n")
    print(f"[ASS] 合并 {len(ass_files)} 个文件 → {out_path.name}")


# ── 视频工具 ───────────────────────────────────────────────────────────────


def get_duration(path: Path) -> float:
    """用 ffprobe 获取文件时长（秒）"""
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_entries",
            "format=duration",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe 失败: {result.stderr}")
    return float(json.loads(result.stdout)["format"]["duration"])


def merge_ts_to_mp4(ts_files: list[Path], out_path: Path) -> None:
    """用 ffmpeg concat demuxer 将多个 TS 合并为 MP4（-c copy）"""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, encoding="utf-8"
    ) as f:
        for ts in ts_files:
            f.write(f"file '{ts.resolve()}'\n")
        concat_list = Path(f.name)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_list),
        "-c",
        "copy",
        str(out_path),
    ]
    print(f"[视频] 合并 {len(ts_files)} 个 TS → {out_path.name}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    concat_list.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 合并失败:\n{result.stderr[-2000:]}")


def get_video_bitrate(path: Path) -> int | None:
    """用 ffprobe 获取视频流码率（bps），失败返回 None"""
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-select_streams",
            "v:0",
            "-print_format",
            "json",
            "-show_entries",
            "stream=bit_rate",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        return None
    try:
        br = json.loads(result.stdout)["streams"][0].get("bit_rate")
        return int(br) if br and br != "N/A" else None
    except Exception:
        return None


def burn_ass_to_mp4(video_path: Path, ass_path: Path, out_path: Path) -> None:
    """将 ASS 字幕烧录进视频，尽量保持原始码率（-b:v），无法获取则用 -crf 0 无损）"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    ass_escaped = str(ass_path.resolve()).replace("\\", "/").replace(":", "\\:")

    bitrate = get_video_bitrate(video_path)
    if bitrate:
        venc_opts = ["-c:v", "libx264", "-preset", "fast", "-b:v", str(bitrate)]
        print(f"[弹幕] 烧录字幕（码率 {bitrate // 1000}k）→ {out_path.name}")
    else:
        venc_opts = ["-c:v", "libx264", "-preset", "fast", "-crf", "0"]
        print(f"[弹幕] 烧录字幕（无损）→ {out_path.name}")

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        f"ass={ass_escaped}",
        *venc_opts,
        "-c:a",
        "copy",
        str(out_path),
    ]
    result = subprocess.run(cmd, text=True)
    if result.returncode != 0:
        raise RuntimeError("ffmpeg 烧录失败")


# ── XML 工具 ──────────────────────────────────────────────────────────────


def _read_xml_record_start(xml_path: Path) -> float:
    """读取 XML 根节点的 record_start 属性（Unix 秒）"""
    for event, elem in ET.iterparse(str(xml_path), events=("start",)):
        return float(elem.get("record_start", 0))
    return 0.0


def merge_xml_files(xml_files: list[Path], out_path: Path) -> None:
    """将多个 XML 分段按 record_start 偏移合并。
    偏移 = xml_files[i].record_start - xml_files[0].record_start
    直接从文件头读取，不需要 ffprobe。
    """
    base_start = _read_xml_record_start(xml_files[0])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as out:
        out.write('<?xml version="1.0" encoding="utf-8"?>\n')
        out.write(f'<danmaku record_start="{base_start:.3f}" session="merged">\n')

        for xml_path in xml_files:
            seg_start = _read_xml_record_start(xml_path)
            offset = seg_start - base_start
            tree = ET.parse(str(xml_path))
            root = tree.getroot()
            for d in root.findall("d"):
                t = float(d.get("t", 0)) + offset
                d.set("t", f"{t:.3f}")
                # 序列化单个 <d> 元素
                attrs = " ".join(f'{k}="{v}"' for k, v in d.attrib.items())
                text = (d.text or "").strip()
                if text:
                    import xml.sax.saxutils as saxutils
                    out.write(f"  <d {attrs}>{saxutils.escape(text)}</d>\n")
                else:
                    out.write(f"  <d {attrs}/>\n")

        out.write("</danmaku>\n")

    print(f"[XML] 合并 {len(xml_files)} 个文件 → {out_path.name}")


def xml_to_ass(
    xml_path: Path,
    ass_path: Path,
    types: set[str] | None = None,
) -> None:
    """将合并后的 XML 按类型过滤，用 AssWriter 重新渲染为 ASS。
    types 默认 {'danmaku', 'gift'}，传 None 表示全部类型。
    """
    from src.danmu.ass_writer import AssWriter
    from src.danmu.models import GiftDanmaku, MemberDanmaku, SimpleDanmaku

    if types is None:
        types = {"danmaku", "gift", "member"}

    writer = AssWriter()
    writer.open(ass_path)

    tree = ET.parse(str(xml_path))
    root = tree.getroot()
    count = 0
    for d in root.findall("d"):
        dtype = d.get("type", "danmaku")
        if dtype not in types:
            continue
        t = float(d.get("t", 0))
        if t < 0:
            continue
        uname = d.get("uname", "")
        uid = d.get("uid", "")
        color = d.get("color", "ffffff")
        content = (d.text or "").strip()

        if dtype == "gift":
            item = GiftDanmaku(
                time=t, uname=uname, uid=uid,
                gift_name=d.get("gift", ""),
                gift_count=int(d.get("count", 1)),
                gift_price=float(d.get("price", 0)),
                content=content, color=color, dtype="gift",
            )
        elif dtype == "member":
            item = MemberDanmaku(
                time=t, uname=uname, uid=uid,
                member_count=int(d.get("member_count", 0)),
                content=content or f"{uname} 进入直播间",
                color=color, dtype="member",
            )
        else:
            item = SimpleDanmaku(
                time=t, uname=uname, uid=uid,
                content=content, color=color, dtype="danmaku",
                text=f"{uname}: {content}" if uname else content,
            )
        if writer.add(item):
            count += 1

    writer.close()
    print(f"[XML→ASS] 渲染 {count} 条弹幕 → {ass_path.name}")


# ── 主逻辑 ────────────────────────────────────────────────────────────────


def find_sessions(task_dir: Path) -> dict[str, list[int]]:
    """返回 {session_ts: [sorted segment indices]}"""
    sessions: dict[str, list[int]] = {}
    for f in task_dir.glob("*.ts"):
        # 文件名形如 prefix_YYYY-MM-DD_HH-MM-SS_NNN.ts
        m = re.search(r"_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_(\d+)\.ts$", f.name)
        if m:
            ts, idx = m.group(1), int(m.group(2))
            sessions.setdefault(ts, []).append(idx)
    for ts in sessions:
        sessions[ts].sort()
    return sessions


def main() -> None:
    parser = argparse.ArgumentParser(description="合并分段录制文件")
    parser.add_argument("task_dir", help="任务输出目录")
    parser.add_argument(
        "--session", help="会话时间戳前缀（如 2026-03-14_15-46-01），默认取最新"
    )
    parser.add_argument("--output", help="输出文件名（不含扩展名），默认自动生成")
    parser.add_argument("--no-danmu", action="store_true", help="不烧录弹幕")
    parser.add_argument(
        "--danmu-only", action="store_true", help="只生成弹幕版，跳过无弹幕版"
    )
    parser.add_argument(
        "--danmu-types",
        default="danmaku,gift",
        help="烧录的弹幕类型（逗号分隔），可选: danmaku,gift,member。默认: danmaku,gift",
    )
    args = parser.parse_args()

    task_dir = Path(args.task_dir)
    if not task_dir.is_dir():
        print(f"错误：目录不存在 {task_dir}")
        return

    sessions = find_sessions(task_dir)
    if not sessions:
        print("未找到任何 TS 分段文件")
        return

    if args.session:
        session_ts = args.session
        if session_ts not in sessions:
            print(f"错误：会话 {session_ts} 不存在。可用会话：")
            for s in sorted(sessions):
                print(f"  {s}  ({len(sessions[s])} 个分段: {sessions[s]})")
            return
    else:
        session_ts = sorted(sessions)[-1]  # 取最新会话
        print(
            f"[自动] 使用最新会话: {session_ts}，共 {len(sessions[session_ts])} 个分段"
        )

    indices = sessions[session_ts]

    danmu_types = set(args.danmu_types.split(",")) if args.danmu_types else {"danmaku", "gift"}

    # 收集 TS、XML、ASS 文件
    prefix = None
    ts_files: list[Path] = []
    xml_files: list[Path] = []
    ass_files: list[Path] = []
    for i in indices:
        matches = list(task_dir.glob(f"*_{session_ts}_{i:03d}.ts"))
        if not matches:
            print(f"警告：找不到分段 {i:03d}，跳过后续")
            break
        ts = matches[0]
        if prefix is None:
            prefix = ts.name.rsplit(f"_{session_ts}_", 1)[0]
        ts_files.append(ts)
        xml = ts.with_suffix(".xml")
        if xml.exists():
            xml_files.append(xml)
        ass = ts.with_suffix(".ass")
        if ass.exists():
            ass_files.append(ass)

    if not ts_files:
        print("没有找到有效的 TS 文件")
        return

    print(f"[分段] TS:  {[f.name for f in ts_files]}")
    if xml_files:
        print(f"[分段] XML: {[f.name for f in xml_files]}")
    elif ass_files:
        print(f"[分段] ASS: {[f.name for f in ass_files]}")

    # 输出文件名：{主播名}_{YYYY-MM-DD}_{HH}（小时粒度）
    if args.output:
        out_base = task_dir / args.output
    else:
        # session_ts 形如 "2026-03-14_15-46-01"，取 YYYY-MM-DD_HH
        m = re.match(r"(\d{4}-\d{2}-\d{2})_(\d{2})", session_ts)
        date_hour_str = f"{m.group(1)}_{m.group(2)}" if m else session_ts
        # 主播名从目录名推断（task{id}_{name} → name）
        dir_name = task_dir.name
        anchor = re.sub(r"^task\d+_", "", dir_name) or dir_name
        out_base = task_dir / f"{anchor}_{date_hour_str}"

    out_xml = out_base.with_suffix(".xml")       # MiiiX大鹏_2026-03-14_15.xml
    out_ass = out_base.with_suffix(".ass")        # MiiiX大鹏_2026-03-14_15.ass
    out_mp4 = out_base.with_suffix(".mp4")        # MiiiX大鹏_2026-03-14_15.mp4
    out_danmu_mp4 = task_dir / f"{out_base.name}_danmu.mp4"  # ..._danmu.mp4

    # 1. 合并弹幕
    has_danmu = not args.no_danmu
    use_xml = bool(xml_files) and has_danmu

    if use_xml:
        # XML 路径：优先用与 TS 同名的 XML
        if len(xml_files) < len(ts_files):
            print(f"注意：只有 {len(xml_files)}/{len(ts_files)} 个分段有 XML 文件")
        merge_xml_files(xml_files, out_xml)
        print(f"✓ 合并 XML: {out_xml.name}")
        xml_to_ass(out_xml, out_ass, types=danmu_types)
        print(f"✓ 字幕: {out_ass.name}  (类型: {','.join(sorted(danmu_types))})")
    elif ass_files and has_danmu:
        # fallback：旧格式，用 ffprobe 偏移合并 ASS
        print("[fallback] 未找到 XML，改用 ASS 合并（ffprobe 偏移）")
        if len(ass_files) < len(ts_files):
            print(f"注意：只有 {len(ass_files)}/{len(ts_files)} 个分段有 ASS 文件")
        offsets: list[float] = [0.0]
        for ts in ts_files[: len(ass_files) - 1]:
            try:
                dur = get_duration(ts)
                offsets.append(offsets[-1] + dur)
                print(f"  {ts.name}: {dur:.1f}s")
            except Exception as e:
                print(f"警告：获取 {ts.name} 时长失败: {e}，使用 0 偏移")
                offsets.append(offsets[-1])
        merge_ass_files(ass_files, offsets, out_ass)
        print(f"✓ 字幕: {out_ass.name}")
    else:
        if has_danmu:
            print("未找到弹幕文件，跳过弹幕烧录")
        has_danmu = False

    # 2. 合并 TS → MP4
    merge_ts_to_mp4(ts_files, out_mp4)
    print(f"✓ 视频: {out_mp4.name}")

    # 3. 烧录弹幕
    if has_danmu and out_ass.exists():
        burn_ass_to_mp4(out_mp4, out_ass, out_danmu_mp4)
        print(f"✓ 弹幕版: {out_danmu_mp4.name}")

    print("\n完成！")


if __name__ == "__main__":
    main()
