"""直播间聊天面板写入器 — 复刻抖音聊天框样式：消息从底部堆叠，新消息在底部，旧消息被顶上去。

布局（默认 1920×1080）：
  - 横向：左侧 2%–42%（宽约 40%），留给右侧视频主体
  - 纵向：底部 5%–25%（y = 75%–95%）
  - 最新消息固定在面板最底部，新消息到来时旧消息向上移动一格
  - display_duration 秒后消息消失（或被推出可见区域后隐藏）
  - clip() 限制渲染区域，超出面板顶部后不可见
"""

from __future__ import annotations

from pathlib import Path

from .ass_writer import _tag_emoji
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
        fontsize: int = 26,
        line_spacing: int = 6,
        opacity: float = 0.85,
        display_duration: float = 30.0,
        panel_left_pct: float = 0.02,
        panel_right_pct: float = 0.42,
        panel_top_pct: float = 0.75,
        panel_bottom_pct: float = 0.95,
        outlinecolor: str = '000000',
        outlinesize: float = 1.0,
    ) -> None:
        self.width = width
        self.height = height
        self.fontsize = int(height / 1080 * fontsize)
        self.font = font
        self.opacity = hex(255 - int(opacity * 255))[2:].zfill(2)
        self.display_duration = display_duration
        self.outlinecolor = outlinecolor.zfill(6)
        self.outlinesize = outlinesize

        # 面板像素坐标
        self.panel_x = int(width * panel_left_pct)
        self.panel_right = int(width * panel_right_pct)
        self.panel_top = int(height * panel_top_pct)
        self.panel_bottom = int(height * panel_bottom_pct)

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

        for i, item in enumerate(valid):
            text = _tag_emoji(
                self._format_text(item).replace('\n', ' ').replace('\r', ' '),
                self.font,
            )
            if not text:
                continue
            color = _rgb2bgr(item.color if item.color.startswith('#') else f'#{item.color}')
            expire = item.time + self.display_duration

            # rank k：消息 i 在面板中的位置（0 = 最底部，随新消息到来逐渐增大）
            # 每当后续第 k 条消息到来，该消息上移到 rank k
            for k in range(self.max_visible):
                j = i + k  # 触发 rank k 的消息索引
                if j >= len(valid):
                    break

                seg_start = valid[j].time  # rank k 开始时刻（k=0 即消息本身出现时）
                next_j = j + 1
                if next_j < len(valid):
                    seg_end = min(valid[next_j].time, expire)
                else:
                    seg_end = expire

                if seg_end <= seg_start:
                    # 下一条消息同时到来（零时段），直接跳过，等下一个 k
                    continue

                # \an1 = 左下角锚点，y 为文字底边坐标
                y = self.panel_bottom - self.line_h * (k + 1)
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
