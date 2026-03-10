"""Audio analysis for highlight detection."""

from __future__ import annotations

import logging
import tempfile

import ffmpeg
import librosa
import numpy as np

from src.config import HighlightConfig, WhisperConfig
from src.models import AudioSegment

logger = logging.getLogger(__name__)


class AudioAnalyzer:
    """Extract and analyze audio from video files."""

    def __init__(self, config: HighlightConfig, whisper_config: WhisperConfig) -> None:
        self._config = config
        self._whisper_config = whisper_config
        self._whisper_model = None

    def extract_audio(self, video_path: str, output_path: str) -> str:
        """Extract audio from video to a WAV file using ffmpeg-python."""
        try:
            (
                ffmpeg
                .input(video_path)
                .output(output_path, ac=1, ar=16000, format="wav")
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
        except ffmpeg.Error as e:
            stderr = e.stderr.decode(errors="replace") if e.stderr else "(no stderr)"
            raise RuntimeError(f"ffmpeg 音频提取失败:\n{stderr}") from e
        logger.info("Extracted audio to %s", output_path)
        return output_path

    def detect_volume_spikes(
        self, audio_path: str, spike_ratio: float
    ) -> list[AudioSegment]:
        """Detect segments where volume exceeds spike_ratio * mean volume."""
        y, sr = librosa.load(audio_path, sr=None)

        # Compute RMS energy over short windows (~50ms)
        hop_length = int(sr * 0.05)
        frame_length = hop_length * 2
        rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]

        mean_rms = np.mean(rms)
        if mean_rms == 0:
            return []

        threshold = spike_ratio * mean_rms
        context = self._config.context_seconds

        # Find frames above threshold
        spike_frames = np.where(rms > threshold)[0]
        if len(spike_frames) == 0:
            return []

        # Convert frame indices to time
        spike_times = librosa.frames_to_time(
            spike_frames, sr=sr, hop_length=hop_length
        )

        # Group nearby spikes into segments
        segments: list[AudioSegment] = []
        seg_start = spike_times[0]
        seg_end = spike_times[0]
        seg_max_ratio = float(rms[spike_frames[0]] / mean_rms)

        for i in range(1, len(spike_times)):
            t = spike_times[i]
            ratio = float(rms[spike_frames[i]] / mean_rms)
            # Merge if within 2x context_seconds
            if t - seg_end <= context * 2:
                seg_end = t
                seg_max_ratio = max(seg_max_ratio, ratio)
            else:
                segments.append(AudioSegment(
                    start_time=max(0.0, seg_start - context),
                    end_time=seg_end + context,
                    volume_ratio=seg_max_ratio,
                ))
                seg_start = t
                seg_end = t
                seg_max_ratio = ratio

        # Append last segment
        segments.append(AudioSegment(
            start_time=max(0.0, seg_start - context),
            end_time=seg_end + context,
            volume_ratio=seg_max_ratio,
        ))

        logger.info("Found %d volume spike segments", len(segments))
        return segments

    def transcribe(self, audio_path: str, start: float, end: float) -> str:
        """Transcribe a segment of audio using OpenAI Whisper."""
        if self._whisper_model is None:
            import whisper

            logger.info("Loading whisper model: %s", self._whisper_config.model_size)
            self._whisper_model = whisper.load_model(self._whisper_config.model_size)

        # Load only the relevant segment
        y, sr = librosa.load(audio_path, sr=16000, offset=start, duration=end - start)

        # Write segment to a temporary file for whisper
        import soundfile as sf

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, y, sr)
            result = self._whisper_model.transcribe(
                tmp.name, language=self._whisper_config.language
            )

        text = result.get("text", "").strip()
        logger.debug("Transcribed [%.1f-%.1f]: %s", start, end, text)
        return text
