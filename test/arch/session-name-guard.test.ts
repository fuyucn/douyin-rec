/**
 * 守护(issue #50):会话基名 / 段号的分段后缀正则只许在 core `session-name.ts` 里出现一份。
 * 受控扫描:packages/*\/src 下非测试 .ts/.tsx 与 scripts/ 下 .ts/.mjs/.js 的**代码行**
 * (去掉整行/行尾注释)里,出现 `PART\d`(含捕获组 `PART(\d+)`)、`_\d{3,}` / `_(\d{3,})` /
 * `_\d{3}` / `[0-9]{3,}` 字面正则片段即视为「第二份同类正则」。
 * 确需例外,把相对路径加入 ALLOW 并写明理由。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const PKG_DIR = join(ROOT, "packages");
const OWNER = "packages/core/src/session-name.ts";
/** 白名单:相对仓库根路径 → 理由。 */
const ALLOW: Record<string, string> = {
  "packages/orchestrator/src/session-plan.ts":
    "UPLOAD_FILE_RE 解析的是合并产物 `{base}_{NNN}[_danmu|_livechat].mp4` 的序号+变体,不是录制分段后缀",
};

/** 导出供自检:各种写法都必须被识别。 */
export const SIGNATURES = [
  /PART[^\\\n]{0,3}\\d/, // PART\d+ / PART(\d+) / PART(?:\d+)
  /_[^\\\n]{0,3}\\d\{3/, // _\d{3,} / _(\d{3,}) / _\d{3}
  /\[0-9\]\{3/, // [0-9]{3,} / [0-9]{3}
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}

function codeLines(src: string): string[] {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ""));
}

describe("会话基名正则唯一(issue #50)", () => {
  it("仓库内无第二份分段后缀正则", () => {
    const files: string[] = [];
    try { walk(join(ROOT, "scripts"), files); } catch { /* 无 scripts */ }
    for (const p of readdirSync(PKG_DIR)) {
      const src = join(PKG_DIR, p, "src");
      try { if (statSync(src).isDirectory()) walk(src, files); } catch { /* 无 src */ }
    }
    const hits: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (rel === OWNER || rel in ALLOW) continue;
      codeLines(readFileSync(f, "utf-8")).forEach((line, i) => {
        if (SIGNATURES.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, `请改用 @drec/core 的 sessionBaseOf / stampedSessionBaseOf / segmentIndexOf:\n${hits.join("\n")}`).toEqual([]);
  });

  it.each([
    String.raw`/-PART(\d+)/`,
    String.raw`/_PART\d+$/`,
    String.raw`/_(\d{3,})\.ts$/`,
    String.raw`/_\d{3}\.flv/`,
    String.raw`/_[0-9]{3,}/`,
    String.raw`/([0-9]{3})/`,
  ])("签名识别写法 %s", (snippet) => {
    expect(SIGNATURES.some((re) => re.test(snippet))).toBe(true);
  });

  it("签名不误伤时间戳正则", () => {
    expect(SIGNATURES.some((re) => re.test(String.raw`/_\d{4}-\d{2}-\d{2}_\d{2}/`))).toBe(false);
  });

  it("守护自检:owner 文件确实含签名(正则没写偏)", () => {
    const src = readFileSync(join(ROOT, OWNER), "utf-8");
    expect(codeLines(src).some((l) => SIGNATURES.some((re) => re.test(l)))).toBe(true);
  });
});
