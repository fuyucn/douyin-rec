import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { freemem } from "node:os";
import type { SyncLedger, StepName } from "./ledger.js";
import type { PipelineCfg, PipelineDeps } from "./pipeline.js";
import { humanBytes } from "./format.js";
import { addArchiveToSeasonIfConfigured, effectiveStageFormat, isAppendAmbiguous, isJobAbort, isUploadRateLimited, throwIfAborted, USER_STOP, UPLOAD_FAIL_CLOSED_MS } from "@drec/core";
import { retry } from "./retry.js";
import type { StageProducts } from "./session-plan.js";
import { prepareUploadAlias } from "./session-plan.js";
import { PART_GROUP_CANONICAL } from "./verify.js";
import { sanitizeUploadLimitState, type UploadLimitStore } from "./upload-limits.js";
import { UPLOAD_GATE_DEFAULT_KEY } from "@drec/core";

export { deriveStageProducts, withOutputStem, type StageProducts } from "./session-plan.js";

/** DAG 核心节点(select/pull 是前奏,clean_* 是收尾,均不进节点表)。 */
export type WorkflowNodeKey = Extract<
  StepName,
  "merge" | "burn_danmu" | "burn_livechat" | "upload_plain" | "append_danmu" | "append_livechat"
>;

export type ResourceKind = "cpu" | "net" | "upload" | "none";
export type ArtifactKind = "file" | "dir" | "ref";

/** 节点输入/输出契约;file/dir 检查存在与大小,ref 只检查非空。 */
export interface ArtifactSpec {
  name: string;
  kind: ArtifactKind;
  required?: boolean;
  minBytes?: number;
}

export interface WorkflowNode {
  key: WorkflowNodeKey;
  inputs: ArtifactSpec[];
  outputs: ArtifactSpec[];
  resource: ResourceKind;
  /** false 的步骤(burnDanmu=false / stage 模式的 upload/append)→ 节点直接 skipped 并放行下游。 */
  disabled?: boolean;
  run(ctx: NodeRunContext): Promise<void>;
}

export interface NodeRunContext {
  streamKey: string;
  stageSub: string;
  products: StageProducts;
  ledger: SyncLedger;
  deps: PipelineDeps;
  cfg: PipelineCfg;
  log(msg: string): void;
  /** 带 job.log 摘尾包装的子命令执行器(merge/burn 用);返回完整输出供调用方解析(如 integrity 告警)。 */
  sh(cmd: string): Promise<string>;
  /** 取产物值(file 路径 / dir 路径 / ref 字符串)。 */
  get(name: string): string | undefined;
  /** 节点 run 内声明产物。 */
  set(name: string, value: string): void;
  /** 节点成功后设置/读取 done 事件 detail。 */
  stepDetail(key: WorkflowNodeKey, detail?: string): string | undefined;
}

export interface WorkflowBuildInput {
  streamKey: string;
  stageSub: string;
  products: StageProducts;
  deps: PipelineDeps;
  cfg: PipelineCfg;
  log(msg: string): void;
  willUpload: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
  /** 该场拉下来的源段数(merge 完成 detail 用)。 */
  segmentCount: number;
}

export interface Workflow {
  ctx: NodeRunContext;
  nodes: WorkflowNode[];
  edges: Array<[WorkflowNodeKey, WorkflowNodeKey]>;
}

/**
 * 构造该场 DAG:merge → {burn_danmu, burn_livechat, upload_plain},upload+burn → append,
 * append_danmu → append_livechat(B 站 P2/P3 顺序)。禁用步骤 = disabled,由 executor 标 skipped 并放行下游。
 */
export function buildWorkflow(input: WorkflowBuildInput): Workflow {
  const { streamKey, stageSub, products, deps, cfg, log, willUpload, burnDanmu, burnLivechat, segmentCount } = input;
  const ledger = deps.ledger;
  const artifacts = new Map<string, string>();
  const details = new Map<string, string>();
  // append_livechat 只在 danmu 轨存在时依赖其 p2 输出(否则跳过 append_danmu 不应阻断 livechat)。
  const appendDanmuOn = willUpload && burnDanmu;
  const stageFmt = effectiveStageFormat(cfg.outputFormat, cfg.uploadMode);

  // 续跑幂等:已 done 的产物直接从确定性路径回填,下游 append 无需重跑上游也能拿到输入。
  if (ledger.getNodeState(streamKey, "upload_plain")?.state === "done") {
    const bv = ledger.get(streamKey)?.bv;
    if (bv) artifacts.set("bv", bv);
  }
  if (ledger.getNodeState(streamKey, "merge")?.state === "done") artifacts.set("plain.mp4", products.plain);
  if (ledger.getNodeState(streamKey, "burn_danmu")?.state === "done") artifacts.set("danmu.mp4", products.danmuMp4);
  if (ledger.getNodeState(streamKey, "burn_livechat")?.state === "done") artifacts.set("livechat.mp4", products.livechatMp4);
  if (ledger.getNodeState(streamKey, "append_danmu")?.state === "done") artifacts.set("p2", "done");

  const ctx: NodeRunContext = {
    streamKey,
    stageSub,
    products,
    ledger,
    deps,
    cfg,
    log,
    sh: async (cmd: string): Promise<string> => {
      log(`$ ${cmd}`);
      const t0 = Date.now();
      const out = await deps.sh(cmd);
      log(`  ✓ 完成(${Math.round((Date.now() - t0) / 1000)}s)`);
      if (typeof out === "string" && out.trim()) log(`  输出尾: ${out.trim().slice(-2048)}`);
      return out ?? "";
    },
    get: (name: string): string | undefined => artifacts.get(name),
    set: (name: string, value: string): void => { artifacts.set(name, value); },
    stepDetail: (key: WorkflowNodeKey, detail?: string): string | undefined => {
      if (detail !== undefined) details.set(key, detail);
      return details.get(key);
    },
  };

  const fileBytes = (p: string): number => {
    try { return Number(statSync(p).size); } catch { return 0; }
  };
  const isPublic = cfg.uploadPrivate === false;

  artifacts.set("src", stageSub);
  const plainXmlRequired = Boolean(
    (products.plainXml && existsSync(products.plainXml)) ||
    (products.xmlArg && products.xmlArg !== products.plainXml && existsSync(products.xmlArg)),
  );

  const nodes: WorkflowNode[] = [
    {
      key: "merge",
      inputs: [{ name: "src", kind: "dir", required: true }],
      outputs: [
        { name: "plain.mp4", kind: "file", required: true, minBytes: 1 },
        { name: "plain.xml", kind: "file", required: plainXmlRequired, minBytes: 1 },
      ],
      resource: "cpu",
      run: async (c: NodeRunContext): Promise<void> => {
        const multi = c.products.sessionBases.length > 1;
        // 断流重连多会话:一次 merge --merge-sessions 拼全部会话(视频 -c copy + 弹幕偏移合并)。
        // --out-base 锁定 stem(= B 站标题),stage 与投稿同一串。
        const outBase = shSingleQuote(products.dateName);
        // 产物容器:非 mp4 才带 --format(CLI 缺省 = mp4,默认路径的命令行与改动前逐字一致)。
        const fmtFlag = stageFmt === "mp4" ? "" : ` --format ${stageFmt}`;
        const cmd = multi
          ? `node dist/douyin-rec.mjs merge --in ${stageSub} --merge-sessions --out-base ${outBase}${fmtFlag}`
          : `node dist/douyin-rec.mjs merge --in ${stageSub} --base ${c.products.sessionBase} --out-base ${outBase}${fmtFlag}`;
        const out = await c.sh(cmd);
        // 录制产物体检:⚠ 是诊断明细(段级提示,只进 step detail),❗ 才是「成品确实有可见风险」,
        // 由 CLI 按成品尾部错误数判定阈值后打印 —— 只有 ❗ 才发通知,避免孤立坏块天天刷告警。
        const { parseIntegrityWarnings, parseIntegrityAlerts } = await import("@drec/post-process");
        const integrityWarns = parseIntegrityWarnings(out);
        const integrityAlerts = parseIntegrityAlerts(out);
        c.set("plain.mp4", products.plain);
        // 单会话才补拷源 xml 为 plain.xml;多会话的合并 xml 由 --merge-sessions 直接产出,不能覆盖。
        if (!multi && products.plainXml && products.xmlArg && products.xmlArg !== products.plainXml) {
          const { copyFileSync } = await import("node:fs");
          try {
            copyFileSync(products.xmlArg, products.plainXml);
          } catch { /* 源 xml 缺失则跳过(plain.xml 输出阀会兜底) */ }
        }
        if (products.plainXml && existsSync(products.plainXml)) c.set("plain.xml", products.plainXml);
        const bytes = fileBytes(products.plain);
        const detail = bytes > 0 ? `${segmentCount} 段 → ${humanBytes(bytes)}` : "";
        if (integrityAlerts.length > 0) {
          c.stepDetail("merge", `${detail}${detail ? " " : ""}❗ 体检告警`);
          c.deps.notify({
            kind: "error",
            stage: "合并",
            message: `${streamKey} 录制产物体检告警:${integrityAlerts.join(" · ")}`,
          });
        } else if (integrityWarns.length > 0) {
          // 段级提示(多为跳尾扫描伪影/孤立坏块):只在 UI 详情可见,不打扰用户。
          c.stepDetail("merge", `${detail}${detail ? " " : ""}⚠ 体检提示 ${integrityWarns.length} 条(未达告警阈值)`);
        } else if (detail) {
          c.stepDetail("merge", detail);
        }
      },
    },
    {
      key: "burn_danmu",
      disabled: !burnDanmu,
      inputs: [
        { name: "plain.mp4", kind: "file", required: true, minBytes: 1 },
        { name: "plain.xml", kind: "file", required: plainXmlRequired, minBytes: 1 },
      ],
      outputs: [{ name: "danmu.mp4", kind: "file", required: true, minBytes: 1 }],
      resource: "cpu",
      run: async (c: NodeRunContext): Promise<void> => {
        await c.sh(`node dist/douyin-rec.mjs burn --video ${products.plain} --xml ${products.plainXml} --style danmu --gift-value 0.9`);
        c.set("danmu.mp4", products.danmuMp4);
        const d1 = bytesDetail(products.danmuMp4);
        if (d1) c.stepDetail("burn_danmu", d1);
      },
    },
    {
      key: "burn_livechat",
      disabled: !burnLivechat,
      inputs: [
        { name: "plain.mp4", kind: "file", required: true, minBytes: 1 },
        { name: "plain.xml", kind: "file", required: plainXmlRequired, minBytes: 1 },
      ],
      outputs: [{ name: "livechat.mp4", kind: "file", required: true, minBytes: 1 }],
      resource: "cpu",
      run: async (c: NodeRunContext): Promise<void> => {
        await c.sh(`node dist/douyin-rec.mjs burn --video ${products.plain} --xml ${products.plainXml} --style livechat --gift-value 0.9`);
        c.set("livechat.mp4", products.livechatMp4);
        const d2 = bytesDetail(products.livechatMp4);
        if (d2) c.stepDetail("burn_livechat", d2);
      },
    },
    {
      key: "upload_plain",
      disabled: !willUpload,
      inputs: [{ name: "plain.mp4", kind: "file", required: true, minBytes: 1 }],
      outputs: [{ name: "bv", kind: "ref", required: true }],
      resource: "upload",
      run: async (c: NodeRunContext): Promise<void> => {
        const bv = await deps.uploadPlain({
          video: prepareUploadAlias(stageSub, "plain", products.plain, products.partTitles?.plain),
          cookies: cfg.cookies,
          // 投稿标题用宽松渲染(含空格/标点);stage 文件名 stem 仍是严格的 dateName。
          title: products.uploadTitle ?? products.dateName,
          tag: cfg.uploadMeta.tag,
          tid: cfg.uploadMeta.tid,
          public: isPublic,
          desc: cfg.uploadMeta.desc,
        });
        // checkpoint:P1 建稿成功即刻落库 bv —— 必须在这里(不能等 burn/split 完),
        // 否则 P1 成功后若后续节点失败,bv 丢失 → 重试重传 P1 → 重复稿。
        ledger.setBv(streamKey, bv);
        // The BV is durable now. The executor associates the season after this upload slot is released
        // (see runWorkflowNodes), so the bounded HTTP call never extends the global upload chain.
        if (cfg.uploadMeta.seasonSectionId) ledger.setSeasonState(streamKey, "pending");
        // 分P核验基线(T11):P1 = plain 组第 0 段。合并路径此前**完全不写** sync_parts →
        // 期望段数恒 0、核验恒跳过(等于没核验),而分段路径有 —— 两条路径基线口径必须一致。
        // 合并路径的 plain 是单文件(不切分),故恒 1 个分 P;段号 0 起(与分段路径同一口径)。
        ledger.markPartDone(streamKey, PART_GROUP_CANONICAL.plain, 0);
        c.set("bv", bv);
        const d3 = bytesDetail(products.plain);
        if (d3) c.stepDetail("upload_plain", d3);
      },
    },
    {
      key: "append_danmu",
      disabled: !(willUpload && burnDanmu),
      inputs: [
        { name: "danmu.mp4", kind: "file", required: true, minBytes: 1 },
        { name: "bv", kind: "ref", required: true },
      ],
      outputs: [{ name: "p2", kind: "ref", required: true }],
      resource: "upload",
      run: async (c: NodeRunContext): Promise<void> => {
        await runAppendGroup(
          c, "append_danmu",
          prepareUploadAlias(stageSub, "danmu", products.danmuMp4, products.partTitles?.danmu),
          "p2",
        );
      },
    },
    {
      key: "append_livechat",
      disabled: !(willUpload && burnLivechat),
      inputs: [
        { name: "livechat.mp4", kind: "file", required: true, minBytes: 1 },
        { name: "bv", kind: "ref", required: true },
        { name: "p2", kind: "ref", required: appendDanmuOn },
      ],
      outputs: [{ name: "p3", kind: "ref", required: true }],
      resource: "upload",
      run: async (c: NodeRunContext): Promise<void> => {
        await runAppendGroup(
          c, "append_livechat",
          prepareUploadAlias(stageSub, "livechat", products.livechatMp4, products.partTitles?.livechat),
          "p3",
        );
      },
    },
  ];

  const extraAppendEdge: Array<[WorkflowNodeKey, WorkflowNodeKey]> = appendDanmuOn
    ? [["append_danmu", "append_livechat"]]
    : [];
  const edges: Array<[WorkflowNodeKey, WorkflowNodeKey]> = [
    ["merge", "burn_danmu"],
    ["merge", "burn_livechat"],
    ["merge", "upload_plain"],
    ["upload_plain", "append_danmu"],
    ["burn_danmu", "append_danmu"],
    ["upload_plain", "append_livechat"],
    ["burn_livechat", "append_livechat"],
    ...extraAppendEdge,
  ];

  return { ctx, nodes, edges };
}

function bytesDetail(p: string): string | undefined {
  try { return `→ ${humanBytes(Number(statSync(p).size))}`; } catch { return undefined; }
}

function splitToSizeLimitSafe(mp4: string): Promise<string[]> {
  // 与旧 pipeline 一致:默认走 @drec/post-process 的 splitToSizeLimit;此处延迟 import 防顶层循环。
  return import("@drec/post-process").then((m) => m.splitToSizeLimit(mp4));
}

function sumBytesOf(files: string[]): number {
  return files.reduce((n, f) => { try { return n + Number(statSync(f).size); } catch { return n; } }, 0);
}

async function appendGroupSafe(o: {
  deps: PipelineDeps;
  bv: string;
  files: string[];
  isPublic: boolean;
  step: "append_danmu" | "append_livechat";
  log(msg: string): void;
  retry?: typeof retry;
}): Promise<void> {
  if (o.files.length === 0) return;
  // B站追加分 P 后稿件会短暂锁定(code 10010),退避 60s*2^n 等锁释放,避免几分钟的
  // 上传白跑 3 次就转人工。多段组无 per-part checkpoint,仍不自动重试(可能已 append 部分)。
  // 601(频率限制)与 append 结果无关,应重试;其余多文件组不重试(可能已部分提交)。
  const tries = o.files.length === 1 ? 5 : 3;
  const fn = (): Promise<void> => o.deps.appendGroup({
    bv: o.bv, files: o.files, cookies: o.deps.cfg.cookies, public: o.isPublic,
  });
  await (o.retry ?? retry)(fn, {
    tries,
    backoffMs: 60_000,
    sleep: o.deps.sleep,
    // append 结果不确定(可能已提交)→ 绝不重试,直接转人工(否则会重复分P)。
    // 601 频率限制 → 重试(队列会先冷却);其余按原规则(不确定结果不重试)。
    shouldRetry: (err) => isUploadRateLimited(err) || !isAppendAmbiguous(err),
    onRetry: (attempt, err) =>
      o.log(`append ${o.step} 第 ${attempt} 次失败,重试: ${String((err as Error)?.message ?? err).slice(0, 200)}`),
  });
}

async function runAppendGroup(
  c: NodeRunContext,
  step: "append_danmu" | "append_livechat",
  mp4: string,
  out: string,
): Promise<void> {
  const splitForUpload = c.deps.splitForUpload ?? splitToSizeLimitSafe;
  const files = await splitForUpload(mp4);
  await appendGroupSafe({
    deps: c.deps,
    bv: c.get("bv")!,
    files,
    isPublic: c.cfg.uploadPrivate === false,
    step,
    log: c.log,
  });
  // 分P核验基线(T11):**append 成功后**才记 checkpoint —— 失败/未提交的分 P 不进基线。
  // 组名用步骤名(`append_danmu`/`append_livechat`),与分段路径 `appendSegmentGroup` 完全一致
  // (不能另起 `danmu`/`livechat`:那会让核验读不到分段路径写的行,恒 mismatch)。
  const group = step === "append_danmu" ? PART_GROUP_CANONICAL.danmu : PART_GROUP_CANONICAL.livechat;
  for (let i = 0; i < files.length; i++) c.ledger.markPartDone(c.streamKey, group, i);
  c.set(out, "done");
  c.stepDetail(step, `${files.length} 段${files.length ? ` · ${humanBytes(sumBytesOf(files))}` : ""}`);
}

/** 共享资源池:cpu/net 各 max=1(可配置),cpu 前先过内存闸门。 */
export interface ResourcePoolCfg {
  maxCpuParallel?: number;
  maxNetParallel?: number;
  minBurnFreeMemMB?: number;
  /**
   * Minimum free memory (MB) before a merge node (ffmpeg concat `-c copy`, no re-encode) may start.
   * Default 512: measured peak RSS of a 1080p concat-copy is ~60 MB, so 512 is ~8x headroom.
   */
  minMergeFreeMemMB?: number;
  /** How long a node waits for memory before ONE alert is raised; waiting continues afterwards. */
  memWaitTimeoutMs?: number;
  /**
   * **热读取值器**(T15):传函数则每次判定都用它取当前值,改配置**立即生效、无需重启**。
   * 不传则退回上面的数字字段(行为不变)。
   *
   * 为什么用 getter 而不是「每 tick 重建 pool」:重建会把 T8/T19 持久化的
   * `uploadTimes`/`uploadBlockedUntil`/限流账本**静默清空** —— 那等于每次改配置
   * 都重新放行一次上传,正是 601 风控最怕的(自审:评审点名过这条捷径)。
   */
  maxCpuParallelLive?: () => number;
  maxNetParallelLive?: () => number;
  minBurnFreeMemMBLive?: () => number;
  minMergeFreeMemMBLive?: () => number;
  /**
   * **全局上传队列**:B 站按「提交次数」限流(`code 601 上传视频过快`),与并发数无关。
   * 故队列对「每一次提交」做限速:
   *   - `uploadRateLimit`:窗口内最多提交次数(缺省 5)。
   *   - `uploadRateWindowMs`:窗口长度 ms(缺省 600000 = 10 分钟)。
   *   - `uploadCooldownMs`:命中 601 后的冷却 ms(缺省 1800000 = 30 分钟),之后自动重试。
   * 池子在整个 master 进程内共享 → 多 hub 任务同时收播时上传统一排队,不会叠加打爆频率。
   * 0/负 关闭该限制。
   */
  uploadRateLimit?: number;
  uploadRateWindowMs?: number;
  uploadCooldownMs?: number;
}

/** ResourcePool.snapshot() 的返回:各资源占用 / 排队 / 上传窗口 / 冷却 + 正在等锁的场。 */
export interface PoolSnapshot {
  cpu: { active: number; queued: number; max: number };
  net: { active: number; queued: number; max: number };
  upload: { active: number; queued: number; cooldownUntil: number; windowUsed: number; windowLimit: number; windowResetAt: number };
  waiting: Array<{ streamKey: string; resource: "cpu" | "net" | "upload"; position: number; since: number }>;
}

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  /** 上限的**取值器**:T15 起可为 getter(每 tick 热读配置),也可为常量(默认)。 */
  private readonly resolveMax: () => number;
  constructor(max: number | (() => number)) {
    this.resolveMax = typeof max === "function" ? max : (): number => max;
  }
  /** 当前上限;非法值夹到 1(0 个并行 = 永远排队 = 看起来像卡死)。 */
  private max(): number {
    const n = this.resolveMax();
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }
  /** 只读快照:当前持锁数 / 等待队列长度 / 上限。 */
  snapshot(): { active: number; queued: number; max: number } {
    return { active: this.active, queued: this.queue.length, max: this.max() };
  }
  async acquire(): Promise<void> {
    if (this.active < this.max()) { this.active++; return; }
    // 排队。**拿到让渡的许可就算数,不再回到上面重新核对上限** ——
    // release() 让渡时已经 active++ 了,回去重判会看到 active>=max 于是**再排一次队**,
    // 造成「许可已让渡但没人接手」的活锁(实测 pipeline 全部超时)。
    // 并发上限在等待期间被调低时,已在队列里的人按**让渡时刻**的判定生效 ——
    // 这是一致且可解释的口径(不会超发:release 只让渡一个)。
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) { this.active++; next(); }
  }
}

function systemFreeMemMB(): number {
  try {
    const mem = readFileSyncSafe("/proc/meminfo");
    if (mem) {
      const m = /^MemAvailable:\s*(\d+)\s*kB/m.exec(mem);
      if (m) return Number(m[1]) / 1024;
    }
  } catch { /* 非 Linux → fallback */ }
  return freemem() / 1024 / 1024;
}

function readFileSyncSafe(p: string): string | undefined {
  try { return readFileSync(p, "utf-8"); } catch { return undefined; }
}

export class ResourcePool {
  /**
   * 限流状态存储不可用时的兜底冷却下限(ms);防止配置 cooldown=0 时 fail-closed 退化成无限速。
   *
   * **引用 core 的同名常量,不再自己写一份 30min**:这是 T19 之后 master 侧与节点侧
   * 唯一的 fail-closed 口径。两处各写 `30 * 60_000` 时,改了一处另一边不会跟着变,
   * 且不会有任何报错 —— 表现为「某条路径的 fail-closed 悄悄变成别的值」。
   * (跨任务审计发现)
   */
  static readonly UPLOAD_FAILCLOSED_MS = UPLOAD_FAIL_CLOSED_MS;
  private cpu: Semaphore;
  private net: Semaphore;
  private streamLocks = new Map<string, Promise<unknown>>();
  /** 全局上传队列:一条跨所有 streamKey 的串行链 + 上次提交时刻(算最小间隔)。 */
  private uploadChain: Promise<unknown> = Promise.resolve();
  /** 在途上传提交数(进入链 +1、结算 -1);用于队列页区分「排队」与「执行」。 */
  private uploadActive = 0;
  private uploadQueued = 0;
  /**
   * 正在等资源闸门的场(streamKey → {resource, since})。runNode 进闸门前登记、进闸门后清除。
   * 队列页据此把「状态=merging 但其实在等 CPU」显示成「排队中(第 N 位)」而非「执行中」。
   *
   * **键必须是 (streamKey, resource) 而不是 streamKey** —— 同一场常同时有多个节点等不同闸门
   * (burn_danmu/burn_livechat 在 cpu 队列 + upload_plain 在上传链,见 runWorkflowNodes 同 tick 派发)。
   * 用 streamKey 单键会互相覆盖:后登记者顶掉前者,且任一 clear() 会误删另一条 → 排队位次丢失。
   * 值用数组(Set 不便按 token 精确删除):同一 (key,resource) 可能有多条(两个 burn 同抢 cpu)。
   */
  private waiting = new Map<
    string,
    Array<{ streamKey: string; resource: "cpu" | "net" | "upload"; since: number; token: symbol }>
  >();
  private minBurnFreeMemMB: number;
  /** 热读的内存下限(T15);无 getter 时是构造值的常量闭包。 */
  private minBurnFreeMemMBLive: () => number;
  private minMergeFreeMemMBLive: () => number;
  private onMemShortage: (msg: string) => void;
  private memWaitTimeoutMs: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private freeMemMB: () => number;
  /** 上传限速:每次提交时刻滑动窗口(算是否超频)。 */
  private uploadRateLimit: number;
  private uploadRateWindowMs: number;
  private uploadCooldownMs: number;
  /** 最近若干次提交时刻(窗口内)。 */
  private uploadTimes: number[] = [];
  /** 命中 601 后的静默截止时刻(此前的提交一律等到此刻,给 B 站冷却)。 */
  private uploadBlockedUntil = 0;
  /** 限流状态持久化后端(T8);缺省 = 纯内存。 */
  private limitStore?: UploadLimitStore;
  /**
   * 限流状态的分键(030 T19)。默认 `UPLOAD_GATE_DEFAULT_KEY`;**master 与节点侧节点上传
   * 必须传同一个账号键**(`bilibili:<DedeUserID>`)才能共享冷却 —— 键算法唯一真理在 core。
   */
  private limitKey: string;
  /** 诊断日志(持久化失败等);缺省 console.error。 */
  private warn: (msg: string) => void;

  constructor(
    cfg: ResourcePoolCfg = {},
    inject: {
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      freeMemMB?: () => number;
      /** 上传限流状态的跨重启持久化后端(T8)。缺省 = 纯内存(旧行为)。 */
      limitStore?: UploadLimitStore;
      /** 限流分键;缺省 `UPLOAD_GATE_DEFAULT_KEY`。 */
      limitKey?: string;
      /** 持久化失败等诊断日志;缺省 console.error。**绝不静默**。 */
      warn?: (msg: string) => void;
      /** Called once per wait when memory stays short past `memWaitTimeoutMs` (the wait itself continues). */
      onMemShortage?: (msg: string) => void;
    } = {},
  ) {
    // 有 live getter 就热读它,否则用构造时的数字(后者保持向后兼容)。
    this.cpu = new Semaphore(cfg.maxCpuParallelLive ?? ((): number => Math.max(1, cfg.maxCpuParallel ?? 1)));
    this.net = new Semaphore(cfg.maxNetParallelLive ?? ((): number => Math.max(1, cfg.maxNetParallel ?? 1)));
    // 热读版:每次等内存门前取当前值(UI 改完立即生效);无 getter 时退回构造值。
    this.minBurnFreeMemMBLive = cfg.minBurnFreeMemMBLive ?? ((): number => cfg.minBurnFreeMemMB ?? 1024);
    this.minBurnFreeMemMB = cfg.minBurnFreeMemMB ?? 1024;
    this.minMergeFreeMemMBLive = cfg.minMergeFreeMemMBLive ?? ((): number => cfg.minMergeFreeMemMB ?? 512);
    this.memWaitTimeoutMs = cfg.memWaitTimeoutMs ?? 600_000;
    this.uploadRateLimit = Math.max(0, cfg.uploadRateLimit ?? 5);
    this.uploadRateWindowMs = Math.max(0, cfg.uploadRateWindowMs ?? 600_000);
    this.uploadCooldownMs = Math.max(0, cfg.uploadCooldownMs ?? 1_800_000);
    this.now = inject.now ?? Date.now;
    this.sleep = inject.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
    this.freeMemMB = inject.freeMemMB ?? systemFreeMemMB;
    this.limitStore = inject.limitStore;
    this.limitKey = (inject.limitKey ?? "").trim() || UPLOAD_GATE_DEFAULT_KEY;
    this.warn = inject.warn ?? ((m: string) => console.error(m));
    this.onMemShortage = inject.onMemShortage ?? ((m: string) => this.warn(m));
    this.restoreUploadLimits();
  }

  /** 构造时读回冷却/窗口状态。**存储不可用 = fail-closed**:先冷却一个完整 cooldown 再放行。 */
  private restoreUploadLimits(): void {
    if (!this.limitStore) return;
    const now = this.now();
    const state = this.limitStore.load(this.limitKey);
    if (state === null) {
      // 无法确认上次打到哪 → 按「刚命中 601」处理,宁可多等,不能重启即打爆。
      // 配置把 cooldown 显式设成 0(关冷却)时,fail-closed 不能退化成无限速 → 用兜底下限。
      const cooldown = this.uploadCooldownMs > 0 ? this.uploadCooldownMs : ResourcePool.UPLOAD_FAILCLOSED_MS;
      this.uploadBlockedUntil = now + cooldown;
      this.warn("[upload-limits] 限流状态不可用,本进程按保守冷却启动");
      return;
    }
    const clean = sanitizeUploadLimitState(state, now, this.uploadRateWindowMs);
    this.uploadBlockedUntil = clean.blockedUntil;
    this.uploadTimes = clean.times;
  }

  /** 落盘当前限流状态;失败只 warn(不阻断上传),但必须留痕。 */
  private persistUploadLimits(): void {
    if (!this.limitStore) return;
    try {
      this.limitStore.save(this.limitKey, { blockedUntil: this.uploadBlockedUntil, times: [...this.uploadTimes] });
    } catch (e) {
      this.warn(`[upload-limits] 持久化失败(限流状态仅存内存): ${(e as Error).message}`);
    }
  }

  private async withSemaphore<T>(s: Semaphore, fn: () => Promise<T>): Promise<T> {
    await s.acquire();
    try { return await fn(); } finally { s.release(); }
  }

  /**
   * 登记「某场在等某资源」;返回**只清除自己那一条**的函数。
   * token 唯一标识本次登记 —— 同 (key,resource) 可能有多条并发(两个 burn 同时抢 cpu),
   * clear 只能删自己那条,不能 `delete(key)` 把同伴一起清掉。
   */
  private markWaiting(streamKey: string | undefined, resource: "cpu" | "net" | "upload"): () => void {
    if (!streamKey) return () => {};
    const key = `${resource}:${streamKey}`; // 资源前缀 → 同一场的不同资源天然分开
    const token = Symbol(resource);
    const entry = { streamKey, resource, since: this.now(), token };
    const list = this.waiting.get(key);
    if (list) list.push(entry);
    else this.waiting.set(key, [entry]);
    return () => {
      const cur = this.waiting.get(key);
      if (!cur) return;
      const i = cur.findIndex((e) => e.token === token);
      if (i >= 0) cur.splice(i, 1);
      if (cur.length === 0) this.waiting.delete(key);
    };
  }

  /**
   * 只读快照:各资源占用 / 排队 / 上传窗口 / 冷却 + 正在等锁的场。
   * 队列页(GET /api/hub/queue)用。绝不修改内部状态。
   */
  snapshot(): PoolSnapshot {
    const now = this.now();
    const winStart = now - this.uploadRateWindowMs;
    // 与判定侧(`_awaitUploadSlot` / core UploadGate)同一窗口口径 `>=`;仅展示用,差一毫秒无碍。
    const inWindow = this.uploadTimes.filter((t) => t >= winStart);
    // 位次按资源分组:每个资源队列内先到的排前(1-based)。
    const byResource = new Map<string, Array<{ streamKey: string; since: number }>>();
    for (const entries of this.waiting.values()) {
      for (const e of entries) {
        const list = byResource.get(e.resource) ?? [];
        list.push({ streamKey: e.streamKey, since: e.since });
        byResource.set(e.resource, list);
      }
    }
    const waiting: PoolSnapshot["waiting"] = [];
    for (const [resource, list] of byResource) {
      list.sort((a, b) => a.since - b.since);
      list.forEach((e, i) =>
        waiting.push({ streamKey: e.streamKey, resource: resource as "cpu" | "net" | "upload", position: i + 1, since: e.since }),
      );
    }
    waiting.sort((a, b) => a.since - b.since);
    return {
      cpu: this.cpu.snapshot(),
      net: this.net.snapshot(),
      upload: {
        active: this.uploadActive,
        queued: this.uploadQueued,
        cooldownUntil: this.uploadBlockedUntil > now ? this.uploadBlockedUntil : 0,
        windowUsed: inWindow.length,
        windowLimit: this.uploadRateLimit,
        windowResetAt: inWindow.length > 0 ? inWindow[0] + this.uploadRateWindowMs : 0,
      },
      waiting,
    };
  }

  /**
   * CPU lock (merge/burn share it, max=1) + memory gate.
   * Memory shortage only queues: the node keeps polling until memory recovers. After `memWaitTimeoutMs`
   * one alert states need vs available, then waiting continues (a user stop still aborts the wait).
   * The memory wait happens OUTSIDE the CPU lock, so a node that cannot get memory never blocks other
   * streams; memory is re-checked once the lock is held. `kind` picks the floor: merge (copy-only) vs burn.
   */
  async withCpu<T>(fn: () => Promise<T>, streamKey?: string, kind: "merge" | "burn" = "burn"): Promise<T> {
    const clear = this.markWaiting(streamKey, "cpu");
    // Merge never gates stricter than burn: `minBurnFreeMemMB: 0` (gate off) keeps disabling both.
    const floor = (): number => {
      const burnFloor = this.minBurnFreeMemMBLive();
      return kind === "merge" ? Math.min(this.minMergeFreeMemMBLive(), burnFloor) : burnFloor;
    };
    const memOk = (): boolean => { const f = floor(); return f <= 0 || this.freeMemMB() >= f; };
    // The alert clock starts when memory is first seen short, not when the node starts queuing for
    // the CPU lock: time spent behind another node's merge/burn is not a memory shortage.
    let shortSince: number | undefined;
    let alerted = false;
    const waitForMem = async (): Promise<void> => {
      while (!memOk()) {
        throwIfAborted();
        shortSince ??= this.now();
        if (!alerted && this.now() - shortSince >= this.memWaitTimeoutMs) {
          alerted = true;
          this.onMemShortage(
            `Memory low for ${kind}${streamKey ? ` (${streamKey})` : ""}: need ${floor()} MB, available ${Math.round(this.freeMemMB())} MB; still waiting`,
          );
        }
        await this.sleep(2000);
      }
    };
    try {
      for (;;) {
        await waitForMem();
        await this.cpu.acquire();
        let ok: boolean;
        try { ok = memOk(); } catch (e) { this.cpu.release(); throw e; } // never leak the permit
        if (ok) {
          clear(); // 已进闸门 → 不再算「排队」
          try { return await fn(); } finally { this.cpu.release(); }
        }
        // Memory dropped while queued for the lock: give the slot back and wait again.
        this.cpu.release();
      }
    } finally {
      clear();
    }
  }

  async withNet<T>(fn: () => Promise<T>, streamKey?: string): Promise<T> {
    const clear = this.markWaiting(streamKey, "net");
    try {
      return await this.withSemaphore(this.net, async () => { clear(); return fn(); });
    } finally {
      clear();
    }
  }

  /**
   * **全局上传队列**:所有 hub 任务共用一条串行链,并对「提交次数」限速
   * (窗口 uploadRateWindowMs 内最多 uploadRateLimit 次);命中 601 后全局冷却 uploadCooldownMs。
   * 用于 upload_plain / append_*。提交前等足配额;单次提交失败但非 601 → 不惩罚后续提交。
   */
  async withUpload<T>(fn: () => Promise<T>, streamKey?: string): Promise<T> {
    this.uploadQueued++; // 进入上传链即算排队;轮到它时转为 active
    const run = this.uploadChain.then(async (): Promise<T> => {
      this.uploadQueued--;
      this.uploadActive++;
      const clear = this.markWaiting(streamKey, "upload");
      try {
        await this._awaitUploadSlot();
        clear(); // 配额已拿到 → 不再算「排队等锁」(可能仍在冷却期,由 cooldownUntil 表达)
        return await fn();
      } catch (e) {
        // 601:记录全局冷却,让后续提交(含本次重试)等够时间再打。
        if (isUploadRateLimited(e)) {
          this.uploadBlockedUntil = Math.max(this.uploadBlockedUntil, this.now() + this.uploadCooldownMs);
          this.persistUploadLimits(); // 冷却必须在重启后仍在,否则重启即再打 601
        }
        throw e;
      } finally {
        this.uploadActive--;
        clear();
      }
    });
    // 链尾吞掉异常,避免单个失败毒化后续排队者(排队者拿到的仍是原 promise 的 reject)。
    this.uploadChain = run.catch(() => undefined);
    return run;
  }

  /**
   * 与**共享 store 同步**(T19):master 与节点侧上传写同一张 upload_limits 表(各自进程、各自库路径时
   * 不共享,同机同库时共享)。内存窗口只在本进程内权威 → 每次判定前重读 store 并**并集**,
   * 否则会把别的进程刚占的额/刚记的冷却当成不存在(实测:节点侧记了冷却、master 照样打)。
   * 单调合并:blockedUntil 取晚、times 取并集 → 不会用自己的旧值覆盖更新的状态。
   */
  private syncFromLimitStore(): void {
    if (!this.limitStore) return;
    const state = this.limitStore.load(this.limitKey);
    if (state === null) return; // 不可用:已在构造时 fail-closed,运行期保持内存值
    const clean = sanitizeUploadLimitState(state, this.now(), this.uploadRateWindowMs);
    this.uploadBlockedUntil = Math.max(this.uploadBlockedUntil, clean.blockedUntil);
    // **按多重集取 max,不能用 Set**:同一毫秒内的两次提交时间戳相同,Set 去重会把两次占额
    // 并成一次 → 窗口计数偏小 → 真实超频被放行(自审发现;回归用例:并发窗口计数跨重启保留)。
    // 逐刻取两边出现次数的较大者 = 「落盘(权威并集) ∪ 内存(本进程尚未落盘的增量)」。
    const countOf = (arr: number[], t: number): number => arr.reduce((n, x) => (x === t ? n + 1 : n), 0);
    const all = [...new Set([...this.uploadTimes, ...clean.times])].sort((a, b) => a - b);
    this.uploadTimes = all.flatMap((t) => Array.from(
      { length: Math.max(countOf(this.uploadTimes, t), countOf(clean.times, t)) },
      () => t,
    ));
  }

  /** 等一个上传配额:先过冷却期,再保证滑动窗口内不超过 uploadRateLimit 次。 */
  private async _awaitUploadSlot(): Promise<void> {
    this.syncFromLimitStore();
    // 冷却期独立于次数限制:即使限速关闭,命中 601 后也要等冷却。
    while (this.uploadBlockedUntil > this.now()) {
      throwIfAborted();
      await this.sleep(this.uploadBlockedUntil - this.now());
    }
    if (this.uploadRateLimit <= 0) return;
    for (;;) {
      throwIfAborted();
      const now = this.now();
      if (this.uploadBlockedUntil > now) { await this.sleep(this.uploadBlockedUntil - now); this.syncFromLimitStore(); continue; }
      // 丢弃窗口外的历史提交时刻。边界 `>=`(滑出边界那一毫秒仍算在窗口内)——
      // 与 core UploadGate / store.tryClaim 的判定**逐字一致**,否则两侧会在边界处各多放一格。
      const winStart = now - this.uploadRateWindowMs;
      this.uploadTimes = this.uploadTimes.filter((t) => t >= winStart);
      if (this.uploadTimes.length < this.uploadRateLimit) {
        // T19:store 支持原子占额时走它(master 与节点侧上传共享同一行时不会各占一格)。
        if (this.limitStore?.tryClaim) {
          if (this.limitStore.tryClaim(this.limitKey, now, this.uploadRateWindowMs, this.uploadRateLimit)) {
            this.syncFromLimitStore();
            return;
          }
          this.syncFromLimitStore(); // 没抢到 → 用真实状态重算该等多久
          if (this.uploadTimes.length < this.uploadRateLimit) continue;
        } else {
          this.uploadTimes.push(now);
          this.persistUploadLimits(); // 占额即落盘,重启后窗口不归零
          return;
        }
      }
      // 超频:睡到最早那次的窗口滑出为止。
      await this.sleep(Math.max(1, this.uploadTimes[0] + this.uploadRateWindowMs - now));
    }
  }

  /** 同一 streamKey 的 pipeline / retryNode 串行,杜绝 reconciler 与手动重跑并发同场。 */
  async withStreamLock<T>(streamKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.streamLocks.get(streamKey) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // 链尾始终存一个 resolve 的哨兵,避免未处理 rejection。
    const tail = run.catch(() => undefined);
    this.streamLocks.set(streamKey, tail);
    try { return await run; } finally {
      if (this.streamLocks.get(streamKey) === tail) this.streamLocks.delete(streamKey);
    }
  }

  /** 该场是否正在本进程执行(pipeline / retryNode 持流锁期间为 true)。 */
  hasStreamLock(streamKey: string): boolean {
    return this.streamLocks.has(streamKey);
  }
}

export interface WorkflowRunResult {
  ok: boolean;
  failed: WorkflowNodeKey[];
  blocked: WorkflowNodeKey[];
}

export interface WorkflowRunOptions {
  streamKey: string;
  nodes: WorkflowNode[];
  edges: Array<[WorkflowNodeKey, WorkflowNodeKey]>;
  ctx: NodeRunContext;
  pool: ResourcePool;
  /** 手动单节点重跑:强制把这些 failed/blocked 节点重置并执行。 */
  forceRetry?: ReadonlySet<WorkflowNodeKey>;
  /** 自动续跑:仅这些 failed 节点重跑(默认空 = 其余 failed 保持终态)。 */
  autoRetry?: ReadonlySet<WorkflowNodeKey>;
}

/**
 * DAG executor:
 * - done/skipped 节点跳过(幂等 checkpoint);
 * - failed 节点仅当在 autoRetry/forceRetry 内才重跑,否则保持 failed,下游 blocked;
 * - 任一父 skipped → 节点 skipped(禁用步骤放行下游),forceRetry 目标除外;
 * - 节点失败不取消兄弟轨;资源池把 cpu/net 各自串成一次一个。
 */
export async function runWorkflowNodes(opts: WorkflowRunOptions): Promise<WorkflowRunResult> {
  const { streamKey, nodes, edges, ctx, pool, forceRetry = new Set(), autoRetry = new Set() } = opts;
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const parents = new Map<WorkflowNodeKey, WorkflowNodeKey[]>();
  for (const [from, to] of edges) {
    const list = parents.get(to) ?? [];
    list.push(from);
    parents.set(to, list);
  }

  const state = new Map<WorkflowNodeKey, "done" | "skipped" | "failed" | "blocked" | "pending">();
  const running = new Map<WorkflowNodeKey, Promise<void>>();

  const base = (key: WorkflowNodeKey): "done" | "skipped" | "failed" | "pending" => {
    if (forceRetry.has(key)) return "pending";
    const row = ctx.ledger.getNodeState(streamKey, key);
    if (!row) return "pending";
    if (row.state === "done") return "done";
    // skipped 是「禁用 / 父链跳过」的派生态:换配置重跑(如 stage → upload)时应重新计算,
    // 否则上一轮被跳过的 upload/append 会永远卡死,任务 done 但 B 站没上传。
    if (row.state === "skipped") return "pending";
    if (row.state === "failed") return autoRetry.has(key) ? "pending" : "failed";
    // blocked 只是「上游失败」的派生态:父节点重跑成功后应恢复可执行,不能永久卡死。
    return "pending"; // blocked / running/pending → 在流锁下不可能并发,按 pending 继续
  };

  const compute = (key: WorkflowNodeKey): "done" | "skipped" | "failed" | "blocked" | "pending" => {
    const seen = state.get(key);
    if (seen) return seen;
    const node = byKey.get(key);
    if (!node) return "blocked";
    const b = base(key);
    if (b !== "pending") { state.set(key, b); return b; }
    if (node.disabled) { state.set(key, "skipped"); return "skipped"; }
    const p = parents.get(key) ?? [];
    const pStates = p.map((k) => compute(k));
    if (pStates.includes("failed") || pStates.includes("blocked")) { state.set(key, "blocked"); return "blocked"; }
    if (pStates.includes("skipped") && !forceRetry.has(key)) { state.set(key, "skipped"); return "skipped"; }
    return "pending";
  };

  const persist = (key: WorkflowNodeKey, s: "done" | "skipped" | "failed" | "blocked"): void => {
    const existing = ctx.ledger.getNodeState(streamKey, key);
    if (s === "skipped") ctx.ledger.syncNodeState(streamKey, key, "skipped");
    else if (s === "blocked") {
      // runNode 已写「用户停止」;后续循环不得覆盖成「上游失败」。
      ctx.ledger.syncNodeState(streamKey, key, "blocked", {
        error: existing?.error === USER_STOP ? USER_STOP : "上游失败",
      });
    } else if (s === "failed") {
      // runNode 已把真实错误写进节点表;这里只保留它,避免被「上游失败」覆盖。
      ctx.ledger.syncNodeState(streamKey, key, "failed", {
        error: existing?.state === "failed" ? existing.error ?? "上游失败" : "上游失败",
      });
    }
  };

  const checkArtifact = (spec: ArtifactSpec, v: string | undefined, kind: "输入" | "输出"): string | undefined => {
    const required = spec.required !== false;
    if (!required) return undefined;
    if (spec.kind === "file") {
      if (!v) return undefined;
      return !existsSync(v) || Number(statSync(v).size) < (spec.minBytes ?? 1)
        ? `节点${kind}缺失或为空: ${spec.name}`
        : undefined;
    }
    if (spec.kind === "dir") {
      if (!v) return undefined;
      return !existsSync(v) || readdirSync(v).length === 0 ? `节点${kind}目录为空: ${spec.name}` : undefined;
    }
    return !v ? `节点${kind}缺失: ${spec.name}` : undefined;
  };
  const validateArtifacts = (specs: ArtifactSpec[], kind: "输入" | "输出"): void => {
    for (const spec of specs) {
      const msg = checkArtifact(spec, ctx.get(spec.name), kind);
      if (msg) throw new Error(msg);
    }
  };

  const runNode = async (node: WorkflowNode): Promise<void> => {
    try {
      ctx.ledger.syncNodeState(streamKey, node.key, "running");
      ctx.ledger.logStep(streamKey, node.key, "start");
      ctx.log(`[node] ${node.key} start`);
      const body = async (): Promise<void> => {
        validateArtifacts(node.inputs, "输入");
        await node.run(ctx);
        validateArtifacts(node.outputs, "输出");
      };
      if (node.resource === "cpu") await pool.withCpu(body, streamKey, node.key === "merge" ? "merge" : "burn");
      else if (node.resource === "upload") await pool.withUpload(body, streamKey);
      else if (node.resource === "net") await pool.withNet(body, streamKey);
      else await body();
      // Season association is a post-upload side effect, not part of the upload slot. Run it only after
      // withUpload has released, so its bounded HTTP budget cannot hold the global submission chain.
      if (node.key === "upload_plain") await associateSeasonAfterUpload(ctx, streamKey);
      ctx.ledger.syncNodeState(streamKey, node.key, "done", { error: null });
      const detail = ctx.stepDetail(node.key);
      ctx.ledger.logStep(streamKey, node.key, "done", detail);
      state.set(node.key, "done");
      ctx.log(`[node] ${node.key} done`);
    } catch (e) {
      if (isJobAbort(e)) {
        ctx.ledger.syncNodeState(streamKey, node.key, "blocked", { error: USER_STOP });
        state.set(node.key, "blocked");
        ctx.log(`[node] ${node.key} aborted: ${USER_STOP}`);
        throw e;
      }
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      ctx.ledger.syncNodeState(streamKey, node.key, "failed", { error: msg });
      state.set(node.key, "failed");
      ctx.log(`[node] ${node.key} failed: ${msg}`);
    }
  };

  // 先持久化 disabled/skip 传播的终态,避免 base() 里旧 failed 覆盖。
  for (const node of nodes) {
    const s = compute(node.key);
    if (s === "skipped" || s === "blocked" || s === "failed") {
      // blocked/failed 由父节点状态决定,先不持久化;loop 内会再算。
      if (s === "skipped") persist(node.key, "skipped");
    }
  }
  state.clear();

  let abortErr: unknown;
  while (true) {
    for (const node of nodes) {
      if (running.has(node.key)) continue;
      const s = compute(node.key);
      if (s === "done" || s === "skipped") {
        if (s === "skipped") persist(node.key, "skipped");
        continue;
      }
      if (s === "failed" || s === "blocked") {
        persist(node.key, s);
        continue;
      }
      // 用户停止后不再起新节点,等已在跑的兄弟轨收口再抛。
      if (abortErr) continue;
      // pending:所有父节点终态 done/skipped 才可起跑。
      const p = parents.get(node.key) ?? [];
      if (p.every((k) => { const ps = state.get(k) ?? compute(k); return ps === "done" || ps === "skipped"; })) {
        const run = runNode(node).catch((e: unknown) => {
          if (isJobAbort(e)) abortErr = e;
        });
        running.set(node.key, run);
      }
    }
    if (running.size === 0) break;
    await Promise.race([...running.values()]);
    for (const [k, r] of running) {
      if (state.get(k) === "done" || state.get(k) === "failed" || state.get(k) === "blocked") {
        void r;
        running.delete(k);
      }
    }
  }
  if (abortErr) throw abortErr;
  // 最后一轮 failed 父节点可能没来得及算到兄弟轨末尾节点 → 补算,保证返回结果完整(ledger 已 persist)。
  for (const node of nodes) compute(node.key);

  const failed = nodes.filter((n) => state.get(n.key) === "failed").map((n) => n.key);
  const blocked = nodes.filter((n) => state.get(n.key) === "blocked").map((n) => n.key);
  return { ok: failed.length === 0 && blocked.length === 0, failed, blocked };
}

/**
 * Best-effort season association owned by the merged workflow. The BV and "pending" marker are written
 * by upload_plain before its upload slot is released; this runs after release and records the terminal
 * state. Never throws, so a season-side failure cannot fail an otherwise successful upload.
 */
export async function associateSeasonAfterUpload(ctx: NodeRunContext, streamKey: string): Promise<void> {
  await associateSeasonForJob(ctx.ledger, ctx.cfg, streamKey, (m) => ctx.log(m));
}

/** Shared by the merged workflow and its resume path; idempotent and never throws. */
export async function associateSeasonForJob(
  ledger: SyncLedger,
  cfg: PipelineCfg,
  streamKey: string,
  log: (msg: string) => void,
): Promise<void> {
  const row = ledger.get(streamKey);
  const bv = row?.bv;
  if (!cfg.uploadMeta.seasonSectionId || !bv || row?.seasonState === "done" || row?.seasonState === "failed") return;
  ledger.setSeasonState(streamKey, "pending");
  const season = await addArchiveToSeasonIfConfigured({
    cookiesPath: cfg.cookies,
    sectionId: cfg.uploadMeta.seasonSectionId,
    bvid: bv,
    note: log,
  });
  ledger.setSeasonState(streamKey, season.status === "failed" ? "failed" : "done");
}

function shSingleQuote(s: string): string {
  return "'" + s.replaceAll("'", "") + "'";
}
