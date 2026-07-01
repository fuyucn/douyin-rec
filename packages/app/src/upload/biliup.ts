// ts/src/core/upload/biliup.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rootBiliupCookies } from "../paths.js";

/** biliup cookies.json:BILIUP_COOKIE > <DOUYIN_REC_ROOT ?? DEFAULT_ROOT>/config/biliup/cookies.json。 */
export const DEFAULT_COOKIES = process.env.BILIUP_COOKIE ?? rootBiliupCookies();

export interface UploadOpts {
  video: string;
  cookies: string;
  title: string;
  tag: string;
  tid: number;
  public: boolean;
  desc?: string;
}

/** 构造 biliup upload 参数（纯函数）。照搬 merge-best-today 的命令。 */
export function buildUploadArgs(o: UploadOpts): string[] {
  const args = [
    "-u", o.cookies, "upload", o.video,
    "--title", o.title, "--tid", String(o.tid), "--tag", o.tag, "--copyright", "1",
    // 关昵称水印:硬性 —— 投稿后无法修改(CLAUDE.md);与 upload-recording-today skill 默认一致。
    "--extra-fields", '{"watermark":{"state":0}}',
  ];
  if (!o.public) args.push("--is-only-self", "1");   // 默认公开；仅自己可见才加
  if (o.desc) args.push("--desc", o.desc);
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

/** 底层：spawn biliup argv，收集 stdout+stderr，非零退出抛错，返回合并输出。 */
export function runBiliup(argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("biliup", argv);
    let out = "", err = "";
    p.stdout.on("data", (c: Buffer) => (out += c));
    p.stderr.on("data", (c: Buffer) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) { reject(new Error(`biliup 失败 (rc=${code}): ${(err || out).slice(-400).trim()}`)); return; }
      resolve(out + err);
    });
  });
}

/** 调 biliup 上传，返回 BV（解析不到则抛错）。 */
export function upload(o: UploadOpts): Promise<{ bv: string }> {
  return runBiliup(buildUploadArgs(o)).then((combined) => {
    const bv = parseBV(combined);
    if (!bv) throw new Error(`biliup 上传完成但解析不到 BV：${combined.slice(-300).trim()}`);
    return { bv };
  });
}

/** 构造 biliup append 参数（纯函数）。 */
export function buildAppendArgs(o: { cookies: string; bv: string; files: string[]; public?: boolean }): string[] {
  // 防御:append 重新提交稿件元数据时可能重置「水印/可见性」(biliLive-tools v3.9.0 修过
  // 「续传水印不被继承」的同类 bug)。故 append 也带上关水印 + 仅自己可见,与 P1 upload 保持一致,
  // 避免追加分 P 后整稿被翻成「带水印 / 公开」。两者均为不可逆/隐私关键项。
  const args = ["-u", o.cookies, "append", "--vid", o.bv, "--extra-fields", '{"watermark":{"state":0}}'];
  if (!o.public) args.push("--is-only-self", "1");
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
}): Promise<string> {
  const run = o.run ?? runBiliup;
  const out = await run(buildUploadArgs(o.plain));
  const bv = parseBV(out);
  if (!bv) throw new Error(`upload plain 完成但解析不到 BV：${out.slice(-300)}`);
  return bv;
}

/** 追加一个逻辑组到已建稿件(空组跳过)。多组必须**串行**调用(同稿件并发 append 会撞)。
 *  public 透传给 buildAppendArgs,保证追加分 P 时保留 P1 的可见性/水印设置。 */
export async function appendGroup(o: {
  cookies: string;
  bv: string;
  files: string[];
  public?: boolean;
  run?: (argv: string[]) => Promise<string>;
}): Promise<void> {
  if (o.files.length === 0) return;
  const run = o.run ?? runBiliup;
  await run(buildAppendArgs({ cookies: o.cookies, bv: o.bv, files: o.files, public: o.public }));
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
