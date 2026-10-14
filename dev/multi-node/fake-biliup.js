#!/usr/bin/env node
// 假 biliup(dev 多节点 e2e,issue #82):只模仿 CLI 形状与 BV 输出,绝不联网、绝不投稿。
// 安全闸:cookies 文件必须含 FAKE-DEV 标记,否则拒绝(防止误挂真凭证后被「假」脚本当真用)。
// 每次 upload/append 追加一行 JSONL 到 <cookies 目录>/fake-archive.jsonl,供场景断言
// 「硬标准」(关水印 / 仅自己可见 / 分 P 顺序)。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const argv = process.argv.slice(2);
if (argv[0] === "-V" || argv[0] === "--version") {
  console.log("biliup 0.0.0-drec-dev-fake");
  process.exit(0);
}

let cookies = null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-u" || argv[i] === "--user-cookie") { cookies = argv[++i]; continue; }
  rest.push(argv[i]);
}
const fail = (m) => { console.error(`[fake-biliup] ${m}`); process.exit(1); };
if (!cookies) fail("缺少 -u <cookies>");
let raw;
try { raw = fs.readFileSync(cookies, "utf-8"); } catch { fail(`cookies 不存在: ${cookies}`); }
if (!raw.includes("FAKE-DEV")) fail("拒绝:cookies 不含 FAKE-DEV 标记(疑似真凭证)。dev 环境禁止真投稿。");

const sub = rest[0];
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const flagged = new Set(["--submit", "--title", "--tid", "--tag", "--copyright", "--extra-fields", "--is-only-self", "--desc", "--line", "--vid"]);
const files = [];
for (let i = 1; i < rest.length; i++) {
  if (flagged.has(rest[i])) { i++; continue; }
  if (rest[i].startsWith("-")) continue;
  files.push(rest[i]);
}
const log = path.join(path.dirname(cookies), "fake-archive.jsonl");
const entry = {
  ts: new Date().toISOString(),
  op: sub,
  files: files.map((f) => path.basename(f)),
  title: opt("--title") ?? null,
  watermarkOff: /"state"\s*:\s*0/.test(opt("--extra-fields") ?? ""),
  onlySelf: opt("--is-only-self") === "1",
  line: opt("--line") ?? null,
};

if (sub === "upload") {
  if (files.length === 0) fail("upload 缺少文件");
  const h = crypto.createHash("sha1").update(`${entry.title}|${entry.files[0]}`).digest("base64").replace(/[^0-9A-Za-z]/g, "");
  entry.bv = ("BV1" + h + "0".repeat(9)).slice(0, 12);
  console.log(`[fake-biliup] 开始上传 ${files.length} 个文件(假,不联网)`);
  console.log(`投稿成功 ${entry.bv}`);
} else if (sub === "append") {
  const vid = opt("--vid");
  if (!vid || !/^BV[0-9A-Za-z]{10}$/.test(vid)) fail(`append 的 --vid 非法: ${vid}`);
  if (files.length === 0) fail("append 缺少文件");
  entry.bv = vid;
  console.log(`[fake-biliup] 追加 ${files.length} 个分P 到 ${vid}(假)`);
  console.log(`追加成功 ${vid}`);
} else {
  fail(`fake biliup 不支持子命令: ${sub}`);
}
fs.appendFileSync(log, JSON.stringify(entry) + "\n");
