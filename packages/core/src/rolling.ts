/**
 * rolling.ts — 「边录边传」的**纯判定**(rank 0,无 IO,唯一真理源)。
 *
 * 背景(见 plans/031_rolling_segment_upload.md / T-33):整场录完才做 merge/upload,多房间同时
 * 在录时节点盘会被源 + 中间产物写满,后处理写盘失败、源也删不掉。本模块提供「哪些分段已经
 * **封口**、可以安全上传 / 删除」的判定 —— 录制端(app 的 RollingUploader)与后处理端
 * (master 删源)共用**同一份**判定,避免两处各写一套(踩过的「判定逻辑两处各写一份」坑)。
 *
 * 硬性不变量(与 plans/031 对齐):
 *   1. 只处理**已经封口**的分段。正在写(growing)的那个文件永不上传、不删除、不选优。
 *   2. 一个分段的源视频只在**它自己**得到上传确认(BV / append ack)**之后**才删。
 *   3. `.xml` / `.ass` 不随分段删除(弹幕源不可再生)。
 *   4. 落败节点的同段**不得早于**胜出段的确认就删(绝不销毁唯一副本)。
 *   5. 磁盘低于水位 → 拒绝**新开录**,但绝不截断/删除正在录的当前段来腾空间。
 *
 * 为什么放 core:orchestrator(L4.5,master 删源)与 app(L4,录制端上传/删段)都要用,
 * 但 app 不能 import orchestrator(test/arch/layering.test.ts 守护)。判定下沉到 core 即两侧可共用。
 */

import { stampedSessionBaseOf } from "./session-name.js";

/** 一个录制分段(节点本地文件)在「边录边传」里的最小投影。 */
export interface RollingSegment {
  /** 节点本地绝对/相对路径(.ts / .flv)。 */
  path: string;
  /** 全场段序号(0 基,跨会话连续,按 `onSegment` 触发顺序)。 */
  index: number;
  /** 该文件最后修改时间(epoch ms);用于「停止写入后是否已稳定」的 grace 判定。 */
  mtimeMs: number;
  /** 字节数(可选,诊断/水位展示用)。 */
  bytes?: number;
}

export interface SealOpts {
  /** 录制器是否仍在活动(还有子进程在写)。false = 本场已收尾(最后一段也视为封口)。 */
  recordingActive: boolean;
  /** 当前时刻(epoch ms;可注入测试)。 */
  nowMs: number;
  /**
   * 收尾后最后一段的「稳定宽限」ms:进程刚退出时文件可能还在 flush,等这么久再认定封口。
   * 录制中(有新段存在)不受此限 —— ffmpeg 滚动到新段即已关闭旧段。缺省 {@link DEFAULT_SEAL_GRACE_MS}。
   *
   * ⚠️ 仅在调用方**无法确知**写入是否已停止时才需要宽限;调用方**确知**进程已退出(如录制端
   * 收尾:`await recorder.stop()` 之后)→ 必须传 **0**,否则「刚写完就收尾」的末段永远判不出封口
   * = 永不上传(实测踩过:整场残段、master 转人工)。
   */
  sealGraceMs?: number;
}

/** 收尾后最后一段的默认稳定宽限(ms)。 */
export const DEFAULT_SEAL_GRACE_MS = 3_000;

/**
 * 返回**已封口**分段的段号集合。规则:
 *   - 存在**更晚**的段(i < maxIndex)→ 旧段已被 ffmpeg 关闭 → 封口(与时间无关,滚动即封口)。
 *   - 只有**最新**段:录制仍在活动 → **未封口**(正在写);录制已收尾 → 需 `now - mtime ≥ grace`
 *     才认定封口(进程退出瞬间文件可能还在 flush)。
 *
 * 空数组 → 空集;单段 + 仍在录 → 空集(绝不碰正在写的唯一段)。纯函数,便于单测。
 */
export function sealedSegmentIndices(
  segments: readonly RollingSegment[],
  opts: SealOpts,
): Set<number> {
  const sealed = new Set<number>();
  if (segments.length === 0) return sealed;
  const grace = Math.max(0, opts.sealGraceMs ?? DEFAULT_SEAL_GRACE_MS);
  // 段号可能不连续/乱序(重连重开);按 index 取最大段号才是「最新」。
  const maxIndex = segments.reduce((m, s) => (s.index > m ? s.index : m), segments[0].index);
  for (const s of segments) {
    if (s.index < maxIndex) { sealed.add(s.index); continue; }
    // 最新段:仅在「录制已收尾且文件已稳定」时才算封口。
    if (!opts.recordingActive && opts.nowMs - s.mtimeMs >= grace) sealed.add(s.index);
  }
  return sealed;
}

/**
 * 待上传的封口段(封口 **且** 尚未确认),按段号升序。`confirmed` = 已拿到 BV/ack 的段号集合。
 * 保证输出顺序 = 上传顺序 = 分 P 顺序(段号字典序)。
 */
export function planRollingUploads(
  segments: readonly RollingSegment[],
  opts: SealOpts,
  confirmed: ReadonlySet<number>,
): RollingSegment[] {
  const sealed = sealedSegmentIndices(segments, opts);
  return segments
    .filter((s) => sealed.has(s.index) && !confirmed.has(s.index))
    .sort((a, b) => a.index - b.index);
}

/**
 * **头阻塞（head-of-line）过滤**：按段号升序，返回**首个阻塞段之前**的全部段。
 *
 * 为什么必须：B 站 append 只能追加到末尾，分 P 必须连续、不能有洞。若第 `k` 段结果未定
 * （`ambiguous` / 失败待重试），还继续上传后面的段，缺口将**永久无法填补** —— 分 P 出现
 * 不可逆空洞/乱序。因此「阻塞段及其之后」的段一律不外发，直到 `k` 结清。
 *
 * `blocking` = 已卡住的段号集合（结果不确定、保留源、转人工）。不传 = 空集 = 不阻塞。
 */
export function headOfLineFilter(
  pending: readonly RollingSegment[],
  blocking: ReadonlySet<number> = new Set(),
): RollingSegment[] {
  const out: RollingSegment[] = [];
  for (const s of [...pending].sort((a, b) => a.index - b.index)) {
    if (blocking.has(s.index)) break;
    out.push(s);
  }
  return out;
}

/**
 * **磁盘水位闸门**:剩余空间低于水位 → 拒绝新开录(绝不靠删未确认源腾空间)。
 * `watermarkBytes <= 0` = 关闭该闸门(向后兼容/未配置)。返回 true = 应拒绝启动**新**录制。
 *
 * 注意语义:只拦「新开一场」;正在录的当前场**不受影响**(调用方不得据此截断当前录制)。
 */
export function shouldRefuseNewRecording(freeBytes: number, watermarkBytes: number): boolean {
  if (!(watermarkBytes > 0)) return false;
  return !(freeBytes >= watermarkBytes);
}

/** 房间身份(跨节点聚类/删源的身份证据):必须 (platform, roomSlug) 一致。 */
export interface RoomIdentity {
  platform: string;
  roomSlug: string;
}

/**
 * 两段录像是否**同一房间**。跨节点删源前必须过这一关 —— **绝不靠主播名**(改名/同名会撞)。
 * 任一字段为空 → false(宁可不删,也不误删他人房间)。
 */
export function sameRoomIdentity(a: RoomIdentity, b: RoomIdentity): boolean {
  const pa = (a.platform ?? "").trim();
  const pb = (b.platform ?? "").trim();
  const ra = (a.roomSlug ?? "").trim();
  const rb = (b.roomSlug ?? "").trim();
  if (!pa || !pb || !ra || !rb) return false;
  return pa === pb && ra === rb;
}

/** 删某节点一段源视频所需的**证据**。任一不满足 → 不删(不可逆操作必须保守)。 */
export interface DeleteEvidence {
  /** 该段是否已封口(未封口 = 可能还在写 → 绝不删)。 */
  sealed: boolean;
  /**
   * 该段是否已确认上传成功(BV / append ack)。**必须**为 true —— 未确认的段删了就没了。
   */
  ack: boolean;
  /** 本场要删的段所属房间身份。 */
  segmentRoom: RoomIdentity;
  /** 本次操作针对的房间身份(来自任务/hub 规则)。必须与 segmentRoom 一致。 */
  targetRoom: RoomIdentity;
}

/**
 * 是否允许删除一段**源视频**。三重证据齐备才 true:
 *   ① 已封口(不在写);② 已确认上传(ack);③ 房间身份一致。
 * 这是「边录边传」与跨节点删源的**唯一删源闸门**,任何删段路径都必须先过它。
 */
export function canDeleteRollingSource(ev: DeleteEvidence): boolean {
  return ev.sealed && ev.ack && sameRoomIdentity(ev.segmentRoom, ev.targetRoom);
}

/** 由已确认段号集合 + 新确认段号,得到合并后的集合(幂等;用于续跑/重入)。 */
export function withConfirmed(
  confirmed: ReadonlySet<number>,
  ...newly: number[]
): Set<number> {
  const out = new Set(confirmed);
  for (const n of newly) out.add(n);
  return out;
}

/**
 * 边录边传的**跨节点重复投稿闸门**判定(纯函数)。
 *
 * 为什么需要:边录边传是**录制节点自己**建稿(P1)。若同一房间被多个节点录制,每台各建一个稿
 * → **重复投稿**(B 站不可逆)。整场管线在 master 侧选优后只传 winner,天然不重复 —— 这正是两者
 * 不能混用的原因。
 *
 * ⚠️ **必须在 master 下发/派发时判定**,不能在 worker 节点上判定 —— hub 规则文件只存在于
 * master,worker 上没有规则可供判断(master 误配时 worker 会静默各建稿)。
 *
 * @param workers 该房间 hub 规则选中的 worker id 列表;**undefined / 空数组 = 全部节点**
 *   (hub 语义:缺省即全部)→ 视为多节点,不安全;**恰好 1 个** → 安全。
 * @param hasRule 该房间是否配了 hub 规则。**无规则 = 单机/未编排** → 只有一个录制节点 → 安全。
 */
export function rollingUploadSingleNode(
  hasRule: boolean,
  workers: readonly string[] | undefined,
): boolean {
  if (!hasRule) return true; // 无 hub 规则 → 单机/未编排,只有一个录制节点
  if (!workers || workers.length === 0) return false; // 规则在但未勾选 = 全部节点 → 多节点
  return workers.length === 1;
}

/** 从分段文件名推**会话 base**(如 `主播_2026-10-12_09-30-00`);语义见 `stampedSessionBaseOf`。 */
export function segmentSessionBase(fileName: string): string | undefined {
  return stampedSessionBaseOf(fileName);
}

/** 是否视频源分段(可删/可传);`.xml`/`.ass` 恒为 false(弹幕源不可再生,绝不随分段删)。 */
export function isVideoSegment(fileName: string): boolean {
  return /\.(ts|flv)$/i.test(fileName);
}
