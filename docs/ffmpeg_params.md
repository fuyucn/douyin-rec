# FFmpeg 录制参数说明

> 基准版本：对齐 DouyinLiveRecorder，经实测可稳定录制抖音直播（含 ByteVC1 流）。
> **禁止随意修改这些参数**。如需调整，必须先用 DouyinLiveRecorder 对比同一地址验证。

---

## 全局选项

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-y` | — | 输出文件已存在时自动覆盖，不询问 | 避免交互阻塞 |
| `-loglevel error` | — | 只输出 error 级别日志，隐藏 warning/info | 减少噪音；`-progress pipe:2` 单独输出进度 |
| `-hide_banner` | — | 隐藏 ffmpeg 版本横幅 | 日志更干净 |

---

## 输入选项（`-i` 之前）

### 网络超时

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-rw_timeout` | `5000000` (5s) | 单次 read/write 系统调用的最大等待时间（微秒） | 设太大：断流后卡 15s+ 才退出；设太小：弱网假超时。5s 是 DouyinLiveRecorder 实测值 |

### 探测/分析阶段

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-analyzeduration` | `20000000` (20s) | ffmpeg 在 demux 阶段最多分析多少微秒的数据来确定流信息（时长维度） | 增大：更准确识别流参数；减小：启动更快但可能误判 |
| `-probesize` | `10000000` (10MB) | ffmpeg 在 probe 阶段最多读取多少字节来确定流信息（⚠️核心参数） | **20MB 时，ByteVC1 私有解码器在 macOS 上解析过多数据触发 SIGSEGV (rc=-11)**；10MB 不触发。DouyinLiveRecorder 使用 10MB |

### 协议白名单

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-protocol_whitelist` | `rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy` | 允许 ffmpeg 使用的底层协议 | 抖音 CDN 同时用到 HTTP/HTTPS/TCP，HLS 还需 crypto（AES 解密）。缺少协议会报 "Protocol not on whitelist" |

### 队列 & 头部

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-thread_queue_size` | `1024` | demux 线程向 decode/encode 线程传包的队列大小（包数） | 过小会报 "Thread message queue blocking"，导致丢包；1024 足够直播场景 |
| `-user_agent` | `Samsung UA` | 设置 HTTP User-Agent | UA 模拟移动端避免限流。**⚠️ 不传 Referer/Cookie**：`Referer` 和 `hevc_supported=true` 等 cookie 会让部分 CDN（pull-q5、pull-flv-l11）切换为 ByteVC1，导致 SIGSEGV (rc=-11)。流 URL 已有内嵌 auth（volcSecret/sign），不需要额外头部。与 DouyinLiveRecorder 一致（DLR 也只用 `-user_agent`）。 |
| `-fflags +discardcorrupt` | — | 遇到损坏包时丢弃而不是中断 | 直播流中偶发的花屏/损坏包不会让 ffmpeg 退出 |

### 限速

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-re` | — | 以 native frame rate 速度读取输入（即"实时"速率） | **防止 ByteVC1 在 macOS 上初始化过快触发 SIGSEGV**。DouyinLiveRecorder 也使用此参数。副作用：对本地文件会变慢，但直播流无影响 |

### M3U8 专用（仅 HLS 流加）

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-reconnect_streamed` | `1` | 直播 HLS 分片结束时自动重连获取下一分片 | HLS 直播必须，否则 EOF 后退出 |
| `-reconnect_at_eof` | `1` | 收到 EOF 后自动重连 | 配合 `reconnect_streamed` 处理 m3u8 playlist 刷新 |
| `-reconnect_delay_max` | `60` | 重连最大等待秒数 | 避免指数退避无限等待 |

> **注意**：`-reconnect_*` 只对 HLS/HTTP 流有意义，FLV 流不加（FLV 断流直接 rc≠0 退出，由上层 task_manager 重启）。

---

## 输出选项（`-i` 之后）

### 编码 & 流映射

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-c:v copy` | — | 视频流不转码，直接复制 | CPU 占用极低（<5%）；保留原始编码质量 |
| `-c:a copy` | — | 音频流不转码，直接复制 | 同上 |
| `-map 0` | — | 映射输入的所有流（音频 + 视频） | 不加时 ffmpeg 用默认规则选流，可能漏掉某些流；与 DLR 一致 |

### 缓冲 & 队列

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-bufsize` | `15000k` (15MB) | muxer 输出缓冲区大小 | 直播高码率流（~8Mbps）缓冲约 15s；过小会导致间歇性卡顿写入 |
| `-max_muxing_queue_size` | `1024` | 各流（音/视频）muxing 时的包队列大小 | 过小报 "Too many packets buffered for output stream"；1024 适合单流 copy 场景 |

### 流选择

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-sn` | — | 不录制字幕流 | 避免内嵌字幕（如弹幕字幕流）被写入 TS 文件 |
| `-dn` | — | 不录制数据流 | 避免抖音 FLV 中的 metadata/script 数据帧干扰 TS muxer |

### 输出侧重连（FLV 和 M3U8 均启用）

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-reconnect_delay_max` | `60` | 重连最大等待秒数（输出侧） | 放在 `-i` 之后作为输出选项，对 FLV 和 HLS 均生效；帮助段内断流自动续连；与 DLR 一致 |
| `-reconnect_streamed` | — | 流结束时自动重连 | 同上 |
| `-reconnect_at_eof` | — | EOF 时自动重连 | 同上 |

### 时间戳修复

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-correct_ts_overflow` | `1` | 检测并修正 33-bit PTS/DTS 溢出 | 直播流长时间录制（>26小时 @90kHz）会溢出；开启后自动修正，防止播放器跳帧 |
| `-avoid_negative_ts` | `1` | 将负 PTS 时间戳调整为正数 | FLV 流起始时常有负 DTS；不修正会导致 TS 文件播放异常 |

---

## 分段模式专用（`segment_duration > 0`）

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-f segment` | — | 使用 segment muxer，按时间自动切分文件 | 输出 `name_%03d.ts` 系列文件 |
| `-segment_time` | N (秒) | 每段最大时长 | 实际切分点对齐关键帧，可能略长于设定值 |
| `-segment_format` | `mpegts` | 每段文件格式 | TS 格式兼容性最好，支持任意点播放 |
| `-reset_timestamps` | `1` | 每段文件的时间戳从 0 开始 | 避免播放器显示异常时间码；弹幕 .ass 时间轴对齐依赖此参数 |

---

## 进度监控

| 参数 | 值 | 作用 | 影响 |
|------|----|------|------|
| `-progress pipe:2` | — | 将 `frame=`, `fps=`, `drop_frames=` 等进度信息输出到 stderr | 供 `_monitor_stderr()` 解析丢帧数 |
| `-nostats` | — | 禁用默认的 stderr 统计行（避免与 `-progress` 冲突） | 与 `-progress` 配合使用 |

---

## 参数稳定性说明

以下参数是经过实测确认可用的组合，**不要在没有充分测试前修改**：

1. `probesize=10000000`：超过 10MB 在 macOS + ByteVC1 上触发 SIGSEGV
2. `rw_timeout=5000000`：与 DouyinLiveRecorder 一致；更大的值会让断流检测变慢
3. `-re`：DouyinLiveRecorder 使用，防止 ByteVC1 初始化过快崩溃
4. `-reconnect_*` 仅 M3U8：FLV 流不加，DouyinLiveRecorder 也是这样做的

如遇新的录制问题，先在 DouyinLiveRecorder 上用相同地址测试：
```
/Users/yuf/Developer/DouyinLiveRecorder
```
对比 `ps aux | grep ffmpeg` 输出，找到参数差异再修改。
