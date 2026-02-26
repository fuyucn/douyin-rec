"""模糊检测器 - 基于 Laplacian 方差"""

import cv2
import numpy as np


class BlurDetector:
    """使用 Laplacian 方差检测模糊帧"""

    def detect(self, frame: np.ndarray) -> float:
        """计算帧的 Laplacian 方差分数（越高越清晰）"""
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        laplacian = cv2.Laplacian(gray, cv2.CV_64F)
        return float(laplacian.var())

    def is_blurry(self, frame: np.ndarray, threshold: float) -> bool:
        """判断帧是否模糊"""
        return self.detect(frame) < threshold
