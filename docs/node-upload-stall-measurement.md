# 节点侧 biliup 停滞信号实测（plan 038 T14）

> 隐私：本文不写主播名、房间号、BV、主机名、IP、路径。原始样本只留在节点 `/tmp`，不入库。

## 结论

- **判死信号用 `tcp.acked`**（biliup 进程全部 TCP socket 的 `bytes_acked`，由 `ss -tinpH` 读取）。
  它是唯一与真实网络进度一致的信号。
- `rchar` / `read_bytes` **不能用**：biliup 先把整段读进内存，随后网络慢慢发送；读完后 `rchar`
  连续 217 秒不涨，而 `tcp.acked` 仍在每 5 秒涨约 200KB。
- `wchar` 也不用：最长 91 秒不涨（socket `sendto` 计数不全），比 `tcp.acked` 噪声大。
- **`stallMs` 默认 300 秒**。实测传输期 `tcp.acked` 最长连续零增长 55 秒（5 秒采样分辨率，上界 60 秒）；
  取约 5 倍余量，因为样本只有一场、5 个进程，没有覆盖同节点并发抢带宽（事故里 0.1–0.2MB/s）的情况。
  该值可按 job 覆盖（`params.stallMs`），后续样本足够再收紧。
- `tcp.acked` 求和会因 socket 关闭而**下降**（分块上传按块换连接），所以判定按「任一 socket 的 acked
  比上次大，或出现新的 acked>0 的 socket」算有进度，不按求和差值。

## 方法

- 采样器 `scripts/sample-biliup-io.py`：只读，每 5 秒对每个 `biliup upload|append` 进程记一行
  `/proc/<pid>/io`（rchar/wchar/read_bytes）与 `ss -tinpH` 的 `bytes_acked`/`bytes_sent`。
  不记录登录凭证、标题、文件名。
- 数据来源：2026-10-17 人工授权的一场测试录制，单 worker，边录边传，120 秒分段，仅自己可见。
- 已知限制：master 容器无 python3，master 本机上传采不到；采样器不知道 biliup 的 step，
  零增长区间里可能混有 submit 阶段（所以 55 秒是**偏大**的估计，判死只看 transfer，不影响安全性）。

## 数据（5 个进程，95 行）

| 进程 | verb | 样本 | 跨度 | 信号 | 总增量 | 最长连续零增长 |
|---|---|---|---|---|---|---|
| A | upload | 3 | 12s | tcp.acked | 33.6MB | 0s |
| | | | | rchar | 22.0MB | 5s |
| B | append | 46 | 227s | tcp.acked | 21.0MB | 45s |
| | | | | wchar | 63.1MB | 91s |
| | | | | rchar | 52.6MB | 217s |
| C | append | 39 | 192s | tcp.acked | 20.1MB | 55s |
| | | | | wchar | 47.8MB | 70s |
| | | | | rchar | 21.5MB | 177s |
| D | append | 3 | 10s | tcp.acked | 41.5MB | 0s |
| E | append | 4 | 15s | tcp.acked | 4KB | 0s |

- B：首个 5 秒 rchar +52MB（整段读入），之后 3 分钟 rchar 为 0、tcp.acked 每 5 秒 +180–390KB，
  末尾 45 秒为 0，随后最后一块 +10.5MB 发完。说明**传输中途也会出现几十秒零增长**（等分块响应），
  `stallMs` 不能取到 1 分钟以内。
- E：被 B 站 `21540 请求过于频繁` 拒绝（预上传阶段），进程 15 秒内自行退出；网络几乎没有字节。
  这类失败由进程退出码处理，不需要停滞判死。

## 采样命令

```bash
nohup python3 /tmp/sample-biliup-io.py --out /tmp/biliup-sample --interval 5 --max-hours 48 &
wc -l /tmp/biliup-sample/samples.jsonl
```

## 后续

- T15 按本结论实现：只在 `step=transfer` 计时，`gate_wait`/`submit` 永不判死；`ss` 不可用时该 job
  不判死并告警一次（缺证据不杀）。
- 样本补充：同节点两路并发上传、慢速线路各一场后，复核 300 秒是否偏大。
