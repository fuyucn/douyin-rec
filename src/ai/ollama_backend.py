"""Ollama 本地模型高能时刻分析后端。"""
from __future__ import annotations

import json
import urllib.request

import numpy as np

from src.config import AIConfig
from src.models import HighlightResult

from .base import build_prompt, encode_frame_to_base64, parse_highlight_result


class OllamaAnalyzer:
    """Analyze video frames using a local Ollama vision model."""

    def __init__(self, config: AIConfig) -> None:
        self._base_url = config.ollama_base_url.rstrip("/")
        self._model = config.ollama_model

    def analyze_frames(
        self, frames: list[np.ndarray], transcript: str | None = None
    ) -> HighlightResult:
        prompt = build_prompt(transcript)
        images = [encode_frame_to_base64(f) for f in frames]

        payload = json.dumps({
            "model": self._model,
            "messages": [{"role": "user", "content": prompt, "images": images}],
            "stream": False,
        }).encode()

        req = urllib.request.Request(
            f"{self._base_url}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())

        text = data["message"]["content"]
        return parse_highlight_result(text)
