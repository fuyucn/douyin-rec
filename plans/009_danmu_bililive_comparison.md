# 弹幕实现对比：本项目 vs biliLive-tools DouYinDanma

参考文件：
- biliLive-tools: `packages/DouYinDanma/src/index.ts`, `packages/DouYinRecorder/src/index.ts`
- biliLive-tools: `packages/liveManager/src/record_extra_data_controller.ts`
- 本项目: `src/danmu/client.py`, `src/task_manager.py`

---

## 1. 时间戳对齐方式

### biliLive-tools

```typescript
// DouYinRecorder/src/index.ts
timestamp: this.useServerTimestamp ? Number(msg.eventTime) * 1000 : Date.now(),

// record_extra_data_controller.ts
const progress = Math.max((ele.timestamp - metadata.recordStartTimestamp) / 1000, 0);
// recordStartTimestamp = Date.now()（ffmpeg 开始录制时打一次）
```

公式：`progress = (eventTime_ms - recordStart_ms) / 1000`

### 本项目

```python
# client.py
ts = float(event_time) if event_time > 1_000_000_000 else now

# task_manager.py
def _item_time(self, item, seg_start):
    return item.timestamp - seg_start
# seg_start = sync_wall_time（DLR 日志 "准备开始录制视频" 触发时的本地时间）
```

公式：`progress = eventTime_sec - seg_start_local`

**结论**：本质相同。区别仅在 `recordStart` 的来源——biliLive-tools 直接在 ffmpeg 启动时打时间戳，本项目通过 DLR 日志回调间接获取，有毫秒级延迟（可忽略）。

---

## 2. 礼物消息的时间戳（差距）

### biliLive-tools

```typescript
// 礼物用 common.createTime，自动判断单位（秒/毫秒）
const serverTimestamp =
  Number(msg.common.createTime) > 9999999999
    ? Number(msg.common.createTime)      // 已经是毫秒
    : Number(msg.common.createTime) * 1000;  // 秒 → 毫秒
```

### 本项目

```python
# 礼物一律用本地接收时间，未使用 createTime
msgs.append(GiftDanmaku(timestamp=now, ...))
```

**问题**：聊天消息的 `createTime` 测试为 0，但礼物消息的 `common.createTime` 可能有值（未验证）。若有值，本项目的礼物时间戳精度不如 biliLive-tools。

---

## 3. 飘屏弹幕 (screenChat) 的 eventTime 单位（差距）

biliLive-tools 发现 `WebcastScreenChatMessage` 的 `eventTime` 单位是**纳秒**：

```typescript
// screenChat: eventTime / 1000000（纳秒 → 毫秒）
timestamp: this.useServerTimestamp ? Number(msg.eventTime) / 1000000 : Date.now(),

// 普通 chat: eventTime * 1000（秒 → 毫秒）
timestamp: this.useServerTimestamp ? Number(msg.eventTime) * 1000 : Date.now(),
```

本项目未处理 `WebcastScreenChatMessage`，如果日后添加需注意单位差异。

---

## 4. WebSocket 重连机制（差距）

### biliLive-tools

- `autoReconnect: 10`（最多重连 10 次）
- `reconnectInterval: 10000ms`（10s 后重连）
- `timeoutInterval: 100000ms`（100s 无消息自动重连）

### 本项目

WS 断开后直接抛 `RuntimeError`，外层 `_DanmuWorker` 停止整个弹幕任务，**不自动重连**。

---

## 5. 消息类型覆盖范围

| 消息类型 | biliLive-tools | 本项目 |
|----------|:-:|:-:|
| WebcastChatMessage（聊天弹幕） | ✅ | ✅ |
| WebcastGiftMessage（礼物） | ✅ | ✅ |
| WebcastMemberMessage（入场） | ✅ emit，不写弹幕 | ❌ 跳过 |
| WebcastLikeMessage（点赞） | ✅ | ❌ |
| WebcastSocialMessage（关注/分享） | ✅ | ❌ |
| WebcastRoomRankMessage | ✅ | ❌ |
| WebcastRoomStatsMessage | ✅ | ❌ |
| WebcastScreenChatMessage（飘屏） | ✅ | ❌ |
| WebcastControlMessage（下播信号） | ❌ | ✅ |

---

## 6. WS URL 参数差异（无影响）

biliLive-tools 额外附加 `browser_language`, `browser_platform`, `browser_name`, `browser_version`，本项目无这些参数。实测连接正常，服务端非必须。

---

## 待改进项（优先级排序）

1. **WS 自动重连**（高）— 直播时长通常数小时，连接偶尔断开后应自动恢复
2. **礼物 createTime 验证**（中）— 确认 GiftMessage 的 `common.createTime` 是否有效，有效则改用服务端时间
3. **screenChat 飘屏弹幕**（低）— 注意 eventTime 单位为纳秒（`/ 1_000_000`）
