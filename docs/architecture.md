# 架构

pnpm workspace monorepo，12 个包，收敛成 **2 个可插拔接缝** + **1 个多节点编排层**：

- **平台轴**（`<平台>-live`）—— 平台专属的一切：取流（`getStream`）+ 弹幕（`connectDanmu`）+ 开播判定（`getLiving`）。接新平台 = 写一个 `<平台>-live` 实现 `Platform` 接口 + `registerPlatform` 一行。
- **引擎轴**（`record-engine`）—— 平台无关的下载：通用 `PollingRecorder` + 下载引擎策略（`ffmpeg` / `mesio`）。加新引擎 = 写一个 `DownloadEngine` 策略 + `registerEngine` 一行，所有平台立即可用。
- **多节点 hub**（`orchestrator`）—— master/slave 跨节点同步:各节点匿名各录各的，master 经 SSH 拿各节点录像清单 → 按 (platform, roomSlug) 聚成一场 → 覆盖度选优 → 拉取 → 合并/烧录 → 穿插上传 B 站。配置文件化（`config/hub/{platform}.{roomSlug}.json`）。详见 [multi-node-sync.md](./multi-node-sync.md)。

依赖**只能向下**（`test/arch/layering.test.ts` 守护：每个包的 rank 必须严格大于它依赖的任何包；新增包须在 `RANKS` 登记）。esbuild 把 `cli` 打成自包含单文件 `dist/douyin-rec.mjs`（+ 独立的 `dist/tui.mjs`）。

> 同时维护一份等价的可交互图：[architecture.html](./architecture.html)。CLI / app 层细节见 [cli.md](./cli.md) · [app.md](./app.md)。

## 依赖分层图

箭头 = 「依赖」（A → B 表示 A 用 B）。层级越低越通用，只能被上层依赖。**绿色 = 平台轴**接缝、**橙色 = 引擎轴**接缝。

```mermaid
flowchart TB
  subgraph L5["L5 · 入口"]
    cli["<b>cli</b><br/>record / merge / burn / probe + task<br/>providers-register: 注册平台 + 引擎"]
  end
  subgraph L45["L4.5 · 多节点 hub (master 编排)"]
    orch["<b>orchestrator</b><br/>Transport(local/ssh/tailscale-ssh)<br/>identity(按 platform,roomSlug 聚类) / select(覆盖度选优)<br/>reconciler / pipeline(选优→pull→merge→burn→穿插上传) / SyncLedger"]
  end
  subgraph L4["L4 · 有状态应用"]
    app["<b>app</b><br/>db / store(房间归一化+平台校验) / hub-store(文件版 hub 规则)<br/>task-manager / daemon(定时) / scheduler<br/>web(api+server) / login(扫码) / upload / events / notify"]
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

  cli --> orch
  orch --> app
  orch --> post
  orch --> core
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

## 多节点 hub 数据流（直播结束 → 选优 → 上传）

**master**（`task serve --hub`）编排多个 **slave**（`task serve`，无 `--hub`）。各节点匿名各录各的；master 经 SSH 主动够到 slave（不需要 slave 跑 hub 服务）。

```mermaid
flowchart TB
  subgraph nodes["各节点(各录各的)"]
    dk["docker(local)<br/>recordings/ + {base}.session.json"]
    vps["VPS(slave)<br/>recordings/ + {base}.session.json"]
  end
  subgraph master["master = docker 的 orchestrator"]
    inv["listInventory<br/>local 直接 scan / 远端 ssh _inventory"]
    cluster["identity 聚类<br/>(platform, roomSlug) → streamKey"]
    sel["select 选优<br/>覆盖度优先(完整录全)"]
    pull["pull 到 stage<br/>(winner 远端→rsync)"]
    merge["merge plain → burn danmu/livechat<br/>(复用 post-process)"]
    up["穿插上传<br/>P1 上传 ∥ 烧录, append 分P"]
    led[("SyncLedger<br/>sync_jobs / candidates")]
  end
  dk --> inv
  vps -->|ssh| inv
  inv --> cluster --> sel --> pull --> merge --> up
  sel -. resolveCfg .-> rule["config/hub/{platform}.{roomSlug}.json<br/>(文件=真理源)"]
  cluster -.-> led
  up -.-> led

  classDef hub fill:#e0e7ff,stroke:#4f46e5,color:#312e81;
  class inv,cluster,sel,pull,merge,up hub;
```

- **触发**：master 自录的 recordEnd + 周期 reconcileAll（settle 等各节点收播，仍在录的场跳过）。
- **选优**：完整录全（单会话无断流）优先；**所有节点都断流 → 中断 + 通知 + 不删源**。
- **配置 = 文件**：每房间一份 `config/hub/{platform}.{roomSlug}.json`（`upload.mode`=stage|upload + `private`），现读不缓存 → UI 与手改文件天然同步。关水印/仅自己可见/copyright 是 `biliup.ts` 代码常量（不可配、绝不漏）。
