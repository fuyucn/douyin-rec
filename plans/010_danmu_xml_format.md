# Plan 010: 弹幕 XML 格式 — 全量记录 + 后处理合并

## 背景

现有 ASS 格式的局限：
- 只能记录 chat / gift，入场提醒（member）等完全丢弃
- 碰撞检测会丢弃部分弹幕（密集时段）
- 无结构化元数据（uid、礼物价格、服务端时间戳）
- 合并时需要 ffprobe 量视频时长推算偏移

改为**双写**：ASS 继续用于视频渲染（不动），同时并行写 XML sidecar 存全量数据。
合并时以 XML 为主数据源，重新生成 ASS 后烧录。

---

## XML 格式设计

### 文件命名

与 ASS 文件同名同目录，扩展名 `.xml`：

```
task42_MiiiX大鹏_2026-03-14_17-18-01_000.xml
task42_MiiiX大鹏_2026-03-14_17-18-01_001.xml
```

### 文件结构

```xml
<?xml version="1.0" encoding="utf-8"?>
<danmaku
  record_start="1773532685.123"
  session="2026-03-14_17-18-01"
  seg_idx="0"
>
  <!-- type=chat -->
  <d t="1.57" type="chat" uid="123456" uname="五月💫" color="ffffff">爱豆和飞总差多高啊</d>

  <!-- type=gift -->
  <d t="60.0" type="gift" uid="789" uname="土豪" gift="舰长" count="1" price="198.0" color="ffaa00">土豪: 送了 1 个 舰长</d>

  <!-- type=member（入场提醒） -->
  <d t="90.0" type="member" uid="111" uname="新粉丝" member_count="1234">新粉丝 进入直播间</d>
</danmaku>
```

### 字段说明

**根节点属性**：

| 属性 | 说明 |
|------|------|
| `record_start` | 分段录制开始的 Unix 时间戳（秒，浮点），= `seg_start` |
| `session` | 会话时间戳字符串，与视频文件名一致 |
| `seg_idx` | 分段索引（0-based） |

**`<d>` 属性**：

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `t` | float | ✅ | 相对于 `record_start` 的秒数 |
| `type` | str | ✅ | `chat` / `gift` / `member` |
| `uid` | str | ✅ | 用户 ID |
| `uname` | str | ✅ | 用户名 |
| `color` | str | chat/gift | 颜色 hex，无 `#` |
| `gift` | str | gift | 礼物名 |
| `count` | int | gift | 数量 |
| `price` | float | gift | 单价（抖音币 / 10 = 元） |
| `member_count` | int | member | 当前在线人数 |

文本内容 = 显示文本（可选，便于直接阅读）。

---

## 实现步骤

### Step 1：新建 `src/danmu/xml_writer.py`

```python
class XmlWriter:
    def open(self, path: Path, record_start: float, session: str, seg_idx: int) -> None:
        """写文件头 + 根节点开标签"""

    def add(self, item: SimpleDanmaku) -> None:
        """追加一条 <d> 行（所有类型，不做碰撞过滤）"""

    def close(self) -> None:
        """写根节点闭标签"""
```

流式追加写入（与 AssWriter 一致，不在内存中积累）。

`add()` 接受 `SimpleDanmaku` / `GiftDanmaku` / `MemberDanmaku`，按 `dtype` 输出对应属性。

### Step 2：`src/danmu/client.py` — 补 MemberDanmaku

```python
elif msg.method == 'WebcastMemberMessage':
    member = MemberMessage()
    member.ParseFromString(msg.payload)
    d = json_format.MessageToDict(member, preserving_proto_field_name=True)
    event_time = int(d.get('eventTime', 0))
    ts = float(event_time) if event_time > 1_000_000_000 else now
    name = d.get('user', {}).get('nickName', '')
    uid = str(d.get('user', {}).get('id', ''))
    member_count = d.get('memberCount', 0)
    msgs.append(MemberDanmaku(
        timestamp=ts, uname=name, uid=uid,
        member_count=member_count,
        content=f'{name} 进入直播间',
    ))
```

同时在 `SimpleDanmaku.__init__` 里加 `uid` 字段（`kwargs` 已支持，只需传参）。

### Step 3：`src/task_manager.py` — `_DanmuWorker` 双写

`_open_writer()` 中同时打开 XML：

```python
def _open_writer() -> None:
    nonlocal seg_start, open_ts, writer_opened
    seg_start = ...
    open_ts = ...
    ass_writer.open(self._seg_path(open_ts, seg_idx, '.ass'))
    xml_writer.open(self._seg_path(open_ts, seg_idx, '.xml'), seg_start, open_ts, seg_idx)
    # 回放缓冲区
    for buffered in pre_buffer:
        buffered.time = self._item_time(buffered, seg_start)
        xml_writer.add(buffered)              # 所有类型写 XML
        if buffered.dtype in ('chat', 'gift'):
            ass_writer.add(buffered)          # 只有 chat/gift 写 ASS
    pre_buffer.clear()
    writer_opened = True
```

分段切换时同步关闭/打开两个 writer。

`_seg_path()` 加 `ext` 参数（默认 `.ass`，传 `'.xml'` 生成 XML 路径）。

### Step 4：`tools/merge_recording.py` — XML 合并 + XML→ASS 转换

#### 4a. 合并 XML

```python
def merge_xml_files(xml_files: list[Path], out_path: Path) -> None:
    """
    按各分段 record_start 计算偏移，将 <d> 的 t 属性加偏移后写入合并文件。
    偏移 = xml_files[i].record_start - xml_files[0].record_start
    """
```

不再需要 ffprobe，精度更高。

#### 4b. XML → ASS（合并后烧录前）

```python
def xml_to_ass(xml_path: Path, ass_path: Path,
               types: set[str] = {'chat', 'gift'},
               **ass_kwargs) -> None:
    """
    读合并后的 XML，按 types 过滤，用 AssWriter 重新渲染为 ASS。
    默认只渲染 chat + gift（不渲染 member，入场提醒太密集影响观看）。
    支持 --danmu-types 参数覆盖。
    """
```

#### 4c. 主流程变化

```
原来：合并 ASS（ffprobe 偏移） → 合并 TS → 烧录 ASS
现在：合并 XML（record_start 偏移） → XML→ASS（按类型过滤） → 合并 TS → 烧录 ASS
     （保留 ASS fallback：若无 XML 则退回原有 ASS 合并逻辑）
```

新增 CLI 参数：

```
--danmu-types   chat,gift,member（默认 chat,gift）
```

---

## 文件变化汇总

| 文件 | 操作 | 规模 |
|------|------|------|
| `src/danmu/xml_writer.py` | **新建** | ~80 行 |
| `src/danmu/client.py` | 加 MemberDanmaku 发射 | +15 行 |
| `src/danmu/models.py` | `uid` 字段显式化 | +5 行 |
| `src/task_manager.py` | `_DanmuWorker` 双写 + `_seg_path` 加 ext | +25 行 |
| `tools/merge_recording.py` | XML 合并 + XML→ASS + fallback | +80 行 |

ASS writer 完全不改，向后兼容。

---

## 验证

1. 录制一段（含聊天 + 礼物 + 入场），确认同时生成 `.ass` + `.xml`
2. 用 `merge_recording.py` 合并，确认：
   - XML 中入场时间戳正确（不全在 0 秒）
   - `--danmu-types chat` 烧录版不含礼物字幕
   - `--danmu-types chat,gift,member` 包含所有类型
3. 对比 XML 偏移 vs ffprobe 偏移，误差应 < 1s
