/**
 * api-mode.ts — 抖音 API 模式(取流 + 弹幕 liveId 用哪个端点)的**唯一读取点**。
 *
 * 单独成模块(而非放 index.ts)的原因:index.ts 与 probe.ts 互相 import,若规则散在 index.ts
 * 会让 probe 依赖它 → 循环引用。这里只依赖 @drec/core,谁都可安全引入。
 *
 * 来源优先级:**env `DOUYIN_REC_API_MODE`**(serve 从全局设置 `settings.douyinApiMode` 注入录制
 * 子进程;见 app/process/spawner) > 默认 `balance`。为什么走 env 而不是 Platform.getStream 参数:
 * `getStream(channelId, quality, cookies)` 是**三方平台契约**(bilibili 也用),不该加抖音专属参数;
 * 且这是**全局设置**(UI 里一份),不是 per-task 字段。子进程是独立 `record` 进程、无 DB 访问,
 * 只能靠 spawner 透传 env(与 MESIO_PATH 同一条路)。
 *
 * 值域/归一**单一真理源 = @drec/core 的 `DOUYIN_API_MODES`/`normalizeDouyinApiMode`**(与 UI 下拉、
 * 设置 API 共用一份),这里不重复写白名单 —— 否则新增模式时容易「core 加了、这里没加」。
 */
import { normalizeDouyinApiMode } from "@drec/core";

export function resolveApiMode(): string {
  return normalizeDouyinApiMode(process.env.DOUYIN_REC_API_MODE);
}
