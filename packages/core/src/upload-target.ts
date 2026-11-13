/**
 * upload-target.ts — 上传目标的通用契约（plans/049 §2，审计 2026-11-10 P1-1）。
 *
 * core 只提供纯类型与注册表：不 import 任何目标实现、不读环境、不开库。目标实现由装配根
 * （cli）注册，app / orchestrator 通过注入拿到；找不到目标必须**显式失败**，不静默回落。
 *
 * 阶段 0 只有契约，没有实现，也没有任何生产路径 import 本文件之外的新包。
 */

/**
 * Opaque per-target checkpoint the process queue persists (plans/049 `6, stage 3).
 *
 * The queue stores it verbatim and only mirrors `archiveId` / `season` into the legacy `bv` /
 * `seasonState` columns so old bundles keep reading. Each target owns the payload; unused fields
 * stay absent rather than guessed.
 */
export interface UploadTargetState {
  targetId: string;
  archiveId: string;
  /** Parts already confirmed on the target; absent = unknown. */
  parts?: number;
  /** Season association checkpoint (Bilibili-only today, generic for display). */
  season?: "pending" | "done" | "failed" | null;
}

export type UploadVisibility = "private" | "public";

export interface CredentialRef {
  targetId: string;
  /** 不透明定位符；日志只打印 targetId，不打印路径或内容。 */
  locator: string;
}

export interface UploadFile {
  path: string;
  /** 分 P 标题；缺省由 target 的 formatPartTitle 生成。 */
  title?: string;
  /** 幂等线索：大小 + mtime 足以识别「同一段」，不读内容哈希。 */
  size?: number;
  mtimeMs?: number;
  /**
   * Bytes straight from memory (plans/049 stage 2: zero-disk uploads have no readable file).
   *
   * When present the target reads chunks from here and `path` is only a name for logs / part
   * titles. Targets that shell out to an external uploader must reject it explicitly rather than
   * silently uploading an empty or stale file.
   */
  source?: UploadByteSource;
}

/**
 * 分块读取的字节来源。大小在**开始前**就必须确定(UPOS 的 preupload 协议要求预声明总量),
 * 这让「零落盘」也能用同一个契约: 字节来自内存缓冲, 不来自文件。
 */
export interface UploadByteSource {
  /** Exact number of bytes the uploader will publish. */
  size: number;
  /** Read chunk `index`; `size` is the exact length the target asked for. */
  readChunk(index: number, size: number): Promise<Uint8Array>;
}

/** 硬策略：水印必须关闭、投稿类型必须是自制；调用方只能显式覆盖 visibility。 */
export interface UploadPolicy {
  visibility: UploadVisibility;
  watermark: false;
  copyright: "self";
}

export interface ArchiveRef {
  targetId: string;
  /** 目标自己的稿件标识；对 B 站是 bvid，对别的目标可以是别的。 */
  id: string;
}

export interface ArchiveInfo {
  ref: ArchiveRef;
  title: string;
  /** 可见性；**无法确认时省略**——调用方不得把它当成 private（阶段 1a 的 biliup 目标就查不到）。 */
  visibility?: UploadVisibility;
  /** null = 查不到 / 无法确认，不是 0。 */
  partCount: number | null;
  parts?: Array<{ index: number; title?: string }>;
}

export type UploadErrorClass =
  | { kind: "rate-limited"; retryAfterMs?: number }
  | { kind: "transient"; reason: string } // 明确未提交，可安全重试
  | { kind: "ambiguous"; reason: string } // 结果不确定，转人工
  | { kind: "permanent"; reason: string };

/** 目标默认值：分区、标签上限、标题上限、最大分 P 数等。 */
export interface UploadTargetDefaults {
  tid: number;
  tags: string[];
  titleMaxLength: number;
  /** null = 目标不限制分 P 数。 */
  maxParts: number | null;
}

export interface UploadTargetCapabilities {
  /** append 粒度：single = 逐段提交；group = 多文件一次提交。 */
  appendGranularity: "single" | "group";
  /** 是否支持合集 / 赛季。 */
  seasons: boolean;
}

/** 上传子进程的观察钩子：目标实现把底层进度事件透传出去,编排层据此回报进度(不参与判定)。 */
export interface UploadChildHooks {
  onSpawn?(pid: number | undefined): void;
  onLine?(line: string): void;
  onClose?(): void;
}

export interface CreateArchiveInput {
  cred: CredentialRef;
  hooks?: UploadChildHooks;
  title: string;
  files: UploadFile[];
  policy: UploadPolicy;
  desc?: string;
  tags?: string[];
  tid?: number;
}

/** 建稿结果必须带 proof：unknown 时驱动转人工，绝不重试建稿。 */
export type CreateArchiveProof = "created" | "found-existing" | "unknown";

export interface CreateArchiveResult {
  proof: CreateArchiveProof;
  /** proof 为 unknown 时为 null。 */
  ref: ArchiveRef | null;
}

export interface AppendPartsInput {
  cred: CredentialRef;
  hooks?: UploadChildHooks;
  /** 幂等核对用的分 P 数回读;缺省由目标自己实现。编排层有更严的读法时要显式传。 */
  countParts?: () => Promise<number | null>;
  ref: ArchiveRef;
  files: UploadFile[];
  policy: UploadPolicy;
}

/** append 结果必须带 proof：unknown 时驱动转人工，不重试、不删源。 */
export type AppendProof = "observed" | "confirmed-not-submitted" | "unknown";

export interface AppendPartsResult {
  proof: AppendProof;
}

export interface UploadTarget {
  readonly id: string;
  readonly platformIds: readonly string[];

  /** 凭据定位：显式路径 > 环境变量 > 数据根默认；只由 target 实现。 */
  resolveCredential(input: { dataRoot: string; explicitPath?: string }): CredentialRef;
  /** 账号键：供 UploadGate / UploadSlot 分键；不泄露凭据内容。 */
  accountKey(cred: CredentialRef): string;

  /** 硬策略：水印 / 自制 / 默认可见性。 */
  hardPolicy(): UploadPolicy;
  /** 目标默认值：分区、标签上限、标题上限、最大分 P 数等。 */
  defaults(): UploadTargetDefaults;

  create(input: CreateArchiveInput): Promise<CreateArchiveResult>;
  append(input: AppendPartsInput): Promise<AppendPartsResult>;
  inspect(input: { ref: ArchiveRef; cred: CredentialRef }): Promise<ArchiveInfo | null>;
  /** 建稿前去重：同标题 + 预期时长找已有稿；返回 "unknown" 时不得建稿。 */
  findRecent(input: { cred: CredentialRef; title: string; expectedDurationSec?: number }):
    Promise<ArchiveInfo | "none" | "unknown">;

  classifyError(err: unknown): UploadErrorClass;
  readonly capabilities: UploadTargetCapabilities;
}

export interface UploadTargetRegistry {
  /** 重复 id 或空 id 直接抛错：注册错误必须在启动时暴露，不能静默覆盖。 */
  register(target: UploadTarget): void;
  get(targetId: string): UploadTarget | undefined;
  /** 同一平台命中多个目标 = 配置错误，抛错而不是静默选第一个。 */
  forPlatform(platformId: string): UploadTarget | undefined;
  list(): UploadTarget[];
}

export function createUploadTargetRegistry(): UploadTargetRegistry {
  const targets = new Map<string, UploadTarget>();
  return {
    register(target: UploadTarget): void {
      if (!target.id) throw new Error("upload target: id 不能为空");
      if (targets.has(target.id)) throw new Error(`upload target 重复注册: ${target.id}`);
      targets.set(target.id, target);
    },
    get(targetId: string): UploadTarget | undefined {
      return targets.get(targetId);
    },
    forPlatform(platformId: string): UploadTarget | undefined {
      const hits = [...targets.values()].filter((t) => t.platformIds.includes(platformId));
      if (hits.length > 1) {
        throw new Error(`平台 ${platformId} 命中多个上传目标: ${hits.map((t) => t.id).join(", ")}`);
      }
      return hits[0];
    },
    list(): UploadTarget[] {
      return [...targets.values()];
    },
  };
}
