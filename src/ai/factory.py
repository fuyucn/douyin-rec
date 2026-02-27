"""Factory for creating AI highlight analyzers."""

from __future__ import annotations

from src.config import AIConfig

from .base import HighlightAnalyzer


def create_analyzer(config: AIConfig) -> HighlightAnalyzer:
    """Create a HighlightAnalyzer instance based on the configured backend.

    Supported backends: "claude", "gemini", "gpt4o", "qwen".
    """
    backend = config.default_backend.lower()

    if backend == "claude":
        from .claude_backend import ClaudeAnalyzer
        return ClaudeAnalyzer(config)

    if backend == "gemini":
        from .gemini_backend import GeminiAnalyzer
        return GeminiAnalyzer(config)

    if backend == "gpt4o":
        from .gpt4o_backend import GPT4oAnalyzer
        return GPT4oAnalyzer(config)

    if backend == "qwen":
        from .qwen_backend import QwenLocalAnalyzer
        return QwenLocalAnalyzer()

    if backend == "ollama":
        from .ollama_backend import OllamaAnalyzer
        return OllamaAnalyzer(config)

    raise ValueError(f"Unknown AI backend: {backend!r}. Supported: claude, gemini, gpt4o, qwen, ollama")
