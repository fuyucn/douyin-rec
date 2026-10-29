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
  /**
   * 该节点具备的能力标签(自由字符串,缺省 = 无特殊能力)。hub 规则用 `requires` 声明房间需要的
   * 能力,reconciler/任务同步据此**硬过滤**:不满足的节点不参与该房间的录制与后处理。
   *
   * 约定词表(不强校验,便于扩展):
   *   - `record`            —— 能录制(所有 worker 事实上都具备,通常不必标)
   *   - `danmu:<platform>`  —— 该出口能拿到弹幕(如 `danmu:douyin`)。**出口 IP 被风控拿不到弹幕的节点不要标**
   *   - `burn` / `upload`   —— 能烧录 / 能传 B 站(仅对后处理阶段有意义的节点标)
   *
   * 典型用法:某 VPS 出口被抖音风控 → 不给它标 `danmu:douyin`;要弹幕的房间写
   * `requires: ["danmu:douyin"]` → 该 VPS 自动被排除,不再出现「勾了它却整场 0 弹幕」的静默失败。
   */
  capabilities?: string[];
}

/** master 下发期望任务后,节点侧对账结果(_apply-tasks / local transport 返回)。 */
export interface ApplyTasksResult {
  /** 新建或收编成功(键 = `{platform}:{roomSlug}`)。 */
  applied: string[];
  /** 两阶段删除完成。 */
  removed: string[];
  /** 需硬停(受管任务被移出期望集且仍在运行)。 */
  pending: string[];
  /**
   * 本轮期望被**安全阀拒绝**的原因(向后兼容:旧字段为 `undefined`)。
   *
   * 为什么需要:master 读不到 `config/hub/`(目录缺失/坏 JSON/权限)时,`listHubRules` 历史上
   * catch → `[]` → 「没有房间」→ desired 为空 → 节点按「缺席即删」把**所有受管任务两阶段删光**
   * (2026-10-09 实测复现,plans/029 §9.2)。守卫命中时返回而不删,并把原因透出到日志/UI,
   * 避免「master 一次异常 = 全节点任务被清空」这类静默数据丢失。
   *
   * - `empty-desired`  期望为空但本地有受管任务 → 整轮拒绝(疑似 master 配置不可读)
   * - `mass-shrink`    期望骤减超过阈值 → 只停用不删除
   */
  rejected?: string;
}
