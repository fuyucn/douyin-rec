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
