# Plan: 定时启停功能 (Per-task Schedule)

## Context

直播录制任务使用循环轮询检测开播状态，24 小时不间断访问可能被平台限制。需要增加定时启停功能，让每个任务可以设定每天的活跃时间窗口（如 20:00~02:00），窗口外自动暂停轮询，窗口内自动恢复。类似 cron 的每日定时。

**行为定义**:
- 窗口外：不发起轮询，worker 线程 sleep 等待
- 窗口内：正常轮询和录制
- 到达 stop 时间时：如果正在录制，等当前直播流自然结束后不再发起新的轮询；如果在等待开播，立即暂停轮询
- 支持跨午夜时间段（如 22:00~03:00）
- 时区可选（默认 Asia/Shanghai）

## 涉及文件

1. `src/storage/database.py` — RecordingTask 新增字段
2. `src/task_manager.py` — worker 逻辑加入时间窗口判断
3. `src/ui/app.py` — API 序列化 + 创建接口支持新字段
4. `src/ui/static/index.html` — 前端表单和详情页展示
5. `tests/test_task_manager.py` — 新增调度相关测试

## 步骤

### 1. RecordingTask 新增 4 个字段 (`src/storage/database.py`)

```python
schedule_enabled: bool = False        # 是否启用定时
schedule_timezone: str = "Asia/Shanghai"  # 时区 (IANA)
schedule_start: str = "00:00"         # 每日开始时间 HH:MM
schedule_stop: str = "23:59"          # 每日停止时间 HH:MM
```

### 2. DB 自动迁移 (`src/task_manager.py` `_migrate_db()`)

在 `migrations` 列表追加 4 项:
```python
("schedule_enabled", "BOOLEAN NOT NULL DEFAULT 0"),
("schedule_timezone", "TEXT NOT NULL DEFAULT 'Asia/Shanghai'"),
("schedule_start", "TEXT NOT NULL DEFAULT '00:00'"),
("schedule_stop", "TEXT NOT NULL DEFAULT '23:59'"),
```

### 3. `create_task()` 接受新参数 (`src/task_manager.py`)

签名增加 `schedule_enabled`, `schedule_timezone`, `schedule_start`, `schedule_stop`，透传给 `RecordingTask()` 构造。

### 4. Worker 时间窗口逻辑 (`src/task_manager.py`)

新增辅助方法 `_is_in_schedule(task) -> bool`:
- 使用 `zoneinfo.ZoneInfo` 获取当前时区时间
- 比较 `schedule_start` 和 `schedule_stop`，支持跨午夜（start > stop 表示跨天）
- `schedule_enabled=False` 时始终返回 `True`

新增辅助方法 `_seconds_until_schedule_start(task) -> float`:
- 计算从当前时刻到下一个 start 时间点的秒数

修改 `_task_worker()` 的 `while` 循环:
```
while not worker.stop_event.is_set():
    # ── 定时窗口检查 ──
    if schedule_enabled and not _is_in_schedule(task):
        worker.status_text = "定时等待"
        log(f"当前不在定时窗口 ({start}~{stop})，等待...")
        # sleep 直到 start 时间或 stop_event
        wait_secs = _seconds_until_schedule_start(task)
        worker.stop_event.wait(min(wait_secs, 60))  # 最多 60s 醒一次检查
        continue

    # ── 等待开播 ──（已有逻辑）
    ...

    # ── 录制中 ──（已有逻辑，不变）
    # 录制结束后回到循环顶部，再次检查时间窗口
```

关键：录制过程中不中断（满足"等待当前流结束"的需求），只是在录制结束后的循环顶部检查是否还在窗口内。

在 `wait_for_live` 的 `poll_interval` sleep 中也需要考虑：如果到达 stop 时间，提前退出等待开播循环。修改方式：在 `_task_worker` 中检查 `wait_for_live` 返回后，是否已经超出时间窗口。

实际上更简单的做法：在 while 循环的顶部检查 schedule 即可。`wait_for_live` 返回后如果已超时间窗口，回到循环顶部自然会被 schedule 检查拦住。在 `wait_for_live` 的轮询间隔中，需要在每次 poll 前也检查时间窗口，如果超出则 raise `InterruptedError` 让 worker 回到顶部。

修改 `src/input/live.py` 的 `wait_for_live()` — 增加可选的 `schedule_check` 回调参数：
```python
def wait_for_live(self, ..., schedule_check=None):
    # 每次 poll 前检查
    if schedule_check and not schedule_check():
        raise InterruptedError("定时窗口结束")
```

### 5. API 更新 (`src/ui/app.py`)

- `_serialize_task()` 增加 4 个字段
- `create_task()` 从 body 读取 4 个字段传给 `task_manager.create_task()`

### 6. 前端 UI (`src/ui/static/index.html`)

**创建表单**:
- 新增一行: checkbox "启用定时" + 时区 select + 开始时间 input (type=time) + 停止时间 input (type=time)
- 定时 checkbox 未勾选时，时间输入框 hidden
- 时区下拉：常用选项 Asia/Shanghai, Asia/Tokyo, America/New_York, Europe/London, UTC 等

**列表页**:
- 如果任务启用了定时，在功能列显示 badge（如 "定时 20:00~02:00"）

**详情页**:
- 配置信息区展示定时设置

### 7. 测试 (`tests/test_task_manager.py`)

- `test_create_task_with_schedule` — 创建带调度的任务，验证字段存储
- `test_create_task_schedule_defaults` — 创建任务时调度字段默认值
- `test_is_in_schedule_disabled` — schedule_enabled=False 始终返回 True
- `test_is_in_schedule_same_day` — 同日窗口 (09:00~18:00)
- `test_is_in_schedule_cross_midnight` — 跨午夜窗口 (22:00~03:00)

## 验证

```bash
# 运行测试
uv run python -m pytest tests/test_task_manager.py -v

# 手动测试
uv run python main.py record --ui
# 在 Web UI 创建任务，勾选定时，设置时间窗口
# 观察日志输出：窗口外显示"定时等待"，窗口内正常轮询
```
