# Plan 014: 弹幕2 直播间聊天框样式烧录

## 背景

用户希望在常规 R2L 弹幕之外提供另一种弹幕烧录风格：复刻抖音直播间左下角聊天框，消息从底部一条一条堆叠上来。

## 实现方案

### 核心文件

| 文件 | 变更 |
|------|------|
| `src/danmu/live_chat_writer.py` | **新建** LiveChatWriter 类 |
| `src/merge/merger.py` | 新增 merged_ass2/merged_danmu2_mp4 属性 + do_danmu2 参数 |
| `src/ui/app.py` | merge 接口新增 burn_danmu2 参数 |
| `src/ui/static/index.html` | 分段列表新增"弹幕2"按钮 |

### LiveChatWriter 设计

**面板布局（默认 1920×1080）：**
- 横向：左侧 2%–42%（panel_x=38, panel_right=806）
- 纵向：75%–95%（panel_top=810, panel_bottom=1026，约 216px 高）
- max_visible = 6 行（216px / 32px line_h）

**堆叠算法：**
```
对每条消息 i（时间 t_i）：
  for k in range(max_visible):
    j = i + k                    # 触发 rank k 的消息索引
    seg_start = items[j].time    # rank k 开始时刻（k=0 = 消息本身出现）
    seg_end = min(items[j+1].time, expire)
    y = panel_bottom - line_h * (k + 1)   # \an1 锚点，向上偏移
    emit Dialogue with \pos(x, y)
```

**关键 ASS 标签：**
- `\an1`：左下角锚点，y 为文字底边
- `\pos(x, y)`：静态定位（不滚动）
- `\clip()`：限制渲染到面板区域
- `_tag_emoji()`：emoji 字符加 `\fn Noto Emoji` 标签

**遵守 danmu_types：** 与常规弹幕一样，默认只含 `danmaku` + `gift`，不含 `member`（入场消息太多，影响性能）

### 输出文件

- `{prefix}_livechat.ass`：独立生成，不附加到 danmu.ass
- `{prefix}_livechat.mp4`：独立烧录，不影响 `_danmu.mp4`

### UI 操作

分段详情中"弹幕2"按钮（secondary 色），独立于"烧录弹幕"按钮。

## 性能说明

烧录耗时约等于常规弹幕：libass CPU 渲染是瓶颈，VideoToolbox 只负责 H.264 编码。
堆叠算法每条消息生成最多 max_visible 个 Dialogue 事件，总事件数约 N×6。

## Commit

`d78fde3` feat: 弹幕2 直播间聊天框样式烧录
