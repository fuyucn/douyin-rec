# plans/041 — 直播统计 tab（Stats）

关联：issue [#443](https://github.com/fuyucn/douyin-rec/issues/443) → PR [#444](https://github.com/fuyucn/douyin-rec/pull/444)；台账条目 T-134。

## Goal

master 在 hub 对账时把各节点的录像会话（直播间、起止、时长、缺口、弹幕数、字节、标题）落进 `<root>/db/room-stats.db`，Web UI 新增 `/stats` 页展示：跨节点去重的在播时长/场次、典型开播整点、7×24 热力图（设置时区整点切片）、节点负载（含峰值并发）、配置维度总览（上传模式/输出格式/平台/引擎/弹幕）。

## Architecture

- `packages/app/src/room-stats.ts`：`room-stats.db`（WAL、`sessionBase` 主键、startMs MIN/endMs MAX 合并、120 天保留同事务、坏行跳过）+ `buildStats()` 纯聚合（跨节点 10 分钟容差合并、按设置时区切整点、`Intl.DateTimeFormat` 按时区缓存）。
- `packages/orchestrator` reconciler：`observeInventory` 旁路钩子（异常吞掉，unreachable/empty 节点跳过）。
- `packages/cli`：hub 启动注入 `recordRoomSessions(rootStatsDbPath(), …)`。
- `packages/core`：`Stats*DTO` 契约（api-types.ts）。
- `packages/app/web/api/stats.ts`（`GET /api/stats?days=N`）+ `packages/web`（`/stats` 页）。

## Global Constraints

- 采集/聚合/统计失败一律不抛到对账/录制/上传主流程（旁路；采集 0 行合法）。
- 统计库路径 = `<drecRoot>/db/room-stats.db`，仅经 paths 模块 `rootStatsDbPath()`，不手拼。
- 时区口径 = 设置时区（core `effectiveTimezone`/`zonedStamp`），不看宿主机本地时区。
- 主键 = `(workerId, platform, roomSlug, sessionBase)`；Node 侧 scan 必带 sessionBase。

## Tasks（已落地）

- [x] 库 + 聚合 + API + 前端 + 导航/i18n
- [x] 回归测试 `room-stats.test.ts` / `stats-api.test.ts` / `stats-observe.test.ts`
- [x] 独立 review（expert/Opus 5.5）：sessionBase 主键、坏行过滤、读失败 5xx、归属判定 isWorkerAssigned、maxNodes 跨节点冗余、Intl formatter 缓存

## 残余风险

- 「上传模式/输出模式」为配置时读取，不回溯历史。
- 在播时长未扣除会话内断流缺口（`gapSec` 已存未用）——后续可在聚合层扣减。
- rolling/节点侧上传删源模式：采集 `endMs` 最多早一个对账周期。
- 采集是同步 sqlite（busy_timeout 2s），跑在对账循环里；风险低。
