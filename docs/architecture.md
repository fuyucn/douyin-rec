# 架构

pnpm workspace monorepo，11 个包，收敛成 **2 个可插拔接缝**：

- **平台轴**（`<平台>-live`）—— 平台专属的一切：取流（`getStream`）+ 弹幕（`connectDanmu`）+ 开播判定（`getLiving`）。接新平台 = 写一个 `<平台>-live` 实现 `Platform` 接口 + `registerPlatform` 一行。
- **引擎轴**（`record-engine`）—— 平台无关的下载：通用 `PollingRecorder` + 下载引擎策略（`ffmpeg` / `mesio`）。加新引擎 = 写一个 `DownloadEngine` 策略 + `registerEngine` 一行，所有平台立即可用。

依赖**只能向下**（`test/arch/layering.test.ts` 守护：每个包的 rank 必须严格大于它依赖的任何包；新增包须在 `RANKS` 登记）。esbuild 把 `cli` 打成自包含单文件 `dist/douyin-rec.mjs`（+ 独立的 `dist/tui.mjs`）。

> 同时维护一份等价的可交互图：[architecture.html](./architecture.html)。CLI / app 层细节见 [cli.md](./cli.md) · [app.md](./app.md)。

## 依赖分层图

箭头 = 「依赖」（A → B 表示 A 用 B）。层级越低越通用，只能被上层依赖。**绿色 = 平台轴**接缝、**橙色 = 引擎轴**接缝。

```mermaid
flowchart TB
  subgraph L5["L5 · 入口"]
    cli["<b>cli</b><br/>record / merge / burn / probe + task<br/>providers-register: 注册平台 + 引擎"]
  end
  subgraph L4["L4 · 有状态应用"]
    app["<b>app</b><br/>db / store(房间归一化+平台校验)<br/>task-manager / daemon(定时) / scheduler<br/>web(api+server) / login(扫码) / upload / events / notify"]
  end
  subgraph L3["L3 · 编排"]
    manager["<b>manager</b><br/>RecordingSession 会话生命周期<br/>onLive→connectDanmu / 断流重连 / drain<br/>danmu-xml(XmlDanmuWriter)"]
  end
  subgraph L15["L1.5 · 平台轴 (可插拔接缝 ①)"]
    douyin["<b>douyin-live</b><br/>douyinPlatform<br/>stream(a_bogus 取流) + danmaku(自有 TS WS 客户端)"]
    bilibili["<b>bilibili-live</b><br/>bilibiliPlatform<br/>getStream + connectDanmu(WBI + 二进制 WS)"]
  end
  subgraph L1["L1 · 引擎轴 (可插拔接缝 ②)"]
    engine["<b>record-engine</b><br/>通用 PollingRecorder<br/>下载引擎: ffmpeg(.ts) / mesio(.flv)"]
  end
  subgraph L0["L0 · 基础叶子"]
    core["<b>core</b><br/>Platform / DownloadEngine 契约<br/>+ 注册表 + types/config/notify/api-types + log"]
    post["<b>post-process</b><br/>concat / burn / ass / merge / ffmpeg / fonts"]
    extra["<b>ffmpeg-recorder-extra</b><br/>logStreamMeta + detectDevice"]
    tui["<b>tui</b><br/>Ink 终端控制台 (独立 bundle)"]
  end

  cli --> app
  cli --> manager
  cli --> douyin
  cli --> bilibili
  cli --> engine
  cli --> post
  cli --> core
  app --> manager
  app --> douyin
  app --> engine
  app --> post
  app --> tui
  app --> core
  manager --> core
  douyin --> core
  douyin --> extra
  bilibili --> core
  engine --> core
  engine --> extra

  classDef axisPlat fill:#dcfce7,stroke:#16a34a,color:#14532d;
  classDef axisEng fill:#ffedd5,stroke:#ea580c,color:#7c2d12;
  class douyin,bilibili axisPlat;
  class engine axisEng;
```

> `web/`（React19 + jotai + @base-ui/react + Tailwind v4）是**独立 Vite 工程**，构建产物 `packages/web/dist` 由 `app` 的 web server 托管，不参与上面的 `@drec/*` 依赖图。

## 运行时数据流（一次录制会话）

`app` 的 daemon 在定时窗口内 spawn 一个 `record` 子进程；`record-engine` 的 `PollingRecorder` 经注册表 `platformForRoom(url)` 拿到平台实例驱动取流，确认开播那一刻 fire `onLive`，`manager` 据此扇出弹幕。视频与弹幕分别落盘，事后由 `post-process` 合并/烧录、`upload` 投稿。

```mermaid
flowchart LR
  url["房间 URL"] --> pf["platformForRoom()<br/>(core 注册表)"]
  pf --> plat["Platform<br/>douyin / bilibili"]

  subgraph eng["record-engine · PollingRecorder (平台无关)"]
    poll["每 30s 轮询<br/>getLiving / getStream"]
    poll -->|living| spawn["选中引擎<br/>ffmpeg / mesio"]
    spawn --> onlive{{"fire onLive<br/>(确认开播)"}}
  end
  plat --> poll

  spawn -->|"url + headers"| dl["下载落盘"]
  dl --> ts[".ts / .flv 分段"]

  onlive --> dm["manager<br/>platform.connectDanmu()"]
  dm --> ws["DanmuSource (WS)<br/>chat / gift / member"]
  ws --> xw["XmlDanmuWriter<br/>(锚到视频起点)"]
  xw --> xml[".xml 弹幕<br/>(biliLive 格式)"]

  ts --> pp["post-process<br/>merge → burn"]
  xml --> pp
  pp --> mp4["成品 mp4<br/>plain / danmu / livechat"]
  mp4 --> up["upload<br/>→ B 站 (biliup)"]
```

**两个接缝在数据流里的体现：**

- **平台轴**只回答「这个房间在播吗 / 流地址是什么 / 弹幕从哪连」——`getLiving` / `getStream` / `connectDanmu`。换平台不动录制逻辑。
- **引擎轴**只负责「把 `getStream` 给的 `url + headers` 下载到磁盘」——`ffmpeg`（`-c copy` → `.ts`）或 `mesio`（rust-srec `--fix` → `.flv`），并透传平台给的 headers（如 bilibili CDN 的 Referer/UA）。换引擎所有平台立即生效。
