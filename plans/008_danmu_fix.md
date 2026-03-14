# Plan 008: 修复抖音弹幕录制

## 问题根因

`src/danmu/` 代码与 bililive-tools 的 DouYinDanma 实现逻辑相同，但有以下问题：

1. **jsengine 不稳定**：用 Python `jsengine` 库跑 499KB 混淆 JS (`webmssdk.js`)，执行环境不可靠，经常失败或 crash，fallback 到 sig=0 导致 WS 认证失败
2. **参数过期**：WS host / sdk version 与 bililive-tools 当前版本不一致
3. **签名 fallback 错误**：我们返回整数 `0`，bililive-tools 返回字符串 `"00000000"`
4. **不必要的 a_bogus**：WS 连接不需要 a_bogus，增加复杂度和出错点
5. **task_manager 未接入**：DLR 迁移时删除了弹幕逻辑，只剩 DB 字段

## 修复方案

### Step 1: 更新 webmssdk.js
从 bililive-tools 仓库拉取最新版 `webmssdk.js`（v1.0.15 对应版本），替换 `src/danmu/webmssdk.js`

### Step 2: 改用 Node.js 子进程执行签名
**文件**: `src/danmu/ws_utils.py`

将 `get_signature()` 从 jsengine 改为 Node.js 子进程：
```python
def get_signature(x_ms_stub: str) -> str:
    js_path = os.path.join(_DIR, 'webmssdk.js')
    script = f"const get_sign=require('{js_path}');console.log(get_sign('{x_ms_stub}'))"
    # 或 inline eval 方式
    result = subprocess.run(['node', '-e', js_code], capture_output=True, text=True, timeout=5)
    return result.stdout.strip() or "00000000"
```

Fallback: Node.js 不可用时返回 `"00000000"`（字符串，对齐 bililive-tools）

### Step 3: 更新 ws 连接参数
**文件**: `src/danmu/client.py`

- `webcast_sdk_version`: `"1.0.14-beta.0"` → `"1.0.15"`
- WS host: `webcast5-ws-web-lf.douyin.com` → `webcast100-ws-web-hl.douyin.com`
- 移除 `build_request_url()`（WS URL 不需要 a_bogus）
- 签名 fallback: `0` → `"00000000"`

### Step 4: 新增 _DanmuWorker 类
**文件**: `src/task_manager.py`

在 `LocalVideoWorker` 后新增 `_DanmuWorker` 类（asyncio.run in daemon thread）：
- `start()` → 启动 daemon thread
- `stop()` → 停止 loop + join thread
- `_async_main()` → DouyinDanmakuClient + AssWriter
  - `ass_path.parent.mkdir()` 防 DLR 还没建目录
  - consume loop: `Queue.get()` → 扣 cdn_delay → `writer.add()`
  - `finally: writer.close()`

### Step 5: 接入 _task_worker
**文件**: `src/task_manager.py`

计算 ASS 输出路径（与 DLR 录制目录一致）：
```python
display_name = task.custom_name or task_dir_name(task_id, task_name)
recording_dir = self._output_dir.resolve() / "抖音直播" / display_name
ass_path = recording_dir / f"{display_name}_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.ass"
```

DLR 生命周期内：
```
launcher.start()
if enable_danmu → danmu_worker.start()
try:
    while DLR running...
finally:
    launcher.stop()
    danmu_worker.stop()   ← 弹幕失败不影响录制
```

## 文件变更

| 文件 | 操作 |
|------|------|
| `src/danmu/webmssdk.js` | 替换为 bililive-tools 最新版 |
| `src/danmu/ws_utils.py` | jsengine → Node.js subprocess |
| `src/danmu/client.py` | 更新 host/version/fallback，移除 a_bogus |
| `src/task_manager.py` | 新增 `_DanmuWorker`，接入 `_task_worker` |

## 依赖要求

- Node.js（系统已安装，用于 webmssdk.js 签名）
- 移除 `jsengine` 依赖（可选）

## 验证

1. `uv run pytest tests/ -v` 全部通过
2. 启动任务（enable_danmu=True），检查 ASS 文件生成
3. 开播后确认弹幕写入 ASS，与视频时间轴对齐
