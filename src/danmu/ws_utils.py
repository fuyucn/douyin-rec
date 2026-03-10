"""抖音弹幕 WebSocket 签名工具（源自 DanmakuRender/DMR/LiveAPI/danmaku/douyin/utils.py）"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import threading

logger = logging.getLogger(__name__)

_DIR = os.path.dirname(os.path.realpath(__file__))
_JSENGINE_LOCK = threading.Lock()  # jsengine 不支持并发，序列化所有调用


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
        with _JSENGINE_LOCK:  # jsengine 不支持并发，序列化调用
            try:
                import jsengine
                with open(os.path.join(_DIR, 'webmssdk.js'), 'r', encoding='utf-8') as f:
                    js_enc = f.read()
                js_dom = "document={}\nwindow={}\nnavigator={'userAgent': 'Mozilla/5.0'}"
                ctx = jsengine.jsengine()
                ctx.eval(js_dom + '\n' + js_enc)
                result = ctx.eval(f"get_sign('{x_ms_stub}')")
                logger.debug('jsengine get_sign 成功: %s', result)
                return result
            except ImportError:
                logger.warning('jsengine 未安装，弹幕签名将使用 0（可能影响部分直播间连接）')
                return 0
            except FileNotFoundError:
                logger.warning('webmssdk.js 文件缺失，弹幕签名将使用 0')
                return 0
            except Exception as e:
                logger.warning('jsengine get_sign 失败（将使用 0）: %s', e)
                return 0
