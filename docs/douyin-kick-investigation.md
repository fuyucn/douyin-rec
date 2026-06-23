# 抖音「异地登录踢手机」问题 — 根因与修复

> 现象:录制机用主播本人(自己)账号 cookie 录制 + 抓弹幕时,**手机端被抖音踢下线**(弹「异地登录」)。
> 排查日期 2026-06-14。结论:**根因是用完整会话 cookie 调 `webcast/room/web/enter` 鉴权 API,与机器/IP/手机网络无关。已修复。**

## TL;DR

| | 触发踢 | 说明 |
|---|---|---|
| `getInfo` 带**会话 cookie** 调 `webcast/room/web/enter` | ❌ **踢** | **真凶**。抖音判「该账号在新设备进直播间」 |
| 视频拉流(CDN 签名 URL) | 不踢 | 公开流,不带 cookie 到 CDN |
| 弹幕 WS 带(过滤后)会话 cookie | 不踢 | 单独连接,不调上面那个鉴权 API |
| 匿名(无会话 cookie)一切操作 | 不踢 | 但拿不到礼物 |

**修复**:解析 liveId / 流地址时**不传会话 cookie**(匿名,liveId/流是公开的);会话 cookie 只用于弹幕 WS(过滤后)以拿礼物。

## 根因

`@bililive-tools/douyin-recorder` 的 `getInfo()` 内部会请求:

```
https://live.douyin.com/webcast/room/web/enter/?...   （douyin_api.js:309，带传入的 auth cookie）
```

这是一个**「以登录身份进入直播间」的鉴权 API**。当带上账号的**会话 token**(`sessionid` / `sid_guard` / `sessionid_ss` / `sid_tt` / `uid_tt` / `sid_ucp_v1` 等)调用时,抖音服务端登记「该账号在一台新设备上进了直播间」→ 触发异地登录保护 → 把**其它端(手机)踢下线**。

我们的 TS 在**三处**带会话 cookie 调了它(任一处都会踢):
- 弹幕路径 `listener-base.ts`:`getInfo(slug, {auth: cookies})` 解析本场 `liveId`。
- 录制路径 `bililive.ts`:`getInfo()`(主播名/开播状态)+ 把 `auth` 传给 `@bililive` 录制器(它用来解析流地址,内部也调 `room/web/enter`)。
- **创建任务时** `anchor.ts` `fetchAnchorName(room, cookies)`(由 `api.ts:resolveAnchorBg` 后台调,用全局会话 cookie 拉主播名)——**最隐蔽**:任务一建就触发,与录制是否启动无关。(2026-06-14 修了前两处后,用服务建任务仍踢,才揪出这第三处。)

对照:**旧 Python 版(`origin/main`)从不踢**,因为它的弹幕/流解析走 `get_douyin_stream_data` —— **GET 直播间网页 HTML 然后正则解析**(注释原话:「HTML 解析,避免地域受限的 webcast API」),是被动网页请求,不是会改账号状态的鉴权调用。

## 排查过程(含被推翻的错误假设)

排查走了不少弯路,记录下来避免重蹈:

1. ❌「会话 token 必踢、只能小号」——逐个会话 token(sessionid/sessionid_ss/sid_guard)单测都踢,误以为会话与礼物焊死、无解。
2. ❌「provider/库不同」——以为 `bililive-builtin` 不踢而 listener 踢;实则两者底层弹幕都是 `douyin-danma-listener`(vendored 与 npm `diff=0`)。`bililive-builtin` 那次「不踢」是**踢有延迟、单次观测漏了**(复测也踢)。
3. ❌「cookie 子集/白名单」——移植 Python 的 cookie 白名单过滤(丢 sid_guard/ucp + 匿名设备合并)到 WS,**仍踢**(因为 `getInfo` 那条还带着完整 cookie)。
4. ❌「uid 随机/重连风暴」——把 WS 的随机 `user_unique_id` 改稳定,仍踢。
5. ❌「是机器/IP」——VPS 不踢、本机踢,一度归因于「VPS 是受信常驻设备」。**但这是混淆**:所有 VPS 测试用 Python,所有本机测试用 TS,机器与实现一起变了。
6. ✅ **决定性实验**:把 **Python 弹幕客户端搬到本机 Mac** 跑(同机、同 cookie,只换实现)→ 抓全三类弹幕**不踢**。而本机 TS → 踢。**变量锁定为「代码实现」**,进而定位到 `getInfo` 的 `room/web/enter` 鉴权调用。
   - 旁证:手机切流量(非 WiFi)照样踢 → 手机是受害者,触发方是录制机,与手机网络无关。

## 修复

两处,均「视频/房间信息用公开方式获取,不带会话 cookie」:

**1. `src/danmu/listener-base.ts`** — 匿名解析 liveId:
```ts
// 旧: getInfo(slug, opts.cookies ? { auth: opts.cookies } : {})
const info = await getInfo(slug, {}); // 匿名:绝不把会话 cookie 传给 room/web/enter
```
WS 连接仍带会话 cookie,但经 `danmu-cookie.ts` 白名单过滤(丢 sid_guard/ucp/login_time 等)+ 匿名 guest 设备指纹合并,以拿礼物。

**2. `src/recorder/bililive.ts`** — 外置弹幕 provider 时录制器匿名拉流:
```ts
// 视频是公开流,不需要会话 cookie。仅 providesDanmu=true(biliLive 自带弹幕需会话拿礼物,
// 但本就会踢)时用 cookie;外置 provider(providesDanmu=false)一律匿名 → 录制器侧不踢。
this.auth = this.providesDanmu ? opts.cookies : undefined;
```
`getInfo`(主播名/isLive)与传给 `@bililive` 录制器的 `auth` 都改用 `this.auth`。

## 验证(本机,完整 cookie)

端到端 `record --danmu websocket-danmu-listener --quality origin`:
- 视频 **原画 1088×1920**(匿名拉流不限画质)
- 弹幕 **/ 礼物 / 入场 三类齐全**
- **手机不踢**
- 无「开播首段 ffmpeg 断流」

## 选型建议

| provider | 弹幕能力 | 踢手机 | 画质 |
|---|---|---|---|
| `websocket-danmu-listener`(推荐) | 弹幕 + 礼物 + **入场** | **不踢**(修复后) | 原画(匿名拉流) |
| `bililive-builtin` | 弹幕 + 礼物(无入场) | **仍会踢**(库内 getInfo 带 cookie,无法分离视频与弹幕) | 原画 |
| 匿名(useCookie=false) | 弹幕 + 入场(无礼物) | 不踢 | 原画 |

**要礼物又不踢主号 → 用 `websocket-danmu-listener`。**

## 注意

- 礼物推送仍需会话 cookie(在弹幕 WS 上,过滤后),这部分不触发踢。
- 旧 Python 版(VPS 生产)本就走 HTML 解析,无此 bug;本修复针对 TS 版。
- 关键文件:`@bililive-tools/douyin-recorder/lib/douyin_api.js:309`(`room/web/enter`)、`src/danmu/listener-base.ts`、`src/recorder/bililive.ts`、`src/danmu/danmu-cookie.ts`。
