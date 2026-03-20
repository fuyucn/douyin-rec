# Plan 012: 弹幕布局重设计 — 顶部横向 + 左下聊天面板

## 背景

当前 AssWriter 把所有弹幕类型（danmaku/gift/member）统一用横向滚动渲染，
覆盖范围占屏幕高度 40%，严重遮挡视频画面。

## 目标布局

```
┌────────────────────────────────┐
│  → 弹幕横向滚动（顶部 20%）→   │  ← AssWriter 约束到顶部
│                                │
│                                │
│                 （主视频画面）  │
│                                │
│  🎁 土豪送了5个飞机             │  ← ChatPanelWriter
│  👋 用户A 进入直播间           │    从底部向上滚动
│  🎁 打赏666礼物                │    消失于底部 70% 处
└────────────────────────────────┘
```

## 区域划分

| 区域 | 位置 | 内容 |
|------|------|------|
| 横向滚动 | 顶部 0–20% 高度 | `danmaku` 聊天弹幕 |
| 聊天面板 | 左下，70%–100% 高度，左 40% 宽 | `gift` + `member` |

## 改动范围

| 文件 | 改动 |
|------|------|
| `src/danmu/ass_writer.py` | 调整默认参数：`dmrate=0.20`，`dst=0`，轨道限制在顶部 20% |
| `src/danmu/chat_panel_writer.py` | **新建**，批量生成底部左侧聊天面板 ASS 事件 |
| `src/merge/merger.py` | danmaku→AssWriter，gift+member→ChatPanelWriter，合并写入同一 .ass |

## ChatPanelWriter 设计

```
参数：
  panel_x       = 20px（左边距）
  panel_bottom  = 1.0 * height（底部）
  panel_top     = 0.70 * height（消失线，距底部 30%）
  scroll_speed  = 50px/s
  duration      = (panel_bottom - panel_top) / speed = 0.30*height/50

每条消息 ASS 事件：
  \move(panel_x, panel_bottom, panel_x, panel_top)
  start = item.time
  end   = item.time + duration

视觉效果：
  message t=0s → 从底部滚到 70% 处消失，耗时 duration
  message t=3s → 同路径，比前一条晚 3s，自然错开 150px
```

### 前缀图标
- `gift`：`🎁 {uname} 送了 {count} 个 {gift_name}`
- `member`：`👋 {uname} 进入直播间`

### ASS Style 定义
```
Style: Chat,{font},{fontsize},&H{opacity}FFFFFF,...,Alignment=1（左对齐）
```

## AssWriter 参数调整

```python
# 旧默认值
dmrate=0.4, dst=60

# 新默认值
dmrate=0.20   # 只用顶部 20% 高度
dst=0         # 从顶部开始，无额外偏移
```

## merger.py 合并逻辑变化

```python
# 旧：所有弹幕 → AssWriter
ass_writer.add(item)  # danmaku/gift/member 全部

# 新：分流
if item.dtype == 'danmaku':
    ass_writer.add(item)          # 横向滚动
else:
    chat_items.append(item)       # 收集 gift/member

# 写完所有段后，ChatPanelWriter 批量追加到同一 .ass 文件
chat_writer.write(chat_items, ass_path)
```
