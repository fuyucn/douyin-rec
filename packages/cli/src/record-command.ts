import type { Command } from "commander";
import type { RecordCliOpts } from "./record-options.js";
import { runRecord } from "./record-run.js";

export function registerRecordCommand(program: Command): void {
  program
    .command("record")
    .description("录制抖音直播（含弹幕捕获）")
    .addHelpText(
      "after",
      `
  例:
    $ douyin-rec record --room '<room-id>' --danmu 1 --segment 1800
    $ douyin-rec record --room https://live.douyin.com/12345 --quality hd --out ./recordings`,
    )
    .requiredOption("--room <id|url>", "直播间房间号或完整 URL")
    .option("--name <s>", "主播/输出名称（录像落在 {out}/{name}/ 子目录；留空则按抓取到的主播名自动分目录）")
    .option("--quality <q>", "画质: origin|uhd|hd|sd|ld (默认 origin)")
    .option("--engine <e>", "下载引擎(按平台: ffmpeg|mesio,省略=平台默认)")
    .option("--recorder <r>", "[已废弃别名] 等价 --engine")
    .option("--danmu <0|1>", "弹幕开关: 1=开(由平台 connectDanmu 提供) 0=关 (默认 1)")
    .option("--cookies <s>", "抖音 cookie 字符串")
    .option("--cookies-file <path>", "从文件读取 cookie (优先于 --cookies)")
    .option("--out <dir>", "输出目录 (默认 <DOUYIN_REC_ROOT>/recordings,未设根则 output-data/recordings)")
    .option("--segment <sec>", "分段时长(秒), 0=不分段 (默认 1800)")
    .option("--danmu-xml-mode <mode>", "弹幕 xml 粒度: session(整场一个,默认) | segment(逐段一个)")
    .option("--reconnect <sec>", "断流快速重连等待(秒) (默认 5)")
    .option("--rolling-upload <0|1>", "边录边传: 1=录制中每封口一段就上传并删该段源 0=整场录完再处理 (默认 0)")
    .option("--stream-upload <0|1>", "直播直传: 1=ffmpeg stdout 直传 UPOS 并续同一稿件,上传确认后删本地回退文件;0=关闭(默认)")
    .option("--stream-upload-size <bytes>", "流式直传每 P 字节上界(默认对齐后的 1.5GiB)")
    .option("--stream-upload-sec <sec>", "流式直传每 P 时长阈值(秒),与 --stream-upload-size 谁先到算一 P")
    .option("--stream-upload-stall-sec <sec>", "流式直传无写入看门狗(秒;默认 120,最低 60):无写入超过该时长即封口并重连,慢速但持续的数据不会误封")
    .option("--stream-upload-recover-sec <sec>", "流式直传停滞后的自动恢复窗口(秒;默认 1200,最低 60)")
    .option("--stream-upload-ratio-alert <0-1>", "流式直传每 P 媒体时长/墙钟时长 低于该比例时告警(默认 0.85,0=关闭)")
    .option("--stream-upload-tid <tid>", "流式直传投稿分区(默认 21)")
    .option("--stream-upload-tag <tag>", "流式直传标签(逗号分隔;省略=hub 规则/hub.config 默认)")
    .option("--stream-upload-spool <full|none>", "(兼容旧参数,已固定为 full) 直播直传保留本地回退文件; none 不再生效", "full")
    .option("--zero-disk-managed <0|1>", "(内部) hub 受管侧节点的 0 落盘:元数据/账号校验只取 master 下发对象,缺失即拒绝启动")
    .option("--stream-upload-private <0|1>", "流式直传仅自己可见(省略=hub 规则/hub.config 默认,保守为 1)")
    .option("--output-format <fmt>", "节点侧输出格式 original|mp4|mkv: 分段封口后原地 remux 成所选容器、校验通过后删原文件 (默认 original=不转)")
    .option("--task-id <n>", "所属任务 id(serve 拉起时传入;封口转换入队行据此归属任务,失败告警按任务显示)")
    .option("--config <path>", "YAML 配置文件 (命令行选项优先覆盖)")
    .action((options: RecordCliOpts) => runRecord(options, program.opts()));
}
