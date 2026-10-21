# 端到端脚手架(test/e2e)

纯本地、进程内、不联网,跑「收播后」整条流程:`Reconciler.reconcileAll` → select / pull / 合并|分段|节点侧 /
上传 / 核验 / 清理,配**真** `SyncLedger`(sqlite 落盘)与**真** `LocalTransport`。

```bash
pnpm test:e2e        # 只跑本目录(~2s);同时也属于 pnpm test
```

## 构成

| 文件 | 作用 |
| --- | --- |
| `harness/fake-biliup.ts` | 假 biliup + 假「B站」。实现真实包装本就开放的 `run(argv)` 接缝,**真实 `uploadPlain`/`appendGroup`(换线、`parseBV`、append 幂等核对、ambiguous 标记、argv 硬标准)全部照跑**。可注入超时 / 网关错误 / 结果不确定(服务端已提交但响应丢失)/ 进程被杀(含「被杀前是否已提交」),`countAvailable=false` 模拟分 P 数不可查,`countLagReads=N` 模拟追加后分 P 列表延迟 N 次读才刷新(#66) |
| `harness/fake-recordings.ts` | 按录制端落盘约定造多会话 × 多分段 + 弹幕 xml + `session.json` |
| `harness/scenario.ts` | 场景驱动:临时数据根、Reconciler、假 shell/remux 替身、`restart()`(内存态全丢,磁盘与台账保留) |
| `harness/invariants.ts` | 通用断言:状态轨迹合法、无 `[ledger] 拒绝`、不重复建稿、分 P 对得上、关水印+仅自己可见、xml/session 保留、stage 无残留 |

被替换的只有外部进程(ffmpeg/ffprobe、biliup、B站)。**没有改任何被测代码的行为,也没有新增注入点。**
唯一的 `vi.mock` 在 `node-side.test.ts`:节点侧执行体 `app/node-pipeline.ts` 直接 import biliup 模块、无注入口,
所以在模块边界顶替成假 biliup(其余仍是真实 `runNodeSidePipeline`)。

## 场景

`merge`(正常合并)、`segments`(分段)、`node-side`(节点侧,含 ssh 假失败回读)、`rolling`(边录边传,含 #57 R1「建稿中被杀、无稿件号 → 主控转人工」)、
`upload-retry`(超时/网关/不确定/被杀后的重试与降级)。`inventory-unreachable`(清单失联:单节点 + 双节点(#69),双节点下失联节点不能被当作空清单)。已知缺陷用 `it.fails` 标注并链接 issue
(现有:#46 重启后孤立分段;#66 追加已提交但响应丢失且回读延迟 → 重复追加;#59 节点侧追加分P计数核对已修复并转为真实用例);缺陷修复后用例会开始「意外通过」→ 去掉 `.fails`。

## 加新场景

```ts
s = await Scenario.create({ cfg: { cleanup: FULL_CLEANUP } });
s.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 }] });
s.fake.inject({ op: "append", mode: "ambiguous" });
await s.reconcile();
await s.restart();            // 模拟进程重启
await s.reconcile();
expectHealthyDone(s, s.onlyKey(), { parts: 3 });
```

多节点:`Scenario.create({ extraNodes: ["n2"] })` 后 `s.record({ node: "n2", ... })`;每个节点独立录像目录、
独立 `LocalTransport`,`wrapTransport(base, s, nodeId)` 按节点包装,`s.recordingFiles(anchor, nodeId)` 查各节点源。

## 口径说明

- 「stage 无残留」按 `FULL_CLEANUP`(三个清理开关全开)判定;只开 `sourceAfterDone`+`stageAfterDone` 时,
  整稿核验通过后 stage 内视频类(`.ts/.flv/.mp4`、`.work/`、`.upload/`,含拉回的源段副本)也会一并清(#60,
  见 `stage-clean.test.ts`);核验未过/待重试、无稿件号(stage 模式)的场一律不动。
- `.drec-node-result.json`(节点侧结果凭据)是有意保留的小文件(场次日志 `job.log` 自 #334 起写在 `<root>/logs/hub/` 下,旧场次仍在 stage 内),不算残留。
- ffmpeg 产物只是占位文件;转码/烧录正确性不在本脚手架范围(由 post-process 各自单测覆盖)。
