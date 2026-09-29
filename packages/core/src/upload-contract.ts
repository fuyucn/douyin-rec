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
  video: string;
  cookies: string;
  title: string;
  tag: string;
  tid: number;
  public: boolean;
  desc?: string;
  line?: UploadLine;
}
