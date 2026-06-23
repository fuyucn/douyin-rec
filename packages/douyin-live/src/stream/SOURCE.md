# vendor/ 来源与维护

抖音取流 + 反爬签名的 vendored 副本。**全部锁在本目录**,只通过 `index.js` 暴露
`getStream` / `getInfo` / `resolveShortURL` 三个函数。改这里要清楚来源与同步方式。

## 来源

| 文件 | 来源 | 版本/commit |
|---|---|---|
| `douyin_api.js` / `stream.js` / `utils.js` / `loadBalancer/` | `@bililive-tools/douyin-recorder` 的 `lib/` | **@1.17.0**(含 FLV 重连 patch) |
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
