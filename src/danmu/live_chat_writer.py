"""直播间聊天面板写入器 — 复刻抖音聊天框样式：消息从底部堆叠，新消息在底部，旧消息被顶上去。

布局（默认 1920×1080）：
  - 横向：左侧 2%–42%（宽约 40%），留给右侧视频主体
  - 纵向：底部 5%–25%（y = 75%–95%）
  - 最新消息固定在面板最底部，新消息到来时旧消息向上移动一格
  - display_duration 秒后消息消失（或被推出可见区域后隐藏）
  - clip() 限制渲染区域，超出面板顶部后不可见
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

from .ass_writer import _prepare_text
from .models import GiftDanmaku, MemberDanmaku, SimpleDanmaku

# 项目内置字体目录
FONTS_DIR = Path(__file__).resolve().parent.parent.parent / 'assets' / 'fonts'


def _sec2ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return '%01d:%02d:%05.2f' % (h, m, s)


def _rgb2bgr(color: str) -> str:
    color = color.lstrip('#').zfill(6)
    return f'&H{color[4:6]}{color[2:4]}{color[0:2]}'


class LiveChatWriter:
    """生成独立的直播间聊天框样式 ASS 文件。

    消息堆叠逻辑：
    - 每条消息出现时在面板最底部（rank 0）
    - 每当新消息到来，已有消息 rank+1（向上移动一格）
    - 超出 max_visible 行的消息被 clip 截断，display_duration 后从 ASS 中消失
    """

    STYLE_NAME = 'LiveChat'

    def __init__(
        self,
        width: int = 1920,
        height: int = 1080,
        font: str = 'Noto Sans CJK SC',
        fontsize: int = 32,
        line_spacing: int = 6,
        opacity: float = 0.85,
        display_duration: float = 30.0,
        panel_left_pct: float = 0.02,
        panel_right_pct: float = 0.65,
        panel_top_pct: float = 0.78,
        panel_bottom_pct: float = 0.98,
        outlinecolor: str = '000000',
        outlinesize: float = 1.0,
    ) -> None:
        self.width = width
        self.height = height
        self.fontsize = int(min(width, height) / 1080 * fontsize)
        self.font = font
        self.opacity = hex(255 - int(opacity * 255))[2:].zfill(2)
        self.display_duration = display_duration
        self.outlinecolor = outlinecolor.zfill(6)
        self.outlinesize = outlinesize

        # 面板像素坐标（panel_right 上限 min(w,h)/2 = 540px@1080p）
        self.panel_x = int(width * panel_left_pct)
        self.panel_right = int(width * panel_right_pct)
        self.panel_top = int(height * panel_top_pct)
        self.panel_bottom = int(height * panel_bottom_pct)

        # 面板宽度（用于手动预计算折行）
        self.panel_w = self.panel_right - self.panel_x

        # 右边距（用于 Dialogue MarginR）
        self.margin_r = width - self.panel_right

        # 每行高度 = 字体大小 + 行间距
        self.line_h = self.fontsize + line_spacing
        # 面板最多显示的行数
        self.max_visible = max(1, (self.panel_bottom - self.panel_top) // self.line_h)

    def _ass_header(self) -> str:
        op = self.opacity
        oc = self.outlinecolor
        style = (
            f'Style: {self.STYLE_NAME},{self.font},{self.fontsize},'
            f'&H{op}FFFFFF,&H{op}000000,&H{op}{oc},&H4F0000FF,'
            f'-1,0,0,0,100,100,0,0,1,{self.outlinesize},0,1,0,0,0,0'
        )
        return '\n'.join([
            '[Script Info]',
            'ScriptType: v4.00+',
            'Collisions: Normal',
            f'PlayResX: {self.width}',
            f'PlayResY: {self.height}',
            'Timer: 100.0000',
            'WrapStyle: 2',
            '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, '
            'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, '
            'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
            'Alignment, MarginL, MarginR, MarginV, Encoding',
            style,
            '',
            '[Events]',
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ]) + '\n'

    def _char_w(self, ch: str) -> int:
        """估算单个字符的渲染宽度（像素）。用 east_asian_width 区分全角/半角。"""
        eaw = unicodedata.east_asian_width(ch)
        if eaw in ('W', 'F'):          # 全宽：CJK、全角标点等
            return self.fontsize
        if eaw in ('Na', 'H'):         # 窄/半角：ASCII、半角标点
            return self.fontsize // 2
        # 'N' 中性 / 'A' 歧义：按字节数粗判，多字节按全宽处理
        return self.fontsize if len(ch.encode('utf-8')) > 1 else self.fontsize // 2

    def _wrap_text(self, text: str) -> str:
        """在面板宽度处插入 \\N（ASS 硬换行），避免依赖 libass 自动折行。"""
        max_w = self.panel_w
        lines, cur, cur_w = [], '', 0
        for ch in text:
            ch_w = self._char_w(ch)
            if cur_w + ch_w > max_w and cur:  # 留一字宽安全边距
                lines.append(cur)
                cur, cur_w = ch, ch_w
            else:
                cur += ch
                cur_w += ch_w
        if cur:
            lines.append(cur)
        return r'\N'.join(lines)

    def _format_text(self, item: SimpleDanmaku) -> str:
        if isinstance(item, GiftDanmaku):
            return f'🎁 {item.uname}: {item.gift_count}个{item.gift_name}'
        if isinstance(item, MemberDanmaku):
            return f'👋 {item.uname} 进入直播间'
        uname = item.uname or ''
        content = item.content or item.text or ''
        return f'{uname}: {content}' if uname else content

    def write(self, items: list[SimpleDanmaku], ass_path: Path) -> int:
        """生成直播间聊天框 ASS 文件（堆叠模式）。返回写入的 Dialogue 行数。"""
        valid = [it for it in items if it.time is not None and it.time >= 0]
        valid.sort(key=lambda x: x.time)  # type: ignore[arg-type]

        if not valid:
            ass_path.write_text(self._ass_header(), encoding='utf-8')
            return 0

        clip = f'\\clip({self.panel_x},{self.panel_top},{self.panel_right},{self.panel_bottom})'
        dialogue_lines: list[str] = []
        count = 0

        # 预计算每条消息的折行后实际高度（行数 × line_h）
        wrapped: list[str] = []
        heights: list[int] = []
        for item in valid:
            raw = self._wrap_text(
                self._format_text(item).replace('\n', ' ').replace('\r', ' ')
            )
            wrapped.append(raw)
            heights.append((raw.count(r'\N') + 1) * self.line_h)

        for i, item in enumerate(valid):
            text = _prepare_text(wrapped[i], self.font)
            if not text:
                continue
            color = _rgb2bgr(item.color if item.color.startswith('#') else f'#{item.color}')
            expire = item.time + self.display_duration

            # rank k：消息 i 在面板中的位置（0 = 最底部，随新消息到来逐渐增大）
            # y = panel_bottom 减去"我下方所有消息"的累计高度
            # 当 k=0 时消息 i 就在最底部，y = panel_bottom（\an1 底边贴面板底）
            for k in range(self.max_visible):
                j = i + k  # 触发 rank k 的消息索引
                if j >= len(valid):
                    break

                # 累计 i 下方（rank 0..k-1）各消息的实际高度
                below_h = sum(heights[i + m] for m in range(1, k + 1))
                y = self.panel_bottom - below_h

                # 若消息已超出面板顶部，停止
                if y - heights[i] < self.panel_top:
                    break

                seg_start = valid[j].time
                next_j = j + 1
                if next_j < len(valid):
                    seg_end = min(valid[next_j].time, expire)
                else:
                    seg_end = expire

                if seg_end <= seg_start:
                    continue

                t0 = _sec2ts(seg_start)
                t1 = _sec2ts(seg_end)
                line = (
                    f'Dialogue: 1,{t0},{t1},{self.STYLE_NAME},,0,0,0,,'
                    f'{{\\an1\\q2{clip}\\pos({self.panel_x},{y})}}'
                    f'{{\\alpha&H{self.opacity}\\1c{color}&}}'
                    f'{text}'
                )
                dialogue_lines.append(line)
                count += 1

                if seg_end >= expire:
                    break  # 消息已过期，停止继续向上

        ass_path.write_text(self._ass_header() + '\n'.join(dialogue_lines) + '\n', encoding='utf-8')
        return count
