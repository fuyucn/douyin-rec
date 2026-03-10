"""抖音弹幕 WebSocket 签名工具（源自 DanmakuRender/DMR/LiveAPI/danmaku/douyin/utils.py）"""

from __future__ import annotations

import hashlib
import logging
import os
import random

logger = logging.getLogger(__name__)

_DIR = os.path.dirname(os.path.realpath(__file__))


class DouyinDanmakuUtils:
    @staticmethod
    def get_user_unique_id() -> str:
        return str(random.randint(7_300_000_000_000_000_000, 7_999_999_999_999_999_999))

    @staticmethod
    def get_x_ms_stub(params: dict) -> str:
        sig_params = ','.join(f'{k}={v}' for k, v in params.items())
        return hashlib.md5(sig_params.encode()).hexdigest()

    @staticmethod
    def get_signature(x_ms_stub: str) -> int:
        try:
            import jsengine
            with open(os.path.join(_DIR, 'webmssdk.js'), 'r', encoding='utf-8') as f:
                js_enc = f.read()
            js_dom = "document={}\nwindow={}\nnavigator={'userAgent': 'Mozilla/5.0'}"
            ctx = jsengine.jsengine()
            ctx.eval(js_dom + '\n' + js_enc)
            return ctx.eval(f"get_sign('{x_ms_stub}')")
        except Exception as e:
            logger.debug(f'签名获取失败（将使用 0）: {e}')
            return 0
