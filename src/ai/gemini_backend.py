"""Gemini (Google) highlight analysis backend."""

from __future__ import annotations

import os

import numpy as np

from src.config import AIConfig
from src.models import HighlightResult

from .base import build_prompt, encode_frame_to_base64, parse_highlight_result


class GeminiAnalyzer:
    """Analyze video frames using the Google Gemini vision API."""

    def __init__(self, config: AIConfig) -> None:
        import google.generativeai as genai

        api_key = config.google_api_key or os.environ.get("GOOGLE_API_KEY")
        genai.configure(api_key=api_key)
        self._model = genai.GenerativeModel("gemini-2.0-flash")

    def analyze_frames(
        self, frames: list[np.ndarray], transcript: str | None = None
    ) -> HighlightResult:
        import base64

        from google.generativeai.types import content_types

        prompt = build_prompt(transcript)

        parts: list = []
        for frame in frames:
            b64 = encode_frame_to_base64(frame)
            image_bytes = base64.b64decode(b64)
            parts.append(content_types.to_part({"mime_type": "image/jpeg", "data": image_bytes}))
        parts.append(prompt)

        response = self._model.generate_content(parts)

        return parse_highlight_result(response.text)
