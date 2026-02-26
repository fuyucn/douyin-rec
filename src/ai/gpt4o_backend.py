"""GPT-4o (OpenAI) highlight analysis backend."""

from __future__ import annotations

import os

import numpy as np

from src.config import AIConfig
from src.models import HighlightResult

from .base import build_prompt, encode_frame_to_base64, parse_highlight_result


class GPT4oAnalyzer:
    """Analyze video frames using the OpenAI GPT-4o vision API."""

    def __init__(self, config: AIConfig) -> None:
        import openai

        api_key = config.openai_api_key or os.environ.get("OPENAI_API_KEY")
        self._client = openai.OpenAI(api_key=api_key)

    def analyze_frames(
        self, frames: list[np.ndarray], transcript: str | None = None
    ) -> HighlightResult:
        prompt = build_prompt(transcript)

        content: list[dict] = []
        for frame in frames:
            b64 = encode_frame_to_base64(frame)
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
            })
        content.append({"type": "text", "text": prompt})

        response = self._client.chat.completions.create(
            model="gpt-4o",
            max_tokens=512,
            messages=[{"role": "user", "content": content}],
        )

        return parse_highlight_result(response.choices[0].message.content)
