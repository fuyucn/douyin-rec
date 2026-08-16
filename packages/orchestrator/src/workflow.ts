import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { freemem } from "node:os";
import type { SyncLedger, StepName } from "./ledger.js";
import type { PipelineCfg, PipelineDeps } from "./pipeline.js";
import { humanBytes } from "./format.js";
import { retry } from "./retry.js";
import type { StageProducts } from "./session-plan.js";

export { deriveStageProducts, type StageProducts } from "./session-plan.js";

/** DAG 核心节点(select/pull 是前奏,clean_* 是收尾,均不进节点表)。 */
export type WorkflowNodeKey = Extract<
  StepName,
  "merge" | "burn_danmu" | "burn_livechat" | "upload_plain" | "append_danmu" | "append_livechat"
>;

export type ResourceKind = "cpu" | "net" | "none";
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
  /** 带 job.log 摘尾包装的子命令执行器(merge/burn 用)。 */
  sh(cmd: string): Promise<void>;
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
  mergeSegments: number;
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
  const { streamKey, stageSub, products, deps, cfg, log, willUpload, burnDanmu, burnLivechat, mergeSegments } = input;
  const ledger = deps.ledger;
  const artifacts = new Map<string, string>();
  const details = new Map<string, string>();
  // append_livechat 只在 danmu 轨存在时依赖其 p2 输出(否则跳过 append_danmu 不应阻断 livechat)。
  const appendDanmuOn = willUpload && burnDanmu;

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
    sh: async (cmd: string): Promise<void> => {
      log(`$ ${cmd}`);
      const t0 = Date.now();
      const out = await deps.sh(cmd);
      log(`  ✓ 完成(${Math.round((Date.now() - t0) / 1000)}s)`);
      if (typeof out === "string" && out.trim()) log(`  输出尾: ${out.trim().slice(-2048)}`);
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
        const cmd = multi
          ? `node dist/douyin-rec.mjs merge --in ${stageSub} --merge-sessions`
          : `node dist/douyin-rec.mjs merge --in ${stageSub} --base ${c.products.sessionBase}`;
        await c.sh(cmd);
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
        if (bytes > 0) c.stepDetail("merge", `${mergeSegments} 段 → ${humanBytes(bytes)}`);
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
      resource: "net",
      run: async (c: NodeRunContext): Promise<void> => {
        const bv = await deps.uploadPlain({
          video: products.plain,
          cookies: cfg.cookies,
          title: products.dateName,
          tag: cfg.uploadMeta.tag,
          tid: cfg.uploadMeta.tid,
          public: isPublic,
          desc: cfg.uploadMeta.desc,
        });
        // checkpoint:P1 建稿成功即刻落库 bv —— 必须在这里(不能等 burn/split 完),
        // 否则 P1 成功后若后续节点失败,bv 丢失 → 重试重传 P1 → 重复稿。
        ledger.setBv(streamKey, bv);
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
      resource: "net",
      run: async (c: NodeRunContext): Promise<void> => {
        await runAppendGroup(c, "append_danmu", products.danmuMp4, "p2");
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
      resource: "net",
      run: async (c: NodeRunContext): Promise<void> => {
        await runAppendGroup(c, "append_livechat", products.livechatMp4, "p3");
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
  const tries = o.files.length === 1 ? 5 : 1;
  const fn = (): Promise<void> => o.deps.appendGroup({
    bv: o.bv, files: o.files, cookies: o.deps.cfg.cookies, public: o.isPublic,
  });
  await (o.retry ?? retry)(fn, {
    tries,
    backoffMs: 60_000,
    sleep: o.deps.sleep,
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
  c.set(out, "done");
  c.stepDetail(step, `${files.length} 段${files.length ? ` · ${humanBytes(sumBytesOf(files))}` : ""}`);
}

/** 共享资源池:cpu/net 各 max=1(可配置),cpu 前先过内存闸门。 */
export interface ResourcePoolCfg {
  maxCpuParallel?: number;
  maxNetParallel?: number;
  minBurnFreeMemMB?: number;
  memWaitTimeoutMs?: number;
}

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) { this.active++; return; }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
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
  private cpu: Semaphore;
  private net: Semaphore;
  private streamLocks = new Map<string, Promise<unknown>>();
  private minBurnFreeMemMB: number;
  private memWaitTimeoutMs: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private freeMemMB: () => number;

  constructor(
    cfg: ResourcePoolCfg = {},
    inject: { now?: () => number; sleep?: (ms: number) => Promise<void>; freeMemMB?: () => number } = {},
  ) {
    this.cpu = new Semaphore(Math.max(1, cfg.maxCpuParallel ?? 1));
    this.net = new Semaphore(Math.max(1, cfg.maxNetParallel ?? 1));
    this.minBurnFreeMemMB = cfg.minBurnFreeMemMB ?? 2048;
    this.memWaitTimeoutMs = cfg.memWaitTimeoutMs ?? 600_000;
    this.now = inject.now ?? Date.now;
    this.sleep = inject.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
    this.freeMemMB = inject.freeMemMB ?? systemFreeMemMB;
  }

  private async withSemaphore<T>(s: Semaphore, fn: () => Promise<T>): Promise<T> {
    await s.acquire();
    try { return await fn(); } finally { s.release(); }
  }

  /** CPU 锁(merge/burn 共用,max=1)+ 内存闸门;内存长期不足 → 抛错由节点标 failed。 */
  async withCpu<T>(fn: () => Promise<T>): Promise<T> {
    return this.withSemaphore(this.cpu, async () => {
      if (this.minBurnFreeMemMB > 0) {
        const deadline = this.now() + this.memWaitTimeoutMs;
        while (this.freeMemMB() < this.minBurnFreeMemMB) {
          if (this.now() >= deadline) {
            throw new Error(`内存不足(可用 ${Math.round(this.freeMemMB())}MB < ${this.minBurnFreeMemMB}MB),等待超时`);
          }
          await this.sleep(2000);
        }
      }
      return fn();
    });
  }

  async withNet<T>(fn: () => Promise<T>): Promise<T> {
    return this.withSemaphore(this.net, fn);
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
    if (row.state === "skipped") return "skipped";
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
    if (s === "skipped") ctx.ledger.syncNodeState(streamKey, key, "skipped");
    else if (s === "blocked") ctx.ledger.syncNodeState(streamKey, key, "blocked", { error: "上游失败" });
    else if (s === "failed") {
      // runNode 已把真实错误写进节点表;这里只保留它,避免被「上游失败」覆盖。
      const existing = ctx.ledger.getNodeState(streamKey, key);
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
      if (node.resource === "cpu") await pool.withCpu(body);
      else if (node.resource === "net") await pool.withNet(body);
      else await body();
      ctx.ledger.syncNodeState(streamKey, node.key, "done", { error: null });
      const detail = ctx.stepDetail(node.key);
      ctx.ledger.logStep(streamKey, node.key, "done", detail);
      state.set(node.key, "done");
      ctx.log(`[node] ${node.key} done`);
    } catch (e) {
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
      // pending:所有父节点终态 done/skipped 才可起跑。
      const p = parents.get(node.key) ?? [];
      if (p.every((k) => { const ps = state.get(k) ?? compute(k); return ps === "done" || ps === "skipped"; })) {
        const run = runNode(node).catch(() => {});
        running.set(node.key, run);
      }
    }
    if (running.size === 0) break;
    await Promise.race([...running.values()]);
    for (const [k, r] of running) {
      if (state.get(k) === "done" || state.get(k) === "failed") {
        void r;
        running.delete(k);
      }
    }
  }
  // 最后一轮 failed 父节点可能没来得及算到兄弟轨末尾节点 → 补算,保证返回结果完整(ledger 已 persist)。
  for (const node of nodes) compute(node.key);

  const failed = nodes.filter((n) => state.get(n.key) === "failed").map((n) => n.key);
  const blocked = nodes.filter((n) => state.get(n.key) === "blocked").map((n) => n.key);
  return { ok: failed.length === 0 && blocked.length === 0, failed, blocked };
}
