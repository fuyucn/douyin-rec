# Plan 006: 抖音弹幕录制 + Bilibili XML 输出

## 状态：已实现 ✅

## 目标

在 video-screenshot 现有录制流程中增加弹幕录制能力：
- 与视频录制同步启停，共用 `RecordingSession.started_at` 对齐时间轴
- 输出 Bilibili XML 格式，供视频合并后一起上传 B 站

**不做**：视频录制（已有）、ASS 烧录、自动上传。

---

## 来源说明

弹幕采集层直接复制自 `/Users/yuf/Developer/DanmakuRender`（已验证可用）：

| 复制来源 | 目标位置 | 说明 |
|---------|---------|------|
| `DMR/LiveAPI/danmaku/douyin/__init__.py` | `src/danmu/client.py` | WebSocket 连接 + Protobuf 解析 |
| `DMR/LiveAPI/danmaku/douyin/dy_pb2.py` | `src/danmu/dy_pb2.py` | Protobuf 生成文件，勿手动修改 |
| `DMR/LiveAPI/danmaku/douyin/webmssdk.js` | `src/danmu/webmssdk.js` | 抖音签名用 JS |
| `DMR/LiveAPI/danmaku/douyin/utils.py` | `src/danmu/ws_utils.py` | 签名工具 (DouyinDanmakuUtils) |
| `DMR/LiveAPI/douyin.py` 中 `douyin_utils` 类 | `src/danmu/douyin_utils.py` | get_headers / build_request_url |

复制后需要修改 import 路径（去掉 `DMR.*` 前缀），其他逻辑不变。

---

## 新增文件结构

```
src/danmu/
├── __init__.py
├── dy_pb2.py           # 复制自 DMR（protobuf 生成）
├── webmssdk.js         # 复制自 DMR（签名 JS）
├── douyin_utils.py     # 复制自 DMR（get_headers / build_request_url）
├── ws_utils.py         # 复制自 DMR（DouyinDanmakuUtils）
├── client.py           # 复制自 DMR（Douyin WebSocket 客户端），修改 import
├── recorder.py         # 新写：封装 client，对接 TaskManager 启停
└── xml_writer.py       # 新写：弹幕队列 → Bilibili XML
```

---

## 时间对齐逻辑

```
video_offset = danmu_wall_time - RecordingSession.started_at - cdn_delay_sec
```

- `RecordingSession.started_at`：ffmpeg 开始录制的时刻（已存入 DB，即视频 t=0 的挂钟时间）
- `cdn_delay_sec`：CDN 推流延迟补偿，默认 **6s**（源自 DMR `dm_delay_fixed`，经实测有效）
- 用户合并所有 `.ts` 分段后，时间轴连续，`video_offset` 直接对应合并视频的播放位置
- 负值弹幕（录制启动前到达的）直接丢弃

---

## 弹幕输出格式

只录制两种消息类型：

| 类型 | XML text 内容 |
|------|-------------|
| 文字弹幕 (`WebcastChatMessage`) | `用户名: 弹幕内容` |
| 礼物 (`WebcastGiftMessage`) | `用户名: 送了 N 个礼物名` |
| 进场 (`WebcastMemberMessage`) | **跳过，不写入** |

### Bilibili XML 格式

```xml
<?xml version="1.0" encoding="UTF-8"?>
<i>
  <chatserver>chat.bilibili.com</chatserver>
  <chatid>0</chatid>
  <mission>0</mission>
  <maxlimit>100000</maxlimit>
  <state>0</state>
  <real_name>0</real_name>
  <source>k-v</source>
  <!-- p属性: 视频时间(s), 模式(1=滚动), 颜色(十进制), Unix时间戳, uid, 0, 0 -->
  <d p="10.5000,1,16777215,1698372000,0,0,0">张三: 主播加油</d>
  <d p="15.2000,1,16777215,1698372006,0,0,0">李四: 送了 50 个玫瑰花</d>
</i>
```

---

## DB 变更

### RecordingTask 新增字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enable_danmu` | `bool` | `False` | 是否录制弹幕 |
| `danmu_cdn_delay` | `int` | `6` | CDN 延迟补偿秒数 |

自动迁移：`_migrate_db()` 已有 `ALTER TABLE` 机制，新增两行即可。

---

## 新文件实现要点

### `src/danmu/recorder.py`

```python
class DanmuRecorder:
    """弹幕录制器：在独立线程中运行 asyncio 事件循环"""

    def __init__(self, url: str, started_at: datetime, output_xml: Path,
                 cdn_delay: int = 6, cookies: str | None = None): ...

    def start(self) -> None:
        # 启动后台线程，运行 asyncio.run(_run())
        # _run() 连接 WebSocket，把 SimpleDanmaku/GiftDanmaku 放入 queue
        # 消费 queue，计算 video_offset，写入 XmlWriter

    def stop(self) -> None:
        # 设置 stop event，等待线程退出，调用 xml_writer.close()
```

### `src/danmu/xml_writer.py`

```python
class XmlWriter:
    """流式写入 Bilibili XML 弹幕文件"""

    def open(self, path: Path) -> None: ...  # 写文件头
    def add(self, dm: SimpleDanmaku) -> None: ...  # 追加一条 <d>
    def close(self) -> None: ...  # 写 </i>，关闭文件
```

---

## TaskManager 集成

### `_task_worker` 改动

```python
# 启动录制后（已有）
recorder.start()
worker.recording_started_at = datetime.now()
# 创建 RecordingSession（已有）...

# 新增：启动弹幕录制
danmu_recorder = None
if task.enable_danmu and task.enable_record:
    xml_path = storage.output_dir / f"{display}_danmu.xml"
    danmu_recorder = DanmuRecorder(
        url=task.url,
        started_at=worker.recording_started_at,
        output_xml=xml_path,
        cdn_delay=task.danmu_cdn_delay,
        cookies=task.cookies,
    )
    danmu_recorder.start()
    log(f"弹幕录制已启动 → {xml_path.name}")

# 停止时（已有 recorder.stop() 之后）
if danmu_recorder:
    danmu_recorder.stop()
    log("弹幕已保存")
```

### Web UI 改动

- 创建任务表单增加 `enable_danmu` 复选框（默认关）
- 任务详情卡片显示 danmu 状态

---

## 新增依赖

```toml
# pyproject.toml 新增
aiohttp = ">=3.8"
google-protobuf = ">=4.21"
jsengine = ">=0.1"   # 可选，签名失败时 fallback 到 0（不影响连接）
```

---

## 实现顺序

1. 复制 DMR 文件，修改 import（30 分钟）
2. 实现 `xml_writer.py`（XmlWriter）
3. 实现 `recorder.py`（DanmuRecorder），跑通独立测试
4. DB 迁移字段 + TaskManager 集成
5. Web UI 复选框（`index.html`）

---

## 实际实现（与原计划差异）

- 输出格式改为 **ASS**（非 XML），因 B 站弹幕 XML 批量上传对普通账号不开放
- 复用了 DMR 的 `AssWriter` 和 `Douyin` WebSocket 客户端
- 依赖：`protobuf>=4.23`（非 `google-protobuf`）、`aiohttp>=3.9`
- `jsengine` 为可选依赖（签名失败 fallback 到 0，不影响连接）

## 注意事项

- `client.py` 中签名 (`jsengine`) 失败时默认 `signature=0`，实测抖音不强验，连接仍可成功
- `danmu_cdn_delay` 可在任务详情页调整；回放后若发现弹幕偏移，修改此值重新生成 XML
- XML 写入用追加模式（`open(..., 'a')`），中途崩溃仍保留已录弹幕；`close()` 补写 `</i>`
- 礼物连击（combo 未结束）跳过，仅记录 `repeatEnd`（已在 DMR 原代码中处理）
