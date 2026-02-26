"""Qwen2.5-VL local highlight analysis backend."""

from __future__ import annotations

import numpy as np
from PIL import Image

from src.models import HighlightResult

from .base import build_prompt, parse_highlight_result


class QwenLocalAnalyzer:
    """Analyze video frames using a locally loaded Qwen2.5-VL model."""

    MODEL_NAME = "Qwen/Qwen2.5-VL-7B-Instruct"

    def __init__(self) -> None:
        self._model = None
        self._processor = None

    def _load_model(self) -> None:
        """Lazy-load the model and processor on first use."""
        if self._model is not None:
            return

        import torch
        from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        dtype = torch.float16 if device == "mps" else torch.float32

        self._processor = AutoProcessor.from_pretrained(self.MODEL_NAME)
        self._model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            self.MODEL_NAME, torch_dtype=dtype
        ).to(device)
        self._device = device

    def analyze_frames(
        self, frames: list[np.ndarray], transcript: str | None = None
    ) -> HighlightResult:
        import torch

        self._load_model()

        prompt = build_prompt(transcript)

        # Convert BGR numpy frames to PIL RGB images
        images = [Image.fromarray(f[:, :, ::-1]) for f in frames]

        # Build chat messages for the processor
        content: list[dict] = [{"type": "image", "image": img} for img in images]
        content.append({"type": "text", "text": prompt})
        messages = [{"role": "user", "content": content}]

        text = self._processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self._processor(
            text=[text], images=images, return_tensors="pt", padding=True
        ).to(self._device)

        with torch.no_grad():
            output_ids = self._model.generate(**inputs, max_new_tokens=512)

        # Decode only the generated portion
        generated = output_ids[:, inputs.input_ids.shape[1]:]
        result_text = self._processor.batch_decode(generated, skip_special_tokens=True)[0]

        return parse_highlight_result(result_text)
