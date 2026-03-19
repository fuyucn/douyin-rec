"""视频分段合并器：将 ffmpeg segment muxer 生成的 .ts 分段合并为 .mp4，支持弹幕烧录"""

from __future__ import annotations

import logging
import re
import subprocess
import tempfile
import threading
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
    xml_map: dict[int, Path] = field(default_factory=dict)  # 段索引 → xml 路径

    @property
    def merged_mp4(self) -> Path:
        return self.output_dir / f"{self.prefix}.mp4"

    @property
    def merged_ass(self) -> Path:
        return self.output_dir / f"{self.prefix}_danmu.ass"

    @property
    def merged_xml(self) -> Path:
        return self.output_dir / f"{self.prefix}_danmu.xml"

    @property
    def merged_danmu_mp4(self) -> Path:
        return self.output_dir / f"{self.prefix}_danmu.mp4"

    @property
    def already_merged(self) -> bool:
        return self.merged_mp4.exists()

    @property
    def has_danmu(self) -> bool:
        return bool(self.xml_map) or bool(self.ass_map)


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
        xml_map: dict[int, Path] = {}
        for i, ts in enumerate(all_ts):
            xml = ts.with_suffix(".xml")
            if xml.exists():
                xml_map[i] = xml
            ass = ts.with_suffix(".ass")
            if ass.exists():
                ass_map[i] = ass

        result.append(RecordingGroup(
            prefix=prefix,
            output_dir=output_dir,
            ts_files=all_ts,
            ass_map=ass_map,
            xml_map=xml_map,
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


# ── XML 工具 ─────────────────────────────────────────────────────────────────

_XML_INVALID_CHARS = re.compile(
    r'[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\U00010000-\U0010FFFF]'
)


def _parse_xml_safe(path: Path):
    """解析 XML 文件，自动修复常见的截断问题和非法字符。"""
    import xml.etree.ElementTree as ET
    content = path.read_text(encoding='utf-8', errors='replace')
    # 过滤 XML 1.0 非法字符（控制字符等），避免 ParseError
    content = _XML_INVALID_CHARS.sub('', content)
    try:
        return ET.fromstring(content)
    except ET.ParseError:
        # 尝试补全常见根标签
        for closing in ('</i>', '</danmaku>'):
            try:
                return ET.fromstring(content + f'\n{closing}')
            except ET.ParseError:
                pass
        raise


# ── XML → ASS 渲染 ───────────────────────────────────────────────────────────

def _xml_record_start(root) -> float:
    """从 XML root 提取录制起始时间（Unix 秒）。兼容新旧格式。"""
    meta = root.find('metadata')
    if meta is not None:
        vst = meta.findtext('video_start_time', '0')
        return int(vst) / 1000.0
    return float(root.get('record_start', 0))


def render_xml_to_ass(
    xml_path: Path,
    ass_path: Path,
    vid_w: int = 1920,
    vid_h: int = 1080,
    danmu_types: set | None = None,
    time_offset: float = 0.0,
    log_fn=None,
) -> tuple[int, int]:
    """将单个分段 XML 渲染为 ASS 文件。

    time_offset: 加到所有时间上（用于合并 ASS；分段 ASS 传 0.0）。
    返回 (dm_count, chat_count)。
    """
    import xml.etree.ElementTree as ET
    from src.danmu.ass_writer import AssWriter
    from src.danmu.chat_panel_writer import ChatPanelWriter
    from src.danmu.models import GiftDanmaku, MemberDanmaku, SimpleDanmaku

    if danmu_types is None:
        danmu_types = {'danmaku', 'gift', 'member'}

    root = _parse_xml_safe(xml_path)
    is_new_fmt = root.find('metadata') is not None
    seg_start = _xml_record_start(root)

    ass_writer = AssWriter(width=vid_w, height=vid_h)
    ass_writer.open(ass_path)
    chat_items: list = []
    dm_count = 0

    if 'danmaku' in danmu_types:
        for d in root.findall('d'):
            t_val = (float(d.get('p', '0').split(',')[0]) if is_new_fmt
                     else float(d.get('t', 0))) + time_offset
            if t_val < 0:
                continue
            uname = d.get('user', '') if is_new_fmt else d.get('uname', '')
            uid = d.get('uid', '')
            content = (d.text or '').strip()
            item = SimpleDanmaku(
                time=t_val, uname=uname, uid=uid,
                content=content, color='ffffff', dtype='danmaku',
                text=f'{uname}: {content}' if uname else content,
            )
            if ass_writer.add(item):
                dm_count += 1

    ass_writer.close()

    if 'gift' in danmu_types:
        for g in root.findall('gift'):
            ts_ms = int(g.get('ts', 0))
            t_val = (ts_ms / 1000.0 - seg_start if is_new_fmt
                     else float(g.get('t', 0))) + time_offset
            if t_val < 0:
                t_val = 0.0
            uname = g.get('user', '') if is_new_fmt else g.get('uname', '')
            chat_items.append(GiftDanmaku(
                time=t_val, uname=uname, uid=g.get('uid', ''),
                gift_name=g.get('giftname', '') or g.get('gift', ''),
                gift_count=int(g.get('giftcount', 1) or g.get('count', 1)),
                gift_price=float(g.get('price', 0)),
                content='', color='ffaa00', dtype='gift',
            ))

    if 'member' in danmu_types:
        for m in root.findall('member'):
            ts_ms = int(m.get('ts', 0))
            t_val = (ts_ms / 1000.0 - seg_start if ts_ms else 0.0) + time_offset
            if t_val < 0:
                t_val = 0.0
            uname = m.get('user', '') if is_new_fmt else m.get('uname', '')
            chat_items.append(MemberDanmaku(
                time=t_val, uname=uname, uid=m.get('uid', ''),
                member_count=int(m.get('member_count', 0)),
                content='', color='aaaaaa', dtype='member',
            ))

    chat_count = 0
    if chat_items:
        chat_items.sort(key=lambda x: x.time or 0)
        chat_writer = ChatPanelWriter(width=vid_w, height=vid_h)
        chat_count = chat_writer.write(chat_items, ass_path)

    if log_fn:
        log_fn(f"[合并] ASS {ass_path.name} — 弹幕 {dm_count} 条 + 聊天 {chat_count} 条")
    return dm_count, chat_count


# ── XML 合并 ─────────────────────────────────────────────────────────────────

def merge_xml_files(
    xml_map: dict[int, Path],
    output_path: Path,
    log_fn: Callable[[str], None] | None = None,
) -> None:
    """
    合并多段 XML 弹幕文件为单个 XML（biliLive-tools 格式）。

    - <d> 的 p 属性第一字段（相对时间秒）按段偏移调整
    - <gift> / <member> 的 ts 是绝对 ms 时间戳，无需调整
    - metadata.video_start_time 取第一段的值（整场录制基准）
    """
    import xml.etree.ElementTree as ET
    import copy

    if not xml_map:
        return

    xml_files = [xml_map[i] for i in sorted(xml_map)]
    roots = [_parse_xml_safe(f) for f in xml_files]

    def _start_ms(root) -> int:
        meta = root.find('metadata')
        if meta is not None:
            return int(meta.findtext('video_start_time', '0'))
        return int(float(root.get('record_start', 0)) * 1000)

    base_ms = _start_ms(roots[0])

    lines: list[str] = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<?xml-stylesheet type="text/xsl" href="#s"?>',
        '<i>',
    ]

    # metadata + RecorderXmlStyle from first segment
    first_meta = roots[0].find('metadata')
    if first_meta is not None:
        lines.append(ET.tostring(first_meta, encoding='unicode'))
    first_style = roots[0].find('RecorderXmlStyle')
    if first_style is not None:
        lines.append(ET.tostring(first_style, encoding='unicode'))

    d_count = gift_count = member_count = 0

    for root in roots:
        seg_ms = _start_ms(root)
        offset_sec = (seg_ms - base_ms) / 1000.0
        is_new_fmt = root.find('metadata') is not None

        for d in root.findall('d'):
            elem = copy.copy(d)
            if is_new_fmt:
                p_parts = elem.get('p', '').split(',')
                if p_parts:
                    p_parts[0] = f"{float(p_parts[0]) + offset_sec:.3f}"
                    elem.set('p', ','.join(p_parts))
            else:
                elem.set('t', f"{float(elem.get('t', 0)) + offset_sec:.3f}")
            lines.append(ET.tostring(elem, encoding='unicode'))
            d_count += 1

        for g in root.findall('gift'):
            lines.append(ET.tostring(copy.copy(g), encoding='unicode'))
            gift_count += 1

        for m in root.findall('member'):
            lines.append(ET.tostring(copy.copy(m), encoding='unicode'))
            member_count += 1

    lines.append('</i>')
    output_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')

    if log_fn:
        log_fn(f"[弹幕] 合并 XML → {output_path.name}（{d_count} 弹幕 + {gift_count} 礼物 + {member_count} 入场）")


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
    danmu_types: set[str] | None = None,
    min_vbitrate: int = 2166,
    progress_callback: Callable[[int], None] | None = None,
) -> dict:
    """
    合并一个录制组。
    do_plain: 生成 {prefix}.mp4（-c copy，无损）
    do_danmu: 生成 {prefix}_danmu.mp4（h264_videotoolbox 硬件编码烧录弹幕，依赖 plain mp4）
    danmu_types: 烧录的弹幕类型集合，默认 {"danmaku", "gift"}；XML 路径时生效，ASS fallback 忽略此参数。
    若 do_danmu=True 但 plain mp4 不存在，自动先执行 plain merge。
    返回 {"plain_mp4": str | None, "danmu_mp4": str | None}
    """
    if danmu_types is None:
        danmu_types = {"danmaku", "gift"}
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
                    err = (proc.stderr + proc.stdout).decode(errors="replace")[-600:].strip()
                    raise RuntimeError(f"ffmpeg 合并失败 (rc={proc.returncode}): {err or '(无输出)'}")

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
        if not group.has_danmu:
            _log("[合并] 无弹幕文件，跳过弹幕烧录")
        elif not group.merged_mp4.exists():
            _log("[合并] plain mp4 不存在，无法烧录弹幕")
        elif group.merged_danmu_mp4.exists() and not overwrite:
            _log(f"[合并] 弹幕版已存在: {group.merged_danmu_mp4.name}")
            danmu_mp4 = str(group.merged_danmu_mp4)
        else:
            try:
                if group.xml_map:
                    # XML 路径：合并 XML → 生成分段 ASS → 生成总体 ASS
                    _log(f"[合并] 合并弹幕 XML ({len(group.xml_map)} 段，类型: {','.join(sorted(danmu_types))})...")

                    # 1. 生成合并后的 XML
                    merge_xml_files(group.xml_map, group.merged_xml, log_fn=_log)

                    # 2. 探测视频分辨率
                    vid_w, vid_h = 1920, 1080
                    try:
                        import json as _json
                        probe = subprocess.run(
                            ["ffprobe", "-v", "quiet", "-print_format", "json",
                             "-show_streams", str(group.merged_mp4)],
                            capture_output=True, text=True, timeout=15,
                        )
                        if probe.returncode == 0:
                            for s in _json.loads(probe.stdout).get("streams", []):
                                if s.get("codec_type") == "video":
                                    vid_w = int(s.get("width", vid_w))
                                    vid_h = int(s.get("height", vid_h))
                                    break
                    except Exception:
                        pass

                    # 3. 生成每段分段 ASS（time_offset=0，时间相对于本段起始）
                    xml_files = [group.xml_map[i] for i in sorted(group.xml_map)]
                    for xml_path in xml_files:
                        seg_ass = xml_path.with_suffix('.ass')
                        render_xml_to_ass(xml_path, seg_ass, vid_w, vid_h,
                                          danmu_types, time_offset=0.0, log_fn=_log)

                    # 4. 生成总体 ASS（各段按偏移拼接到 merged_ass）
                    base_start = _xml_record_start(_parse_xml_safe(xml_files[0]))
                    total_dm, total_chat = 0, 0
                    # 总体 ASS：先用第一段建文件（offset=0），再追加后续段（offset>0）
                    # 利用 render_xml_to_ass 的 time_offset 参数依次渲染并合并
                    from src.danmu.ass_writer import AssWriter
                    from src.danmu.chat_panel_writer import ChatPanelWriter
                    from src.danmu.models import GiftDanmaku, MemberDanmaku, SimpleDanmaku
                    ass_writer = AssWriter(width=vid_w, height=vid_h)
                    ass_writer.open(group.merged_ass)
                    all_chat_items: list[SimpleDanmaku] = []
                    dm_count = 0

                    for xml_path in xml_files:
                        root = _parse_xml_safe(xml_path)
                        seg_start = _xml_record_start(root)
                        offset = seg_start - base_start
                        is_new_fmt = root.find('metadata') is not None

                        if 'danmaku' in danmu_types:
                            for d in root.findall('d'):
                                t_val = (float(d.get('p', '0').split(',')[0]) if is_new_fmt
                                         else float(d.get('t', 0))) + offset
                                if t_val < 0:
                                    continue
                                uname = d.get('user', '') if is_new_fmt else d.get('uname', '')
                                content = (d.text or '').strip()
                                item = SimpleDanmaku(
                                    time=t_val, uname=uname, uid=d.get('uid', ''),
                                    content=content, color='ffffff', dtype='danmaku',
                                    text=f'{uname}: {content}' if uname else content,
                                )
                                if ass_writer.add(item):
                                    dm_count += 1

                        if 'gift' in danmu_types:
                            for g in root.findall('gift'):
                                ts_ms = int(g.get('ts', 0))
                                t_val = (ts_ms / 1000.0 - seg_start if is_new_fmt
                                         else float(g.get('t', 0))) + offset
                                uname = g.get('user', '') if is_new_fmt else g.get('uname', '')
                                all_chat_items.append(GiftDanmaku(
                                    time=max(0.0, t_val), uname=uname, uid=g.get('uid', ''),
                                    gift_name=g.get('giftname', '') or g.get('gift', ''),
                                    gift_count=int(g.get('giftcount', 1) or g.get('count', 1)),
                                    gift_price=float(g.get('price', 0)),
                                    content='', color='ffaa00', dtype='gift',
                                ))

                        if 'member' in danmu_types:
                            for m in root.findall('member'):
                                ts_ms = int(m.get('ts', 0))
                                t_val = (ts_ms / 1000.0 - seg_start if ts_ms else 0.0) + offset
                                uname = m.get('user', '') if is_new_fmt else m.get('uname', '')
                                all_chat_items.append(MemberDanmaku(
                                    time=max(0.0, t_val), uname=uname, uid=m.get('uid', ''),
                                    member_count=int(m.get('member_count', 0)),
                                    content='', color='aaaaaa', dtype='member',
                                ))

                    ass_writer.close()
                    chat_count = 0
                    if all_chat_items:
                        all_chat_items.sort(key=lambda x: x.time or 0)
                        chat_writer = ChatPanelWriter(width=vid_w, height=vid_h)
                        chat_count = chat_writer.write(all_chat_items, group.merged_ass)

                    _log(f"[合并] 渲染完成 — 弹幕 {dm_count} 条 + 聊天面板 {chat_count} 条 → {group.merged_ass.name}")
                else:
                    # ASS fallback（旧格式，无 XML）
                    _log(f"[合并] 合并弹幕 ASS ({len(group.ass_map)} 段，fallback 模式)...")
                    merge_ass_files(group.ts_files, group.ass_map, group.merged_ass, log_fn=log_fn)

                # 获取原片视频码率 + 时长（用于烧录进度计算）
                src_vbitrate = min_vbitrate
                total_ms = 0
                try:
                    probe = subprocess.run(
                        ["ffprobe", "-v", "quiet", "-print_format", "json",
                         "-show_streams", "-show_format", str(group.merged_mp4)],
                        capture_output=True, text=True, timeout=30,
                    )
                    if probe.returncode == 0:
                        import json as _json
                        probe_data = _json.loads(probe.stdout)
                        for s in probe_data.get("streams", []):
                            if s.get("codec_type") == "video":
                                src_vbitrate = max(min_vbitrate, int(s.get("bit_rate", 0)) // 1000)
                                break
                        dur = float(probe_data.get("format", {}).get("duration", 0))
                        total_ms = int(dur * 1000)
                except Exception:
                    pass
                _log(f"[合并] 烧录弹幕 → {group.merged_danmu_mp4.name}（VideoToolbox {src_vbitrate}k）")
                proc = subprocess.Popen(
                    [
                        "ffmpeg", "-y",
                        "-i", str(group.merged_mp4),
                        "-progress", "pipe:1", "-nostats",
                        "-vf", f"ass={group.merged_ass.name},format=yuv420p",
                        "-c:v", "h264_videotoolbox", "-b:v", f"{src_vbitrate}k",
                        "-color_range", "tv",
                        "-c:a", "copy",
                        "-movflags", "+faststart",
                        str(group.merged_danmu_mp4),
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    cwd=str(group.output_dir),
                )
                # 后台收集 stderr（错误信息）
                stderr_lines: list[str] = []
                def _read_stderr() -> None:
                    for line in proc.stderr:
                        stderr_lines.append(line)
                threading.Thread(target=_read_stderr, daemon=True).start()
                # 从 stdout 解析 ffmpeg progress 协议
                for line in proc.stdout:
                    if line.startswith("out_time_ms=") and total_ms > 0 and progress_callback:
                        val = line.split("=", 1)[1].strip()
                        if val.lstrip("-").isdigit():
                            ms = int(val)
                            if ms > 0:
                                pct = min(99, int(ms / total_ms * 100))
                                progress_callback(pct)
                proc.wait()
                if proc.returncode != 0:
                    group.merged_danmu_mp4.unlink(missing_ok=True)
                    err = "".join(stderr_lines)[-600:].strip()
                    raise RuntimeError(f"ffmpeg 弹幕烧录失败 (rc={proc.returncode}): {err or '(无输出)'}")
                if progress_callback:
                    progress_callback(100)

                size_mb = group.merged_danmu_mp4.stat().st_size / 1024 / 1024
                danmu_mp4 = str(group.merged_danmu_mp4)
                _log(f"[合并] 弹幕版完成: {group.merged_danmu_mp4.name} ({size_mb:.1f} MB)")

            except Exception as e:
                _log(f"[合并] 弹幕烧录失败: {e}")
                raise

    return {"plain_mp4": plain_mp4, "danmu_mp4": danmu_mp4}
