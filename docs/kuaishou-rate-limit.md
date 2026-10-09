# 快手直播页限流(风控)问题记录

记录 2026-09-23~24 的「任务 57 开播没录」排查结论与修复。

> **2026-10-08 重要修正 —— 见文末「修复 3」**:2026-10-06 的「API 优先」方向是**错的**,
> `livedetail` API **已被平台下线**(对任意 id 都返回同一桩数据),据此判「未开播」导致**全节点漏录**。
> 现改为**页面优先、API 仅兜底**,并对持续风控**递进退避**。

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

---

## 修复 3:`livedetail` 已下线 → 改回「页面优先」+ 递进退避(2026-10-08)

### 真凶(与 IP 无关,影响所有节点)

2026-10-06 的「API 优先」建立在一个**当时就不成立的假设**上:以为 `livedetail` 是权威数据源。
2026-10-08 实测证明该接口**已被平台下线**:

```
GET /live_api/liveroom/livedetail?principalId={任意值}
→ {"data":{"result":2,"liveStream":{"playUrls":{"h264":{},"hevc":{}},"url":".../live/undefined"},
   "author":{"living":false,...}}}   # 634 字节
```

- 对**真房间号 / 主播 id(`donghaogege`) / 不存在的乱码 id / 完全不带参数** → 返回**逐字节相同**
  (去掉 `timestamp` 后)的桩数据。即「`result:2` / `living:false`」**与是否在播无关**,是下线占位。
- 旧 `getStreamViaApi` 只要 `data` 存在就返回 `{living:false}`(非 null)→ `getStream` 立即返回,
  **永不回退页面**;`getLiving` 同理返回 `false`(不抛错,连失败告警都绕过)。
- **后果:任何节点(含 IP 完全干净的 VPS1/VPS2)都录不到快手直播**,任务一直「等待开播」。
  这是任务 75 漏录的根因,不是限流。

同一时刻,页面 SSR 路径(`GET /u/{id}`)是**好的**:干净出口实测返回完整 `playUrls`
(`h264` `bitrate:2000` → `hw-origin.pull.yximgs.com/...flv`),且该流可拉(`HTTP 200 video/x-flv`)。

### 修复

1. **取流改回「页面优先、API 仅兜底」**(`packages/kuaishou-live/src/stream/index.ts`):
   - `getStream`/`getLiving` 先走页面 SSR;只有**页面请求本身失败**(网络/HTTP/改版/无 `__INITIAL_STATE__`)
     才试一次 API。
   - **API 只认「拿到可播流 URL」这一种结果**;拿不到一律 `null`(= 不可用),**绝不返回 `{living:false}`** ——
     否则下线的桩又会被当成「权威未开播」。
   - 页面解析失败时:HTML 含限流文案(`请求过快`/`稍后重试`/`操作太快`/`访问过于频繁`)→ 报 `throttledReason`;
     否则**抛错**(= 未知),交给录制器失败告警,**不静默成「未开播」**。
2. **持续风控递进退避**(`packages/record-engine/src/index.ts`):风控探测间隔由固定 5 分钟改为
   **逐次翻倍 5→10→20→30 分钟封顶**,探到正常即复位。依据「越打越冷」:固定频率不足以让 IP 冷却。
3. **测试**:`packages/kuaishou-live/src/stream/index.test.ts` 重写为 12 条(含★回归:
   「API 返回下线桩 → 页面在播照样录」「页面失败+API 桩 → 抛错不静默」);
   `record-engine` 补 2 条退避用例。

### 实测验证(2026-10-08,同一房间 `3x2ys8px8zgu9ba`)

| 出口 | 旧代码 | 新代码 |
|---|---|---|
| VPS1(干净) | `{living:false}` ← 静默漏录 | `{living:true, url: https://hw-origin...flv, owner:"董浩406..."}` |
| VPS2(干净) | `{living:false}` ← 静默漏录 | `{living:true, url: https://hw-origin...flv}` |
| 本机(docker master,被限流) | `{living:false}` | `{living:false, throttledReason:"请求过快，请稍后重试"}`(显式风控,不伪装) |

### 恢复被限流 IP 的做法

1. **停止该 IP 对快手的所有轮询**,冷却数小时(继续高频请求会延长冷却)。
2. 冷却期把快手任务交给干净出口(VPS);hub 规则 `workers` **只勾 1 台**,不要多节点冗余
   (每多一个节点轮询就多一份请求量,是限流主因之一)。
3. 恢复后常态轮询已放宽到 5 分钟 + 风控时递进退避(见上),不会再按 30s 猛打。
