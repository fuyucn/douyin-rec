"""人脸检测与质量评估"""

from __future__ import annotations

import logging
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from src.config import FaceConfig
from src.models import FaceInfo

logger = logging.getLogger(__name__)

_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
_MODEL_DIR = Path.home() / ".cache" / "mediapipe" / "face_detector"
_MODEL_PATH = _MODEL_DIR / "blaze_face_short_range.tflite"


def _ensure_model() -> str:
    """下载 MediaPipe 人脸检测模型 (如果不存在)"""
    if _MODEL_PATH.exists():
        return str(_MODEL_PATH)
    _MODEL_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Downloading MediaPipe face detection model...")
    urllib.request.urlretrieve(_MODEL_URL, _MODEL_PATH)
    logger.info("Model saved to %s", _MODEL_PATH)
    return str(_MODEL_PATH)


class FaceDetector:
    """使用 MediaPipe 快速检测人脸，InsightFace 分析姿态角"""

    def __init__(self, detection_confidence: float = 0.7):
        import mediapipe as mp

        model_path = _ensure_model()
        base_options = mp.tasks.BaseOptions(model_asset_path=model_path)
        options = mp.tasks.vision.FaceDetectorOptions(
            base_options=base_options,
            min_detection_confidence=detection_confidence,
        )
        self._detector = mp.tasks.vision.FaceDetector.create_from_options(options)
        self._mp = mp
        self._insightface_app = None
        self._insightface_loaded = False

    def _load_insightface(self) -> None:
        """延迟加载 InsightFace 模型"""
        if self._insightface_loaded:
            return
        self._insightface_loaded = True
        try:
            from insightface.app import FaceAnalysis

            self._insightface_app = FaceAnalysis(
                name="buffalo_l",
                providers=["CoreMLExecutionProvider", "CPUExecutionProvider"],
            )
            self._insightface_app.prepare(ctx_id=-1, det_size=(640, 640))
            logger.info("InsightFace model loaded successfully")
        except Exception as e:
            logger.warning("InsightFace not available, face pose analysis disabled: %s", e)
            self._insightface_app = None

    def detect_faces(self, frame: np.ndarray) -> list[FaceInfo]:
        """使用 MediaPipe 快速检测人脸"""
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._detector.detect(mp_image)

        if not result.detections:
            return []

        h, w = frame.shape[:2]
        frame_area = h * w
        faces: list[FaceInfo] = []

        for det in result.detections:
            bb = det.bounding_box
            x1 = max(0, bb.origin_x)
            y1 = max(0, bb.origin_y)
            x2 = min(w, bb.origin_x + bb.width)
            y2 = min(h, bb.origin_y + bb.height)

            face_area = (x2 - x1) * (y2 - y1)
            face_ratio = face_area / frame_area if frame_area > 0 else 0.0

            confidence = det.categories[0].score if det.categories else 0.0

            faces.append(FaceInfo(
                bbox=(x1, y1, x2, y2),
                confidence=confidence,
                face_ratio=face_ratio,
            ))

        return faces

    def analyze_face_quality(self, frame: np.ndarray, face: FaceInfo) -> FaceInfo:
        """使用 InsightFace 获取 yaw/pitch/roll 角度"""
        self._load_insightface()

        if self._insightface_app is None:
            return face

        try:
            results = self._insightface_app.get(frame)
            if not results:
                return face

            # 找到与 MediaPipe bbox 最近的 InsightFace 结果
            x1, y1, x2, y2 = face.bbox
            center = ((x1 + x2) / 2, (y1 + y2) / 2)
            best = None
            best_dist = float("inf")

            for r in results:
                rb = r.bbox
                rc = ((rb[0] + rb[2]) / 2, (rb[1] + rb[3]) / 2)
                dist = (center[0] - rc[0]) ** 2 + (center[1] - rc[1]) ** 2
                if dist < best_dist:
                    best_dist = dist
                    best = r

            if best is not None and hasattr(best, "pose"):
                face.yaw = float(best.pose[1])
                face.pitch = float(best.pose[0])
                face.roll = float(best.pose[2])
        except Exception as e:
            logger.warning("InsightFace analysis failed: %s", e)

        return face

    def has_good_face(self, frame: np.ndarray, config: FaceConfig) -> FaceInfo | None:
        """检测并返回通过质量检查的最佳人脸，无合适人脸则返回 None"""
        faces = self.detect_faces(frame)
        if not faces:
            return None

        # 按置信度排序，取最佳
        faces.sort(key=lambda f: f.confidence, reverse=True)

        for face in faces:
            if face.face_ratio < config.min_face_ratio:
                continue

            face = self.analyze_face_quality(frame, face)

            if abs(face.yaw) > config.max_yaw:
                continue
            if abs(face.pitch) > config.max_pitch:
                continue

            return face

        return None
