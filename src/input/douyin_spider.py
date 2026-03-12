"""抖音直播流地址抓取（移植自 DouyinLiveRecorder by Hmily）

源码: https://github.com/ihmily/DouyinLiveRecorder
License: MIT

移植内容:
  - ab_sign.py   → ab_sign()，纯 Python 签名算法（SM3 + RC4）
  - room.py      → get_sec_user_id(), get_unique_id()，短链接/用户主页解析
  - spider.py    → get_douyin_stream_data/web/app，获取直播间数据
  - stream.py    → get_douyin_stream_url()，按画质提取最终流地址

无 execjs / Node.js 依赖。仅依赖 httpx。
"""

from __future__ import annotations

import json
import logging
import math
import re
import time
import urllib.parse
from typing import Any

import httpx

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# ab_sign — 纯 Python 实现的 a_bogus 签名算法
# ---------------------------------------------------------------------------

def _rc4_encrypt(plaintext: str, key: str) -> str:
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + ord(key[i % len(key)])) % 256
        s[i], s[j] = s[j], s[i]
    i = j = 0
    result = []
    for char in plaintext:
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        t = (s[i] + s[j]) % 256
        result.append(chr(s[t] ^ ord(char)))
    return ''.join(result)


def _left_rotate(x: int, n: int) -> int:
    n %= 32
    return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF


def _get_t_j(j: int) -> int:
    if j < 16:
        return 2043430169
    return 2055708042


def _ff_j(j: int, x: int, y: int, z: int) -> int:
    if j < 16:
        return (x ^ y ^ z) & 0xFFFFFFFF
    return ((x & y) | (x & z) | (y & z)) & 0xFFFFFFFF


def _gg_j(j: int, x: int, y: int, z: int) -> int:
    if j < 16:
        return (x ^ y ^ z) & 0xFFFFFFFF
    return ((x & y) | (~x & z)) & 0xFFFFFFFF


class _SM3:
    def __init__(self):
        self.reg: list[int] = []
        self.chunk: list[int] = []
        self.size = 0
        self.reset()

    def reset(self):
        self.reg = [1937774191, 1226093241, 388252375, 3666478592,
                    2842636476, 372324522, 3817729613, 2969243214]
        self.chunk = []
        self.size = 0

    def write(self, data: str | list[int]):
        a = list(data.encode('utf-8')) if isinstance(data, str) else data
        self.size += len(a)
        f = 64 - len(self.chunk)
        if len(a) < f:
            self.chunk.extend(a)
        else:
            self.chunk.extend(a[:f])
            while len(self.chunk) >= 64:
                self._compress(self.chunk)
                if f < len(a):
                    self.chunk = a[f:min(f + 64, len(a))]
                else:
                    self.chunk = []
                f += 64

    def _fill(self):
        bit_length = 8 * self.size
        padding_pos = len(self.chunk)
        self.chunk.append(0x80)
        padding_pos = (padding_pos + 1) % 64
        if 64 - padding_pos < 8:
            padding_pos -= 64
        while padding_pos < 56:
            self.chunk.append(0)
            padding_pos += 1
        high_bits = bit_length // 4294967296
        for i in range(4):
            self.chunk.append((high_bits >> (8 * (3 - i))) & 0xFF)
        for i in range(4):
            self.chunk.append((bit_length >> (8 * (3 - i))) & 0xFF)

    def _compress(self, data: list[int]):
        w = [0] * 132
        for t in range(16):
            w[t] = (data[4*t] << 24) | (data[4*t+1] << 16) | (data[4*t+2] << 8) | data[4*t+3]
            w[t] &= 0xFFFFFFFF
        for j in range(16, 68):
            a = w[j-16] ^ w[j-9] ^ _left_rotate(w[j-3], 15)
            a = a ^ _left_rotate(a, 15) ^ _left_rotate(a, 23)
            w[j] = (a ^ _left_rotate(w[j-13], 7) ^ w[j-6]) & 0xFFFFFFFF
        for j in range(64):
            w[j+68] = (w[j] ^ w[j+4]) & 0xFFFFFFFF
        a, b, c, d, e, f, g, h = self.reg
        for j in range(64):
            ss1 = _left_rotate((_left_rotate(a, 12) + e + _left_rotate(_get_t_j(j), j)) & 0xFFFFFFFF, 7)
            ss2 = ss1 ^ _left_rotate(a, 12)
            tt1 = (_ff_j(j, a, b, c) + d + ss2 + w[j+68]) & 0xFFFFFFFF
            tt2 = (_gg_j(j, e, f, g) + h + ss1 + w[j]) & 0xFFFFFFFF
            d, c, b, a = c, _left_rotate(b, 9), a, tt1
            h, g, f, e = g, _left_rotate(f, 19), e, (tt2 ^ _left_rotate(tt2, 9) ^ _left_rotate(tt2, 17)) & 0xFFFFFFFF
        for i, v in enumerate((a, b, c, d, e, f, g, h)):
            self.reg[i] ^= v

    def sum(self, data=None, output_format=None):
        if data is not None:
            self.reset()
            self.write(data)
        self._fill()
        for f in range(0, len(self.chunk), 64):
            self._compress(self.chunk[f:f+64])
        if output_format == 'hex':
            result: Any = ''.join(f'{val:08x}' for val in self.reg)
        else:
            result = []
            for val in self.reg:
                result += [(val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF]
        self.reset()
        return result


_ENCODING_TABLES = {
    "s3": "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
    "s4": "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe",
}


def _get_long_int(round_num: int, s: str) -> int:
    r = round_num * 3
    c1 = ord(s[r]) if r < len(s) else 0
    c2 = ord(s[r+1]) if r+1 < len(s) else 0
    c3 = ord(s[r+2]) if r+2 < len(s) else 0
    return (c1 << 16) | (c2 << 8) | c3


def _result_encrypt(long_str: str, num: str) -> str:
    table = _ENCODING_TABLES[num]
    masks = [16515072, 258048, 4032, 63]
    shifts = [18, 12, 6, 0]
    result = ""
    round_num = 0
    long_int = _get_long_int(0, long_str)
    total_chars = math.ceil(len(long_str) / 3 * 4)
    for i in range(total_chars):
        if i // 4 != round_num:
            round_num += 1
            long_int = _get_long_int(round_num, long_str)
        idx = (long_int & masks[i % 4]) >> shifts[i % 4]
        result += table[idx]
    return result


def _gener_random(n: int, option: list[int]) -> list[int]:
    b1, b2 = n & 255, (n >> 8) & 255
    return [(b1 & 170) | (option[0] & 85), (b1 & 85) | (option[0] & 170),
            (b2 & 170) | (option[1] & 85), (b2 & 85) | (option[1] & 170)]


def _generate_random_str() -> str:
    rv = [0.123456789, 0.987654321, 0.555555555]
    rb: list[int] = []
    rb.extend(_gener_random(int(rv[0] * 10000), [3, 45]))
    rb.extend(_gener_random(int(rv[1] * 10000), [1, 0]))
    rb.extend(_gener_random(int(rv[2] * 10000), [1, 5]))
    return ''.join(chr(b) for b in rb)


def _generate_rc4_bb_str(url_search_params: str, user_agent: str, window_env_str: str) -> str:
    sm3 = _SM3()
    start_time = int(time.time() * 1000)
    url_sm3 = sm3.sum(sm3.sum(url_search_params + "cus"))
    cus_sm3 = sm3.sum(sm3.sum("cus"))
    ua_key = chr(0) + chr(1) + chr(14)
    ua_sm3 = sm3.sum(_result_encrypt(_rc4_encrypt(user_agent, ua_key), "s3"))
    end_time = start_time + 100

    def split4(n: int) -> list[int]:
        return [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]

    st = split4(start_time)
    et = split4(end_time)
    a0 = split4(0)
    a1 = split4(1)
    a2 = split4(14)
    wenv = [ord(c) for c in window_env_str]
    pid = 110624
    aid = 6383
    pid4 = split4(pid)
    aid4 = split4(aid)

    b18, b20, b21, b22, b23, b24, b25 = 44, st[0], st[1], st[2], st[3], 0, 0
    b26, b27, b28, b29 = a0
    b30, b31 = (1 >> 8) & 255, 1 & 255
    b32, b33 = a1[0], a1[1]
    b34, b35, b36, b37 = a2
    b38, b39 = url_sm3[21], url_sm3[22]
    b40, b41 = cus_sm3[21], cus_sm3[22]
    b42, b43 = ua_sm3[23], ua_sm3[24]
    b44, b45, b46, b47 = et
    b48, b49, b50 = 3, 0, 0
    b51 = pid
    b52, b53, b54, b55 = pid4
    b56, b57, b58, b59, b60 = aid, aid & 255, (aid >> 8) & 255, (aid >> 16) & 255, (aid >> 24) & 255
    b64 = b65 = len(wenv)
    b66 = (b64 >> 8) & 255
    b65 = b64 & 255
    b70 = b71 = 0

    b72 = (b18 ^ b20 ^ b26 ^ b30 ^ b38 ^ b40 ^ b42 ^ b21 ^ b27 ^ b31 ^
           b35 ^ b39 ^ b41 ^ b43 ^ b22 ^ b28 ^ b32 ^ b36 ^ b23 ^ b29 ^
           b33 ^ b37 ^ b44 ^ b45 ^ b46 ^ b47 ^ b48 ^ b49 ^ b50 ^ b24 ^
           b25 ^ b52 ^ b53 ^ b54 ^ b55 ^ b57 ^ b58 ^ b59 ^ b60 ^ b65 ^
           b66 ^ b70 ^ b71)

    bb = [b18, b20, b52, b26, b30, b34, b58, b38, b40, b53, b42, b21,
          b27, b54, b55, b31, b35, b57, b39, b41, b43, b22, b28, b32,
          b60, b36, b23, b29, b33, b37, b44, b45, b59, b46, b47, b48,
          b49, b50, b24, b25, b65, b66, b70, b71]
    bb.extend(wenv)
    bb.append(b72)

    return _rc4_encrypt(''.join(chr(x) for x in bb), chr(121))


def ab_sign(url_search_params: str, user_agent: str) -> str:
    """生成抖音 API 请求的 a_bogus 签名参数"""
    window_env_str = "1920|1080|1920|1040|0|30|0|0|1872|92|1920|1040|1857|92|1|24|Win32"
    return _result_encrypt(
        _generate_random_str() + _generate_rc4_bb_str(url_search_params, user_agent, window_env_str),
        "s4"
    ) + "="


# ---------------------------------------------------------------------------
# HTTP 工具
# ---------------------------------------------------------------------------

async def _async_req(url: str, headers: dict | None = None, timeout: int = 20) -> str:
    """简单 GET，返回响应文本"""
    async with httpx.AsyncClient(timeout=timeout, verify=False, follow_redirects=True) as client:
        resp = await client.get(url, headers=headers or {})
        return resp.text


async def _check_url_alive(url: str, timeout: int = 10) -> bool:
    """检查 URL 是否可访问（HEAD 请求）"""
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=False) as client:
            resp = await client.head(url, follow_redirects=True)
            return resp.status_code == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# room.py — 短链接 / 用户主页解析（无 execjs）
# ---------------------------------------------------------------------------

class UnsupportedUrlError(Exception):
    pass


_MOBILE_UA = ('Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 '
              '(KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36')
_MOBILE_HEADERS = {
    'User-Agent': _MOBILE_UA,
    'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
    'Cookie': 's_v_web_id=verify_lk07kv74_QZYCUApD_xhiB_405x_Ax51_GYO9bUIyZQVf',
}


async def get_sec_user_id(url: str) -> tuple[str, str]:
    """从短链接/用户主页 URL 解析 (room_id, sec_user_id)"""
    async with httpx.AsyncClient(timeout=15, verify=False, follow_redirects=True) as client:
        response = await client.get(url, headers=_MOBILE_HEADERS)
        redirect_url = str(response.url)
        if 'reflow/' in redirect_url:
            match = re.search(r'sec_user_id=([\w_\-]+)&', redirect_url)
            if match:
                sec_user_id = match.group(1)
                room_id = redirect_url.split('?')[0].rsplit('/', maxsplit=1)[1]
                return room_id, sec_user_id
            raise RuntimeError("Could not find sec_user_id in the URL.")
        raise UnsupportedUrlError("The redirect URL does not contain 'reflow/'.")


async def get_unique_id(url: str) -> str:
    """从短链接/用户主页 URL 解析抖音号 unique_id"""
    ttwid_cookie = ('ttwid=1%7C4ejCkU2bKY76IySQENJwvGhg1IQZrgGEupSyTKKfuyk%7C1740470403%7Cbc9ad2ee341f1a162f9e27f464'
                    '1778030d1ae91e31f9df6553a8f2efa3bdb7b4; __ac_nonce=0683e59f3009cc48fbab0; '
                    '__ac_signature=_02B4Z6wo00f01mG6waQAAIDB9JUCzFb6.TZhmsUAAPBf34; __ac_referer=__ac_blank')
    async with httpx.AsyncClient(timeout=15, verify=False, follow_redirects=True) as client:
        response = await client.get(url, headers=_MOBILE_HEADERS)
        redirect_url = str(response.url)
        if 'reflow/' in redirect_url:
            raise UnsupportedUrlError("Unsupported URL")
        sec_user_id = redirect_url.split('?')[0].rsplit('/', maxsplit=1)[1]
        hdrs = {**_MOBILE_HEADERS, 'Cookie': ttwid_cookie}
        user_resp = await client.get(
            f'https://www.iesdouyin.com/share/user/{sec_user_id}', headers=hdrs)
        matches = re.findall(r'unique_id":"(.*?)","verification_type', user_resp.text)
        if matches:
            return matches[-1]
        raise RuntimeError("Could not find unique_id in the response.")


# ---------------------------------------------------------------------------
# spider.py — 三种获取直播间数据的方式
# ---------------------------------------------------------------------------

_WEB_UA = ('Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) '
           'Chrome/116.0.5845.97 Safari/537.36 Core/1.116.567.400 QQBrowser/19.7.6764.400')

_WEB_TTWID = ('ttwid=1%7C2iDIYVmjzMcpZ20fcaFde0VghXAA3NaNXE_SLR68IyE%7C1761045455'
              '%7Cab35197d5cfb21df6cbb2fa7ef1c9262206b062c315b9d04da746d0b37dfbc7d')

_APP_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
           'Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')

# 较长的默认 cookie，来自 DouyinLiveRecorder 原始代码
_DEFAULT_COOKIE = (
    'ttwid=1%7CB1qls3GdnZhUov9o2NxOMxxYS2ff6OSvEWbv0ytbES4%7C1680522049%7C280d802d6d478e3e78d0c807f7c487e7ffec0ae4e5fdd6a0fe74c3c6af149511; '
    'my_rd=1; passport_csrf_token=3ab34460fa656183fccfb904b16ff742; '
    'd_ticket=9f562383ac0547d0b561904513229d76c9c21; store-region=cn-fj; LOGIN_STATUS=1; '
    'msToken=jV_yeN1IQKUd9PlNtpL7k5vthGKcHo0dEh_QPUQhr8G3cuYv-Jbb4NnIxGDmhVOkZOCSihNpA2kvYtHiTW25XNNX_yrsv5FN8O6zm3qmCIXcEe0LywLn7oBO2gITEeg='
)


def _inject_origin_quality(room_data: dict, stream_data_str: str) -> None:
    """将 ORIGIN 画质注入到 flv_pull_url / hls_pull_url_map 的末尾（备用）。

    ⚠️ 注入 URL 使用 wsSecret/wsTime auth 格式，与 flv_pull_url 原始条目的
    expire/sign 格式不同。wsSecret/wsTime 格式可能被路由到 ByteVC1 CDN 节点。
    因此 ORIGIN 放末尾，position-based lookup 优先使用原始条目（与 DLR 一致）。
    """
    try:
        sd = json.loads(stream_data_str)
        if 'origin' not in sd.get('data', {}):
            return
        origin_main = sd['data']['origin']['main']
        sdk_params = json.loads(origin_main.get('sdk_params', '{}'))
        codec = sdk_params.get('VCodec', '')
        if codec:
            room_data['_vcodec'] = codec.lower()  # 供 get_douyin_stream_url 追加 codec= 参数
        origin_m3u8 = {'ORIGIN': origin_main['hls'] + '&codec=' + codec}
        origin_flv = {'ORIGIN': origin_main['flv'] + '&codec=' + codec}
        # 原始条目优先（expire/sign 格式，H.264 CDN）；ORIGIN 放末尾备用
        room_data['stream_url']['hls_pull_url_map'] = {
            **room_data['stream_url'].get('hls_pull_url_map', {}), **origin_m3u8}
        room_data['stream_url']['flv_pull_url'] = {
            **room_data['stream_url'].get('flv_pull_url', {}), **origin_flv}
    except Exception:
        pass


async def get_douyin_web_stream_data(url: str, cookies: str | None = None) -> dict:
    """通过 Web API（webcast/room/web/enter）获取直播间数据"""
    headers = {
        'cookie': cookies or _WEB_TTWID,
        'referer': 'https://live.douyin.com/335354047186',
        'user-agent': _WEB_UA,
    }
    web_rid = url.split('?')[0].split('live.douyin.com/')[-1]
    params = {
        'aid': '6383', 'app_name': 'douyin_web', 'live_id': '1',
        'device_platform': 'web', 'language': 'zh-CN',
        'browser_language': 'zh-CN', 'browser_platform': 'Win32',
        'browser_name': 'Chrome', 'browser_version': '116.0.0.0',
        'web_rid': web_rid, 'msToken': '',
    }
    api = f'https://live.douyin.com/webcast/room/web/enter/?{urllib.parse.urlencode(params)}'
    api += '&a_bogus=' + ab_sign(urllib.parse.urlparse(api).query, headers['user-agent'])

    json_str = await _async_req(api, headers=headers)
    json_data = json.loads(json_str)['data']
    if not json_data.get('data'):
        raise RuntimeError(f"Douyin web API returned no data for {url}")
    room_data = json_data['data'][0]
    room_data['anchor_name'] = json_data['user']['nickname']

    if room_data.get('status') == 2 and 'stream_url' in room_data:
        live_core = room_data['stream_url'].get('live_core_sdk_data', {})
        pull_datas = room_data['stream_url'].get('pull_datas', {})
        if live_core:
            if pull_datas:
                key = list(pull_datas.keys())[0]
                stream_data_str = pull_datas[key]['stream_data']
            else:
                stream_data_str = live_core['pull_data']['stream_data']
            _inject_origin_quality(room_data, stream_data_str)
    return room_data


async def get_douyin_app_stream_data(url: str, cookies: str | None = None) -> dict:
    """通过 App API（webcast.amemv.com/webcast/room/reflow）获取直播间数据。
    对于 live.douyin.com/{id} 直接路由到 get_douyin_web_stream_data。
    """
    if 'live.douyin.com/' in url.split('?')[0]:
        return await get_douyin_web_stream_data(url, cookies)

    # 短链接 / 用户主页：解析 room_id + sec_uid
    headers = {
        'User-Agent': _APP_UA,
        'Accept-Language': 'zh-CN,zh;q=0.8',
        'Referer': 'https://live.douyin.com/',
        'Cookie': cookies or _DEFAULT_COOKIE,
    }
    try:
        data = await get_sec_user_id(url)
        room_id, sec_uid = data
    except UnsupportedUrlError:
        unique_id = await get_unique_id(url)
        return await get_douyin_stream_data(f'https://live.douyin.com/{unique_id}', cookies)

    app_params = {
        'verifyFp': 'verify_hwj52020_7szNlAB7_pxNY_48Vh_ALKF_GA1Uf3yteoOY',
        'type_id': '0', 'live_id': '1',
        'room_id': room_id, 'sec_user_id': sec_uid,
        'version_code': '99.99.99', 'app_id': '1128',
    }
    api2 = f'https://webcast.amemv.com/webcast/room/reflow/info/?{urllib.parse.urlencode(app_params)}'
    api2 += '&a_bogus=' + ab_sign(urllib.parse.urlparse(api2).query, headers['User-Agent'])

    json_str2 = await _async_req(api2, headers=headers)
    json_data2 = json.loads(json_str2)['data']
    if not json_data2.get('room'):
        raise RuntimeError(f"Douyin app API returned no room data for {url}")
    room_data = json_data2['room']
    room_data['anchor_name'] = room_data['owner']['nickname']

    if room_data.get('status') == 2 and 'stream_url' in room_data:
        live_core = room_data['stream_url'].get('live_core_sdk_data', {})
        pull_datas = room_data['stream_url'].get('pull_datas', {})
        if live_core:
            if pull_datas:
                key = list(pull_datas.keys())[0]
                stream_data_str = pull_datas[key]['stream_data']
            else:
                stream_data_str = live_core['pull_data']['stream_data']
            _inject_origin_quality(room_data, stream_data_str)
    return room_data


async def get_douyin_stream_data(url: str, cookies: str | None = None) -> dict:
    """主入口：先尝试 HTML 解析，失败则回退 App API。"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
        'Accept-Language': 'zh-CN,zh;q=0.8',
        'Referer': 'https://live.douyin.com/',
        'Cookie': cookies or _DEFAULT_COOKIE,
    }
    try:
        html_str = await _async_req(url, headers=headers)
        match = re.search(r'(\{\\"state\\":.*?)]\\n"]\)', html_str)
        if not match:
            match = re.search(r'(\{\\"common\\":.*?)]\\n"]\)</script><div hidden', html_str)
        json_str = match.group(1)
        cleaned = json_str.replace('\\', '').replace(r'u0026', '&')
        room_store = re.search('"roomStore":(.*?),"linkmicStore"', cleaned, re.DOTALL).group(1)
        anchor_name = re.search('"nickname":"(.*?)","avatar_thumb', room_store, re.DOTALL).group(1)
        room_store = room_store.split(',"has_commerce_goods"')[0] + '}}}'
        json_data = json.loads(room_store)['roomInfo']['room']
        json_data['anchor_name'] = anchor_name

        if json_data.get('status') == 4:
            return json_data

        stream_orientation = json_data['stream_url'].get('stream_orientation', 1)
        origin_url_list = None
        matches2 = re.findall(r'"(\{\\"common\\":.*?)"]\)</script><script nonce=', html_str)
        if matches2:
            js2 = matches2[0] if stream_orientation == 1 else matches2[1]
            jd2 = json.loads(js2.replace('\\', '').replace('"{', '{').replace('}"', '}').replace('u0026', '&'))
            if 'origin' in jd2.get('data', {}):
                origin_url_list = jd2['data']['origin']['main']
        else:
            h2 = html_str.replace('\\', '').replace('u0026', '&')
            m3 = re.search(r'"origin":\\{"main":(.*?),"dash"', h2, re.DOTALL)
            if m3:
                origin_url_list = json.loads(m3.group(1) + '}')

        if origin_url_list:
            codec = origin_url_list.get('sdk_params', {}).get('VCodec', '') if isinstance(origin_url_list.get('sdk_params'), dict) else ''
            if isinstance(origin_url_list.get('sdk_params'), str):
                try:
                    codec = json.loads(origin_url_list['sdk_params']).get('VCodec', '')
                except Exception:
                    codec = ''
            if codec:
                json_data['_vcodec'] = codec.lower()  # 供 get_douyin_stream_url 追加 codec= 参数
            origin_m3u8 = {'ORIGIN': origin_url_list['hls'] + '&codec=' + codec}
            origin_flv = {'ORIGIN': origin_url_list['flv'] + '&codec=' + codec}
            # 原始条目优先（可能是 expire/sign 格式，H.264 CDN）；ORIGIN 放末尾备用
            json_data['stream_url']['hls_pull_url_map'] = {
                **json_data['stream_url'].get('hls_pull_url_map', {}), **origin_m3u8}
            json_data['stream_url']['flv_pull_url'] = {
                **json_data['stream_url'].get('flv_pull_url', {}), **origin_flv}
        return json_data

    except Exception as e:
        # HTML 解析失败，回退 App API
        return await get_douyin_app_stream_data(url=url, cookies=cookies)


# ---------------------------------------------------------------------------
# stream.py — 按画质提取最终流地址
# ---------------------------------------------------------------------------

# 画质名称 → list 下标（0=最高画质 ORIGIN）
_QUALITY_MAPPING = {"OD": 0, "BD": 0, "UHD": 1, "HD": 2, "SD": 3, "LD": 4}

# 项目内部画质名称 → DouyinLiveRecorder 画质代码
QUALITY_MAP = {
    "origin": "OD",
    "uhd": "UHD",
    "hd": "HD",
    "sd": "SD",
    "ld": "LD",
}


# 画质 index → URL dict 中的候选 key 名称（优先级从高到低）
# 抖音 API 的 flv_pull_url / hls_pull_url_map 可能以 OD/UHD/HD/SD/LD 为 key，
# 我们自己注入的 origin URL 用 'ORIGIN' key。
_QUALITY_KEY_NAMES: dict[int, list[str]] = {
    # origin — ORIGIN 是我们注入的 URL（sdk_params origin_main，expire/sign + codec=h264）
    # 在 cookie 移除 hevc_supported 后，ORIGIN 始终为 H.264 且路径一致（如 _or4）。
    # FULL_HD1 在 CDN 负载均衡时可能指向 ByteVC1 变体（如 _Stage0T000ld），不稳定。
    0: ['ORIGIN', 'FULL_HD1', 'OD', 'BD'],
    1: ['UHD'],
    2: ['HD'],
    3: ['SD'],
    4: ['LD'],
}


def _lookup_quality(d: dict, qi: int) -> tuple[str | None, str]:
    """先按画质 key 名称查找，找不到再按位置索引。返回 (url, matched_key)。

    API 返回的 dict 顺序可能不确定（例如 HD 排在 OD 前面），
    key 查找确保即使注入 ORIGIN 失败也能选到正确画质。
    """
    for k in _QUALITY_KEY_NAMES.get(qi, []):
        if k in d:
            return d[k], k
    values = list(d.values())
    keys = list(d.keys())
    idx = qi if qi < len(values) else (len(values) - 1 if values else -1)
    if idx < 0:
        return None, "?"
    return values[idx], keys[idx]


async def get_douyin_stream_url(room_data: dict, quality: str = "origin") -> dict:
    """从 room_data 中按画质提取流地址。

    quality: "origin" / "uhd" / "hd" / "sd" / "ld"（项目内部画质名）

    返回:
        {
            "anchor_name": str,
            "is_live": bool,
            "title": str,
            "quality": str,
            "flv_url": str | None,
            "m3u8_url": str | None,
            "record_url": str | None,
        }
    """
    anchor_name = room_data.get('anchor_name', '')
    result: dict = {"anchor_name": anchor_name, "is_live": False}

    if room_data.get('status') != 2:
        return result

    quality_code = QUALITY_MAP.get(quality.lower(), "OD")
    qi = _QUALITY_MAPPING.get(quality_code, 0)

    stream_url = room_data['stream_url']
    flv_dict = stream_url.get('flv_pull_url', {})
    m3u8_dict = stream_url.get('hls_pull_url_map', {})

    # 按 key 名优先查找（避免因 dict 顺序不定而选错画质）
    flv_url, flv_key = _lookup_quality(flv_dict, qi)
    m3u8_url, m3u8_key = _lookup_quality(m3u8_dict, qi)

    # 若 API 原始条目缺少 codec= 参数，追加已知 VCodec（与 DLR 一致）。
    # pull-q5/stage/ CDN 默认 ByteVC1，需要 &codec=h264 才路由到 H.264 流。
    vcodec = room_data.get('_vcodec', '')
    def _with_codec(url: str | None) -> str | None:
        if not url or not vcodec or 'codec=' in url:
            return url
        sep = '&' if '?' in url else '?'
        return url + sep + 'codec=' + vcodec
    flv_url = _with_codec(flv_url)
    m3u8_url = _with_codec(m3u8_url)

    _log.info(
        "[spider] flv_pull_url keys=%s → selected key=%s url_auth=%s vcodec=%s",
        list(flv_dict.keys()), flv_key,
        "wsSecret" if flv_url and "wsSecret" in flv_url else
        "expire/sign" if flv_url and "expire=" in flv_url else
        "k/t" if flv_url and "&k=" in flv_url else "unknown",
        vcodec or "(none)",
    )

    # 若目标画质 M3U8 不可用，尝试相邻画质
    if m3u8_url and not await _check_url_alive(m3u8_url):
        m3u8_list = list(m3u8_dict.values())
        flv_list = list(flv_dict.values())
        alt = qi + 1 if qi < 4 else qi - 1
        if alt < len(m3u8_list):
            m3u8_url = m3u8_list[alt]
            flv_url = flv_list[alt] if alt < len(flv_list) else flv_url

    result.update({
        'is_live': True,
        'title': room_data.get('title', ''),
        'quality': quality_code,
        'flv_url': flv_url,
        'm3u8_url': m3u8_url,
        'record_url': m3u8_url or flv_url,
    })
    return result
