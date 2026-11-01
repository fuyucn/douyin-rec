# vendor/ 来源与维护

抖音取流 + 反爬签名的 vendored 副本。**全部锁在本目录**,只通过 `index.js` 暴露
`getStream` / `getInfo` / `resolveShortURL` 三个函数。改这里要清楚来源与同步方式。

## 来源

| 文件 | 来源 | 版本/commit |
|---|---|---|
| `douyin_api.js` / `stream.js` / `utils.js` / `loadBalancer/` | `@bililive-tools/douyin-recorder` 的 `lib/` | 起点 **@1.17.0**(含 FLV 重连 patch);已按 **1.17.4** 补差(见「上游修复对照」) |
| `sign.js`(ABogus = a_bogus 反爬签名) | TS 移植自 `hua0512/rust-srec` 的 `abogus.rs` | commit **6444641014ea58628af9b0fa51b099620a01d0d0** |
| `index.d.ts` | 手写(只声明用到的 3 函数 + 读到的字段) | 跟随上面手动维护 |

为什么 vendor 而非依赖 npm 包:自有副本 → 不再依赖该 npm 包、可自行扩展(如 H265/HEVC),
且避免该包带会话 cookie 调 `webcast/room/web/enter` 踢手机的坑(见 docs/douyin-kick-investigation.md)。

## 最脆的点:a_bogus(`sign.js`)

`a_bogus` 是抖音反爬签名,**上游算法会变**;变了之后 `getStream`/`getInfo` 会被风控拒(取不到流/弹幕)。

- **运行时检测(已有)**:`douyin-live-recorder` 的 poll 用 `getInfo` 判别「真没开播 vs 签名失效/风控」,
  连续失败跨阈值 → `onProbeError`(推 webhook 告警,见 `douyin-live-recorder/src/index.ts:~230`)。
  所以 a_bogus 失效**不会静默漏录**,会告警。
- **无单测**:`sign.js` 顶层 `import sm-crypto`,vitest 无法 import(sm-crypto/protobufjs ESM/CJS interop 坑,
  与 recorder 同因)→ 不做 vitest contract 测试,靠上面的运行时告警 + 真实录制覆盖。

## 升级 / 重新 vendor 步骤

**抖音取流逻辑变(douyin_api/stream)**:
1. 升级参考:`@bililive-tools/douyin-recorder` 新版 `lib/`(或上游仓库)。
2. 比对 `douyin_api.js`/`stream.js`/`utils.js`/`loadBalancer/`,迁移改动(保留我们的扩展)。
3. 更新本表的版本号。

**a_bogus 失效(收到 onProbeError 告警 / 取流持续失败)**:
1. 看 `hua0512/rust-srec` 的 `crates/platforms/.../douyin/abogus.rs` 最新实现。
2. 按新算法更新 `sign.js`(逐字节移植,保持 StringProcessor/ABogus 结构)。
3. 更新本表 commit。
4. 真实录制验证(本地 `node dist/douyin-rec.mjs probe --room <在播房间>` 能取到流即 OK)。

## 注意
- 这些是 `.js` + 手写 `.d.ts`,无类型保护 → 改 `sign.js` 算法后 `.d.ts` 不会报错,务必真实录制验证。
- 录制必须跑打包后 `node dist`(sm-crypto/protobufjs interop),不能 tsx 直跑。

## 上游修复对照(1.17.0 → 1.17.4)

我们 vendored 的起点是 **1.17.0**。2026-10-07 逐文件比对上游 **1.17.4**(把上游 TS 转译后与我们的
JS 做归一化 diff),补齐了以下**上游修复**(这些是我们缺的,不做会漏录/取不到流):

| 上游修复 | 版本 | 落点 | 我们的状态 |
|---|---|---|---|
| `webHTML` 不再参与取流 | 1.17.1 | `stream.js`(改写回 `web`) | ✅ 已补 |
| 电台直播判活 `room_status === 1` | 1.17.1/1.17.2 | `douyin_api.js` `getRoomInfoByWeb` | ✅ 已补 |
| 电台直播判活 `enter_mode == 1` | 1.17.1/1.17.2 | `douyin_api.js` `getRoomInfoByHtml` | ✅ 已补 |
| `isLiveRadio` 全链路透传 | 1.17.1/1.17.2 | `douyin_api.js` 4 处 + `stream.js` `getInfo` + `index.d.ts` | ✅ 已补 |
| 电台优先 `mobile` 取流 | 1.17.2 | `stream.js`(`if (opts.isLiveRadio) api = "mobile"`) | ✅ 已补 |
| `userHTML` 的 `stream_url` 构造(从 `flv_pull_url` 重建,`or4`→`origin`) | 1.17.x | `douyin_api.js` `getRoomInfoByUserWeb` | ✅ 已补 |
| `getFormatPriorities`(`preferAlternativeStream`) | 1.17.x | `stream.js` | ✅ 已补 |

**顺带修掉的我们的历史 bug**:`getRoomInfoByUserWeb` 原标 `api: "webHTML"`(应为 `"userHTML"`),
会让 `getRoomInfo` 里按 `data.api` 走的返回分支错判。已与上游对齐。

**仍未同步(不影响我们的路径,按需再做)**:
- `getRoomInfoByUserWeb` 里 `res.data.includes("直播中")` 的早退判断等细枝末节,上游结构与我们的
  `if (api === "userHTML")` 特判不同(功能等价)。重新整体 vendor 时再统一。

**电台语义备忘**(实测 2026-10-07):`isLiveRadio` 是**主播属性**(该主播是电台主播),不等于「正在播」——
未开播的电台房间 `isLiveRadio:true` 且 `living:false`(web 端点 `room_status` 非 0/1)。上游把
`room_status===1` 直接当 living,是**宁可多判在播也不漏录电台**的取舍,我们照抄。

## 我们的扩展(与上游 @bililive-tools/douyin-recorder 的差异,升级时务必保留)

上游的 `loadBalancer/` **只有 `getInfo` 走 balance**;`getStream` 传 `api:"balance"` 会静默落到 `web`
(`stream.ts` 里只处理 `userHTML`/`webHTML`/`random`),且均衡器把「不抛错但返回不可用结果」当成功。
我们在 vendored 副本上补了 4 处(2026-10-07):

1. **`loadBalancer.js`: `getNextEndpoint(exclude)`** —— 支持排除端点。取流时排除 `userHTML`
   (它只返回状态、无 `sources/streams`)。
2. **`loadBalancer.js`: `callWithLoadBalance` 单次调用内端点去重** —— 上游 `getNextEndpoint()` 无参,
   一次调用里可能反复选中同一个刚失败的端点(「试遍所有端点」退化成「重试同一个」)。我们记录 `tried`
   并入 exclude。
3. **`loadBalancer.js`: `validate` 结果校验** —— 关键修复。某些端点**不抛错但返回不可用结果**
   (如取流时被拦的 `webHTML` → `living:false` 且无流)。上游会把它当成功、停止重试,调用方随后才炸
   「未找到对应的流」(实测 VPS2 取流失败即此因)。传 `validate` 后返回 falsy 即按失败处理。
4. **`stream.js`: `getStream` 支持 `api:"balance"`** —— 走均衡器拿完整 roomInfo(含 sources)再选流,
   并传 `exclude:["webHTML","userHTML"]` + `validate`(要求 living 且有 streams)。

   ⚠️ **取流必须排除 `webHTML`**。依据(两条,互相印证):
   - **上游官方声明**:`@bililive-tools/douyin-recorder` CHANGELOG **1.17.1** —— 「修复:`webHTML`
     接口不再参与获取流」;`stream.ts:75-77` 把 `webHTML` 强制改回 `web`。**我们 vendored 的是 1.17.0,
     早于该修复**,所以副本里还带着这个 bug。
   - **我们的实测**(2026-10-07,家宽 + VPS 均如此):`webHTML` 的 `getRoomInfo` **恒返回 `streams: 0`**
     (只给状态与 `id_str`,不给流),选中即「未找到对应的流」。
5. **`douyin_api.js`: assert 错误模板不打登录串** —— 上游把整串会话登录串拼进 `Unexpected resp` 消息,
   经 loadBalancer 的 console.warn 进 docker logs(2026-10-31 巡检发现,issue #425)。只打「有(长度)/无」。
6. **`loadBalancer.js`: 日志出口对 `cookies:` 字段脱敏 + blocked 消息的时间戳修复** —— 上游 blocked 消息
   用逗号运算符把 `nextRetryTime` 丢掉了(`(new Date(...).toISOString(), error.message)`),且把原始
   error.message 拼进日志。两处 console.warn 现在都过滤 `cookies:` 字段(issue #425)。

   注意:上游**只修了 `getStream` 直调路径,没修 balance 路径** —— 它的 `loadBalancer` 端点表里
   `webHTML` 仍在候选、且会把「无流」当成功返回。我们的 `exclude` + `validate` 正好补上这半。

   **但弹幕 liveId 解析相反** —— 那里 `webHTML` 可用(只要 `id_str` 不要流,实测正常),故
   `resolveDouyinLiveId` 的 balance **保留** `webHTML`。两处 exclude 不同是有意的,别「统一」掉。

接线(`packages/douyin-live/src/index.ts`,全部走 balance):`getStream`(视频)、`getLiving`、
`fetchAnchorName`、`resolveDouyinWebRid`、`resolveDouyinLiveId`(弹幕 liveId;balance + `web` 兜底,
不再用上游的手写 webHTML→web→mobile 回落链 —— 那条链每次都白试被拦的 webHTML,是在喂风控)。

验证:`scripts/verify-douyin-balance.mjs <roomSlug> [N]`(真实网络;vitest 因 sm-crypto 无法 import)。
