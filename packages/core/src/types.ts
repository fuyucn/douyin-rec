/** 一条弹幕消息（统一模型，Recorder/DanmuSource 都用） */
export type DanmuKind = "danmaku" | "gift" | "member";
export interface DanmuMessage {
  kind: DanmuKind;
  /** 绝对时间戳，毫秒 (Date.now() 量级) */
  tsMs: number;
  user?: string;
  uid?: string;
  /** danmaku: 弹幕文本 */
  content?: string;
  /** gift: 礼物名 / 数量 / 单价(元) */
  giftName?: string;
  giftCount?: number;
  price?: number;
}

export interface StreamInfo {
  anchorName: string;
  title?: string;
  /** 分辨率/编码，如 "1088x1920 | H264" */
  streamDesc?: string;
}

export interface RecordOpts {
  /** 画质档:**平台自解释的字符串**(抖音 origin/uhd/hd/sd/ld);通用契约不写死平台档位。 */
  quality: string;
  cookies?: string;
  outDir: string;
  segmentSec: number;      // 0 = 不分段
  /**
   * 主播/输出名称（可选）。有值时录像落在 {outDir}/{name}/ 子目录，文件名也以 {name} 开头；
   * 留空则按抓取到的主播名（getStream 返回的 owner）自动分目录。
   */
  name?: string;
  /**
   * 弹幕 xml 落盘粒度（仅当弹幕由 DanmuSource + 我们的 XmlDanmuWriter 写时生效）：
   *   "session"（默认）— 整场一个 xml，合并时按 ffprobe 时长切 ASS。最稳，避开断流位移。
   *   "segment"        — 每个视频分段一个 xml（{base}_NNN.xml），配对好看但断流可能位移。
   */
  danmuXmlMode?: "session" | "segment";
}

export interface RecorderEvents {
  /**
   * **真正拿到流、开始录制时**触发(不是「开始等待开播」)。**契约**:这是 RecordingSession
   * 扇出「连弹幕」的唯一时机——recorder 必须在确认开播那一刻 fire,否则弹幕不会启动(开播前
   * 连会拿到陈旧 liveId → 整场 0 弹幕)。新增 recorder 务必遵守。
   */
  onLive(info: StreamInfo): void;
  onSegment(tsPath: string): void;      // 新 .ts 分段产生
  onDanmu?(m: DanmuMessage): void;      // 仅 providesDanmu=true 的 recorder 用
  onOffline(): void;                    // 流断 / 下播
  onError(err: Error): void;
  /**
   * 开播探测**连续失败**(取流+getInfo 都失败,疑似签名失效/被风控 → 可能在漏录)。
   * 与 onError 区别:**只告警不触发重连/收尾**(此时并没有在录制)。可选 —— 老 recorder 不实现即不报。
   */
  onProbeError?(message: string): void;
}

export interface Recorder {
  readonly name: string;
  /** 是否自带弹幕。当前录制器均 video-only(false)，弹幕由独立 DanmuSource 抓。 */
  readonly providesDanmu: boolean;
  start(roomUrl: string, opts: RecordOpts, ev: RecorderEvents): Promise<void>;
  stop(): Promise<void>;
  /**
   * 排空：停止「开播轮询」（不再自动录下一场），但不中断当前正在进行的录制。
   * 用于定时窗口结束时不腰斩直播。未实现时 session 回退到 stop()（硬停）。
   */
  drain?(): Promise<void>;
  /**
   * 查询直播间当前是否在播（权威 API）。drain 期间用于判定「自然收播」。
   * 未实现时 session 只依赖 RecordStop / onOffline 事件。
   */
  isLive?(): Promise<boolean>;
}

export interface DanmuSource {
  readonly name: string;
  /**
   * @param onAlert 健康告警(可选):连不上 / 解析连接 id 失败 / 连上但长时间 0 条 → 上报。
   *   session 接到后走 notify(webhook + UI),与视频卡死看门狗对等,避免弹幕静默失败无人知。
   */
  start(
    roomUrl: string,
    opts: RecordOpts,
    onMessage: (m: DanmuMessage) => void,
    onAlert?: (msg: string) => void,
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface DanmuWriter {
  /**
   * @param meta.videoStartMs 视频/本段录制起点 epoch ms。给定时:弹幕时间轴**锚到视频起点**
   *   (rel = 弹幕真实发送时间 − 视频起点),且**丢弃发送时间早于视频起点的消息**(抖音 WS 连上
   *   会回灌开播前的历史弹幕,带旧时间戳)。不给则退化为锚到「首条消息」(旧行为)。
   */
  open(filePath: string, meta: { anchorName: string; roomId?: string; videoStartMs?: number }): void;
  add(m: DanmuMessage): void;
  close(): void;
}
