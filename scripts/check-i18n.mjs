/**
 * check-i18n.mjs — 前端文案完整性检查(web 没有 vitest,这是它的替代守门人)。
 *
 * 为什么需要:`t("settings.saving")` 这种**引用不存在的 key** 不会报错、不会崩,
 * 而是把 key 名原样渲染给用户 —— 属于最难靠肉眼发现的静默缺陷(T15 就漏过一次)。
 * 本脚本做两件事:
 *   1. 代码里所有字面量 t("...") 的 key 必须存在于词典(中英各查一遍);
 *   2. 中英键集必须对称(否则切语言会出现 key 名)。
 * 用法:node scripts/check-i18n.mjs   (在仓库根跑;退出码非 0 = 有问题)
 *
 * 局限:动态拼接的 key(如 t(`x.${y}`))与复数 _one/_other 已按规则兼容,
 * 但「定义但未被引用」那栏会因动态拼接误报 —— 只作参考,不作失败判据。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dirname, join as pjoin } from "node:path";
import { fileURLToPath } from "node:url";
const WEB = pjoin(dirname(fileURLToPath(import.meta.url)), "..", "packages", "web", "src");
const src = readFileSync(pjoin(WEB, "lib", "i18n.tsx"), "utf-8");
const start = src.indexOf("const DICT"); const eq = src.indexOf("=", start);
let i = src.indexOf("{", eq), depth = 0, end = -1;
for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (!depth) { end = i + 1; break; } } }
const dict = eval("(" + src.slice(src.indexOf("{", eq), end) + ")");
// 带路径的扁平化(保留完整嵌套路径)
function flat(o, p = "") { const out = new Set();
  for (const [k, v] of Object.entries(o)) { const key = p ? p + "." + k : k;
    if (v && typeof v === "object") { for (const x of flat(v, key)) out.add(x); } else out.add(key); }
  return out; }
const zh = flat(dict.zh), en = flat(dict.en);
const base = (k) => k.replace(/_(one|other|zero|few|many|two)$/, "");
const known = new Set([...zh, ...en].flatMap(k => [k, base(k)]));
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f);
  if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(p) && !p.includes("i18n.tsx")) files.push(p); } })(WEB);
const missing = new Map();
// 实验性功能注册表(core/src/experimental.ts)里的 *Key 字面量也是 i18n key(徽标组件动态 t(f.nameKey)),单独核对。
const expSrc = readFileSync(pjoin(WEB, "..", "..", "core", "src", "experimental.ts"), "utf-8");
for (const mm of expSrc.matchAll(/\b\w+Key:\s*"([^"]+)"/g))
  if (!known.has(mm[1])) { if (!missing.has(mm[1])) missing.set(mm[1], []); missing.get(mm[1]).push("core/src/experimental.ts"); }
for (const f of files) for (const mm of readFileSync(f, "utf-8").matchAll(/\bt\(\s*"([^"]+)"\s*[,)]/g))
  if (!known.has(mm[1])) { if (!missing.has(mm[1])) missing.set(mm[1], []); missing.get(mm[1]).push(f); }
for (const k of ["experimental.badge","experimental.riskPrefix","experimental.defaultPrefix","experimental.defaultOff","experimental.defaultOn","experimental.truthNote","experimental.graduationPrefix","experimental.trackingPrefix"]) if (!known.has(k)) missing.set(k, ["ExperimentalBadge.tsx"]);
console.log("检查文件数:", files.length, "| key 总数:", zh.size);
const onlyZh2 = [...zh].filter(k => !en.has(k) && !en.has(base(k)));
const onlyEn2 = [...en].filter(k => !zh.has(k) && !zh.has(base(k)));
if (!missing.size) console.log("✅ 代码引用的 key 全部存在");
else for (const [k, fs] of missing) console.log("❌ 缺失:", k, "←", [...new Set(fs)].join(", "));
if (onlyZh2.length || onlyEn2.length) {
  console.log("❌ 中英不对称:", { onlyZh: onlyZh2, onlyEn: onlyEn2 });
  process.exit(1);
}
process.exit(missing.size ? 1 : 0);
// 顺带列出 i18n 里定义但**从未被引用**的 key(死文案),供清理参考
const used = new Set();
for (const f of files) for (const mm of readFileSync(f, "utf-8").matchAll(/\bt\(\s*"([^"]+)"\s*[,)]/g)) used.add(mm[1]);
const dead = [...zh].filter(k => !used.has(k) && !used.has(base(k)) && !k.endsWith("_one") && !k.endsWith("_other"));
console.log("定义但未被 t(\"...\") 直接引用:", dead.length, "(含动态拼接的会误报)");
