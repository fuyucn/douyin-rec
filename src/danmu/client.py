"""抖音直播弹幕 WebSocket 客户端（源自 DanmakuRender/DMR/LiveAPI/danmaku/douyin/__init__.py）"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import re
import ssl
import time
from datetime import datetime

import aiohttp
from google.protobuf import json_format

from .douyin_utils import DouyinUtils
from .dy_pb2 import ChatMessage, GiftMessage, MemberMessage, PushFrame, Response
from .models import GiftDanmaku, SimpleDanmaku
from .ws_utils import DouyinDanmakuUtils

logger = logging.getLogger(__name__)


def _cookiestr2dict(cookie_str: str) -> dict:
    result = {}
    for part in cookie_str.split('; '):
        if '=' in part:
            k, v = part.split('=', 1)
            result[k.strip()] = v.strip()
    return result


def _extract_room_id(url: str) -> str:
    """从直播间 URL 提取 room_id（web_rid）"""
    m = re.search(r'live\.douyin\.com/(\d+)', url)
    if m:
        return m.group(1)
    # 短链或其他格式，取最后一段路径
    m = re.search(r'/([^/?#]+)(?:[?#]|$)', url)
    return m.group(1) if m else url


class DouyinDanmakuClient:
    """抖音直播弹幕 WebSocket 客户端，向 asyncio.Queue 推送 SimpleDanmaku"""

    heartbeat = b':\x02hb'
    heartbeat_interval = 10

    def __init__(self, url: str, queue: asyncio.Queue,
                 cookies: str | None = None) -> None:
        self._url = url
        self._queue = queue
        self._stop = False
        self._ws = None
        self._session: aiohttp.ClientSession | None = None

        extra_cookies = _cookiestr2dict(cookies) if cookies else None
        self._headers = DouyinUtils.get_headers(extra_cookies=extra_cookies)
        self._room_id = _extract_room_id(url)

    async def _get_ws_url(self) -> str:
        async with aiohttp.ClientSession() as sess:
            api_url = DouyinUtils.build_request_url(
                f'https://live.douyin.com/webcast/room/web/enter/?web_rid={self._room_id}'
            )
            async with sess.get(api_url, headers=self._headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                text = await resp.text()
                data = json.loads(text)
                try:
                    room_info = data['data']['data'][0]
                except (KeyError, IndexError, TypeError) as e:
                    raise RuntimeError(f'获取房间信息失败 (HTTP {resp.status}): {text[:200]}') from e

        uid = DouyinDanmakuUtils.get_user_unique_id()
        VERSION_CODE = 180800
        SDK_VERSION = '1.0.14-beta.0'

        sig_params = {
            'live_id': '1', 'aid': '6383',
            'version_code': VERSION_CODE,
            'webcast_sdk_version': SDK_VERSION,
            'room_id': room_info['id_str'],
            'sub_room_id': '', 'sub_channel_id': '',
            'did_rule': '3', 'user_unique_id': uid,
            'device_platform': 'web', 'device_type': '',
            'ac': '', 'identity': 'audience',
        }
        try:
            sig = DouyinDanmakuUtils.get_signature(
                DouyinDanmakuUtils.get_x_ms_stub(sig_params))
            logger.debug('弹幕签名: %s', sig)
        except Exception as _e:
            logger.warning('弹幕签名失败: %s', _e)
            sig = 0

        params = {
            'room_id': room_info['id_str'],
            'compress': 'gzip',
            'version_code': VERSION_CODE,
            'webcast_sdk_version': SDK_VERSION,
            'live_id': '1',
            'did_rule': '3',
            'user_unique_id': uid,
            'identity': 'audience',
            'signature': sig,
        }
        qs = '&'.join(f'{k}={v}' for k, v in params.items())
        wss_url = f'wss://webcast5-ws-web-lf.douyin.com/webcast/im/push/v2/?{qs}'
        return DouyinUtils.build_request_url(wss_url)

    @staticmethod
    def _decode(data: bytes) -> tuple[list, bytes | None]:
        frame = PushFrame()
        frame.ParseFromString(data)
        decompressed = gzip.decompress(frame.payload)
        response = Response()
        response.ParseFromString(decompressed)

        ack = None
        if response.needAck:
            obj = PushFrame()
            obj.payloadType = response.internalExt
            obj.logId = frame.logId
            ack = obj.SerializeToString()

        msgs = []
        for msg in response.messagesList:
            now = datetime.now().timestamp()
            if msg.method == 'WebcastChatMessage':
                chat = ChatMessage()
                chat.ParseFromString(msg.payload)
                d = json_format.MessageToDict(chat, preserving_proto_field_name=True)
                name = d.get('user', {}).get('nickName', '')
                content = d.get('content', '')
                msgs.append(SimpleDanmaku(
                    timestamp=now, uname=name,
                    content=content,
                    text=f'{name}: {content}',
                    dtype='danmaku', color='ffffff',
                ))
            elif msg.method == 'WebcastGiftMessage':
                gift = GiftMessage()
                gift.ParseFromString(msg.payload)
                d = json_format.MessageToDict(gift, preserving_proto_field_name=True)
                # 连击礼物：只在 repeatEnd 时记录
                if 'combo' in d.get('gift', {}) and 'repeatEnd' not in d:
                    continue
                name = d.get('user', {}).get('nickName', '')
                gift_name = d.get('gift', {}).get('name', '')
                count = d.get('repeatCount', 1)
                msgs.append(GiftDanmaku(
                    timestamp=now, uname=name,
                    content=f'{name}: 送了 {count} 个 {gift_name}',
                    gift_name=gift_name, gift_count=count,
                    dtype='gift', color='ffaa00',
                ))
            # WebcastMemberMessage（进场）跳过
        return msgs, ack

    async def _heartbeat_loop(self) -> None:
        while not self._stop:
            await asyncio.sleep(self.heartbeat_interval)
            try:
                if self._ws and not self._ws.closed:
                    await self._ws.send_bytes(self.heartbeat)
            except Exception:
                pass

    async def _fetch_loop(self) -> None:
        while not self._stop:
            msg = await self._ws.receive()
            if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                raise RuntimeError('WebSocket closed')
            msgs, ack = self._decode(msg.data)
            if ack:
                await self._ws.send_bytes(ack)
            for m in msgs:
                await self._queue.put(m)

    async def start(self) -> None:
        ws_url = await self._get_ws_url()
        ctx = ssl.create_default_context()
        ctx.set_ciphers('DEFAULT')
        self._session = aiohttp.ClientSession()
        self._ws = await self._session.ws_connect(
            ws_url, ssl_context=ctx,
            headers=self._headers,
        )
        await asyncio.gather(self._heartbeat_loop(), self._fetch_loop())

    async def stop(self) -> None:
        self._stop = True
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session and not self._session.closed:
            await self._session.close()
