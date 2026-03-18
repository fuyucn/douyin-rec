# Plan 013: DLR 智能重连

## 背景

DLR 内部 ffmpeg 在同一进程内第二次启动时 rc=-11（SIGSEGV，fork-safety 问题）。
已有修复（Plan 007 延伸）：检测 `直播录制出错`/`直播录制完成` → break 监控循环 → kill DLR → 重启。

但当前重连间隔过长：

```
出错 → kill DLR (最多10s) → 重新进入30s轮询 → 启动新DLR
```

**最小间隔 ~40s**，对 rc=-11 + CDN断流场景损失过多内容。

## 目标

出错/完成时立刻查一次直播状态，在线就直接启动新 DLR，不等 30s 轮询：

```
出错/完成 → kill DLR → 立刻查状态
    ├── 在线 → 立刻启动新 DLR（间隔 <5s）
    └── 离线 → 进入正常 30s 轮询
```

## 实现

### 修改 `src/task_manager.py`

在监控循环的 `_dlr_stream_ended_ref[0]` 检测处，设置一个 `_dlr_error_restart` 标志区分原因：

```python
# 在 _dlr_stream_ended_ref 旁边新增：
_dlr_quick_restart_ref: list[bool] = [False]  # 出错时置 True → 跳过首次轮询等待
```

在 `log()` 回调中：

```python
if '[DLR]' in msg and '直播录制出错' in msg:
    _dlr_stream_ended_ref[0] = True
    _dlr_quick_restart_ref[0] = True   # 出错 → 快速重连
if '[DLR]' in msg and '直播录制完成' in msg:
    _dlr_stream_ended_ref[0] = True
    _dlr_quick_restart_ref[0] = True   # 完成也快速检查一次（可能是CDN中断）
```

在 `launcher.stop()` 之后、进入等待开播循环之前，插入快速检查：

```python
if _dlr_quick_restart_ref[0] and not worker.stop_event.is_set():
    _dlr_quick_restart_ref[0] = False
    log("[检测] 录制中断，立刻检查直播状态...")
    try:
        from src.input.douyin_spider import get_douyin_stream_data
        data = asyncio.run(get_douyin_stream_data(task.url, cookies=cookies))
        if data.get('status') == 2:
            anchor = data.get('anchor_name', '')
            title = data.get('title', '')
            desc = f"{anchor}" + (f" 《{title}》" if title else "")
            log(f"[检测] ✓ 直播仍在线: {desc}，立刻重启 DLR")
            continue  # 直接跳到本次 while 循环顶部 → 启动新 DLR
        else:
            log("[检测] 直播已离线，进入轮询等待...")
    except Exception as e:
        log(f"[检测] 状态查询失败: {e}，进入轮询等待...")
# 否则 fall through 到正常 30s 轮询
```

## 关键文件

| 操作 | 文件 |
|------|------|
| 修改 | `src/task_manager.py` |

## 验证

1. 任务运行中，手动用 `kill -11 <ffmpeg_pid>` 模拟 rc=-11
2. 观察日志：应在 <5s 内出现"立刻重启 DLR"
3. 确认新 DLR 进程启动并恢复录制
