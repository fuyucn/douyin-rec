"""测试数据模型"""

import numpy as np

from src.models import FrameInfo, FaceInfo, FrameScore, HighlightCategory


def test_frame_info():
    """FrameInfo 基本构造"""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    info = FrameInfo(frame=frame, timestamp=1.5, frame_index=3, source="test.mp4")
    assert info.timestamp == 1.5
    assert info.frame_index == 3
    assert info.source == "test.mp4"
    assert info.frame.shape == (480, 640, 3)


def test_face_info():
    """FaceInfo 默认值"""
    face = FaceInfo(bbox=(10, 20, 100, 200), confidence=0.95)
    assert face.bbox == (10, 20, 100, 200)
    assert face.confidence == 0.95
    assert face.yaw == 0.0
    assert face.pitch == 0.0
    assert face.face_ratio == 0.0


def test_frame_score():
    """FrameScore 构造"""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    info = FrameInfo(frame=frame, timestamp=0.0, frame_index=0, source="test")
    face = FaceInfo(bbox=(0, 0, 50, 50), confidence=0.9)
    score = FrameScore(
        frame_info=info,
        blur_score=150.0,
        face_info=face,
        aesthetic_score=7.5,
    )
    assert score.blur_score == 150.0
    assert score.aesthetic_score == 7.5
    assert score.face_info.confidence == 0.9
    assert score.clip_features is None


def test_highlight_category():
    """HighlightCategory 枚举"""
    assert HighlightCategory.FUNNY.value == "funny"
    assert HighlightCategory.SKILLFUL.value == "skillful"
    assert HighlightCategory.EMOTIONAL.value == "emotional"
    assert HighlightCategory.OTHER.value == "other"
