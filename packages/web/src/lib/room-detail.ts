// lib/room-detail.ts — derived labels + 角色裁剪判定 for the room screens (pure, testable without a DOM).
import { burnFlags } from "@drec/rolling-policy";
import type { RoomDTO } from "../api/client";
import type { NodeCaps } from "./capabilities";

/**
 * Which outputs a room delivers, as i18n keys. Burn flags use the core authority `burnFlags`
 * (default ON, independent of archive/upload — stage mode burns too). Without a danmu file there
 * is nothing to burn, matching the editor's reading (`danmu` off → burn off).
 */
export function versionKeys(room: Pick<RoomDTO, "processing" | "recording">): string[] {
  // Same reading as the editor's `burnVersionsApply`: no rule, or a paused rule, runs no steps.
  if (!room.processing || room.processing.enabled === false) return ["room.editor.original"];
  const f = burnFlags(room.processing.pipeline?.steps);
  const canBurn = room.recording ? !!room.recording.danmu : true;
  return [
    "room.editor.original",
    ...(canBurn && f.burnDanmu ? ["room.editor.danmuVer"] : []),
    ...(canBurn && f.burnLivechat ? ["room.editor.livechatVer"] : []),
  ];
}

/** 一个房间能提供的写操作(列表 + 详情共用同一份判定,plan §3.3)。 */
export interface RoomActions {
  /** 受管(`managedBy === "hub"`)= 整个房间只读:只剩「查看 / 日志 / 运行历史」。 */
  readOnly: boolean;
  startStop: boolean;
  drain: boolean;
  edit: boolean;
  remove: boolean;
}

/**
 * 房间动作的唯一判定(plan §3.3 / §3.2)。
 *
 * - 受管 = 只读,与角色无关:master 上的受管房间同样没有启停/排空/编辑/删除。
 * - `caps` 刻意**不**参与启停/编辑判定。启停是录制半边:worker 上没有 hub 编排能力
 *   (`caps.editPipeline === false`),但它对自己的**非受管**任务照样能启停/改录制参数 ——
 *   拿 `editPipeline` 当闸门会让 worker 永远停不掉自己的录制。
 *   参数保留是为了让调用点只有一个形状(免得以后每加一条判定又改一遍签名)。
 */
export function roomActionsFor(input: { managed: boolean; caps: NodeCaps }): RoomActions {
  const readOnly = input.managed;
  return { readOnly, startStop: !readOnly, drain: !readOnly, edit: !readOnly, remove: !readOnly };
}

/** 页面「能看见什么」(plan §3.2 / §4.1)——worker 上处理半边与 master 专有面板一律不挂。 */
export interface RoomVisibility {
  /** 处理半边:规则 / 交付方式 / 合成方式 / 版本,以及读 hub 台账的进度数据。 */
  processing: boolean;
  /** 节点列 / 节点名 / 本节点之外的节点明细。 */
  nodes: boolean;
  /** hub 运行历史(`RoomRunsPanel`)。 */
  runs: boolean;
  /** 任务级手工合并(`MergePanel`)。 */
  mergePanel: boolean;
  /** 直播直传时间线(数据来自 master 的台账)。 */
  liveUpload: boolean;
}

/**
 * `caps` 的 master-only 位就是可见性:`hubEnabled === null`(探测中)按 worker 保守渲染,
 * 宁可不显示,也不显示越权按钮(plan §3.2 注 / §6 F5)。
 */
export function roomVisibilityFor(caps: NodeCaps): RoomVisibility {
  return {
    processing: caps.editPipeline,
    nodes: caps.nodes,
    runs: caps.runs,
    mergePanel: caps.mergePanel,
    liveUpload: caps.runs,
  };
}
