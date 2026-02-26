"""Headed 模式 - 实时显示视频画面和处理结果"""

from __future__ import annotations

import cv2
import numpy as np

from src.models import FaceInfo


class FrameDisplay:
    """通过 cv2.imshow 实时显示视频画面，叠加检测结果"""

    WINDOW_NAME = "Video Screenshot - Headed Mode"
    TARGET_WIDTH = 960

    def show(
        self,
        frame: np.ndarray,
        blur_score: float | None = None,
        face_info: FaceInfo | None = None,
        aesthetic_score: float | None = None,
        status: str = "",
        saved_count: int = 0,
        timestamp: float = 0.0,
        total_duration: float = 0.0,
    ) -> bool:
        """显示一帧画面，叠加标注信息。

        Returns:
            True 表示用户按下 q 请求退出
        """
        display = self._resize(frame)
        h, w = display.shape[:2]
        scale = w / frame.shape[1]

        # 绘制人脸 bbox
        if face_info is not None:
            x1, y1, x2, y2 = face_info.bbox
            x1, y1 = int(x1 * scale), int(y1 * scale)
            x2, y2 = int(x2 * scale), int(y2 * scale)
            # 绿色=通过, 红色=拒绝
            is_accepted = status.startswith("\u2713")  # ✓
            color = (0, 200, 0) if is_accepted else (0, 0, 220)
            cv2.rectangle(display, (x1, y1), (x2, y2), color, 2)
            # 人脸置信度标签
            label = f"face {face_info.confidence:.2f}"
            cv2.putText(
                display, label, (x1, y1 - 6),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA,
            )

        # 左上角: 分数信息
        y_offset = 24
        lines = []
        if blur_score is not None:
            lines.append(f"blur: {blur_score:.1f}")
        if face_info is not None:
            lines.append(f"face_conf: {face_info.confidence:.2f}")
        if aesthetic_score is not None:
            lines.append(f"aesthetic: {aesthetic_score:.2f}")
        for line in lines:
            self._put_text_bg(display, line, (10, y_offset))
            y_offset += 22

        # 右上角: 状态
        if status:
            text_size = cv2.getTextSize(
                status, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1,
            )[0]
            tx = w - text_size[0] - 14
            is_good = status.startswith("\u2713")
            color = (0, 200, 0) if is_good else (0, 0, 220)
            self._put_text_bg(display, status, (tx, 24), color=color)

        # 底部: 进度 + 已保存数量
        ts_str = self._format_time(timestamp)
        if total_duration > 0:
            total_str = self._format_time(total_duration)
            pct = min(timestamp / total_duration * 100, 100.0)
            bottom_text = f"{ts_str} / {total_str}  ({pct:.1f}%)  |  saved: {saved_count}"
        else:
            # 直播流没有总时长
            bottom_text = f"{ts_str}  |  saved: {saved_count}"
        self._put_text_bg(display, bottom_text, (10, h - 12))

        # 底部进度条 (仅有总时长时绘制)
        if total_duration > 0:
            bar_y = h - 4
            bar_h = 3
            progress = min(timestamp / total_duration, 1.0)
            bar_w = int(w * progress)
            cv2.rectangle(display, (0, bar_y), (w, bar_y + bar_h), (60, 60, 60), -1)
            cv2.rectangle(display, (0, bar_y), (bar_w, bar_y + bar_h), (0, 200, 0), -1)

        cv2.imshow(self.WINDOW_NAME, display)
        key = cv2.waitKey(1) & 0xFF
        return key == ord("q")

    def close(self):
        cv2.destroyAllWindows()

    # ---- internal helpers ----

    def _resize(self, frame: np.ndarray) -> np.ndarray:
        h, w = frame.shape[:2]
        if w == self.TARGET_WIDTH:
            return frame.copy()
        scale = self.TARGET_WIDTH / w
        new_h = int(h * scale)
        return cv2.resize(frame, (self.TARGET_WIDTH, new_h))

    @staticmethod
    def _put_text_bg(
        img: np.ndarray,
        text: str,
        org: tuple[int, int],
        color: tuple[int, int, int] = (255, 255, 255),
        font_scale: float = 0.50,
    ):
        """带半透明背景的文字"""
        font = cv2.FONT_HERSHEY_SIMPLEX
        thickness = 1
        (tw, th), baseline = cv2.getTextSize(text, font, font_scale, thickness)
        x, y = org
        # 背景矩形
        overlay = img.copy()
        cv2.rectangle(overlay, (x - 2, y - th - 4), (x + tw + 4, y + baseline + 2), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.55, img, 0.45, 0, img)
        cv2.putText(img, text, (x, y), font, font_scale, color, thickness, cv2.LINE_AA)

    @staticmethod
    def _format_time(seconds: float) -> str:
        m, s = divmod(int(seconds), 60)
        h, m = divmod(m, 60)
        if h > 0:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"
