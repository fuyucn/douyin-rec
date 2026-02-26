"""High-level highlight detection combining audio analysis and AI."""

from __future__ import annotations

import logging
import tempfile

import cv2
import numpy as np

from src.ai.factory import create_analyzer
from src.config import AppConfig
from src.models import AudioSegment, FrameInfo, HighlightMoment

from .audio import AudioAnalyzer

logger = logging.getLogger(__name__)


class HighlightDetector:
    """Detect highlight moments in a video using audio + AI analysis."""

    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._audio = AudioAnalyzer(config.highlight, config.whisper)
        self._analyzer = create_analyzer(config.ai)

    def detect(self, video_path: str) -> list[HighlightMoment]:
        """Detect highlights in a video file.

        Returns a list of HighlightMoment sorted by score (descending).
        """
        # Extract audio
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            audio_path = tmp.name
        self._audio.extract_audio(video_path, audio_path)

        # Detect volume spikes
        segments = self._audio.detect_volume_spikes(
            audio_path, self._config.highlight.volume_spike_ratio
        )
        if not segments:
            logger.info("No volume spikes found in %s", video_path)
            return []

        logger.info("Analyzing %d candidate segments", len(segments))

        # Get video metadata for frame extraction
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = total_frames / fps if fps > 0 else 0
        cap.release()

        moments: list[HighlightMoment] = []

        for seg in segments:
            # Clamp segment to video duration
            start = max(0.0, seg.start_time)
            end = min(duration, seg.end_time)
            if end <= start:
                continue

            # Extract frames from segment
            frames = self._extract_frames(video_path, start, end, fps)
            if not frames:
                continue

            # Optionally transcribe
            transcript: str | None = None
            try:
                transcript = self._audio.transcribe(audio_path, start, end)
                if not transcript:
                    transcript = None
            except Exception:
                logger.debug("Transcription failed for [%.1f-%.1f]", start, end, exc_info=True)

            # Analyze with AI
            raw_frames = [f.frame for f in frames]
            result = self._analyzer.analyze_frames(raw_frames, transcript)

            if result.is_highlight:
                moments.append(HighlightMoment(
                    start_time=start,
                    end_time=end,
                    frames=frames,
                    result=result,
                    audio_segment=seg,
                ))

        # Sort by score descending
        moments.sort(key=lambda m: m.result.score, reverse=True)
        logger.info("Detected %d highlight moments", len(moments))
        return moments

    def _extract_frames(
        self, video_path: str, start: float, end: float, fps: float
    ) -> list[FrameInfo]:
        """Extract evenly-spaced frames from a time range using cv2."""
        n = self._config.highlight.frames_per_segment
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            logger.warning("Cannot open video: %s", video_path)
            return []

        frames: list[FrameInfo] = []
        duration = end - start
        interval = duration / max(n, 1)

        for i in range(n):
            t = start + interval * (i + 0.5)
            frame_idx = int(t * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if not ret:
                continue
            frames.append(FrameInfo(
                frame=frame,
                timestamp=t,
                frame_index=frame_idx,
                source=video_path,
            ))

        cap.release()
        return frames
