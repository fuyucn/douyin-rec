"""底部聊天面板写入器 — 礼物/入场消息从底部向上滚动，消失于 70% 高度处"""

from __future__ import annotations

from pathlib import Path

from .models import GiftDanmaku, MemberDanmaku, SimpleDanmaku


def _sec2ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return '%01d:%02d:%05.2f' % (h, m, s)


def _rgb2bgr(color: str) -> str:
    color = color.lstrip('#').zfill(6)
    return f'&H{color[4:6]}{color[2:4]}{color[0:2]}'


class ChatPanelWriter:
    """批量处理礼物/入场消息，追加到已有 ASS 文件的聊天面板样式。

    布局：
      - 区域：屏幕左侧，底部 20% 高度（80%–100%）
      - 每条消息从底部向上匀速滚动，到达 80% 高度时消失
      - 速度：scroll_speed px/s（默认 50）
    """

    STYLE_NAME = 'Chat'

    def __init__(
        self,
        width: int = 1920,
        height: int = 1080,
        font: str = 'Microsoft YaHei',
        fontsize: int = 24,
        opacity: float = 0.85,
        scroll_speed: float = 50.0,
        panel_x: int = 20,
        outlinecolor: str = '000000',
        outlinesize: float = 1.0,
    ) -> None:
        self.width = width
        self.height = height
        self.fontsize = int(height / 1080 * fontsize)
        self.font = font
        self.opacity = hex(255 - int(opacity * 255))[2:].zfill(2)
        self.scroll_speed = scroll_speed
        self.panel_x = panel_x
        self.outlinecolor = outlinecolor.zfill(6)
        self.outlinesize = outlinesize

        # 聊天面板：底部 30% 区域
        self.panel_bottom = height
        self.panel_top = int(height * 0.80)
        self.duration = (self.panel_bottom - self.panel_top) / scroll_speed  # 秒

    def _style_line(self) -> str:
        op = self.opacity
        oc = self.outlinecolor
        return (
            f'Style: {self.STYLE_NAME},{self.font},{self.fontsize},'
            f'&H{op}FFFFFF,&H{op}000000,&H{op}{oc},&H4F0000FF,'
            f'-1,0,0,0,100,100,0,0,1,{self.outlinesize},0,1,0,0,0,0'
        )

    def _format_text(self, item: SimpleDanmaku) -> str:
        if isinstance(item, GiftDanmaku):
            return f'🎁 {item.uname}: {item.gift_count}个{item.gift_name}'
        if isinstance(item, MemberDanmaku):
            return f'👋 {item.uname} 进入直播间'
        return item.content or item.text or ''

    def write(self, items: list[SimpleDanmaku], ass_path: Path) -> int:
        """将礼物/入场消息作为聊天面板事件追加到已有 .ass 文件。返回写入条数。"""
        if not items:
            return 0

        # 读取已有文件，在 [V4+ Styles] 块插入 Chat style，在 [Events] 块追加事件
        content = ass_path.read_text(encoding='utf-8')

        # 插入 Chat style（在 [Events] 行前）
        style_line = self._style_line()
        if self.STYLE_NAME not in content:
            content = content.replace(
                '\n[Events]',
                f'\n{style_line}\n\n[Events]',
            )

        # 生成聊天面板 Dialogue 行
        lines = []
        x = self.panel_x
        y0 = self.panel_bottom
        y1 = self.panel_top

        for item in items:
            if item.time is None or item.time < 0:
                continue
            t_start = _sec2ts(item.time)
            t_end = _sec2ts(item.time + self.duration)
            text = self._format_text(item).replace('\n', ' ').replace('\r', ' ')
            if not text:
                continue
            color = _rgb2bgr(item.color if item.color.startswith('#') else f'#{item.color}')
            line = (
                f'Dialogue: 1,{t_start},{t_end},{self.STYLE_NAME},,0,0,0,,'
                f'{{\\q2\\move({x},{y0},{x},{y1})}}'
                f'{{\\alpha&H{self.opacity}\\1c{color}&}}'
                f'{text}'
            )
            lines.append(line)

        if not lines:
            return 0

        content = content.rstrip('\n') + '\n' + '\n'.join(lines) + '\n'
        ass_path.write_text(content, encoding='utf-8')
        return len(lines)
