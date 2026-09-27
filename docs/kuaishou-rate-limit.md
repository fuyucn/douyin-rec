# 快手直播页限流(风控)问题记录

记录 2026-09-23~24 的「任务 57 开播没录」排查结论与修复。

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

## 验证

- VPS 取页 `isLiving: true`、本机返回风控页 → 确认是 IP 维度。
- 冷却 10 小时（停任务、本地零请求）后，本机页面不再返回「请求过快」，任务 57 恢复 enabled 并按 5 分钟轮询，开播后自动录制。
- VPS 侧日志可见降频提示：`平台风控:请求过快，请稍后重试 —— 5 分钟一探…`。

## 运营注意

- 被限流后**继续高频请求会延长冷却**；最快恢复方式是停掉该平台的轮询几小时。
- hub 规则的 `workers` 决定「谁录」：只在 `local` 时本机实跑；只勾远端时本机自动让位。
