// ts/src/core/upload/biliup.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rootBiliupCookies } from "../paths.js";

/** biliup cookies.json:BILIUP_COOKIE > <DOUYIN_REC_ROOT>/config/biliup/cookies.json > ~/.config/biliup/cookies.json。 */
export const DEFAULT_COOKIES =
  process.env.BILIUP_COOKIE ?? rootBiliupCookies() ?? join(homedir(), ".config", "biliup", "cookies.json");

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

/** 调 biliup 上传，返回 BV（解析不到则抛错）。 */
export function upload(o: UploadOpts): Promise<{ bv: string }> {
  return new Promise((resolve, reject) => {
    const args = buildUploadArgs(o);
    const p = spawn("biliup", args);
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) { reject(new Error(`biliup upload 失败 (rc=${code}): ${(err || out).slice(-400).trim()}`)); return; }
      const bv = parseBV(out + err);
      if (!bv) { reject(new Error(`biliup 上传完成但解析不到 BV：${(out + err).slice(-300).trim()}`)); return; }
      resolve({ bv });
    });
  });
}
