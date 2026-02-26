"""美学评分 - 基于 CLIP + 美学预测器"""

from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
from PIL import Image

logger = logging.getLogger(__name__)

AESTHETIC_PROMPTS = [
    "a beautiful photo",
    "a high quality photo",
    "a professional photo",
    "an aesthetically pleasing image",
    "a well-composed photograph",
]

NEGATIVE_PROMPTS = [
    "a bad photo",
    "a low quality photo",
    "an ugly image",
    "a blurry photo",
    "a poorly composed photograph",
]


class AestheticPredictor(nn.Module):
    """LAION 美学预测头：CLIP 特征 -> 美学分数"""

    def __init__(self, input_size: int = 768):
        super().__init__()
        self.linear = nn.Linear(input_size, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.linear(x)


class AestheticScorer:
    """使用 CLIP 和美学预测器对帧进行美学评分"""

    def __init__(self):
        self._device = self._select_device()
        self._model = None
        self._preprocess = None
        self._tokenize = None
        self._predictor = None
        self._use_predictor = False
        self._text_features = None
        self._loaded = False

    @staticmethod
    def _select_device() -> torch.device:
        if torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True

        try:
            import open_clip

            model, _, preprocess = open_clip.create_model_and_transforms(
                "ViT-L-14", pretrained="openai", device=self._device,
            )
            model.eval()
            self._model = model
            self._preprocess = preprocess
            self._tokenize = open_clip.get_tokenizer("ViT-L-14")
        except Exception as e:
            logger.error("Failed to load CLIP model: %s", e)
            raise

        # 尝试加载美学预测头
        self._load_aesthetic_predictor()

        # 如果没有预测头，预计算文本特征作为回退
        if not self._use_predictor:
            self._precompute_text_features()

    def _load_aesthetic_predictor(self) -> None:
        """加载 LAION 美学预测器权重"""
        weights_path = Path.home() / ".cache" / "aesthetic_predictor" / "sa_0_4_vit_l_14_linear.pth"

        if not weights_path.exists():
            try:
                self._download_aesthetic_weights(weights_path)
            except Exception as e:
                logger.warning("Could not download aesthetic predictor weights: %s", e)
                return

        try:
            self._predictor = AestheticPredictor(input_size=768)
            state_dict = torch.load(weights_path, map_location=self._device, weights_only=True)
            self._predictor.load_state_dict(state_dict)
            self._predictor.to(self._device)
            self._predictor.eval()
            self._use_predictor = True
            logger.info("Aesthetic predictor loaded from %s", weights_path)
        except Exception as e:
            logger.warning("Failed to load aesthetic predictor: %s", e)
            self._predictor = None

    @staticmethod
    def _download_aesthetic_weights(dest: Path) -> None:
        """下载 LAION 美学预测器权重"""
        import urllib.request

        url = (
            "https://github.com/christophschuhmann/"
            "improved-aesthetic-predictor/raw/main/"
            "sa_0_4_vit_l_14_linear.pth"
        )
        dest.parent.mkdir(parents=True, exist_ok=True)
        logger.info("Downloading aesthetic predictor weights...")
        urllib.request.urlretrieve(url, dest)

    @torch.no_grad()
    def _precompute_text_features(self) -> None:
        """预计算正面/负面提示词的文本特征（回退方案）"""
        all_prompts = AESTHETIC_PROMPTS + NEGATIVE_PROMPTS
        tokens = self._tokenize(all_prompts).to(self._device)
        self._text_features = self._model.encode_text(tokens)
        self._text_features = self._text_features / self._text_features.norm(dim=-1, keepdim=True)

    @torch.no_grad()
    def score(self, frame: np.ndarray) -> tuple[float, np.ndarray]:
        """对帧进行美学评分

        Returns:
            (aesthetic_score, clip_features): 美学分数 (1-10) 和 CLIP 特征向量
        """
        self._load()

        # BGR -> RGB -> PIL
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pil_image = Image.fromarray(rgb)

        # 提取 CLIP 特征
        image_input = self._preprocess(pil_image).unsqueeze(0).to(self._device)
        image_features = self._model.encode_image(image_input)
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)

        clip_features_np = image_features.cpu().numpy().flatten()

        if self._use_predictor and self._predictor is not None:
            # 使用美学预测头
            raw_score = self._predictor(image_features).item()
            # 原始分数通常在 1-10 范围内
            aesthetic_score = max(1.0, min(10.0, raw_score))
        else:
            # 回退：基于文本相似度估算
            aesthetic_score = self._score_by_text_similarity(image_features)

        return aesthetic_score, clip_features_np

    def _score_by_text_similarity(self, image_features: torch.Tensor) -> float:
        """使用 CLIP 文本相似度估算美学分数"""
        n_pos = len(AESTHETIC_PROMPTS)
        similarities = (image_features @ self._text_features.T).squeeze(0)

        pos_sim = similarities[:n_pos].mean().item()
        neg_sim = similarities[n_pos:].mean().item()

        # 将差值映射到 1-10 范围
        diff = pos_sim - neg_sim
        score = 5.0 + diff * 20.0
        return max(1.0, min(10.0, score))
