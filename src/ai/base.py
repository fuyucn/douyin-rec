"""AI backend protocol and shared utilities."""

from __future__ import annotations

import base64
import json
import re
from typing import Protocol

import cv2
import numpy as np

from src.models import HighlightCategory, HighlightResult

ANALYSIS_PROMPT = """\
You are analyzing a sequence of video frames for highlight detection.

Examine the frames and determine:
1. Whether this is a highlight moment (funny, skillful, emotional, or otherwise notable).
2. A confidence score from 0.0 to 1.0.
3. The category: "funny", "skillful", "emotional", or "other".
4. A brief description of what is happening.

{transcript_section}

Respond with ONLY a JSON object in this exact format:
{{
  "is_highlight": true,
  "score": 0.85,
  "category": "funny",
  "description": "A brief description of the moment"
}}
"""


def build_prompt(transcript: str | None = None) -> str:
    """Build the analysis prompt, optionally including transcript context."""
    if transcript:
        section = f"Transcript context:\n{transcript}\n"
    else:
        section = ""
    return ANALYSIS_PROMPT.format(transcript_section=section)


def encode_frame_to_base64(frame: np.ndarray, quality: int = 80) -> str:
    """Encode a numpy frame (BGR) to a base64-encoded JPEG string."""
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("Failed to encode frame to JPEG")
    return base64.b64encode(buf.tobytes()).decode("utf-8")


def parse_highlight_result(text: str) -> HighlightResult:
    """Parse a JSON response from any AI backend into a HighlightResult."""
    match = re.search(r"\{[^{}]*\}", text, re.DOTALL)
    if not match:
        return HighlightResult(is_highlight=False, score=0.0, description="Failed to parse AI response")

    data = json.loads(match.group())

    category_str = data.get("category", "other").lower()
    try:
        category = HighlightCategory(category_str)
    except ValueError:
        category = HighlightCategory.OTHER

    return HighlightResult(
        is_highlight=bool(data.get("is_highlight", False)),
        score=float(data.get("score", 0.0)),
        category=category,
        description=str(data.get("description", "")),
    )


class HighlightAnalyzer(Protocol):
    """Protocol for AI highlight analysis backends."""

    def analyze_frames(
        self, frames: list[np.ndarray], transcript: str | None = None
    ) -> HighlightResult: ...
