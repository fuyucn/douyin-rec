# 计划：接入 Ollama 本地模型作为高能时刻 AI 后端

## Context
项目高能时刻检测目前只支持云端 AI（Claude/Gemini/GPT-4o），需要 API Key 且需联网。
用户已在 M3 Pro 本地安装 ollama + minicpm-v，希望接入本地模型，无需 API Key。

## 修改文件（共 4 处）

### 1. 新建 `src/ai/ollama_backend.py`
- `OllamaAnalyzer` 类，用标准库 `urllib` 调用 Ollama `/api/chat` 接口
- 传入 base64 图片，`stream: false`，timeout=120s
- 无需新增依赖

### 2. 修改 `src/config.py`
- `AIConfig` 增加 `ollama_base_url: str = "http://localhost:11434"`
- `AIConfig` 增加 `ollama_model: str = "minicpm-v"`

### 3. 修改 `src/ai/factory.py`
- 注册 `ollama` 分支：`if backend == "ollama": return OllamaAnalyzer(config)`
- 更新错误提示中的后端列表

### 4. 修改 `config.yaml`
- `default_backend` 改为 `ollama`
- 添加 `ollama_base_url` / `ollama_model` 配置项

## 验证方式

```bash
ollama list  # 确认 minicpm-v 存在

uv run python -c "
from src.config import load_config
from src.ai.factory import create_analyzer
import numpy as np
config = load_config()
analyzer = create_analyzer(config.ai)
result = analyzer.analyze_frames([np.zeros((480, 640, 3), dtype=np.uint8)])
print(result)
"
```
