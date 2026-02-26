"""过滤管线 - 整合模糊检测、人脸检测和美学评分"""

from __future__ import annotations

import logging

import numpy as np

from src.config import AppConfig
from src.models import FrameInfo, FrameScore

from .aesthetic import AestheticScorer
from .blur import BlurDetector
from .face import FaceDetector

logger = logging.getLogger(__name__)


class FilterPipeline:
    """过滤管线：依次执行模糊检测、人脸检测、美学评分"""

    def __init__(self, config: AppConfig):
        self.config = config
        self.blur_detector = BlurDetector()
        self.face_detector = FaceDetector(
            detection_confidence=config.face.detection_confidence,
        )
        self.aesthetic_scorer = AestheticScorer()

    def process_frame(self, frame_info: FrameInfo) -> FrameScore | None:
        """处理单帧，返回 FrameScore 或 None（不通过则丢弃）"""
        frame = frame_info.frame

        # 1. 模糊检测
        blur_score = self.blur_detector.detect(frame)
        if blur_score < self.config.blur.threshold:
            logger.debug(
                "Frame %d rejected: blur_score=%.1f < threshold=%.1f",
                frame_info.frame_index, blur_score, self.config.blur.threshold,
            )
            return None

        # 2. 人脸检测
        face_info = self.face_detector.has_good_face(frame, self.config.face)

        # 3. 美学评分
        aesthetic_score, clip_features = self.aesthetic_scorer.score(frame)
        if aesthetic_score < self.config.aesthetic.min_score:
            logger.debug(
                "Frame %d rejected: aesthetic_score=%.2f < min_score=%.1f",
                frame_info.frame_index, aesthetic_score, self.config.aesthetic.min_score,
            )
            return None

        return FrameScore(
            frame_info=frame_info,
            blur_score=blur_score,
            face_info=face_info,
            aesthetic_score=aesthetic_score,
            clip_features=clip_features,
        )

    def process_frame_detailed(self, frame_info: FrameInfo) -> tuple[FrameScore | None, dict]:
        """处理单帧并返回中间结果（供 headed 模式使用）

        Returns:
            (score_or_none, details_dict)
            details_dict 包含: blur_score, face_info, aesthetic_score, reject_reason
        """
        frame = frame_info.frame
        details: dict = {
            "blur_score": None,
            "face_info": None,
            "aesthetic_score": None,
            "reject_reason": None,
        }

        # 1. 模糊检测
        blur_score = self.blur_detector.detect(frame)
        details["blur_score"] = blur_score
        if blur_score < self.config.blur.threshold:
            details["reject_reason"] = "模糊"
            return None, details

        # 2. 人脸检测
        face_info = self.face_detector.has_good_face(frame, self.config.face)
        details["face_info"] = face_info
        if face_info is None:
            details["reject_reason"] = "无人脸"

        # 3. 美学评分
        aesthetic_score, clip_features = self.aesthetic_scorer.score(frame)
        details["aesthetic_score"] = aesthetic_score
        if aesthetic_score < self.config.aesthetic.min_score:
            details["reject_reason"] = "美学低"
            return None, details

        score = FrameScore(
            frame_info=frame_info,
            blur_score=blur_score,
            face_info=face_info,
            aesthetic_score=aesthetic_score,
            clip_features=clip_features,
        )
        return score, details

    def process_batch(self, frames: list[FrameInfo]) -> list[FrameScore]:
        """批量处理帧"""
        results: list[FrameScore] = []
        for frame_info in frames:
            score = self.process_frame(frame_info)
            if score is not None:
                results.append(score)
        return results

    def select_top_k(self, scores: list[FrameScore], k: int) -> list[FrameScore]:
        """选取 top-K 帧：按美学评分排序，基于 CLIP 特征余弦相似度去重

        Args:
            scores: 候选帧评分列表
            k: 最多返回的帧数

        Returns:
            去重后的 top-K 帧列表
        """
        if not scores:
            return []

        # 按美学评分降序排序
        sorted_scores = sorted(scores, key=lambda s: s.aesthetic_score, reverse=True)

        threshold = self.config.aesthetic.dedup_similarity
        selected: list[FrameScore] = []

        for candidate in sorted_scores:
            if len(selected) >= k:
                break

            if candidate.clip_features is None:
                selected.append(candidate)
                continue

            # 与已选帧去重
            is_duplicate = False
            for existing in selected:
                if existing.clip_features is None:
                    continue
                similarity = self._cosine_similarity(
                    candidate.clip_features, existing.clip_features,
                )
                if similarity > threshold:
                    is_duplicate = True
                    break

            if not is_duplicate:
                selected.append(candidate)

        return selected

    @staticmethod
    def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        """计算两个向量的余弦相似度"""
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return float(np.dot(a, b) / (norm_a * norm_b))
