/**
 * biliup-target.ts — 把既有 biliup 上传链包装成 core 的 `UploadTarget`（plans/049 §8 阶段 1a）。
 *
 * 阶段 1a 的原则：**只包装，不重写**。参数构造与重试语义仍由 `./run-biliup.js` 负责——
 *   - 建稿走 `uploadPlain`（逐线路重试 + parseBV），不是裸 `buildUploadArgs + run`；
 *   - append 走 `appendGroup`（逐线路重试 + 分 P 数回读 + 不确定标记），不是裸 `run`。
 * 本文件只做三件事：契约输入 → 既有函数入参、返回值 → `proof`、错误 → core 的分类。
 *
 * 已是全部生产路径的唯一入口：orchestrator / app / node-pipeline 仍走旧实现，直到阶段 1b。
 */
import { readFileSync, existsSync } from "node:fs";
import {
  appendGroup,
  countVideoParts,
  runBiliup,
  uploadPlain,
  type BiliupHooks,
} from "./run-biliup.js";
import {
  isAppendAmbiguous,
  isPlainNoBv,
  isUploadRateLimited,
  type AppendPartsInput,
  type AppendPartsResult,
  type ArchiveInfo,
  type CreateArchiveInput,
  type CreateArchiveResult,
  type CredentialRef,
  type UploadErrorClass,
  type UploadOpts,
  type UploadFile,
  type UploadTarget,
} from "@drec/core";

import { BILIUP_TARGET_ID } from "./target-id.js";
import { accountKeyFor, cookieLocator, COOKIE_ENV as SHARED_COOKIE_ENV } from "./credential.js";
export { BILIUP_TARGET_ID } from "./target-id.js";
export { COOKIE_ENV } from "./credential.js";

/** B 站「日常」分区：仅当调用方没给 tid 时兜底；真实分区来自规则。 */
export const DEFAULT_TID = 21;
/** B 站标题上限（字符）。 */
export const TITLE_MAX_LENGTH = 80;
/** 凭据环境变量：与 app 的既有默认（`BILIUP_COOKIE`）同口径，不新造第二套命名。 */
const COOKIE_ENV = SHARED_COOKIE_ENV;

export interface BiliupTargetDeps {
  /** spawn 注入（测试捕获 argv，不真跑子进程）。 */
  run?: (argv: string[], hooks?: BiliupHooks) => Promise<string>;
  /** 分 P 数查询注入：返回 null = 无法确认。 */
  countParts?: (bv: string, cookiesPath: string) => Promise<number | null>;
  /** 文件存在性判定注入。 */
  exists?: (path: string) => boolean;
  /** 环境变量读取注入（测试固定优先级）。 */
  env?: (key: string) => string | undefined;
  /** 文本读取注入（读 cookies JSON，取账号键）。 */
  readText?: (path: string) => string | null;
  /** 等待实现注入（appendGroup 的重读窗口）。 */
  sleep?: (ms: number) => Promise<void>;
}

function messageOf(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/** biliup 把文件交给外部子进程:内存字节没有路径可读,必须显式拒绝而不是传一个空文件。 */
function assertLocalFiles(files: UploadFile[]): void {
  if (files.some((f) => f.source)) {
    throw new Error("biliup 目标只能上传本地文件;内存字节请走 UPOS 目标");
  }
}

export function createBiliupFileTarget(deps: BiliupTargetDeps = {}): UploadTarget {
  const run = deps.run ?? runBiliup;
  const countParts = deps.countParts ?? countVideoParts;
  const exists = deps.exists ?? existsSync;
  const env = deps.env ?? ((k: string) => process.env[k]);
  const readText = deps.readText ?? ((p: string) => (exists(p) ? readFileSync(p, "utf-8") : null));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const credPath = (cred: CredentialRef): string => cred.locator;

  return {
    id: BILIUP_TARGET_ID,
    platformIds: ["bilibili"],
    // 阶段 1a 没有合集/赛季操作：能力声明必须与实现一致，接线时再随 U2 打开。
    capabilities: { appendGranularity: "group", seasons: false },

    resolveCredential({ dataRoot, explicitPath }): CredentialRef {
      // 显式 > 环境变量 > 数据根默认（plans/049 §5.2），与 app 既有默认同序。
      // 环境变量为空串/纯空格时按「没给」处理，回落到数据根默认——判定与 UPOS 目标共用一份实现。
      const locator = cookieLocator(
        BILIUP_TARGET_ID,
        { dataRoot, ...(explicitPath ? { explicitPath } : {}) },
        { env, exists },
      );
      return { targetId: BILIUP_TARGET_ID, locator };
    },

    accountKey(cred: CredentialRef): string {
      // 读不到账号 ID 时退回路径哈希：仍然稳定，但换了路径就换了键，能区分而不是静默合并。
      return accountKeyFor(BILIUP_TARGET_ID, cred.locator, { readText });
    },

    hardPolicy() {
      // 关水印 + 自制不可配（biliup 参数里写死）；默认仅自己可见，公开必须显式覆盖。
      return { visibility: "private", watermark: false, copyright: "self" };
    },

    defaults() {
      return { tid: DEFAULT_TID, tags: [], titleMaxLength: TITLE_MAX_LENGTH, maxParts: null };
    },

    async create(input: CreateArchiveInput): Promise<CreateArchiveResult> {
      assertLocalFiles(input.files);
      // 只映射 path：`UploadFile` 的 title/size/mtimeMs 不进 biliup 的 argv
      // （旧链按文件整段上传，分 P 标题由文件顺序/文件名决定），阶段 1a 不做额外映射。
      const opts: UploadOpts = {
        cookies: credPath(input.cred),
        videos: input.files.map((f) => f.path),
        title: input.title,
        tid: input.tid ?? DEFAULT_TID,
        tag: (input.tags ?? []).join(","),
        public: input.policy.visibility === "public",
        desc: input.desc,
      };
      try {
        // uploadPlain = 逐线路重试 + parseBV；拿不到 BV 时它自己抛「解析不到」。
        const bv = await uploadPlain({ plain: opts, run, ...(input.hooks ? { hooks: input.hooks } : {}) });
        return { proof: "created", ref: { targetId: BILIUP_TARGET_ID, id: bv } };
      } catch (err) {
        // 只有「确定没建稿」才能重试；不确定一律 unknown 交人工，绝不猜第二个稿件。
        // 匹配结构化标记而不是文案：上游改字不会把「状态不确定」变成「可重试」。
        if (isAppendAmbiguous(err) || isPlainNoBv(err)) return { proof: "unknown", ref: null };
        throw err;
      }
    },

    async append(input: AppendPartsInput): Promise<AppendPartsResult> {
      assertLocalFiles(input.files);
      try {
        // appendGroup = 逐线路重试 + 分 P 数回读 + 不确定标记（与旧链完全同一套判定）。
        await appendGroup({
          cookies: credPath(input.cred),
          bv: input.ref.id,
          files: input.files.map((f) => f.path),
          public: input.policy.visibility === "public",
          run,
          ...(input.hooks ? { hooks: input.hooks } : {}),
          ...(input.countParts ? { countParts: input.countParts } : { countParts: () => countParts(input.ref.id, credPath(input.cred)) }),
          sleep,
        });
        return { proof: "observed" };
      } catch (err) {
        if (isAppendAmbiguous(err)) return { proof: "unknown" };
        throw err;
      }
    },

    async inspect({ ref, cred }): Promise<ArchiveInfo | null> {
      const partCount = await countParts(ref.id, credPath(cred));
      if (partCount === null) return null;
      // 标题与可见性需要稿件详情查询，旧的 countVideoParts 不返回；省略而不是编造。
      return { ref, title: "", partCount };
    },

    async findRecent() {
      // 阶段 1a 不做建稿前去重：没有可靠的「同标题 + 同场次」来源时返回 unknown，
      // 让驱动转人工，而不是猜一个可能重复的稿件。
      return "unknown";
    },

    classifyError(err: unknown): UploadErrorClass {
      // 顺序很重要：不确定（请求可能已生效）必须先于「限流」——限流暗示可冷却重试，
      // 而 ambiguous 重试就是重复追加/重复建稿。
      if (isAppendAmbiguous(err)) return { kind: "ambiguous", reason: messageOf(err) };
      if (isUploadRateLimited(err)) return { kind: "rate-limited" };
      if (/econnreset|etimedout|timeout|timed out|connection reset|socket hang up|unexpected eof/i.test(messageOf(err))) {
        return { kind: "transient", reason: messageOf(err) };
      }
      return { kind: "permanent", reason: messageOf(err) };
    },
  };
}
