"""Storage manager for saving screenshots and highlight clips."""

from __future__ import annotations

import json
import re
from pathlib import Path

import cv2
from PIL import Image
from sqlmodel import Session, SQLModel, create_engine, select

from ..config import StorageConfig
from ..models import FrameScore, HighlightMoment
from .database import HighlightClip, Screenshot


def _sanitize_source_name(source: str) -> str:
    """Extract a filesystem-safe name from a source path or URL."""
    name = Path(source).stem
    name = re.sub(r"[^\w\-.]", "_", name)
    return name or "unknown"


class StorageManager:
    def __init__(self, config: StorageConfig, name: str | None = None) -> None:
        self.config = config
        self.output_dir = Path(config.output_dir)
        if name:
            # 按主播名字/视频名字建子目录
            safe_name = re.sub(r"[^\w\u4e00-\u9fff\-.]", "_", name)
            self.output_dir = self.output_dir / safe_name
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # 数据库统一存放在 output/ 根目录，不跟随主播子目录
        db_path = Path(config.db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(f"sqlite:///{db_path}")
        SQLModel.metadata.create_all(self.engine)

    def save_screenshot(
        self,
        frame_score: FrameScore,
        category: str = "portrait",
    ) -> Screenshot:
        """Save a scored frame as a JPEG image and record it in the database."""
        info = frame_score.frame_info
        source_name = _sanitize_source_name(info.source)

        # Build output path: {output_dir}/{category}/{source_name}_{timestamp:.1f}.{format}
        cat_dir = self.output_dir / category
        cat_dir.mkdir(parents=True, exist_ok=True)

        filename = f"{source_name}_{info.timestamp:.1f}.{self.config.image_format}"
        image_path = cat_dir / filename

        # Convert BGR (OpenCV) -> RGB -> PIL Image -> save
        rgb = cv2.cvtColor(info.frame, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(rgb)
        pil_img.save(str(image_path), quality=self.config.image_quality)

        face = frame_score.face_info
        record = Screenshot(
            source=info.source,
            timestamp=info.timestamp,
            frame_index=info.frame_index,
            blur_score=frame_score.blur_score,
            aesthetic_score=frame_score.aesthetic_score,
            face_confidence=face.confidence if face else None,
            face_yaw=face.yaw if face else None,
            face_pitch=face.pitch if face else None,
            category=category,
            image_path=str(image_path),
        )

        with Session(self.engine) as session:
            session.add(record)
            session.commit()
            session.refresh(record)

        return record

    def save_highlight(self, moment: HighlightMoment) -> HighlightClip:
        """Save key frames of a highlight moment and record it in the database."""
        source_name = _sanitize_source_name(
            moment.frames[0].source if moment.frames else "unknown"
        )

        cat_dir = self.output_dir / "highlight"
        cat_dir.mkdir(parents=True, exist_ok=True)

        key_frame_paths: list[str] = []
        for frame_info in moment.frames:
            filename = (
                f"{source_name}_{frame_info.timestamp:.1f}.{self.config.image_format}"
            )
            image_path = cat_dir / filename
            rgb = cv2.cvtColor(frame_info.frame, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(rgb)
            pil_img.save(str(image_path), quality=self.config.image_quality)
            key_frame_paths.append(str(image_path))

        record = HighlightClip(
            source=moment.frames[0].source if moment.frames else "",
            start_time=moment.start_time,
            end_time=moment.end_time,
            score=moment.result.score,
            category=moment.result.category.value,
            description=moment.result.description,
            key_frame_paths=json.dumps(key_frame_paths),
        )

        with Session(self.engine) as session:
            session.add(record)
            session.commit()
            session.refresh(record)

        return record

    def get_screenshots(
        self,
        category: str | None = None,
        min_score: float | None = None,
    ) -> list[Screenshot]:
        """Query saved screenshots with optional filters."""
        with Session(self.engine) as session:
            stmt = select(Screenshot)
            if category is not None:
                stmt = stmt.where(Screenshot.category == category)
            if min_score is not None:
                stmt = stmt.where(Screenshot.aesthetic_score >= min_score)
            return list(session.exec(stmt).all())

    def get_highlights(
        self,
        category: str | None = None,
    ) -> list[HighlightClip]:
        """Query saved highlight clips with optional category filter."""
        with Session(self.engine) as session:
            stmt = select(HighlightClip)
            if category is not None:
                stmt = stmt.where(HighlightClip.category == category)
            return list(session.exec(stmt).all())
