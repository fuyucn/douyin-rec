// biliup process helpers shared by app and processors (plan 038 T05).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { APPEND_AMBIGUOUS_MARKER, biliupCookieHeader, registerChild, throwIfAborted, type UploadLine, type UploadOpts } from "@drec/core";


// 契约在 core(orchestrator 也要用,不能让 L4.5 反向依赖 L4);这里 re-export 保持既有调用点不变。
export type { UploadLine, UploadOpts } from "@drec/core";

/**
 * Cookie 头提取已下沉 core(单一真理源,0 落盘直传包也要用,不能让 L4 反向依赖)。
 * 这里 re-export 保持既有调用点(`@drec/processors` 的导入方)不变。
 */
export { biliupCookieHeader } from "@drec/core";

/**
 * Read biliup's Bilibili login cookies as a request Cookie header (default path for callers).
 * 解析在 core;这里只负责读盘并按需兜底 null。
 */
export function readBiliupCookieHeader(cookiesPath: string): string | null {
  try {
    return biliupCookieHeader(JSON.parse(readFileSync(cookiesPath, "utf-8")));
  } catch {
    return null;
  }
}

/**
 * B站 preupload probe 在当前 deployment 通常只返回 txa/alia；默认 probe 可能选中
 * 延迟低但分块连接不稳定的线路。这里优先 alia，并在 chunk SendRequest/connection
 * error 时自动换其他线路。可用 BILIUP_UPLOAD_LINE 或 BILIUP_UPLOAD_LINES 覆盖。
 */
export const DEFAULT_UPLOAD_LINES: readonly UploadLine[] = ["alia", "bda2", "cnbd", "txa", "bldsa"];

const UPLOAD_LINES = new Set<UploadLine>([
  "bldsa", "cnbldsa", "andsa", "atdsa", "bda2", "cnbd", "anbd", "atbd",
  "tx", "cntx", "antx", "attx", "bda", "txa", "alia",
]);

function isUploadLine(value: string): value is UploadLine {
  return UPLOAD_LINES.has(value as UploadLine);
}

/**
 * B站投稿**提交接口**。`app`(biliup CLI 的默认)会拿第一个标签自动参加活动(转载稿 → 21071),
 * 且**更易触发 21566「投稿过于频繁」**——biliup 自己的 server 端因此把默认改成 web(见
 * `crates/biliup-cli/src/server/common/upload.rs` 注释 + issue #1762/#1609)。CLI 默认仍是 app,
 * 故这里显式指定 web,与上游 server 行为对齐。
 *
 * 可用 env `BILIUP_SUBMIT` 覆盖(app|web|b-cut-android);非法值回落 web。要回退到 CLI 旧默认
 * (app)不必改代码:`BILIUP_SUBMIT=app`。
 */
export type UploadSubmit = "app" | "web" | "b-cut-android";

const UPLOAD_SUBMITS = new Set<UploadSubmit>(["app", "web", "b-cut-android"]);

export function uploadSubmit(): UploadSubmit {
  const raw = (process.env.BILIUP_SUBMIT ?? "").trim().toLowerCase();
  return UPLOAD_SUBMITS.has(raw as UploadSubmit) ? (raw as UploadSubmit) : "web";
}

/** 显式传入 > BILIUP_UPLOAD_LINE > BILIUP_UPLOAD_LINES > 内置线路。 */
export function uploadLineCandidates(explicit?: UploadLine, override?: readonly UploadLine[]): UploadLine[] {
  const envLine = (process.env.BILIUP_UPLOAD_LINE ?? "").trim();
  const envLines = (process.env.BILIUP_UPLOAD_LINES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const configured = [
    ...(explicit ? [explicit] : []),
    ...(envLine ? [envLine] : []),
    ...envLines,
    ...(override ?? []),
  ].filter(isUploadLine);
  return [...new Set([...configured, ...DEFAULT_UPLOAD_LINES])];
}

function isRetryableLineError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return (
    // `timed? out` 只匹配 "timed out"/"time out";biliup 上游 504 文案是 "Gateway Time-out"
    // (带连字符)→ 之前漏判为不可重试,504 直接抛错、**不换线路**,整场转 needs_manual(线上实测)。
    // 补 `gateway time-?out` 与 HTTP `50[234]` 服务端错误(5xx 均为线路/网关侧瞬时故障,可换线重试)。
    /connection error|error sending request|connection reset|unexpected eof|broken pipe|timed? out|gateway time-?out|http status server error|\b50[234]\b/i.test(msg)
    && /start=\d+.*end=\d+|uploader\.rs:\d+/i.test(msg)
  );
}

/** 构造 biliup upload 参数（纯函数）。照搬 merge-best-today 的命令。 */
export function buildUploadArgs(o: UploadOpts): string[] {
  // 多文件 = 同一稿件多个分 P(分段上传模式);单文件 = 传统 P1。顺序 = 分 P 顺序。
  const files = o.videos && o.videos.length > 0 ? o.videos : o.video ? [o.video] : [];
  const args = [
    "-u", o.cookies, "upload", ...files,
    // 提交接口:biliup CLI 默认 app,但 app 接口更易触发 21566 风控(见 uploadSubmit 注释)。
    "--submit", uploadSubmit(),
    "--title", o.title, "--tid", String(o.tid), "--tag", o.tag, "--copyright", "1",
    // 关昵称水印:硬性 —— 投稿后无法修改(CLAUDE.md);与 upload-recording-today skill 默认一致。
    "--extra-fields", '{"watermark":{"state":0}}',
  ];
  if (!o.public) args.push("--is-only-self", "1");   // 默认公开；仅自己可见才加
  if (o.desc) args.push("--desc", o.desc);
  if (o.line) args.push("--line", o.line);
  return args;
}

/** 从 biliup stdout 抓 BV 号。 */
export function parseBV(out: string): string | null {
  const m = out.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

/** 预检：biliup 命令可用 + cookies 文件存在。返回错误信息或 null。 */
export function checkBiliup(cookies: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!existsSync(cookies)) { resolve(`cookies 文件不存在: ${cookies}（先 biliup login）`); return; }
    const p = spawn("biliup", ["-V"]);
    p.on("error", () => resolve("biliup 命令未找到（请先安装 biliup CLI）"));
    p.on("close", (code) => resolve(code === 0 ? null : "biliup -V 非零退出"));
  });
}

/** biliup 在全部文件传完、提交稿件之前打印的行(传输 → 提交的唯一文本边界)。 */
export function isAllFilesUploadedLine(line: string): boolean {
  return /All files uploaded successfully/.test(line);
}

/** runBiliup 的可选观测回调(plan 038):只读观测,回调抛错不影响上传。 */
export interface BiliupHooks {
  /** 子进程启动后调用(pid 可能为 undefined:spawn 失败时)。 */
  onSpawn?: (pid: number | undefined) => void;
  /** stdout / stderr 每出现一整行调用一次(`\r` 与 `\n` 都算行尾;进度条用 `\r` 刷新)。 */
  onLine?: (line: string) => void;
}

/** 底层：spawn biliup argv，收集 stdout+stderr，非零退出抛错，返回合并输出。 */
export function runBiliup(argv: string[], hooks: BiliupHooks = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("biliup", argv);
    registerChild(p); // 不建进程组:biliup 自己管分块;checkBiliup(-V)不走这里
    let out = "", err = "";
    const appendTail = (current: string, c: Buffer): string => (current + String(c)).slice(-65536);
    // 观测回调的异常一律吞掉:观测不能把一次正常上传变成失败。
    const safe = (fn: () => void): void => { try { fn(); } catch { /* 观测回调不得影响上传 */ } };
    // stdout 与 stderr 各自缓冲半行,凑够整行才回调(chunk 边界不保证按行切)。
    const makeLiner = (): ((c: Buffer) => void) => {
      let buf = "";
      return (c: Buffer): void => {
        if (!hooks.onLine) return;
        buf += String(c);
        const parts = buf.split(/[\r\n]+/);
        buf = parts.pop() ?? "";
        for (const line of parts) if (line) safe(() => hooks.onLine!(line));
      };
    };
    const lineOut = makeLiner(), lineErr = makeLiner();
    if (hooks.onSpawn) safe(() => hooks.onSpawn!(p.pid));
    p.stdout.on("data", (c: Buffer) => { out = appendTail(out, c); lineOut(c); });
    p.stderr.on("data", (c: Buffer) => { err = appendTail(err, c); lineErr(c); });
    p.on("error", reject);
    p.on("close", (code) => {
      try { throwIfAborted(); } catch (e) { reject(e); return; }
      if (code !== 0) { reject(new Error(`biliup 失败 (rc=${code}): ${(err || out).slice(-2000).trim()}`)); return; }
      resolve(out + err);
    });
  });
}

/** 调 biliup 上传，返回 BV（解析不到则抛错）。 */
export async function upload(o: UploadOpts): Promise<{ bv: string }> {
  const tried: UploadLine[] = [];
  let last: unknown;
  for (const line of uploadLineCandidates(o.line)) {
    tried.push(line);
    try {
      const combined = await runBiliup(buildUploadArgs({ ...o, line }));
      const bv = parseBV(combined);
      if (!bv) throw new Error(`biliup 上传完成但解析不到 BV：${combined.slice(-300).trim()}`);
      return { bv };
    } catch (e) {
      last = e;
      if (!isRetryableLineError(e)) throw e;
    }
  }
  throw new Error(`biliup 上传线路均失败 (${tried.join(",")}): ${String((last as Error)?.message ?? last)}`);
}

/** 构造 biliup append 参数（纯函数）。 */
export function buildAppendArgs(o: { cookies: string; bv: string; files: string[]; public?: boolean; line?: UploadLine }): string[] {
  // 防御:append 重新提交稿件元数据时可能重置「水印/可见性」(biliLive-tools v3.9.0 修过
  // 「续传水印不被继承」的同类 bug)。故 append 也带上关水印 + 仅自己可见,与 P1 upload 保持一致,
  // 避免追加分 P 后整稿被翻成「带水印 / 公开」。两者均为不可逆/隐私关键项。
  // 提交接口与 upload 同口径(--submit web):biliup append 的默认也是 app(→ edit_by_app),
  // 与 upload 一样更易被风控;web 走 edit_by_web,是上游 server 的既定选择。
  const args = ["-u", o.cookies, "append", "--vid", o.bv, "--submit", uploadSubmit(), "--extra-fields", '{"watermark":{"state":0}}'];
  if (!o.public) args.push("--is-only-self", "1");
  if (o.line) args.push("--line", o.line);
  args.push(...o.files);
  return args;
}

/**
 * 仅上传 plain(P1)拿 BV —— **穿插上传的接缝**:调用方可先 fire 这个(网络),与烧录(CPU)并行,
 * 再 await BV 后逐组 appendGroup。`run` 可注入(测试)。
 */
export async function uploadPlain(o: {
  plain: UploadOpts;
  run?: (argv: string[]) => Promise<string>;
  lines?: readonly UploadLine[];
}): Promise<string> {
  const run = o.run ?? runBiliup;
  const tried: UploadLine[] = [];
  let last: unknown;
  for (const line of uploadLineCandidates(o.plain.line, o.lines)) {
    tried.push(line);
    try {
      const out = await run(buildUploadArgs({ ...o.plain, line }));
      const bv = parseBV(out);
      if (!bv) throw new Error(`upload plain 完成但解析不到 BV：${out.slice(-300)}`);
      return bv;
    } catch (e) {
      last = e;
      if (!isRetryableLineError(e)) throw e;
    }
  }
  throw new Error(`upload plain 上传线路均失败 (${tried.join(",")}): ${String((last as Error)?.message ?? last)}`);
}

/**
 * B 站稿件当前分 P 数(append 幂等判定用)。任何异常/无权限/风控 → null(= 无法确认)。
 * 注意:稿件是"仅自己可见"时匿名查不到,必须带上传者 cookie。
 */
export async function countVideoParts(bv: string, cookiesPath: string): Promise<number | null> {
  try {
    const cookie = readBiliupCookieHeader(cookiesPath);
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bv)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { code?: number; data?: { pages?: unknown[] } };
    if (j?.code !== 0) return null;
    return Array.isArray(j.data?.pages) ? j.data.pages.length : null;
  } catch {
    return null;
  }
}

/** Re-read intervals after an append failure whose count looks unchanged (~10s total; list refresh lags). */
export const APPEND_REREAD_DELAYS_MS: readonly number[] = [3000, 3000, 4000];

/**
 * Issue #310: extra re-read intervals when the count read fails (null) after an append failure, ~30s total.
 * A null read is the view API throttling or erroring, not proof of anything; giving up on the first one turns a
 * transient hiccup into a manual-review record. Only the count is re-read: the append itself is never retried here.
 */
export const APPEND_UNREADABLE_REREAD_DELAYS_MS: readonly number[] = [5000, 10000, 15000];

/**
 * 追加一个逻辑组到已建稿件(空组跳过)。多组必须**串行**调用(同稿件并发 append 会撞)。
 * public 透传给 buildAppendArgs,保证追加分 P 时保留 P1 的可见性/水印设置。
 *
 * **幂等**:传入 `countParts`(生产由此前的分 P 数查询提供)时,失败后会重新查询分 P 数:
 *   变多 → 服务端其实已追加成功(直接返回,不再重试);
 *   未变 → 分 P 列表刷新有延迟(约 0.5-1s+,#66),按 APPEND_REREAD_DELAYS_MS 间隔继续重读(合计约 10s);
 *     期间变多 → 已追加成功;整个窗口都没变 → 确认未提交,安全换线;
 *   读到 null(且有基线)→ 先按 APPEND_UNREADABLE_REREAD_DELAYS_MS 延迟重读(#310)等接口恢复,仍读不到才算结果不确定;
 *     恢复后若数量未变,同样要在完整的 APPEND_REREAD_DELAYS_MS 窗口内保持不变才算未提交,窗口内任一次 null 即不确定,
 *     抛 APPEND_AMBIGUOUS_MARKER(调用方不得自动重试,转人工);没有基线(before 为 null)直接不确定。
 * 不传 countParts → 保持旧行为(仅换线,不判定)。
 */
export async function appendGroup(o: {
  cookies: string;
  bv: string;
  files: string[];
  public?: boolean;
  line?: UploadLine;
  lines?: readonly UploadLine[];
  run?: (argv: string[]) => Promise<string>;
  /** 查询当前分 P 数;返回 null = 无法确认。 */
  countParts?: () => Promise<number | null>;
  /** 重读间隔的等待实现(测试注入以免真等)。 */
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (o.files.length === 0) return;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run = o.run ?? runBiliup;
  const tried: UploadLine[] = [];
  let last: unknown;
  const before = o.countParts ? await o.countParts().catch(() => null) : null;
  for (const line of uploadLineCandidates(o.line, o.lines)) {
    tried.push(line);
    try {
      await run(buildAppendArgs({ cookies: o.cookies, bv: o.bv, files: o.files, public: o.public, line }));
      return;
    } catch (e) {
      last = e;
      if (!isRetryableLineError(e)) throw e;
      if (o.countParts) {
        let after = await o.countParts().catch(() => null);
        // Issue #310: baseline known but the first re-read failed (view API throttled/erroring): wait for it to
        // answer again before judging anything.
        if (before != null && after == null) {
          for (const delay of APPEND_UNREADABLE_REREAD_DELAYS_MS) {
            await sleep(delay);
            after = await o.countParts().catch(() => null);
            if (after != null) break;
          }
        }
        // Unchanged may just be a stale list (#66): it must stay unchanged through the whole re-read window,
        // counted from the first readable answer. Any null inside the window leaves the outcome unknown.
        for (const delay of APPEND_REREAD_DELAYS_MS) {
          if (before == null || after == null || after !== before) break;
          await sleep(delay);
          after = await o.countParts().catch(() => null);
        }
        // A count below the baseline is a truncated/degraded list, not proof of anything: ambiguous (#318 review).
        if (before != null && after != null && after >= before) {
          if (after > before) return;              // 服务端已追加成功(客户端只是没拿到响应)
        } else {
          throw new Error(
            `${APPEND_AMBIGUOUS_MARKER} append 失败且无法确认是否已提交(可能已追加分P),请人工核对稿件: ${String((e as Error)?.message ?? e)}`,
          );
        }
      }
    }
  }
  throw new Error(`append 上传线路均失败 (${tried.join(",")}): ${String((last as Error)?.message ?? last)}`);
}

/**
 * 分P 上传：先用 plain（P1）上传拿 BV，再 append extras（P2、P3）。
 * `run` 可注入（测试用假实现）；默认走 runBiliup。
 */
export async function uploadThenAppend(o: {
  plain: UploadOpts;
  extras: string[];
  run?: (argv: string[]) => Promise<string>;
}): Promise<string> {
  const run = o.run ?? runBiliup;
  const uploadOut = await run(buildUploadArgs(o.plain));
  const bv = parseBV(uploadOut);
  if (!bv) throw new Error(`upload plain 完成但解析不到 BV：${uploadOut.slice(-300)}`);
  if (o.extras.length > 0) {
    await run(buildAppendArgs({ cookies: o.plain.cookies, bv, files: o.extras, public: o.plain.public }));
  }
  return bv;
}

/**
 * 分P 上传(**按逻辑块拆 append**):先 plain(P1)拿 BV,再**每个逻辑组一条独立 append**。
 * groups 例:`[[danmu_part0, danmu_part1], [livechat]]` → 一条 append 提交 danmu 两段、另一条提交 livechat。
 * 比 uploadThenAppend(所有 extras 塞一条 append)好:① 传完一组即提交、增量可见 ② 各组独立可续传/重试。
 * 见 memory feedback_upload_append_per_logical_part。`run` 可注入(测试)。
 */
export async function uploadThenAppendGroups(o: {
  plain: UploadOpts;
  groups: string[][];
  run?: (argv: string[]) => Promise<string>;
}): Promise<string> {
  const run = o.run ?? runBiliup;
  const uploadOut = await run(buildUploadArgs(o.plain));
  const bv = parseBV(uploadOut);
  if (!bv) throw new Error(`upload plain 完成但解析不到 BV：${uploadOut.slice(-300)}`);
  for (const files of o.groups) {
    if (files.length > 0) {
      await run(buildAppendArgs({ cookies: o.plain.cookies, bv, files, public: o.plain.public }));
    }
  }
  return bv;
}
