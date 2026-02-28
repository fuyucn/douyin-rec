# 计划：RecordingSession 持久化追踪 + 孤儿 ffmpeg 自动接管

## Context

服务器重启时，正在运行的 ffmpeg 录制进程不会被 kill，成为孤儿进程继续占用磁盘空间。
当前临时方案 `_kill_orphan_ffmpeg()` 只做了 kill，且依赖脆弱的 pgrep 命令。

用户选择长期方案（方案 B）：为每次录制创建 `RecordingSession` 数据库记录，重启时检测孤儿 PID 并被动监控，UI 展示历史录制列表与孤儿告警。

---

## 数据流

```
ffmpeg 启动前  → 写入 RecordingSession(status=active, pid=...)
ffmpeg 正常结束 → 更新 ended_at, duration_sec, status=stopped, end_reason
服务器重启时   → _handle_orphan_sessions() 检测上次 active session 的 PID
                   PID 存活 → status=orphan，启动 _orphan_monitor() 被动等待
                   PID 不存在 → status=stopped, end_reason=server_restart
孤儿进程结束时 → _orphan_monitor() 更新 ended_at, duration_sec
```

---

## 修改文件（共 5 处）

### 1. `src/storage/database.py`

新增 `RecordingSession` 表：

```python
class RecordingSession(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    task_id: int = Field(index=True)
    ffmpeg_pid: int
    output_path: str
    started_at: datetime = Field(default_factory=datetime.now)
    ended_at: datetime | None = None
    duration_sec: float | None = None
    status: str = "active"    # active | stopped | orphan
    end_reason: str | None = None  # user_stop|stream_end|server_restart|orphan_died|error
```

### 2. `src/recorder.py`

新增 `pid` 属性：

```python
@property
def pid(self) -> int | None:
    return self._process.pid if self._process else None
```

### 3. `src/task_manager.py`

- `TaskWorker` 新增 `active_session_id: int | None = None`
- 删除 `_kill_orphan_ffmpeg()`，替换为 `_handle_orphan_sessions()`
- 新增 `_pid_is_ffmpeg()` 静态方法
- 新增 `_orphan_monitor()` 方法
- `__init__` 改为调用 `_handle_orphan_sessions()`
- `_recover_running_tasks` 跳过有活跃孤儿 session 的任务
- `_task_worker` 录制前创建 RecordingSession，录制结束后更新

### 4. `src/ui/app.py`

- 新增 GET `/api/tasks/{task_id}/sessions` 接口
- `_serialize_task` 新增 `has_orphan` 字段

### 5. `src/ui/static/index.html`

- 列表页任务行状态列追加孤儿告警 badge
- 详情页新增"录制会话历史"折叠区块，在 loadTaskDetail 时加载

---

## 验证方式

1. 启动任务，开始录制后重启服务器
2. 重启后打开 UI：任务状态仍显示 running，任务行出现"孤儿"badge
3. 详情页"录制会话历史"折叠区显示 orphan 状态的会话记录
4. 等待孤儿 ffmpeg 自然结束（或手动 kill），badge 消失，会话状态变 stopped，end_reason=orphan_died
5. 正常停止任务时，最新 session end_reason=user_stop
6. 直播自然断开时，end_reason=stream_end
7. 服务器重启时 PID 已不存在，session 状态=stopped, end_reason=server_restart
