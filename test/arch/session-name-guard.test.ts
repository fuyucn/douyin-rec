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
/** 白名单:精确到「文件 + 变量名」,只豁免含该标记的那一行,文件其余行照常扫描。 */
const ALLOW: { file: string; marker: string; reason: string }[] = [
  {
    file: "packages/orchestrator/src/session-plan.ts",
    marker: "UPLOAD_FILE_RE =",
    reason: "解析合并产物 `{base}_{NNN}[_danmu|_livechat].mp4` 的序号+变体,不是录制分段后缀",
  },
];

/**
 * 归一化:把连续反斜杠折成一个。字符串拼接写法 `new RegExp("-PART(\\\\d+)$")` 源码里的
 * 转义层数比字面量 `/-PART(\d+)/` 多,折叠后两者同形。
 */
export function normalize(line: string): string {
  return line.replace(/\\+/g, "\\");
}

/** 导出供自检:各种写法都必须被识别(不区分大小写)。 */
export const SIGNATURES = [
  /PART[^\\\n]{0,3}\\d/i, // PART\d+ / PART(\d+) / PART(?:\d+)
  /_[^\\\n]{0,3}\\d\{3/i, // _\d{3,} / _(\d{3,}) / _\d{3}
  /\[0-9\]\{3/, // [0-9]{3,} / [0-9]{3}
];

export function matchesSignature(line: string): boolean {
  const n = normalize(line);
  return SIGNATURES.some((re) => re.test(n));
}

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
      if (rel === OWNER) continue;
      const allowed = ALLOW.filter((a) => a.file === rel).map((a) => a.marker);
      codeLines(readFileSync(f, "utf-8")).forEach((line, i) => {
        if (allowed.some((m) => line.includes(m))) return;
        if (matchesSignature(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
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
    // 字符串拼接/new RegExp 形式:源码里转义多一层
    String.raw`new RegExp("-PART(\\d+)$")`,
    String.raw`new RegExp("_(\\d{3,})$")`,
    String.raw`new RegExp(\`(?:-PART(\\\\d+)|_(\\\\d{3,}))$\`)`,
    // 不区分大小写
    String.raw`/-part\d+$/i`,
    String.raw`/_Part(\d+)/i`,
  ])("签名识别写法 %s", (snippet) => {
    expect(matchesSignature(snippet)).toBe(true);
  });

  it("签名不误伤时间戳正则", () => {
    expect(matchesSignature(String.raw`/_\d{4}-\d{2}-\d{2}_\d{2}/`)).toBe(false);
    expect(matchesSignature(String.raw`new RegExp("_\\d{4}-\\d{2}")`)).toBe(false);
  });

  it("白名单只豁免标记行:同文件的其他段号正则仍会命中", () => {
    const allowed = ALLOW[0]!;
    const sample = String.raw`const X = /-PART\d+$/;`;
    expect(sample.includes(allowed.marker)).toBe(false);
    expect(matchesSignature(sample)).toBe(true);
  });

  it("core 自身的 SEGMENT_INDEX / SEGMENT_SUFFIX 写法(模板串多层转义)被识别,owner 文件整体豁免即因此成立", () => {
    const src = readFileSync(join(ROOT, OWNER), "utf-8");
    const lines = codeLines(src);
    expect(matchesSignature(lines.find((l) => l.includes("const SEGMENT_INDEX"))!)).toBe(true);
    expect(matchesSignature(lines.find((l) => l.includes("const SEGMENT_SUFFIX_SRC"))!)).toBe(true);
  });

  it("守护自检:owner 文件确实含签名(正则没写偏)", () => {
    const src = readFileSync(join(ROOT, OWNER), "utf-8");
    expect(codeLines(src).some(matchesSignature)).toBe(true);
  });
});
