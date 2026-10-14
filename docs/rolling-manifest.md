# 边录边传进度清单 v3 与启动接管(#57 R2 / #46)

`{sessionBase}.rolling.json` 与分段文件同目录,录制端写、主控经 `_inventory` 读。v3 在不破坏旧读者的前提下增加分段状态机、意图、租约。

## Schema(`schemaVersion: 3`)

| 字段 | 含义 |
| --- | --- |
| `segs[]` | 逐段状态 `{index,path,status,attempts?,bytes?,reason?}` |
| `intent` | 先写意图再外发:`{attemptId,kind:create\|append,index,startedAt}` |
| `lease` | `{pid,until,holder}`;心跳每 20s 续期,有效期 90s;写前复核 |
| `policy` | 建稿时的可见性快照 `{private}`,接管续传沿用 |
| `room` | `{platform,roomSlug}`;老清单缺省,回落 `session.json` |
| 旧字段 | `segments / confirmed / ambiguous / uploading / updatedAt`:**每次写由 segs+intent 派生镜像**,旧主控与旧节点包照常读 |

读到 v2/v1(无 `schemaVersion:3`)按旧字段重建 `segs`;旧版本写回会把 `schemaVersion` 压回 2,新读者因此忽略其中过期的 `segs/lease`、重新按旧字段重建。

### 段状态与转换白名单(`core/rolling-manifest.ts`,不强制写)

`open → sealed → uploading → acked → sourceDeleted`;`uploading → sealed`(回读证实未提交)、
`uploading/ambiguous → acked`(回读证实已提交)、`→ ambiguous`(结果不确定)、`→ needs_manual`、`sealed → skipped`(碎片段)。
终态:`needs_manual / skipped / sourceDeleted`。镜像:`acked+sourceDeleted → confirmed`;`ambiguous+needs_manual → ambiguous`。

### 读写

- 读:**不存在 ≠ 损坏**。不存在 = 全新会话;解析失败 / 读失败 = 不可信 → 日志 + 通知转人工,**不覆盖原文件、不当新会话**。主控 `scan.ts` 同口径(`rolling.corrupt` → 转人工,不走常规管线)。
- 写:临时文件 + fsync + rename + **目录 fsync**;写前复核盘上租约,已被别的存活写者持有则停手(僵尸写者自停)。

## 接管(启动 / 新会话首段)

触发:新会话加入第一段时扫同目录同房间的兄弟清单;`task serve` 启动扫一次录像根目录,之后每 5 分钟复扫。
仅当**租约已过期或 pid 已不存在**才接管;租约有效跳过。无租约(v2)的清单须静置 ≥ 10 分钟(老版本进程可能仍在写)。
同进程内以存活表为准(断流重连后旧会话的后台上传租约必然有效)。

| 清单状态 | 动作 |
| --- | --- |
| `intent=create` 且无稿件号 | 转人工,**绝不建稿** |
| `intent=append` 且回读分P数 = 已确认+1 | 补确认 |
| `intent=append` 且两次回读(间隔 ≥ 3 分钟)= 已确认数 | 放回可续传 |
| 其它(查不到 / 数量异常 / 稿件消失 / 两次不一致 / 无稿件号的 append) | 转人工 |
| 段可续传且有稿件号 | 按段序只 append 到该稿件号;头阻塞规则不变 |
| 无稿件号且所有段确定未提交 | 不动,交主控常规管线 |
| 清单损坏 | 转人工(日志 + 通知),不动文件 |

转人工一律日志 + 通知(站内事件 / webhook)。上传硬标准不变:默认仅自己可见、每个分P关水印。

## 断流重连

`onSessionEnd({wait:false})`:最后一段**封口并落盘**后立即返回,上传在后台串行链继续、完成后释放租约;
停止路径 `wait:true` 有限等待(60s),超时进程退出,意图与租约留盘,下次启动接管。

## 部署顺序

先主控后节点。新主控能读旧节点清单(镜像字段);新节点写的 v3 清单旧主控也能读,但旧主控不识别 `corrupt` 标记。
