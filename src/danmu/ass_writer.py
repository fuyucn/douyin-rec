"""ASS 弹幕写入器（源自 DanmakuRender/DMR/Downloader/Danmaku/asswriter.py）"""

from __future__ import annotations

import threading
import unicodedata
from pathlib import Path

from .models import SimpleDanmaku

# 项目内置字体目录，优先于系统字体
FONTS_DIR = Path(__file__).resolve().parent.parent.parent / 'assets' / 'fonts'

# libass 通过 fontconfig 查找字体。emoji 需要显式指定字体标签，
# 否则 fallback 机制在 macOS coretext 后端下对 emoji 字形不可靠。
# NotoEmoji-Static.ttf 随项目打包在 assets/fonts/，避免依赖系统安装。
EMOJI_FONT = 'Noto Emoji'

# Unicode emoji 区间（BMP + 扩展平面常用段）
_EMOJI_RANGES = (
    (0x1F300, 0x1FAFF),  # 杂项符号、表情、交通、地图等
    (0x1F000, 0x1F0FF),  # 麻将/多米诺
    (0x2600,  0x27BF),   # 杂项符号 & 迪丁巴茨
    (0x231A,  0x231B), (0x23E9, 0x23F3), (0x23F8, 0x23FA),
    (0x25AA,  0x25AB), (0x25FB, 0x25FE),
    (0x2614,  0x2615), (0x2648, 0x2653),
    (0x26AA,  0x26AB), (0x26BD, 0x26BE), (0x26C4, 0x26C5),
    (0x2702,  0x2702), (0x2705, 0x2705), (0x2708, 0x270D),
    (0x2753,  0x2755), (0x2795, 0x2797),
    (0xFE00,  0xFE0F),   # 变体选择符
)


def _is_emoji(cp: int) -> bool:
    return any(lo <= cp <= hi for lo, hi in _EMOJI_RANGES)


def _prepare_text(text: str, main_font: str) -> str:
    """NFKC 规范化（花体字 → ASCII fallback）+ emoji 字体标签。"""
    return _tag_emoji(unicodedata.normalize('NFKC', text), main_font)


def _tag_emoji(text: str, main_font: str) -> str:
    """将 emoji 字符用 \\fn 标签包裹，强制 libass 使用 EMOJI_FONT 渲染。"""
    parts: list[str] = []
    in_emoji = False
    for ch in text:
        e = _is_emoji(ord(ch))
        if e and not in_emoji:
            parts.append(f'{{\\fn{EMOJI_FONT}}}')
            in_emoji = True
        elif not e and in_emoji:
            parts.append(f'{{\\fn{main_font}}}')
            in_emoji = False
        parts.append(ch)
    if in_emoji:
        parts.append(f'{{\\fn{main_font}}}')
    return ''.join(parts)


def _sec2hms(sec: float) -> tuple[int, int, float]:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return h, m, s


def _rgb2bgr(color: str) -> str:
    """#RRGGBB → &HBBGGRR（ASS 格式）"""
    color = color.lstrip('#').zfill(6)
    return f'&H{color[4:6]}{color[2:4]}{color[0:2]}'


class AssWriter:
    """流式写入 ASS 弹幕文件，支持碰撞检测避免重叠"""

    def __init__(
        self,
        width: int = 1920,
        height: int = 1080,
        font: str = 'Noto Sans CJK SC',
        fontsize: int = 32,
        dmrate: float = 0.20,
        dmduration: float = 16.0,
        opacity: float = 0.8,
        margin_h: int = 6,
        margin_w: int = 12,
        dst: int = 0,
        outlinecolor: str = '000000',
        outlinesize: float = 1.0,
    ) -> None:
        self.width = width
        self.height = height
        self.fontsize = int(height / 1080 * fontsize)
        self.font = font
        self.dmduration = dmduration
        self.margin_h = margin_h
        self.margin_w = margin_w
        self.dst = dst
        self.outlinecolor = str(outlinecolor).zfill(6)
        self.outlinesize = outlinesize
        self.opacity = hex(255 - int(opacity * 255))[2:].zfill(2)
        self._ntracks = int(((height - dst) * dmrate) / (self.fontsize + margin_h))
        self._lock = threading.Lock()
        self._filename: str | None = None
        self._track_tails: list[SimpleDanmaku | None] = []

        self._meta = [
            '[Script Info]',
            'ScriptType: v4.00+',
            'Collisions: Normal',
            f'PlayResX: {width}',
            f'PlayResY: {height}',
            'Timer: 100.0000',
            'WrapStyle: 2',
            '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, '
            'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, '
            'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
            'Alignment, MarginL, MarginR, MarginV, Encoding',
            f'Style: R2L,{font},{self.fontsize},&H{self.opacity}FFFFFF,'
            f'&H{self.opacity}000000,&H{self.opacity}{outlinecolor},'
            f'&H4F0000FF,-1,0,0,0,100,100,0,0,1,{outlinesize},0,1,0,0,0,0',
            '',
            '[Events]',
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ]

    def open(self, path: str | Path) -> None:
        with self._lock:
            self._filename = str(path)
            self._track_tails = [None] * self._ntracks
            with open(self._filename, 'w', encoding='utf-8') as f:
                for line in self._meta:
                    f.write(line + '\n')

    def _char_width(self, text: str) -> int:
        w = 0
        for ch in text:
            w += self.fontsize if len(ch.encode('utf-8')) > 1 else self.fontsize // 2
        return w

    def add(self, dm: SimpleDanmaku) -> bool:
        """追加一条弹幕，碰撞时丢弃。返回是否写入。"""
        if not self._filename or dm.time is None or dm.time < 0 or not dm.text:
            return False

        def tail_dist(tail: SimpleDanmaku | None) -> float:
            if tail is None:
                return 1e5
            dm_len = self._char_width(tail.text)
            return (dm.time - tail.time) * (dm_len + self.width) / self.dmduration - dm_len

        with self._lock:
            tid, max_dist = 0, -1e5
            for i, tail in enumerate(self._track_tails):
                dist = tail_dist(tail)
                if dist > 0.2 * self.width and dist > self.margin_w:
                    tid, max_dist = i, dist
                    break
                if dist > max_dist:
                    tid, max_dist = i, dist

            if max_dist < self.margin_w:
                return False  # 碰撞，丢弃

            dm_len = self._char_width(dm.text)
            x0, x1 = self.width, -dm_len
            y = self.fontsize + (self.fontsize + self.margin_h) * tid

            t0 = '%02d:%02d:%05.2f' % _sec2hms(dm.time)
            t1 = '%02d:%02d:%05.2f' % _sec2hms(dm.time + self.dmduration)

            color_str = _rgb2bgr(dm.color if dm.color.startswith('#') else f'#{dm.color}')
            text = _prepare_text(
                dm.text.replace('\n', ' ').replace('\r', ' '),
                self.font,
            )
            line = (
                f'Dialogue: 0,{t0},{t1},R2L,,0,0,0,,'
                f'{{\\q2\\move({x0},{y + self.dst},{x1},{y + self.dst})}}'
                f'{{\\alpha&H{self.opacity}\\1c{color_str}&}}'
                + text
            )
            with open(self._filename, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
            self._track_tails[tid] = dm
        return True

    def close(self) -> None:
        with self._lock:
            self._filename = None
            self._track_tails = []
