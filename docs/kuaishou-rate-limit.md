# 快手直播页限流(风控)问题记录

记录 2026-09-23~24 的「任务 57 开播没录」排查结论与修复。

> **2026-10-06 更新**:取流已改为 **`livedetail` API 优先、页面刮取兜底**(见下「修复 2」)。
> 页面那条路径仍是风控重灾区,新代码正常情况不再走它。

## 症状

- 快手任务 57（`live.kuaishou.com/u/myhx123456789`）状态 running，但主播开播后一直「等待开播」，不录制。
- 本地浏览器打开同一房间也显示「请求过快，请稍后重试」；手机流量（不同出口 IP）正常。

## 结论

快手**直播间页面接口按出口 IP 限流**，阈值很低：录制器原先 30s 轮询一次开播（约 2880 次/天），**约 40 次请求即触发**风控。

- 实测：本机、容器、带登录 cookie 的请求都返回 `errorType.type=2`；VPS（另一 IP 段）同一时刻返回 `isLiving: true`。
- 与账号、cookie、房间号无关，换 IP 即可绕过 —— 属 IP 级限流。
- 触发后页面仍返回 HTTP 200，只是 `playList[0]` 里带 `errorType`、`isLiving=false`，所以旧代码会把它当作「主播没开播」，静默漏录。

## 修复

1. **平台级轮询间隔**（`packages/core/src/platform.ts` 的 `Platform.pollIntervalMs`）：快手设为 **5 分钟**；其余平台保持 30s。平台可用它表达「这个接口经不起高频轮询」。
2. **风控显式透出**（`packages/kuaishou-live/src/stream/index.ts`）：`errorType` → `PlatformStream.throttledReason`；录制器据此打印
   `平台风控:请求过快，请稍后重试 —— 5 分钟一探(冷却期少打扰平台;解除前若在播会漏录)` 并把轮询降频到 `THROTTLE_POLL_MS`，
   解除后自动恢复。
3. **master 本机抑制**（`packages/app/src/daemon.ts` + `hub-store.localSuppressedSourceTaskIds`）：
   hub 规则把源任务交给远端节点（`workers` 不含 `local`）时，master 本机的源任务只当**配置模板**，daemon 不再实跑它 ——
   既避免本机持续轮询把 IP 刷进黑名单，也避免两个节点重复录制。

## 修复 2:改用 `livedetail` API(2026-10-06)

对照 [biliup 的 kuaishou 实现](https://github.com/biliup/biliup/blob/v1.2.11/crates/biliup/src/downloader/live/kuaishou.rs)，
我们原先「只刮页面」是本项目最大的结构性劣势 —— 页面接口限流紧、payload 59KB、依赖前端 SSR。

快手实际有**匿名可访问的 JSON 接口**（已实测 200,未开播也返回结构化数据）：

```
GET https://live.kuaishou.com/live_api/liveroom/livedetail?principalId={userId}
→ {"data":{"result":…,"liveStream":{"caption","playUrls":{"h264":{"adaptationSet":{"representation":[…]}}},"author":{"living":…,"name":…}}}
```

改动（`packages/kuaishou-live`）：

1. **API 优先、页面兜底**：`getStream` / `getLiving` 先走 `livedetail`；只有**请求本身失败**（网络/JSON 解析）
   才回退页面刮取。平台明确答复「没在播」不再回退（那是权威结论，回退只是白花一次 59KB 请求）。
2. **warmup 反爬**：每次取流前先 GET 快手首页 + 随机等 3~4s（同 biliup `warmup`）。
   真实用户进直播间必然先过首页,直接打 `/u/{id}` 在行为特征上更像爬虫。
3. **判活以「拿到可播流」为准**,不依赖 `result` 内部码（离线实测为 2,biliup 按 1/22/671 分支,但这些码未公开）。
   离线时 `liveStream.url` 是 `.../live/undefined` 占位且 `playUrls` 为空对象 → 天然判不出流。
4. **画质不变**:仍按 bitrate 阈值选 6 档(h264 → hevc → HLS)。这点我们比 biliup 精细
   （biliup 直接取 `representation.last()`,无画质参数）。
5. **附带拿到 `caption`(直播标题)**,经 `PlatformStream.title` 透出,可用于产物命名。
6. **URL 形式扩展**:`/u/` `/profile/` `/fw/live/` 三种路径 + `*.m.chenzhongtech.com` 企业号域名(同 biliup)。

预期收益：正常轮询走几 KB 的 API 而非 59KB 页面,触发风控的概率显著下降;
真被限流时还有页面路径兜底,不会因为 API 改版而彻底漏录。

**待验证**:目前只验证到「离线房间」的真实响应;**「在播」分支尚未用真实开播房间验证过**
(测试环境无可播的快手房间,相关单测用的是构造样本)。下次快手任务开播时应确认能正常取到流。

## 验证

- VPS 取页 `isLiving: true`、本机返回风控页 → 确认是 IP 维度。
- 冷却 10 小时（停任务、本地零请求）后，本机页面不再返回「请求过快」，任务 57 恢复 enabled 并按 5 分钟轮询，开播后自动录制。
- VPS 侧日志可见降频提示：`平台风控:请求过快，请稍后重试 —— 5 分钟一探…`。

## 运营注意

- 被限流后**继续高频请求会延长冷却**；最快恢复方式是停掉该平台的轮询几小时。
- hub 规则的 `workers` 决定「谁录」：只在 `local` 时本机实跑；只勾远端时本机自动让位。
