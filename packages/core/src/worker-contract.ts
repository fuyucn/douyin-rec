/**
 * worker-contract.ts — hub worker(录制节点)与「下发任务对账结果」的纯类型契约。
 *
 * 同形状曾在 app/worker-store、orchestrator/transport、core/api-types 各写一份,
 * 字段升级容易只改一侧;统一放 core,app/orchestrator 各自别名或窄化使用。
 */

/** hub.config.json 的 `workers[]` 一项(truth = 该文件;id 唯一,local 不可删)。 */
export interface WorkerConfig {
  id: string;
  name?: string;
  kind: string;
  host?: string;
  dataRoot?: string;
  apiUrl?: string;
}

/** master 下发期望任务后,节点侧对账结果(_apply-tasks / local transport 返回)。 */
export interface ApplyTasksResult {
  /** 新建或收编成功(键 = `{platform}:{roomSlug}`)。 */
  applied: string[];
  /** 两阶段删除完成。 */
  removed: string[];
  /** 需硬停(受管任务被移出期望集且仍在运行)。 */
  pending: string[];
}
