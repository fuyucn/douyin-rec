"""抖音弹幕 WebSocket 签名工具"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import subprocess

logger = logging.getLogger(__name__)

_DIR = os.path.dirname(os.path.realpath(__file__))
_RUNNER = os.path.join(_DIR, 'sign_runner.mjs')


class DouyinDanmakuUtils:
    @staticmethod
    def get_user_unique_id() -> str:
        return str(random.randint(7_300_000_000_000_000_000, 7_999_999_999_999_999_999))

    @staticmethod
    def get_x_ms_stub(params: dict) -> str:
        sig_params = ','.join(f'{k}={v}' for k, v in params.items())
        return hashlib.md5(sig_params.encode()).hexdigest()

    @staticmethod
    def get_signature(x_ms_stub: str) -> str:
        """通过 Node.js 子进程调用 webmssdk.js get_sign()，对齐 bililive-tools 实现。"""
        try:
            result = subprocess.run(
                ['node', _RUNNER, x_ms_stub],
                capture_output=True, text=True, timeout=5,
            )
            sig = result.stdout.strip()
            if sig:
                logger.debug('get_sign 成功: %s', sig)
                return sig
            logger.warning('get_sign 返回空，使用 fallback: %s', result.stderr.strip())
        except FileNotFoundError:
            logger.warning('Node.js 未安装，弹幕签名将使用 fallback')
        except subprocess.TimeoutExpired:
            logger.warning('get_sign 超时，使用 fallback')
        except Exception as e:
            logger.warning('get_sign 失败，使用 fallback: %s', e)
        return "00000000"
