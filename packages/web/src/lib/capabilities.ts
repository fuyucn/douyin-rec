// lib/capabilities.ts — 节点角色能力矩阵(plans/047 §3.2)。纯函数,无 DOM/atom 依赖,可单测。
//
// **唯一真理**:页面不再各自判断 `hubEnabled`,而是问「本节点能不能做这件事」。
// 录制半边(`editRecording` / `createRoom`)两端都有。
// 直播直传是 task 字段,节点 UI 可开启(非 hub 任务);边录边传读主控派生的 rolling,节点不提供;
// `editPipeline` 只管处理/投稿半边。
// 处理半边(`editPipeline` / `hubRule`)与 master 专有页(`nodes` / `queue` / `stats` / `mergePanel` / `runs`)
// 只在 hub master 上成立。

export interface NodeCaps {
  /** 房间页所有节点都有(唯一用户可见入口)。 */
  rooms: true;
  /** 两端都能建房间(worker 建出来只有录制半边)。 */
  createRoom: true;
  /** 两端都能改录制半边(时间/名字/画质/引擎/分段/弹幕/账号)。 */
  editRecording: true;
  /** master only:合并 / 烧录 / 节点直传 / 上传投稿 / 清理。 */
  editPipeline: boolean;
  /** master only:规则文件只在主控配置与生效。 */
  hubRule: boolean;
  /** master only:节点页、节点选择、节点状态。 */
  nodes: boolean;
  /** master only。 */
  queue: boolean;
  /** master only。 */
  stats: boolean;
  /** master only:任务级手工合并。 */
  mergePanel: boolean;
  /** master only:hub 运行历史。 */
  runs: boolean;
}

/**
 * `hubEnabled === null` = 启动探测还没回来 → **按 worker 保守**:
 * 宁可不显示写操作,也不显示越权按钮(plan §3.2 注 / §6 F5)。
 * 首页/导航另由 `nav.homeTarget` 等待探测完成,避免闪跳。
 */
export function nodeCaps(hubEnabled: boolean | null): NodeCaps {
  const master = hubEnabled === true;
  return {
    rooms: true,
    createRoom: true,
    editRecording: true,
    editPipeline: master,
    hubRule: master,
    nodes: master,
    queue: master,
    stats: master,
    mergePanel: master,
    runs: master,
  };
}
