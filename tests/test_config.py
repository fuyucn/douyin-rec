"""测试配置加载"""

import tempfile
from pathlib import Path

from src.config import AppConfig, InputConfig, load_config


def test_load_config_default():
    """不存在配置文件时返回默认值"""
    config = load_config("nonexistent.yaml")
    assert isinstance(config, AppConfig)
    assert config.input.extract_fps == 2.0
    assert config.input.quality == "origin"
    assert config.blur.threshold == 100.0
    assert config.face.detection_confidence == 0.7
    assert config.aesthetic.min_score == 5.0
    assert config.aesthetic.top_k == 20


def test_load_config_from_yaml():
    """从 YAML 文件加载配置"""
    yaml_content = """\
input:
  extract_fps: 5.0
  quality: hd
blur:
  threshold: 200.0
aesthetic:
  min_score: 6.5
  top_k: 10
"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write(yaml_content)
        f.flush()
        config = load_config(f.name)

    assert config.input.extract_fps == 5.0
    assert config.input.quality == "hd"
    assert config.blur.threshold == 200.0
    assert config.aesthetic.min_score == 6.5
    assert config.aesthetic.top_k == 10
    # 未指定的字段使用默认值
    assert config.face.detection_confidence == 0.7


def test_load_config_ignores_extra_fields():
    """忽略多余字段"""
    yaml_content = """\
input:
  extract_fps: 3.0
  unknown_field: 999
"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write(yaml_content)
        f.flush()
        config = load_config(f.name)

    assert config.input.extract_fps == 3.0


def test_input_config_defaults():
    """InputConfig 默认值"""
    c = InputConfig()
    assert c.extract_fps == 2.0
    assert c.quality == "origin"
    assert c.cookies is None
    assert c.cookies_file is None
    assert c.segment_duration == 300.0
