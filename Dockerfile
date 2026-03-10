FROM python:3.11-slim

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    curl \
    build-essential \
    cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装 uv
RUN pip install --no-cache-dir uv

# 先复制依赖声明（利用 Docker 层缓存: 源码变更不重新安装依赖）
COPY pyproject.toml uv.lock ./

# 安装依赖 (ui extra, 不安装项目本身)
RUN uv sync --extra ui --no-install-project --frozen

# 可选: CPU-only torch 替换 (--build-arg CPU_ONLY=true 时生效, 省 ~1.3GB)
ARG CPU_ONLY=false
RUN if [ "$CPU_ONLY" = "true" ]; then \
    uv pip install torch --index-url https://download.pytorch.org/whl/cpu; \
    fi

# 复制源码
COPY . .

# 挂载点: 输出 + 模型缓存
VOLUME ["/app/output", "/root/.insightface", "/root/.cache"]

ENV UV_LINK_MODE=copy

EXPOSE 7860

CMD ["uv", "run", "python", "main.py", "record", "--ui", "--port", "7860"]
