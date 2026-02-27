# 计划：高能时刻任务支持 AI 后端选择 + API Key 校验

## Context
高能时刻任务目前 AI 后端固定读取全局 config，用户无法在 UI 上选择不同的后端（本地 Ollama 或云端 Claude/Gemini/GPT-4o）。需要在创建任务时允许选择后端，并提示云端后端是否已配置 API Key。

---

## 修改文件（共 4 处）

### 1. `src/storage/database.py` — LocalVideoTask 增加字段
```python
class LocalVideoTask(SQLModel, table=True):
    ...
    ai_backend: str | None = None   # 新增：任务级 AI 后端覆盖，None 表示用全局默认
```

### 2. `src/task_manager.py` — 三处修改

**`_migrate_db()`** — 自动补列（已有 `_migrate_db` 同款模式）：
```python
_add_column_if_missing(conn, "localvideotask", "ai_backend", "TEXT")
```

**`create_local_task()`** — 增加参数：
```python
def create_local_task(self, video_path, task_type="portrait", name=None, ai_backend=None):
    task = LocalVideoTask(..., ai_backend=ai_backend)
```

**`_run_highlight()`** — 使用任务级后端覆盖：
```python
config = load_config()
if task.ai_backend:
    config.ai.default_backend = task.ai_backend
ai_analyzer = create_analyzer(config.ai)
```

### 3. `src/ui/app.py` — 两处修改

**新增 `GET /api/ai/backends`** — 返回各后端可用状态（不暴露 key 内容）：
```python
@app.get("/api/ai/backends")
async def get_ai_backends():
    config = load_config()
    ai = config.ai
    import os
    return {
        "default": ai.default_backend,
        "backends": [
            {"id": "ollama", "label": "Ollama（本地）", "local": True,
             "available": True, "model": ai.ollama_model},
            {"id": "claude", "label": "Claude", "local": False,
             "available": bool(ai.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY"))},
            {"id": "gemini", "label": "Gemini", "local": False,
             "available": bool(ai.google_api_key or os.environ.get("GOOGLE_API_KEY"))},
            {"id": "gpt4o", "label": "GPT-4o", "local": False,
             "available": bool(ai.openai_api_key or os.environ.get("OPENAI_API_KEY"))},
        ]
    }
```

**`POST /api/local/tasks`** — 接收 `ai_backend` 参数：
```python
ai_backend = body.get("ai_backend") or None
task = task_manager.create_local_task(..., ai_backend=ai_backend)
```

### 4. `src/ui/static/index.html` — 前端 UI

页面加载时调用 `/api/ai/backends` 缓存后端列表。

在「高能时刻」单选被选中时，显示 AI 后端选择区域：
- 显示为一组 radio button（横排），每项包含：
  - 本地后端：显示模型名（如 `minicpm-v`）
  - 云端后端：已配置 → 绿色「✓ 已配置」，未配置 → 橙色「⚠ 缺少 API Key」
- 默认选中全局 `default_backend`
- 提交时将选中的 `ai_backend` 一起 POST

**UI 联动**：
- `taskType == "portrait"` → 隐藏后端选择区域
- `taskType == "highlight"` → 显示后端选择区域

---

## 额外 Bug Fix

**`src/ai/base.py`** — `parse_highlight_result` 中 `score: null` 导致 `float(None)` 崩溃：
```python
# 修复前
score=float(data.get("score", 0.0)),
# 修复后（兼容 null 返回值，与 category: null 同款修复）
score=float(data.get("score") or 0.0),
```

---

## 关键文件路径

| 文件 | 修改类型 |
|------|---------|
| `src/storage/database.py` | 新增字段 `ai_backend` |
| `src/task_manager.py` | 迁移 + 参数传递 + 后端覆盖 |
| `src/ui/app.py` | 新增 `/api/ai/backends` + 接收参数 |
| `src/ui/static/index.html` | 后端选择 UI + 联动逻辑 |
| `src/ai/base.py` | Bug fix: score: null 兼容 |

---

## 验证方式

1. 启动 UI：`uv run python main.py record --ui`
2. 创建本地视频任务，选择「高能时刻」，确认后端选择区域出现
3. 切换不同后端，确认 Key 状态正确显示
4. 选择 ollama 提交，确认任务日志中使用 ollama 后端
5. 选择一个无 Key 的云端后端提交，确认错误信息清晰
