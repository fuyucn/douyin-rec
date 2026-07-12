// 动态 pipeline 流程图构造:纯函数(不 import React/平台代码),根 vitest 可直接单测。
export interface FlowNode { key: string; x: number; y: number }
export interface FlowGraph { nodes: FlowNode[]; edges: Array<[string, string]> }
export type FlowCfg = {
  steps?: { burnDanmu?: boolean; burnLivechat?: boolean };
  upload?: { mode?: string };
  cleanup?: { stageSourceAfterMerge?: boolean; sourceAfterDone?: boolean; stageAfterDone?: boolean };
};

const COL = 170;
const Y_MID = 70, Y_TOP = 10, Y_BOT = 130;
const TERMINAL = new Set(["done", "failed", "needs_manual"]);
const OPTIONAL = [
  "burn_danmu", "burn_livechat", "clean_stage_src",
  "upload_plain", "append_danmu", "append_livechat",
  "clean_source", "clean_stage",
] as const;

/** 该 run 要画哪些可选节点:终态按实际 steps;进行中按规则配置(+已有事件兜底)。 */
export function presentSet(
  job: { state: string; steps: { step: string }[] },
  cfg: FlowCfg | undefined,
): Set<string> {
  const has = (k: string): boolean => job.steps.some((s) => s.step === k);
  const p = new Set<string>(["select", "pull", "merge"]);
  for (const k of OPTIONAL) if (has(k)) p.add(k); // 已跑过的一律画(兜底 + 终态即全部依据)
  if (!TERMINAL.has(job.state) && cfg) {
    const st = cfg.steps ?? {};
    const up = cfg.upload?.mode === "upload";
    const cl = cfg.cleanup ?? {};
    if (st.burnDanmu !== false) p.add("burn_danmu");
    if (st.burnLivechat !== false) p.add("burn_livechat");
    if (up) p.add("upload_plain");
    if (up && st.burnDanmu !== false) p.add("append_danmu");
    if (up && st.burnLivechat !== false) p.add("append_livechat");
    if (cl.stageSourceAfterMerge) p.add("clean_stage_src");
    if (cl.sourceAfterDone) p.add("clean_source");
    if (cl.stageAfterDone) p.add("clean_stage");
  }
  return p;
}

export function buildFlow(
  job: { state: string; steps: { step: string }[] },
  cfg: FlowCfg | undefined,
): FlowGraph {
  const p = presentSet(job, cfg);
  const keep = (arr: string[]): string[] => arr.filter((k) => p.has(k));
  const spine = ["select", "pull", "merge"];
  const burnLane = keep(["burn_danmu", "burn_livechat", "clean_stage_src"]);
  const uploadLane = keep(["upload_plain"]);
  const tail = [...keep(["append_danmu", "append_livechat", "clean_source", "clean_stage"]), "__term__"];

  const nodes: FlowNode[] = [];
  spine.forEach((k, i) => nodes.push({ key: k, x: i * COL, y: Y_MID }));
  const forkStart = spine.length;
  const forked = burnLane.length > 0 && uploadLane.length > 0; // 只有两轨都在才分叉
  burnLane.forEach((k, i) => nodes.push({ key: k, x: (forkStart + i) * COL, y: forked ? Y_TOP : Y_MID }));
  uploadLane.forEach((k, i) => nodes.push({ key: k, x: (forkStart + i) * COL, y: forked ? Y_BOT : Y_MID }));
  const forkWidth = Math.max(burnLane.length, uploadLane.length);
  const tailStart = forkStart + forkWidth;
  tail.forEach((k, i) => nodes.push({ key: k, x: (tailStart + i) * COL, y: Y_MID }));

  const edges: Array<[string, string]> = [["select", "pull"], ["pull", "merge"]];
  const chain = (arr: string[]): void => { for (let i = 0; i + 1 < arr.length; i++) edges.push([arr[i], arr[i + 1]]); };
  chain(burnLane); chain(uploadLane); chain(tail);
  const joinTarget = tail[0]; // 恒有(至少 __term__)
  if (burnLane.length) { edges.push(["merge", burnLane[0]]); edges.push([burnLane[burnLane.length - 1], joinTarget]); }
  if (uploadLane.length) { edges.push(["merge", uploadLane[0]]); edges.push([uploadLane[uploadLane.length - 1], joinTarget]); }
  if (!burnLane.length && !uploadLane.length) edges.push(["merge", joinTarget]);

  return { nodes, edges };
}

const SIZE_RE = /\d[\d.]*\s?[KMGT]?B\b/;
/** 节点面板显示的关键指标:清理步取删除计数,其余取大小段;无 → null(组件回落耗时)。 */
export function pickMetric(step: string, detail?: string): string | null {
  if (!detail) return null;
  if (step.startsWith("clean_")) {
    const m = detail.match(/删\s*\d+\s*\S+/);
    return m ? m[0].replace(/\s+/g, " ").trim() : null;
  }
  const m = detail.match(SIZE_RE);
  return m ? m[0] : null;
}
