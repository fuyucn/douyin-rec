"""弹幕 XML 写入器 — 输出与 biliLive-tools DouYin 兼容的 XML 格式"""

from __future__ import annotations

import re
import threading
import xml.sax.saxutils as _saxutils
from pathlib import Path

# XML 1.0 合法字符范围（不含这些范围的字符会导致解析失败）
_XML_INVALID_CHARS = re.compile(
    r'[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\U00010000-\U0010FFFF]'
)


def _xml_escape(s: str) -> str:
    """先去除 XML 1.0 非法字符，再做标准 escape（防止弹幕内容破坏 XML 结构）"""
    s = _XML_INVALID_CHARS.sub('', s)
    return _saxutils.escape(s)

from .models import GiftDanmaku, MemberDanmaku, SimpleDanmaku

# XSL 样式块（来自 biliLive-tools），写入后浏览器可直接预览弹幕文件
_RECORDER_XML_STYLE = '<RecorderXmlStyle><z:stylesheet version="1.0" id="s" xml:id="s" xmlns:z="http://www.w3.org/1999/XSL/Transform"><z:output method="html"/><z:template match="/"><html><meta name="viewport" content="width=device-width"/><title>弹幕文件 <z:value-of select="/i/metadata/user_name/text()"/></title><style>body{margin:0}h1,h2,p,table{margin-left:5px}table{border-spacing:0}td,th{border:1px solid grey;padding:1px 5px}th{position:sticky;top:0;background:#4098de}tr:hover{background:#d9f4ff}div{overflow:auto;max-height:80vh;max-width:100vw;width:fit-content}</style><h1>弹幕XML文件</h1><p>本文件不支持在 IE 浏览器里预览，请使用 Chrome Firefox Edge 等浏览器。</p><table><tr><td>房间号</td><td><z:value-of select="/i/metadata/room_id/text()"/></td></tr><tr><td>主播名</td><td><z:value-of select="/i/metadata/user_name/text()"/></td></tr><tr><td><a href="#d">弹幕</a></td><td>共<z:value-of select="count(/i/d)"/>条记录</td></tr><tr><td><a href="#gift">礼物</a></td><td>共<z:value-of select="count(/i/gift)"/>条记录</td></tr><tr><td><a href="#member">入场</a></td><td>共<z:value-of select="count(/i/member)"/>条记录</td></tr></table><h2 id="d">弹幕</h2><div id="dm"><table><tr><th>用户名</th><th>出现时间</th><th>用户ID</th><th>弹幕</th><th>参数</th></tr><z:for-each select="/i/d"><tr><td><z:value-of select="@user"/></td><td></td><td><z:value-of select="@uid"/></td><td><z:value-of select="."/></td><td><z:value-of select="@p"/></td></tr></z:for-each></table></div><script>Array.from(document.querySelectorAll(\'#dm tr\')).slice(1).map(t=>t.querySelectorAll(\'td\')).forEach(t=>{let p=t[4].textContent.split(\',\'),a=p[0];t[1].textContent=`${(Math.floor(a/60/60)+\'\').padStart(2,0)}:${(Math.floor(a/60%60)+\'\').padStart(2,0)}:${(a%60).toFixed(3).padStart(6,0)}`})</script><h2 id="gift">礼物</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>礼物名</th><th>数量</th><th>价格</th><th>时间戳</th></tr><z:for-each select="/i/gift"><tr><td><z:value-of select="@user"/></td><td><z:value-of select="@uid"/></td><td><z:value-of select="@giftname"/></td><td><z:value-of select="@giftcount"/></td><td><z:value-of select="@price"/></td><td><z:value-of select="@ts"/></td></tr></z:for-each></table></div><h2 id="member">入场提醒</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>在线人数</th><th>时间戳</th></tr><z:for-each select="/i/member"><tr><td><z:value-of select="@user"/></td><td><z:value-of select="@uid"/></td><td><z:value-of select="@member_count"/></td><td><z:value-of select="@ts"/></td></tr></z:for-each></table></div></html></z:template></z:stylesheet></RecorderXmlStyle>'


class XmlWriter:
    """流式写入弹幕 XML 文件，格式兼容 biliLive-tools DouYin。

    文件格式::

        <?xml version="1.0" encoding="utf-8"?>
        <?xml-stylesheet type="text/xsl" href="#s"?>
        <i>
        <metadata>
          <platform>DouYin</platform>
          <video_start_time>1773532685123</video_start_time>  <!-- Unix ms -->
          <room_title>...</room_title>
          <user_name>主播名</user_name>
          <room_id>767116735823</room_id>
        </metadata>
        <RecorderXmlStyle>...</RecorderXmlStyle>
        <d p="1.57,1,25,16777215,1773532687000,0,123,123,0" user="五月" uid="123" timestamp="1773532687000">弹幕内容</d>
        <gift user="土豪" uid="456" giftname="舰长" giftcount="1" price="198.0" ts="1773532700000"/>
        <member user="新粉丝" uid="789" member_count="1234" ts="1773532720000"/>
        </i>

    p 属性格式（对齐 biliLive-tools）：
        time_sec, mode(1), fontsize(25), color(16777215), timestamp_ms, pool(0), uid, uid, badge(0)
    video_start_time = record_start * 1000（Unix ms），用于多分段合并时计算偏移。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._file = None
        self._path: Path | None = None
        self._insert_pos: int = 0  # byte offset of the closing </i> tag

    def open(
        self,
        path: Path,
        record_start: float,
        session: str,
        seg_idx: int,
        user_name: str = '',
        room_id: str = '',
        room_title: str = '',
    ) -> None:
        with self._lock:
            self._path = path
            self._file = open(path, 'w+', encoding='utf-8')
            video_start_time = int(record_start * 1000)
            self._file.write('<?xml version="1.0" encoding="utf-8"?>\n')
            self._file.write('<?xml-stylesheet type="text/xsl" href="#s"?>\n')
            self._file.write('<i>\n')
            self._file.write('<metadata>\n')
            self._file.write('  <platform>DouYin</platform>\n')
            self._file.write(f'  <video_start_time>{video_start_time}</video_start_time>\n')
            self._file.write(f'  <room_title>{_xml_escape(room_title)}</room_title>\n')
            self._file.write(f'  <user_name>{_xml_escape(user_name)}</user_name>\n')
            self._file.write(f'  <room_id>{_xml_escape(room_id)}</room_id>\n')
            self._file.write('</metadata>\n')
            self._file.write(_RECORDER_XML_STYLE + '\n')
            # 记录插入点，写入关闭标签使文件始终是合法 XML
            self._insert_pos = self._file.tell()
            self._file.write('</i>\n')
            self._file.flush()

    def add(self, item: SimpleDanmaku) -> None:
        if self._file is None or item.time is None:
            return
        t = max(0.0, item.time)
        uid = _xml_escape(str(getattr(item, 'uid', '') or ''))
        uname = _xml_escape(item.uname or '')
        ts_ms = int(item.timestamp * 1000)

        with self._lock:
            if self._file is None:
                return
            if isinstance(item, GiftDanmaku):
                line = (
                    f'<gift'
                    f' user="{uname}"'
                    f' uid="{uid}"'
                    f' giftname="{_xml_escape(item.gift_name)}"'
                    f' giftcount="{item.gift_count}"'
                    f' price="{item.gift_price:.1f}"'
                    f' ts="{ts_ms}"'
                    f'/>\n'
                )
            elif isinstance(item, MemberDanmaku):
                line = (
                    f'<member'
                    f' user="{uname}"'
                    f' uid="{uid}"'
                    f' member_count="{item.member_count}"'
                    f' ts="{ts_ms}"'
                    f'/>\n'
                )
            else:
                # 聊天弹幕：<d p="time_sec,mode,fontsize,color,timestamp_ms,pool,uid,uid,0">
                p = f'{t:.3f},1,25,16777215,{ts_ms},0,{uid},{uid},0'
                text = _xml_escape((item.content or '').replace('\n', ' ').replace('\r', ' '))
                line = f'<d p="{p}" user="{uname}" uid="{uid}" timestamp="{ts_ms}">{text}</d>\n'
            # 在 </i> 之前插入，保持文件始终是合法 XML
            self._file.seek(self._insert_pos)
            self._file.write(line)
            self._insert_pos = self._file.tell()
            self._file.write('</i>\n')
            self._file.flush()

    def close(self) -> None:
        with self._lock:
            if self._file is not None:
                # </i> 已在每次 add() 后写入，直接关闭即可
                self._file.close()
                self._file = None
                self._path = None
                self._insert_pos = 0
