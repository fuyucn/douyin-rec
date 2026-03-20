"""抖音直播弹幕 WebSocket 客户端（源自 DanmakuRender/DMR/LiveAPI/danmaku/douyin/__init__.py）"""

from __future__ import annotations

import asyncio
import gzip
import logging
import re
from datetime import datetime
from urllib.parse import urlencode

import aiohttp
from google.protobuf import json_format

from .douyin_utils import DouyinUtils
from .dy_pb2 import ChatMessage, GiftMessage, MemberMessage, PushFrame, Response
from .models import GiftDanmaku, MemberDanmaku, SimpleDanmaku, StreamEndSignal
from .ws_utils import DouyinDanmakuUtils
from src.input.douyin_spider import get_douyin_stream_data

logger = logging.getLogger(__name__)

# 弹幕 WS 连接所需的 cookie 白名单（过滤浏览器完整 cookie 里的无关追踪字段）
_DANMU_COOKIE_KEYS = {
    'ttwid',
    'sessionid', 'sessionid_ss',
    'uid_tt', 'uid_tt_ss',
    'sid_tt', 'sid_tt_ss',
    'msToken',
    '__ac_nonce', '__ac_signature',
    's_v_web_id',
    'odin_ttid',
    'passport_csrf_token', 'passport_csrf_token_default',
    'LOGIN_STATUS',
    'passport_auth_status',
    'n_mh', 'd_ticket',
}


def _filter_danmu_cookies(raw: str) -> str:
    kept = []
    for part in raw.split(';'):
        part = part.strip()
        if not part:
            continue
        key = part.split('=', 1)[0].strip()
        if key in _DANMU_COOKIE_KEYS:
            kept.append(part)
    return '; '.join(kept)


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
        self._user_cookies = cookies  # 用户提供的额外 cookie
        self._room_id = _extract_room_id(url)

    async def _fetch_anon_cookie(self) -> str:
        """获取匿名 cookie：ttwid（缓存）+ 随机设备标识（对齐 DouyinUtils.get_headers）"""
        ttwid = await asyncio.to_thread(DouyinUtils.get_ttwid)
        parts = []
        if ttwid:
            parts.append(f'ttwid={ttwid}')
        parts.extend([
            f'__ac_nonce={DouyinUtils.generate_nonce()}',
            f'odin_ttid={DouyinUtils.generate_odin_ttid()}',
            f'msToken={DouyinUtils.generate_ms_token()}',
        ])
        return '; '.join(parts)

    async def _get_cookie(self) -> str:
        """获取 WS 用 cookie。始终确保包含有效 ttwid（WS 服务器强制要求）。"""
        # 先获取匿名 ttwid（WS 鉴权必须有此字段）
        anon_cookie = await self._fetch_anon_cookie()
        logger.debug('弹幕 匿名 cookie: %.120s', anon_cookie)

        if not self._user_cookies:
            return anon_cookie

        # 用户有 cookie：过滤后与匿名 cookie 合并
        # 匿名 ttwid 优先（避免用户 cookie 里 ttwid 缺失或过期导致 417）
        # 用户 sessionid/uid_tt 等字段附加（提升账号稳定性）
        filtered = _filter_danmu_cookies(self._user_cookies)
        logger.debug('弹幕 用户 cookie 过滤: %d → %d 字符', len(self._user_cookies), len(filtered))
        if not filtered:
            return anon_cookie

        # 合并：anon 提供 ttwid/msToken/odin_ttid，user 提供 sessionid/uid_tt 等
        # 以 anon 为基础，用 user 字段覆盖（anon 没有的字段）
        anon_dict: dict[str, str] = {}
        for part in anon_cookie.split(';'):
            part = part.strip()
            if '=' in part:
                k, v = part.split('=', 1)
                anon_dict[k.strip()] = v
        user_dict: dict[str, str] = {}
        for part in filtered.split(';'):
            part = part.strip()
            if '=' in part:
                k, v = part.split('=', 1)
                user_dict[k.strip()] = v
        merged = {**user_dict, **anon_dict}  # anon 的 ttwid/msToken 覆盖 user 的
        merged_str = '; '.join(f'{k}={v}' for k, v in merged.items())
        logger.debug('弹幕 合并 cookie: %.120s', merged_str)
        return merged_str

    async def _get_ws_url(self) -> tuple[str, str]:
        """返回 (ws_url, cookie_str)"""
        # 获取 room_id：通过 HTML 解析（douyin_spider），避免调用地域受限的 webcast API
        room_data = await get_douyin_stream_data(
            f'https://live.douyin.com/{self._room_id}',
            cookies=self._user_cookies,
        )
        actual_room_id = str(room_data.get('id_str', self._room_id))
        logger.debug('弹幕房间 web_rid=%s → room_id=%s', self._room_id, actual_room_id)

        # 获取 WS 连接用的 cookie
        cookie_str = await self._get_cookie()

        # 若 cookie 里有 uid_tt（登录态），用真实 UID；否则随机生成（匿名）
        # 抖音 WS 服务端会校验 user_unique_id 与 sessionid 对应的 UID 是否一致
        uid_match = re.search(r'(?:^|[;\s])uid_tt=(\d+)', cookie_str)
        uid = uid_match.group(1) if uid_match else DouyinDanmakuUtils.get_user_unique_id()
        logger.debug('弹幕 uid: %s (from_cookie=%s)', uid, uid_match is not None)

        VERSION_CODE = 180800
        SDK_VERSION = '1.0.15'  # 对齐 bililive-tools DouYinDanma

        sig_params = {
            'live_id': '1', 'aid': '6383',
            'version_code': VERSION_CODE,
            'webcast_sdk_version': SDK_VERSION,
            'room_id': actual_room_id,
            'sub_room_id': '', 'sub_channel_id': '',
            'did_rule': '3', 'user_unique_id': uid,
            'device_platform': 'web', 'device_type': '',
            'ac': '', 'identity': 'audience',
        }
        sig = DouyinDanmakuUtils.get_signature(
            DouyinDanmakuUtils.get_x_ms_stub(sig_params))
        logger.info('弹幕签名: %s (room_id=%s, uid=%s)', sig, actual_room_id, uid)

        # 对齐 bililive-tools DouYinDanma — 无 msToken，有 browser_* 参数
        params = {
            'room_id': actual_room_id,
            'compress': 'gzip',
            'version_code': VERSION_CODE,
            'webcast_sdk_version': SDK_VERSION,
            'live_id': '1',
            'did_rule': '3',
            'user_unique_id': uid,
            'identity': 'audience',
            'aid': '6383',
            'device_platform': 'web',
            'device_type': '',
            'browser_language': 'zh-CN',
            'browser_platform': 'Win32',
            'browser_name': 'Mozilla',
            'browser_version': '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.159 Safari/537.36',
            'signature': sig,
        }
        qs = urlencode(params)
        ws_url = f'wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/?{qs}'
        return ws_url, cookie_str

    @staticmethod
    def _decode(data: bytes) -> tuple[list, bytes | None]:
        frame = PushFrame()
        frame.ParseFromString(data)
        try:
            decompressed = gzip.decompress(frame.payload)
        except (gzip.BadGzipFile, OSError):
            # 服务端偶发未压缩帧（不遵守 compress=gzip 协议），直接用原始 payload
            decompressed = frame.payload
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
                # eventTime (field 15) = 服务端 Unix 秒时间戳，用于弹幕-视频对齐
                # 对齐公式参考 biliLive-tools DouYinDanma：progress = eventTime - recordStart
                event_time = int(d.get('eventTime', 0))
                ts = float(event_time) if event_time > 1_000_000_000 else now
                uid = str(d.get('user', {}).get('id', ''))
                msgs.append(SimpleDanmaku(
                    timestamp=ts, uname=name, uid=uid,
                    content=content,
                    text=f'{name}: {content}',
                    dtype='danmaku', color='ffffff',
                ))
            elif msg.method == 'WebcastGiftMessage':
                gift = GiftMessage()
                gift.ParseFromString(msg.payload)
                d = json_format.MessageToDict(gift, preserving_proto_field_name=True)
                # DEBUG: 记录所有礼物消息的关键字段
                _g = d.get('gift', {})
                logger.info('[礼物DEBUG] combo=%s repeatEnd=%s repeatCount=%s giftName=%s user=%s',
                            _g.get('combo'), d.get('repeatEnd'), d.get('repeatCount'),
                            _g.get('name'), d.get('user', {}).get('nickName', ''))
                # 连击礼物：只在 repeatEnd 时记录
                if 'combo' in d.get('gift', {}) and 'repeatEnd' not in d:
                    logger.info('[礼物DEBUG] 跳过（combo 中间帧）')
                    continue
                name = d.get('user', {}).get('nickName', '')
                uid = str(d.get('user', {}).get('id', ''))
                gift_name = d.get('gift', {}).get('name', '')
                count = d.get('repeatCount', 1)
                diamond_count = d.get('gift', {}).get('diamondCount', 0)
                msgs.append(GiftDanmaku(
                    timestamp=now, uname=name, uid=uid,
                    content=f'{name}: 送了 {count} 个 {gift_name}',
                    gift_name=gift_name, gift_count=count,
                    gift_price=float(diamond_count) / 10,
                    dtype='gift', color='ffaa00',
                ))
            elif msg.method == 'WebcastControlMessage':
                # status 字段 (field 1, uint32)：3 = 主播下播
                # Protobuf wire format: tag byte 0x08 + varint value
                if len(msg.payload) >= 2 and msg.payload[0] == 0x08:
                    status = msg.payload[1] & 0x7f
                    if status == 3:
                        msgs.append(StreamEndSignal(status=status))
            elif msg.method == 'WebcastMemberMessage':
                member = MemberMessage()
                member.ParseFromString(msg.payload)
                d = json_format.MessageToDict(member, preserving_proto_field_name=True)
                event_time = int(d.get('eventTime', 0))
                ts = float(event_time) if event_time > 1_000_000_000 else now
                name = d.get('user', {}).get('nickName', '')
                uid = str(d.get('user', {}).get('id', ''))
                member_count = int(d.get('memberCount', 0))
                msgs.append(MemberDanmaku(
                    timestamp=ts, uname=name, uid=uid,
                    member_count=member_count,
                    content=f'{name} 进入直播间',
                    dtype='member', color='aaaaaa',
                ))
            # 其他消息跳过
        return msgs, ack

    async def _heartbeat_loop(self) -> None:
        while not self._stop:
            await asyncio.sleep(self.heartbeat_interval)
            try:
                if self._ws and not self._ws.closed:
                    await self._ws.send_bytes(self.heartbeat)
            except Exception as e:
                logger.warning('弹幕心跳发送失败: %s', e)
                # 心跳失败意味着连接已断，退出循环让 _fetch_loop 报错
                break

    async def _fetch_loop(self) -> None:
        msg_count = 0
        while not self._stop:
            msg = await self._ws.receive()
            if msg.type == aiohttp.WSMsgType.BINARY:
                msg_count += 1
                msgs, ack = self._decode(msg.data)
                if ack:
                    await self._ws.send_bytes(ack)
                for m in msgs:
                    await self._queue.put(m)
            elif msg.type == aiohttp.WSMsgType.CLOSED:
                close_code = self._ws.close_code
                raise RuntimeError(f'WebSocket 被关闭 (code={close_code}, 已收 {msg_count} 帧)')
            elif msg.type == aiohttp.WSMsgType.CLOSING:
                logger.info('弹幕 WebSocket 正在关闭 (已收 %d 帧)', msg_count)
            elif msg.type == aiohttp.WSMsgType.ERROR:
                exc = self._ws.exception()
                raise RuntimeError(f'WebSocket 错误: {exc} (已收 {msg_count} 帧)')

    async def start(self) -> None:
        ws_url, cookie_str = await self._get_ws_url()
        ws_headers = {
            'Cookie': cookie_str,
            'User-Agent': DouyinUtils.base_headers['user-agent'],
            'Origin': 'https://live.douyin.com',
            'Referer': f'https://live.douyin.com/{self._room_id}',
        }
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = aiohttp.ClientSession()
        try:
            self._ws = await self._session.ws_connect(
                ws_url,
                headers=ws_headers,
                ssl=True,
            )
        except Exception as e:
            logger.warning('WebSocket 连接失败 (status=%s): %s', getattr(e, 'status', '?'), e)
            raise
        logger.info('弹幕 WebSocket 已连接 (room_id=%s)', self._room_id)
        await asyncio.gather(self._heartbeat_loop(), self._fetch_loop())

    async def stop(self) -> None:
        self._stop = True
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session and not self._session.closed:
            await self._session.close()
