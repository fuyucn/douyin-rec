/**
 * upload-contract.ts — 上传输入契约(平台无关)。
 *
 * 放在 core 而不是 app:orchestrator(L4.5) 需要这份类型来编排上传节点,但它不应该依赖
 * app(L4) 的实现。biliup 实现(@drec/app)自行把它映射成命令行参数。
 */

/** biliup `upload --line` 的线路取值。 */
export type UploadLine =
  | "bldsa" | "cnbldsa" | "andsa" | "atdsa" | "bda2" | "cnbd" | "anbd" | "atbd"
  | "tx" | "cntx" | "antx" | "attx" | "bda" | "txa" | "alia";

export interface UploadOpts {
  /** 单个视频(P1 建稿)。**多文件建稿**(分段上传)时改用 `videos`。 */
  video?: string;
  /**
   * 多文件建稿:一次 `biliup upload` 提交多个文件 → 同一稿件多个分 P(分段上传模式)。
   * 非空时优先于 `video`。与 append 一样,单次多文件 upload 是 biliup 的正常用法。
   */
  videos?: string[];
  cookies: string;
  title: string;
  tag: string;
  tid: number;
  public: boolean;
  desc?: string;
  line?: UploadLine;
}

/**
 * append(追分P)结果**不确定**的标记:请求已发出但客户端没拿到成功响应(超时/断连),
 * 服务端可能已经追加成功。调用方**不得自动重试**(会重复分P),应转人工核对。
 */
export const APPEND_AMBIGUOUS_MARKER = "[append-ambiguous]";

export function isAppendAmbiguous(err: unknown): boolean {
  return String((err as Error)?.message ?? err).includes(APPEND_AMBIGUOUS_MARKER);
}

/**
 * B 站**投稿频率限制**错误。两种已知码:
 *   - `601`「您上传视频过快,请您稍作休息后再继续」(按提交次数限流)。
 *   - `21566`「投稿过于频繁,建议将APP升级至最新版本后再试」(app 提交接口更易触发,见
 *     biliup#1609 / social-auto-upload#210;biliup 自己的 server 端因此默认改走 web 接口)。
 * 都是按**提交次数**的限流(与并发数无关):连发若干次提交即被拒。识别到它应
 * **长时间冷却后重试**(而不是立刻重试或直接转人工)——该次提交未成功,不影响幂等。
 *
 * 漏掉 21566 的后果(2026-10-09 实况):建稿撞上 21566 后按「非限流」只退避 60s 重试,
 * 仍处风控窗口 → 二次失败 → 整场转人工,白等一场。
 */
export function isUploadRateLimited(err: unknown): boolean {
  const s = String((err as Error)?.message ?? err);
  return /upload rate limit|code:\s*601|code:\s*21566|上传视频过快|上传过快|投稿过于频繁/i.test(s);
}
