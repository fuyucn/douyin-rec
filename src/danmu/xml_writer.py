"""弹幕 XML 写入器 — 全量记录所有弹幕类型，不做碰撞过滤"""

from __future__ import annotations

import threading
import xml.sax.saxutils as saxutils
from pathlib import Path

from .models import GiftDanmaku, MemberDanmaku, SimpleDanmaku


class XmlWriter:
    """流式写入弹幕 XML 文件。

    文件格式::

        <?xml version="1.0" encoding="utf-8"?>
        <danmaku record_start="1773532685.123" session="2026-03-14_17-18-01" seg_idx="0">
          <d t="1.57" type="chat" uid="123" uname="五月" color="ffffff">弹幕内容</d>
          <d t="60.0" type="gift" uid="456" uname="土豪" gift="舰长" count="1" price="198.0"/>
          <d t="90.0" type="member" uid="789" uname="新粉丝" member_count="1234"/>
        </danmaku>

    record_start 写在根节点，合并工具直接相减算偏移，无需 ffprobe。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._file = None
        self._path: Path | None = None

    def open(self, path: Path, record_start: float, session: str, seg_idx: int) -> None:
        with self._lock:
            self._path = path
            self._file = open(path, 'w', encoding='utf-8')
            self._file.write('<?xml version="1.0" encoding="utf-8"?>\n')
            self._file.write(
                f'<danmaku'
                f' record_start="{record_start:.3f}"'
                f' session="{saxutils.escape(session)}"'
                f' seg_idx="{seg_idx}"'
                f'>\n'
            )
            self._file.flush()

    def add(self, item: SimpleDanmaku) -> None:
        if self._file is None or item.time is None:
            return
        t = max(0.0, item.time)
        attrs = self._build_attrs(item, t)
        text = (item.content or '').replace('\n', ' ').replace('\r', ' ')

        with self._lock:
            if self._file is None:
                return
            if text:
                self._file.write(
                    f'  <d {attrs}>{saxutils.escape(text)}</d>\n'
                )
            else:
                self._file.write(f'  <d {attrs}/>\n')
            self._file.flush()

    def _build_attrs(self, item: SimpleDanmaku, t: float) -> str:
        uid = getattr(item, 'uid', '') or ''
        uname = item.uname or ''
        parts = [
            f't="{t:.3f}"',
            f'type="{item.dtype or "chat"}"',
            f'uid="{saxutils.escape(str(uid))}"',
            f'uname="{saxutils.escape(uname)}"',
        ]
        if isinstance(item, GiftDanmaku):
            parts += [
                f'gift="{saxutils.escape(item.gift_name)}"',
                f'count="{item.gift_count}"',
                f'price="{item.gift_price:.1f}"',
                f'color="{item.color}"',
            ]
        elif isinstance(item, MemberDanmaku):
            parts.append(f'member_count="{item.member_count}"')
        else:
            parts.append(f'color="{item.color}"')
        return ' '.join(parts)

    def close(self) -> None:
        with self._lock:
            if self._file is not None:
                self._file.write('</danmaku>\n')
                self._file.close()
                self._file = None
                self._path = None
