"""ASS 弹幕写入器（源自 DanmakuRender/DMR/Downloader/Danmaku/asswriter.py）"""

from __future__ import annotations

import threading
from pathlib import Path

from .models import SimpleDanmaku


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
        font: str = 'Microsoft YaHei',
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
            line = (
                f'Dialogue: 0,{t0},{t1},R2L,,0,0,0,,'
                f'{{\\q2\\move({x0},{y + self.dst},{x1},{y + self.dst})}}'
                f'{{\\alpha&H{self.opacity}\\1c{color_str}&}}'
                + dm.text.replace('\n', ' ').replace('\r', ' ')
            )
            with open(self._filename, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
            self._track_tails[tid] = dm
        return True

    def close(self) -> None:
        with self._lock:
            self._filename = None
            self._track_tails = []
