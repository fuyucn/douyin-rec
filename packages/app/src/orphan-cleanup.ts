/**
 * orphan-cleanup.ts — T13 孤儿/空壳/中间产物**可预览、可审计**的维护清理。
 *
 * 扫 `<root>/recordings` 与 `<root>/stage`(纯 node:fs,无业务依赖),识别三类垃圾:
 *   1. **空壳 xml** —— 无有效弹幕(0 条 `<d`/`<gift`/`<member`)的 .xml;
 *   2. **孤儿 sidecar** —— `{base}.session.json` 而同 base **既无视频、也无 xml**;
 *   3. **scratch 残留** —— `.upload`/`.work`/`.part`/`.tmp` 等下载/合并中间产物。
 *
 * ## 删除口径(权威 = AGENTS.md「.xml / .ass 的保护口径」+ cleanup-recording-today skill)
 * - 视频与 scratch 中间产物:**总删**(可再生/无用)。
 * - `.xml`:**不得删掉最后一份**。空壳 xml 只有在「同会话(或 stage 副本)别处存在**非空** xml」
 *   时才可删;判不出来一律 keep 并写明原因。**有内容的 xml 永不进删除集**(弹幕不可再生)。
 *
 * ## 三条硬安全阀(宁可少删,不误删)
 * - **活动文件保护**:`recordingDirs` / `activePaths` 前缀命中的文件一律 keep ——
 *   扫目录时正在写的分段、正在上传的 mp4 都在列表里。
 * - **陈旧判定**:scratch 需 `mtime` 超过 `staleMs`(默认 6h)才删,给没登记在册的在跑任务留窗口。
 * - **默认 dryRun**:`cleanupOrphans` 默认只预览不删(API 需显式 `confirm=true`),
 *   真删逐条 append 审计日志到 `<root>/config/maintenance/cleanup-audit.jsonl`。
 *
 * 预览与删除**用同一份结果**(`scanOrphans` 一次算清删除集/保留集),故二者天然一致。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { sessionBaseOf, VIDEO_EXTS } from "@drec/core";

/** 视频容器扩展名(会话基名索引用;视频本身不在清理集内 —— 由 cleanup-recording-today 管)。 */
const VIDEO_EXT = [...VIDEO_EXTS, ".webm"];
/** scratch / 中间产物后缀(总删,但需过陈旧判定)。 */
const SCRATCH_EXT = [".upload", ".work", ".part", ".tmp", ".temp", ".download"];
/** 文件名后缀型 scratch(ffmpeg concat 列表等)。 */
const SCRATCH_SUFFIX = [".concat.txt"];
/** 会话身份 sidecar(无视频无 xml 时=孤儿)。 */
const SIDECAR_EXT = ".session.json";
/** 审计日志文件名(在 `<root>/config/maintenance/` 下)。 */
const AUDIT_FILE = "cleanup-audit.jsonl";

/** scratch 默认陈旧阈值 6h:低于它的一律 keep(可能在跑,只是没登记)。 */
export const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

/** 一个待清理(或被保留)的条目。`keepReason === null` ⇔ 可删。 */
export interface OrphanItem {
  /** 绝对路径。 */
  path: string;
  /** 会话基名(xml/视频/sidecar 剥后缀后的公共前缀)。 */
  base: string;
  /** 相对扫描根的路径(审计/展示用,不含机器前缀)。 */
  rel: string;
  /** 命中的清理类别。 */
  kind: "emptyXml" | "orphanSession" | "scratch";
  /** 文件字节数。 */
  bytes: number;
  /** 为什么**必须保留**;null = 可删。 */
  keepReason: string | null;
}

export interface ScanOptions {
  /** 额外扫的目录(默认 `<root>/recordings` + `<root>/stage`)。 */
  dirs?: string[];
  /** scratch 陈旧阈值(ms),默认 {@link DEFAULT_STALE_MS}。 */
  staleMs?: number;
  /**
   * **正在录制的目录**(前缀匹配)。其下所有文件一律 keep:正在写的分段、以及刚落盘、
   * 弹幕还在缓冲的 xml 都在里面。调用方从 `GET /api/tasks` 的 `recording===true` 推导。
   */
  recordingDirs?: string[];
  /**
   * **正在上传/处理的文件或目录**(前缀匹配)。hub 正在传的 mp4、merge 中间产物在此列,
   * 删了就是毁掉一次正在进行的任务。
   */
  activePaths?: string[];
}

export interface ScanResult {
  /** 空壳 xml(含被保留的,`keepReason` 说明原因)。 */
  emptyXml: OrphanItem[];
  /** 孤儿 session.json。 */
  orphanSession: OrphanItem[];
  /** scratch 残留。 */
  scratch: OrphanItem[];
  /** 全部**可删**条目的字节合计(`keepReason` 非 null 的不计入)。 */
  reclaimableBytes: number;
  /** 实际扫描的目录。 */
  dirs: string[];
}

export interface CleanupResult extends ScanResult {
  /** 本次真删的文件(dryRun 时为空)。 */
  deleted: OrphanItem[];
  /** 删除失败的文件。**不静默** —— 看起来清理成功其实没删是最危险的失败模式。 */
  failed: { path: string; error: string }[];
  /** 审计日志路径(未写时 null)。 */
  auditPath: string | null;
  /** 是否 dryRun。 */
  dryRun: boolean;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

/** 视频/弹幕/scratch/sidecar 之外的文件(log 等)不归本任务 —— 不枚举「可能有用」的东西。 */
function classify(name: string): OrphanItem["kind"] | null {
  if (name.endsWith(SIDECAR_EXT)) return "orphanSession";
  const ext = extOf(name);
  if (ext === ".xml") return "emptyXml";
  if (SCRATCH_EXT.includes(ext)) return "scratch";
  if (SCRATCH_SUFFIX.some((s) => name.endsWith(s))) return "scratch";
  return null;
}

/**
 * xml 是否**空壳**(无有效弹幕)。判据与 post-process 的解析口径一致:
 * `<d ` / `<d>`(弹幕)、`<gift`(礼物)、`<member`(上舰)。0 字节 / 只有 `<?xml?><i>` 壳 → true。
 *
 * ⚠️ 调用方必须自己处理读文件失败(本函数只判文本):读不到 → 保守当作「没有非空副本」,
 * 绝不能因为解析失败就判定「空 → 可删」。
 */
export function isEmptyXml(text: string): boolean {
  return !/<d[ >]/.test(text) && !/<gift[ >\/]/.test(text) && !/<member[ >\/]/.test(text);
}

/** 路径是否落在任一 parent 之下(目录级前缀匹配,带边界检查防 `/a` 误吞 `/ab`)。 */
function underAny(child: string, parents: string[]): boolean {
  return parents.some((p) => p && (child === p || child.startsWith(p.endsWith("/") ? p : p + "/")));
}

/** 递归列文件。目录不存在/EACCES → 当空(预览不该因一个坏目录整体失败);符号链接不跟随。 */
function walk(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path, out);
    else if (e.isFile()) out.push(path);
  }
}

/**
 * 扫 `<root>/recordings` + `<root>/stage`(或 `opts.dirs`)。**只读**,不改任何文件。
 *
 * 删除集与保留集一次算清(`keepReason === null` ⇔ 可删)—— 预览与实际删除用同一份结果,
 * 所以「预览说删的」与「真删的」不会漂移。
 */
export function scanOrphans(root: string, opts: ScanOptions = {}): ScanResult {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const dirs = opts.dirs ?? [join(root, "recordings"), join(root, "stage")];
  const recordingDirs = opts.recordingDirs ?? [];
  const activePaths = opts.activePaths ?? [];

  // 1) 全量列文件一次(下面几个索引都从这里派生,不重复扫盘)。
  const files: { path: string; name: string }[] = [];
  for (const d of dirs) {
    const acc: string[] = [];
    walk(d, acc);
    for (const path of acc) files.push({ path, name: path.slice(path.lastIndexOf("/") + 1) });
  }

  // 2) 视频索引:哪些 base 有视频(sidecar 判孤儿、xml 保留原因都要用)。
  //    基名规则与 post-process 一致(剥 -PART\d+ / _PART\d+ / _\d{3,})。
  const videoBases = new Set<string>();
  for (const f of files) {
    if (!VIDEO_EXT.includes(extOf(f.name))) continue;
    videoBases.add(sessionBaseOf(f.name));
  }

  // 3) 非空 xml 索引:base → 别处是否有**有内容**的 xml。空壳只有命中这个集合才可删。
  const nonEmptyXmlBases = new Set<string>();
  // xmlPath → 空壳?(false = 有内容 → **永不**进删除集);undefined = 读不出来。
  const xmlEmpty = new Map<string, boolean | undefined>();
  for (const f of files) {
    if (extOf(f.name) !== ".xml") continue;
    let empty: boolean;
    try {
      empty = isEmptyXml(readFileSync(f.path, "utf-8"));
      xmlEmpty.set(f.path, empty);
    } catch {
      empty = false; // 读不到 → 保守:既不当空壳,也不当副本
      xmlEmpty.set(f.path, undefined);
    }
    if (!empty) nonEmptyXmlBases.add(sessionBaseOf(f.name));
  }

  const relOf = (p: string): string => {
    const d = dirs.find((x) => p.startsWith(x));
    return d ? p.slice(d.length + 1) : p;
  };
  const sizeOf = (p: string): number => {
    try { return statSync(p).size; } catch { return 0; }
  };

  const emptyXml: OrphanItem[] = [];
  const orphanSession: OrphanItem[] = [];
  const scratch: OrphanItem[] = [];
  let reclaimableBytes = 0;

  for (const f of files) {
    const kind = classify(f.name);
    if (!kind) continue;
    const base = kind === "emptyXml" ? sessionBaseOf(f.name)
      : kind === "orphanSession" ? f.name.slice(0, -SIDECAR_EXT.length)
      : f.name;
    const bytes = sizeOf(f.path);
    let keepReason: string | null = null;

    if (underAny(f.path, recordingDirs)) {
      keepReason = "正在录制中(该目录有活动录制)";
    } else if (underAny(f.path, activePaths)) {
      keepReason = "正在上传/处理中";
    } else if (kind === "emptyXml") {
      // 有内容的 xml **根本不是候选**(弹幕不可再生)—— 不出现在 emptyXml 里,免得调用方误当垃圾。
      if (xmlEmpty.get(f.path) === false) continue;
      // 「不得删掉最后一份」的唯一判据:同会话(含 stage 副本)别处存在**非空** xml。
      if (xmlEmpty.get(f.path) === undefined) {
        keepReason = "xml 读不出来,无法判定内容 —— 保留(不拿不可读文件赌)";
      } else if (nonEmptyXmlBases.has(base)) {
        keepReason = null; // 别处有非空副本 → 这份空壳可删
      } else {
        keepReason = videoBases.has(base)
          ? "同会话无其它非空 xml(这是唯一一份)—— 保留,不得删掉最后一份弹幕"
          : "同会话无其它非空 xml 且无视频 —— 唯一一份,保留,不得删掉最后一份弹幕";
      }
    } else if (kind === "orphanSession") {
      // sidecar 有视频或 xml 就不算孤儿(选优/身份聚类依赖它)。
      const hasXml = files.some((x) => extOf(x.name) === ".xml" && sessionBaseOf(x.name) === base);
      keepReason = videoBases.has(base) || hasXml
        ? "同会话有视频/弹幕 —— 非孤儿,保留 sidecar(选优/身份依赖)"
        : null;
    } else {
      // scratch:总删,但太新的一律留(可能正在写、没登记在册)。
      let mtime = 0;
      try { mtime = statSync(f.path).mtimeMs; } catch { mtime = 0; }
      keepReason = Date.now() - mtime < staleMs
        ? `scratch 尚未陈旧(< ${Math.round(staleMs / 60000)} 分钟,可能正在写)`
        : null;
    }

    const item: OrphanItem = { path: f.path, base, rel: relOf(f.path), kind, bytes, keepReason };
    if (kind === "emptyXml") emptyXml.push(item);
    else if (kind === "orphanSession") orphanSession.push(item);
    else scratch.push(item);
    if (keepReason === null) reclaimableBytes += bytes;
  }

  return { emptyXml, orphanSession, scratch, reclaimableBytes, dirs };
}

export interface CleanupOptions extends ScanOptions {
  /**
   * true = 只预览不删(**默认**,安全侧)。API 需显式 `confirm=true` 才真删。
   */
  dryRun?: boolean;
  /** 审计日志目录,默认 `<root>/config/maintenance`。 */
  auditDir?: string;
}

/**
 * 执行清理,默认 `dryRun`。
 *
 * - 只删 `keepReason === null` 的条目;有保留理由的一律不碰。
 * - 逐个文件 try:一个失败不阻断其余,并进 `failed` 返回(**不静默**)。
 * - 真删才写审计日志(append JSONL:时间/动作/类别/路径/字节/错误)。日志写失败不阻断删除
 *   (删除已发生,反噬报错会让人误以为「没删」),改为 console.error 提示。
 */
export function cleanupOrphans(root: string, opts: CleanupOptions = {}): CleanupResult {
  const dryRun = opts.dryRun !== false;
  const scan = scanOrphans(root, opts);
  const recordingDirs = opts.recordingDirs ?? [];
  const activePaths = opts.activePaths ?? [];
  const deleted: OrphanItem[] = [];
  const failed: { path: string; error: string }[] = [];
  let auditPath: string | null = null;

  if (!dryRun) {
    const targets = [...scan.emptyXml, ...scan.orphanSession, ...scan.scratch].filter((i) => i.keepReason === null);
    for (const item of targets) {
      // 扫描与删除之间可能**跨越了一次状态变化**(预览刚扫完就开播了/上传开始了)。
      // 这里用与扫描同一把尺子再判一次活动性:宁可留下垃圾,也不删正在录/正在传的文件。
      if (underAny(item.path, recordingDirs) || underAny(item.path, activePaths)) continue;
      try {
        rmSync(item.path, { force: true });
        // rmSync(force) 对**不存在**也返回成功 → 会出现「报删了其实没删」的假成功。
        // 删后确认真的没了,否则计入 failed(不静默)。
        if (existsSync(item.path)) failed.push({ path: item.path, error: "删除后文件仍存在" });
        else deleted.push(item);
      } catch (e) {
        failed.push({ path: item.path, error: (e as Error)?.message ?? String(e) });
      }
    }
    if (deleted.length > 0 || failed.length > 0) {
      const ts = Date.now();
      try {
        const dir = opts.auditDir ?? join(root, "config", "maintenance");
        mkdirSync(dir, { recursive: true });
        auditPath = join(dir, AUDIT_FILE);
        const lines = [
          ...deleted.map((d) => JSON.stringify({ ts, action: "deleted", kind: d.kind, path: d.rel, bytes: d.bytes })),
          ...failed.map((f) => JSON.stringify({ ts, action: "failed", path: f.path, error: f.error })),
        ].join("\n") + "\n";
        appendFileSync(auditPath, lines, "utf-8");
      } catch (e) {
        auditPath = null;
        console.error(`[orphan-cleanup] 审计日志写失败(删除已完成): ${(e as Error)?.message ?? e}`);
      }
    }
  }

  return { ...scan, deleted, failed, auditPath, dryRun };
}
