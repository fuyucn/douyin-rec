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
  /**
   * Optional Bilibili season section id (issue #364). Bilibili has no ordinary-season field on the
   * submit request, so the uploader adds the archive after a successful P1 create. Empty = off.
   */
  seasonSectionId?: number;
  /** Best-effort note channel for post-upload side effects (season association). */
  onNote?: (msg: string) => void;
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
 * B 站**投稿频率限制**错误。三种已知码:
 *   - `601`「您上传视频过快,请您稍作休息后再继续」(按提交次数限流)。
 *   - `21566`「投稿过于频繁,建议将APP升级至最新版本后再试」(app 提交接口更易触发,见
 *     biliup#1609 / social-auto-upload#210;biliup 自己的 server 端因此默认改走 web 接口)。
 *   - `21540`「请求过于频繁,请稍后再试」(实测 2026-10-18:web `edit` 连续追 P 时命中;
 *     与 601/21566 同类 —— 按提交次数限流,该次提交未生效,冷却后可安全重试)。
 *   - `21186`「您投稿的频率过快,请稍等2秒」(实测 2026-10-18:**两个房间同时建稿**时命中)。
 *     同属按提交次数限流。漏掉它的代价是一场直播白录:该分 P 的字节已经传上去,却因为建稿
 *     被拒而整段丢弃 —— 零落盘模式下连本地副本都没有,数据直接消失。
 * 都是按**提交次数**的限流(与并发数无关):连发若干次提交即被拒。识别到它应
 * **长时间冷却后重试**(而不是立刻重试或直接转人工)——该次提交未成功,不影响幂等。
 *
 * 漏掉 21566 的后果(2026-10-09 实况):建稿撞上 21566 后按「非限流」只退避 60s 重试,
 * 仍处风控窗口 → 二次失败 → 整场转人工,白等一场。
 * 漏掉 21540 的后果(2026-10-18 实况):web `edit` 追 P 撞上 21540 后按「永久失败」处理,
 * 整个分 P 判失败、后续分 P 头阻塞,一场直播白录。
 * 漏掉 21186 的后果(2026-10-18 实况):两个房间同时开录,第二个的建稿被它拒掉 → 已上传的
 * 分 P 字节整段丢失,该房间整场没有产出。
 */
export function isUploadRateLimited(err: unknown): boolean {
  const s = String((err as Error)?.message ?? err);
  return /upload rate limit|code:\s*601|code:\s*21566|code:\s*21540|code:\s*21186|上传视频过快|上传过快|投稿过于频繁|投稿的频率过快|请求过于频繁/i.test(s);
}

/**
 * 0 落盘边录边传(plans/039 `streamUpload`)与滚动边录边传(`rollingEffective`)**互斥**:
 * 前者 ffmpeg 管道 stdout → UPOS 直传、源录像不落盘;后者靠节点上的**文件**分段滚动上传。
 * 同时开启没有可执行的语义(要么丢源文件、要么没有文件可传),必须由写入侧拒绝。
 *
 * 返回 true 表示**冲突**,调用方应回 400 / 抛错。用 core 里的单一函数而不是各处各判一次,
 * 免得 Web 表单、API、hub 同步三处判定漂移。
 */
export function streamUploadConflicts(
  streamUpload: boolean | null | undefined,
  rollingEffective: boolean | null | undefined,
): boolean {
  return streamUpload === true && rollingEffective === true;
}
