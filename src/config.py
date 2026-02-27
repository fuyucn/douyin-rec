"""配置加载与管理"""

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class InputConfig:
    extract_fps: float = 2.0
    max_duration: int = 0
    segment_duration: float = 300.0  # 分段处理间隔（秒），每段独立 top-k 保存，0=不分段
    quality: str = "origin"  # 直播画质: origin(原画) / uhd(蓝光) / hd(高清) / sd(标清) / ld(流畅)
    cookies_file: str | None = None
    cookies: str | None = None  # raw cookie string (browser format: "key1=val1; key2=val2")


@dataclass
class BlurConfig:
    threshold: float = 100.0


@dataclass
class FaceConfig:
    detection_confidence: float = 0.7
    min_face_ratio: float = 0.05
    max_yaw: float = 30.0
    max_pitch: float = 25.0


@dataclass
class AestheticConfig:
    min_score: float = 5.0
    top_k: int = 20
    dedup_similarity: float = 0.95


@dataclass
class HighlightConfig:
    volume_spike_ratio: float = 2.0
    context_seconds: float = 3.0
    frames_per_segment: int = 5


@dataclass
class AIConfig:
    default_backend: str = "claude"
    anthropic_api_key: str | None = None
    google_api_key: str | None = None
    openai_api_key: str | None = None
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "minicpm-v"


@dataclass
class StorageConfig:
    output_dir: str = "./output"
    db_path: str = "./output/metadata.db"
    image_format: str = "jpg"
    image_quality: int = 95


@dataclass
class WhisperConfig:
    model_size: str = "base"
    language: str = "zh"


@dataclass
class AppConfig:
    input: InputConfig = field(default_factory=InputConfig)
    blur: BlurConfig = field(default_factory=BlurConfig)
    face: FaceConfig = field(default_factory=FaceConfig)
    aesthetic: AestheticConfig = field(default_factory=AestheticConfig)
    highlight: HighlightConfig = field(default_factory=HighlightConfig)
    ai: AIConfig = field(default_factory=AIConfig)
    storage: StorageConfig = field(default_factory=StorageConfig)
    whisper: WhisperConfig = field(default_factory=WhisperConfig)


def _build_dataclass(cls, data: dict):
    """从字典构建 dataclass，忽略多余字段"""
    if data is None:
        return cls()
    valid = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
    return cls(**valid)


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    """从 YAML 文件加载配置"""
    path = Path(path)
    if not path.exists():
        return AppConfig()

    with open(path) as f:
        raw = yaml.safe_load(f) or {}

    return AppConfig(
        input=_build_dataclass(InputConfig, raw.get("input")),
        blur=_build_dataclass(BlurConfig, raw.get("blur")),
        face=_build_dataclass(FaceConfig, raw.get("face")),
        aesthetic=_build_dataclass(AestheticConfig, raw.get("aesthetic")),
        highlight=_build_dataclass(HighlightConfig, raw.get("highlight")),
        ai=_build_dataclass(AIConfig, raw.get("ai")),
        storage=_build_dataclass(StorageConfig, raw.get("storage")),
        whisper=_build_dataclass(WhisperConfig, raw.get("whisper")),
    )
