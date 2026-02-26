"""Claude (Anthropic) highlight analysis backend."""

from __future__ import annotations

import os

import numpy as np

from src.config import AIConfig
from src.models import HighlightResult

from .base import build_prompt, encode_frame_to_base64, parse_highlight_result


class ClaudeAnalyzer:
    """Analyze video frames using the Anthropic Claude vision API."""

    def __init__(self, config: AIConfig) -> None:
        import anthropic

        api_key = config.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
        self._client = anthropic.Anthropic(api_key=api_key)

    def analyze_frames(
        self, frames: list[np.ndarray], transcript: str | None = None
    ) -> HighlightResult:
        prompt = build_prompt(transcript)

        content: list[dict] = []
        for frame in frames:
            b64 = encode_frame_to_base64(frame)
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
            })
        content.append({"type": "text", "text": prompt})

        message = self._client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=512,
            messages=[{"role": "user", "content": content}],
        )

        return parse_highlight_result(message.content[0].text)
