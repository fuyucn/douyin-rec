"""抖音请求工具（源自 DanmakuRender/DMR/LiveAPI/douyin.py）"""

from __future__ import annotations

import logging
import random
import requests
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

logger = logging.getLogger(__name__)


def _random_user_agent() -> str:
    version = random.randint(100, 120)
    return (f'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            f'(KHTML, like Gecko) Chrome/{version}.0.0.0 Safari/537.36 Edg/{version}.0.0.0')


class DouyinUtils:
    base_headers = {
        'authority': 'live.douyin.com',
        'accept-encoding': 'gzip, deflate',
        'Referer': 'https://live.douyin.com/',
        'user-agent': _random_user_agent(),
    }
    CHARSET = 'abcdef0123456789'
    LONG_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

    _ttwid: Optional[str] = None

    @staticmethod
    def get_ttwid() -> Optional[str]:
        if not DouyinUtils._ttwid:
            try:
                page = requests.get(
                    'https://live.douyin.com/1-2-3-4-5-6-7-8-9-0',
                    timeout=15,
                    headers=DouyinUtils.base_headers,
                )
                DouyinUtils._ttwid = page.cookies.get('ttwid')
            except Exception as e:
                logger.warning(f'获取抖音 ttwid 失败: {e}')
        return DouyinUtils._ttwid

    @staticmethod
    def generate_nonce() -> str:
        return ''.join(random.choice(DouyinUtils.CHARSET) for _ in range(21))

    @staticmethod
    def generate_odin_ttid() -> str:
        return ''.join(random.choice(DouyinUtils.CHARSET) for _ in range(160))

    @staticmethod
    def generate_ms_token() -> str:
        return ''.join(random.choice(DouyinUtils.LONG_CHARSET) for _ in range(184))

    @classmethod
    def get_headers(cls, extra_cookies: dict | None = None) -> dict:
        headers = cls.base_headers.copy()
        cookies = {
            'ttwid': cls.get_ttwid() or '',
            '__ac_nonce': cls.generate_nonce(),
            'odin_ttid': cls.generate_odin_ttid(),
            'msToken': cls.generate_ms_token(),
        }
        if extra_cookies:
            cookies.update(extra_cookies)
        headers['cookie'] = '; '.join(f'{k}={v}' for k, v in cookies.items())
        return headers

    @classmethod
    def build_request_url(cls, url: str, query: dict | None = None) -> str:
        """给 URL 附加 a_bogus 参数（失败时返回原 URL）"""
        headers = cls.get_headers()
        user_agent = headers.get('user-agent', '')
        parsed_url = urlparse(url)
        params = (query or parse_qs(parsed_url.query)).copy()
        try:
            from .abogus import ABogus
            browser_info = user_agent.split(' ')[-1]
            browser_name = browser_info.split('/')[0]
            browser_version = browser_info.split('/')[1]
        except Exception:
            browser_name, browser_version = 'Edge', '124.0.0.0'
            logger.debug('ABogus 不可用，跳过签名')
            params.update({'aid': '6383', 'device_platform': 'web',
                           'browser_language': 'zh-CN'})
            new_query = urlencode(params, doseq=True)
            return urlunparse((parsed_url.scheme, parsed_url.netloc,
                               parsed_url.path, parsed_url.params,
                               new_query, parsed_url.fragment))

        params.update({
            'aid': '6383',
            'enter_from': random.choice(['link_share', 'web_live']),
            'device_platform': 'web',
            'browser_language': 'zh-CN',
            'browser_platform': 'Win32',
            'browser_name': browser_name,
            'browser_version': browser_version,
        })
        try:
            encoded_params = urlencode(params, doseq=True)
            abogus_value = ABogus(user_agent=user_agent).generate_abogus(
                params=encoded_params, body='')[1]
            params['a_bogus'] = abogus_value
        except Exception as e:
            logger.debug(f'a_bogus 生成失败: {e}')
        new_query = urlencode(params, doseq=True)
        return urlunparse((parsed_url.scheme, parsed_url.netloc,
                           parsed_url.path, parsed_url.params,
                           new_query, parsed_url.fragment))
