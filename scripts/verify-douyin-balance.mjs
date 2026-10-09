#!/usr/bin/env node
// verify-douyin-balance.mjs — 抖音「均衡模式(balance)」端到端验证脚本。
//
// 为什么独立脚本:loadBalancer 经 getRoomInfo 间接依赖 sign.js(sm-crypto),vitest 无法 import
// (仓库已知约束:平台实例零单测)→ 用真实网络验证代替。
//
// 验证两条取数路径(对应「直播 + 弹幕完整录制」):
//   1. 视频取流 getStream(api:"balance") 能拿到流 URL;
//   2. 弹幕 liveId resolveDouyinLiveId 能解析到当场 id;
//   3. 判活 getInfo(api:"balance")。
// 反复 N 次统计端点分布 + 成功率(观察 webHTML 被拦时是否自动摘除)。
//
// 用法:
//   pnpm bundle                                   # 先构建 dist(CLI 产物,本脚本不用它)
//   node scripts/verify-douyin-balance.mjs <roomSlug> [N]
// 脚本内部用 esbuild 现场把 packages/douyin-live 源码打成临时 mjs 再跑(绕开 dist 不导出内部函数)。
//
// 在 VPS 上验证(部署后):先 scp 本脚本 + 仓库源码不可行 → 用 `node dist/douyin-rec.mjs probe` 或
//   本地打包一个独立 probe(见 scripts/README 说明)。

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const slug = process.argv[2];
const N = Number(process.argv[3] ?? 8);
if (!slug) {
  console.error("用法: node scripts/verify-douyin-balance.mjs <roomSlug> [N]");
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "dybalance-"));
const entry = join(dir, "probe.ts");
const out = join(dir, "probe.mjs");
writeFileSync(entry, `
import { getStream, getInfo, resolveDouyinLiveId } from ${JSON.stringify(join(root, "packages/douyin-live/src/index.js"))};
const slug = process.argv[2];
const N = Number(process.argv[3] ?? 8);
const used = {}; const stat = { streamOk: 0, liveIdOk: 0, livingOk: 0 };
let lastLiveId = "", lastErr = "";
for (let i = 0; i < N; i++) {
  try { const r = await getStream({ channelId: slug, quality: "origin", api: "balance", formatPriorities: ["flv","hls"] });
    if (r?.currentStream?.url) stat.streamOk++;
    const u = String(r?.api ?? "?"); used[u] = (used[u] ?? 0) + 1;
  } catch (e) { used["stream:ERR"] = (used["stream:ERR"] ?? 0) + 1; lastErr = String(e?.message ?? e); }
  try { const id = await resolveDouyinLiveId("https://live.douyin.com/" + slug);
    if (id) { stat.liveIdOk++; lastLiveId = id; } } catch (e) { lastErr = String(e?.message ?? e); }
  try { const info = await getInfo(slug, { api: "balance" }); if (info?.living) stat.livingOk++; } catch {}
}
console.log(JSON.stringify({ slug, n: N, streamOk: stat.streamOk+"/"+N, liveIdOk: stat.liveIdOk+"/"+N,
  livingOk: stat.livingOk+"/"+N, liveId: lastLiveId, apiUsed: used, ...(lastErr?{lastErr:lastErr.slice(0,120)}:{}) }, null, 2));
`);

try {
  execFileSync(join(root, "node_modules/.bin/esbuild"), [entry, "--bundle", "--platform=node", "--format=esm",
    "--outfile=" + out, "--log-level=error",
    "--banner:js=import{createRequire as __cr}from\"module\";const require=__cr(import.meta.url);"],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  // 直接 import 临时产物:其顶层代码即验证逻辑,执行即输出结果。
  await import(pathToFileURL(out).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
