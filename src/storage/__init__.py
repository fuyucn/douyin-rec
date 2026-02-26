"""Storage module for persisting screenshots and highlight clips."""

from .database import HighlightClip, Screenshot
from .manager import StorageManager

__all__ = ["HighlightClip", "Screenshot", "StorageManager"]
