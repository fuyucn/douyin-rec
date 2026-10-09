#!/usr/bin/env node
/**
 * gen-architecture.mjs — 从仓库**真实数据**生成架构热图(docs/architecture.html)。
 *
 * 为什么生成而不是手写:此前 architecture.md 与 architecture.html 是两份手维护的等价文档,
 * 已实测漂移(两份都漏了 kuaishou-live,见 docs/audit-2026-10-06/)。本脚本把「包分层 / 依赖边 /
 * 代码量 / 变更热度 / 测试覆盖」全部从仓库现算 → 单一数据源,不会再有第二份需要同步的图。
 *
 * 数据来源:
 *   - 包与分层:packages 下各 package.json(name/dependencies) + test/arch/layering.test.ts 的 RANKS
 *   - 代码量:packages/<p>/src 下的 ts/tsx(排除 .test.)
 *   - 变更热度:git log(默认近 90 天;--days N 可调)
 *   - 测试覆盖:packages/<p>/src 下的 .test.ts + test/ 下按包名归类
 *
 * 用法:
 *   node scripts/gen-architecture.mjs            # 生成 docs/architecture.html
 *   node scripts/gen-architecture.mjs --days 30  # 换热度窗口
 *   node scripts/gen-architecture.mjs --check    # 只校验现有产物是否与仓库一致(CI/自审用)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "packages");
const OUT = join(ROOT, "docs", "architecture.html");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const daysArg = args.indexOf("--days");
const DAYS = daysArg >= 0 ? Number(args[daysArg + 1]) : 90;

// ── 分层表:从 layering.test.ts 的 RANKS 解析(单一真相,不在此重复维护) ──────────
function readRanks() {
  const src = readFileSync(join(ROOT, "test", "arch", "layering.test.ts"), "utf-8");
  const block = src.slice(src.indexOf("const RANKS"), src.indexOf("};", src.indexOf("const RANKS")));
  const ranks = {};
  for (const m of block.matchAll(/"(@drec\/[a-z-]+)":\s*([0-9.]+)/g)) ranks[m[1]] = Number(m[2]);
  return ranks;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function countLoc(files) {
  let n = 0;
  for (const f of files) {
    try { n += readFileSync(f, "utf-8").split("\n").length; } catch { /* skip */ }
  }
  return n;
}

function gitCount(paths, days) {
  try {
    // 用 execFileSync(argv 数组)避免 `--since=90 days ago` 被 shell 拆词。
    const out = execFileSync("git", ["log", `--since=${days} days ago`, "--oneline", "--", ...paths], { cwd: ROOT, encoding: "utf-8" });
    return out.trim() ? out.trim().split("\n").length : 0;
  } catch { return 0; }
}

// ── 收集每包数据 ─────────────────────────────────────────────────────────────
const ranks = readRanks();
const pkgs = [];
for (const dir of readdirSync(PKG_DIR)) {
  const pj = join(PKG_DIR, dir, "package.json");
  if (!existsSync(pj)) continue;
  const j = JSON.parse(readFileSync(pj, "utf-8"));
  if (!j.name?.startsWith("@drec/")) continue; // 跳过 web 等非 @drec 包
  const deps = Object.keys(j.dependencies ?? {}).filter((d) => d.startsWith("@drec/"));
  const srcFiles = walk(join(PKG_DIR, dir, "src"));
  const code = srcFiles.filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
  const tests = srcFiles.filter((f) => /\.test\.(ts|tsx)$/.test(f));
  pkgs.push({
    dir, name: j.name, rank: ranks[j.name] ?? null, deps,
    loc: countLoc(code), files: code.length,
    srcTests: tests.length,
    churn: gitCount([join("packages", dir)], DAYS),
  });
}
// 顶层 test/ 目录里的用例按「文件名含包名」归类(粗粒度,够热图用)。
const topTests = walk(join(ROOT, "test")).filter((f) => /\.test\.ts$/.test(f));
for (const t of topTests) {
  const base = t.toLowerCase();
  for (const p of pkgs) {
    const short = p.dir.replace(/-live$/, "").replace(/-/g, "");
    if (base.includes(p.dir) || base.includes(short)) p.srcTests += 1;
  }
}
// 前端是独立 Vite 工程(非 @drec 包),单独统计。
const webDir = join(PKG_DIR, "web", "src");
const webCode = walk(webDir).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
const webPkg = { dir: "web", name: "@drec/web (独立 Vite)", rank: 4, deps: [], loc: countLoc(webCode), files: webCode.length, srcTests: 0, churn: gitCount([join("packages", "web")], DAYS), separate: true };

const all = [...pkgs, webPkg].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || b.loc - a.loc);
const maxLoc = Math.max(...all.map((p) => p.loc));
const maxChurn = Math.max(...all.map((p) => p.churn), 1);

// 依赖边(A → B 表示 A 依赖 B),按 rank 排序便于阅读
const edges = [];
for (const p of pkgs) for (const d of p.deps) edges.push([p.name, d]);

// ── 颜色:热度 = 变更频率(红=热),代码量 = 深浅 ───────────────────────────────
function heatColor(churn) {
  const t = churn / maxChurn; // 0..1
  // 冷(灰蓝) → 热(橙红)
  const stops = [[239, 246, 255], [191, 219, 254], [253, 230, 138], [251, 146, 60], [220, 38, 38]];
  const x = t * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c.join(",")})`;
}
function textOn(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#1c1c28" : "#fff";
}

const RANK_LABEL = {
  0: "L0 · 基础叶子", 0.5: "L0.5 · 可观测性", 1: "L1 · 引擎轴(共享)",
  1.5: "L1.5 · 平台轴(可插拔)", 3: "L3 · 会话编排", 4: "L4 · 有状态应用",
  4.5: "L4.5 · 多节点 hub", 5: "L5 · 入口",
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));


// ── 语义角色 → 颜色(Archify 风格:深色底 + 语义色) ──────────────────────────────
const SEMANTIC = {
  "@drec/core": "core", "@drec/observability": "core", "@drec/post-process": "core",
  "@drec/tui": "core", "@drec/ffmpeg-recorder-extra": "core",
  "@drec/record-engine": "engine",
  "@drec/douyin-live": "platform", "@drec/bilibili-live": "platform", "@drec/kuaishou-live": "platform",
  "@drec/manager": "session",
  "@drec/app": "app", "@drec/web (独立 Vite)": "app",
  "@drec/orchestrator": "hub", "@drec/cli": "entry",
};
const ROLE = {
  core:     { name: "基础/契约",   c: "#94a3b8" },
  engine:   { name: "引擎轴",      c: "#fb923c" },
  platform: { name: "平台轴",      c: "#22d3ee" },
  session:  { name: "会话编排",    c: "#a78bfa" },
  app:      { name: "应用/前端",   c: "#34d399" },
  hub:      { name: "多节点 hub",  c: "#fbbf24" },
  entry:    { name: "入口",        c: "#f472b6" },
};
const roleOf = (name) => ROLE[SEMANTIC[name] ?? "core"];

// 热: 提交数 → 0..1。用归一化后映射到角色色相上的「饱和度/亮度」变化,避免整页只靠红黄。
const heatT = (p) => Math.min(1, p.churn / maxChurn);
// 卡片背景:深色 canvas + 该角色色微染,热度越高越亮。
function cardStyle(p) {
  const t = heatT(p);
  const role = roleOf(p.name).c;
  const mix = 8 + t * 26;           // 8%..34% 角色色混入(基色随主题:暗=深底 / 亮=白底)
  return `--role:${role};--mix:${mix.toFixed(0)}%`;
}
const heatBar = (p) => Math.round(heatT(p) * 100);

// ── 运行流程图(手写,架构语义稳定;热图数据部分自动生成)──────────────────────
const FLOWS = [
  {
    id: "record", title: "① 一次录制会话", sub: "app.daemon → record 子进程 → 落盘",
    nodes: [
      ["cron", "定时窗口", "daemon tick(60s)", "app"],
      ["proc", "record 子进程", "task-manager spawn", "entry"],
      ["poll", "PollingRecorder", "每 30s getLiving / getStream", "engine"],
      ["plat", "Platform", "douyin / bilibili / kuaishou", "platform"],
      ["live", "确认开播", "fire onLive", "engine"],
      ["dl", "下载落盘", "ffmpeg(.ts) / mesio(.flv)", "engine"],
      ["dm", "connectDanmu", "onLive 后才连(拿本场 liveId)", "platform"],
      ["xml", "XmlDanmuWriter", "biliLive 格式 .xml", "session"],
    ],
    edges: [["cron","proc"],["proc","poll"],["poll","plat"],["poll","live"],["live","dl"],["live","dm"],["dm","xml"],["dl","xml"]],
  },
  {
    id: "hub", title: "② 多节点 hub 后处理", sub: "节点录制 → master 选优 → 合并/烧录/上传",
    nodes: [
      ["intent", "控制台意图", "任务页启停 + Hub 页选节点", "app"],
      ["sync", "任务同步", "local store / ssh _apply-tasks", "hub"],
      ["nodes", "选中节点录制", "local / vps1 / vps2", "platform"],
      ["inv", "listInventory", "local scan / ssh _inventory", "hub"],
      ["clu", "聚类", "(platform,roomSlug) → streamKey", "hub"],
      ["sel", "select 选优", "覆盖度优先(完整录全)", "hub"],
      ["pull", "pull → stage", "rsync 回传 winner", "hub"],
      ["mg", "merge → burn", "复用 post-process", "core"],
      ["up", "穿插上传", "P1 ∥ 烧录, append 分P", "entry"],
    ],
    edges: [["intent","sync"],["sync","nodes"],["nodes","inv"],["inv","clu"],["clu","sel"],["sel","pull"],["pull","mg"],["mg","up"]],
    note: "experimental:不烧录的房间可走 nodeSideUpload —— winner 节点本地 remux+上传,跳过 pull(见 plans/027)",
  },
];

function flowSvg(flow) {
  const BW = 168, BH = 62, GX = 40, GY = 74, PAD = 22;
  const n = flow.nodes.length;
  // 两行折返:每行 5 个。
  const perRow = 5;
  const rows = Math.ceil(n / perRow);
  const W = PAD * 2 + Math.min(n, perRow) * BW + (Math.min(n, perRow) - 1) * GX;
  const H = PAD * 2 + rows * BH + (rows - 1) * GY + 26;
  const pos = flow.nodes.map((_, i) => {
    const r = Math.floor(i / perRow);
    const c = r % 2 === 0 ? i % perRow : perRow - 1 - (i % perRow);
    return { x: PAD + c * (BW + GX), y: PAD + r * (BH + GY) };
  });
  const byId = Object.fromEntries(flow.nodes.map((x, i) => [x[0], i]));
  const boxes = flow.nodes.map((nd, i) => {
    const [id, label, sub, role] = nd;
    const col = ROLE[role].c;
    const { x, y } = pos[i];
    return `<g class="fnode" data-id="${esc(id)}">
      <rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="10" class="fbox" style="--role:${col}" stroke="${col}" stroke-opacity=".55"/>
      <rect x="${x}" y="${y}" width="3" height="${BH}" rx="1.5" fill="${col}"/>
      <text x="${x + 14}" y="${y + 25}" class="fl">${esc(label)}</text>
      <text x="${x + 14}" y="${y + 43}" class="fs">${esc(sub)}</text>
    </g>`;
  }).join("");
  const links = flow.edges.map(([a, b]) => {
    const i = byId[a], j = byId[b];
    const A = pos[i], B = pos[j];
    const sameRow = Math.abs(A.y - B.y) < 1;
    let x1, y1, x2, y2, d;
    if (sameRow) {
      const fwd = B.x > A.x;
      x1 = fwd ? A.x + BW : A.x; y1 = A.y + BH / 2;
      x2 = fwd ? B.x : B.x + BW; y2 = B.y + BH / 2;
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else {
      // 换行:从底边中点折到下一行第一个的顶边
      x1 = A.x + BW / 2; y1 = A.y + BH;
      x2 = B.x + BW / 2; y2 = B.y;
      const midY = (y1 + y2) / 2;
      d = `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;
    }
    return `<path class="fedge" d="${d}" marker-end="url(#arrow)"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="flow-svg" role="img" aria-label="${esc(flow.title)}">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/></marker></defs>
    ${links}${boxes}
  </svg>`;
}

const legend = Object.entries(ROLE).map(([k, v]) => `<span class="lg"><i style="background:${v.c}"></i>${esc(v.name)}</span>`).join("");

// ── 生成 architecture.md 里的 mermaid 依赖图(从真实 package.json 算,消除文档漂移)──────
// 段落用标记锚定,重复运行幂等。手改这段会被下次生成覆盖。
const MD_PATH = join(ROOT, "docs", "architecture.md");
const MD_BEGIN = "<!-- BEGIN GENERATED: deps -->";
const MD_END = "<!-- END GENERATED: deps -->";

/** 每包一句话职责(手写:语义无法从代码算出;包新增时这里必须补,否则生成时抛错提醒)。 */
const PKG_BLURB = {
  "@drec/core": "Platform / DownloadEngine 契约<br/>+ 注册表 + types/config/notify/api-types",
  "@drec/observability": "Notifier / EventCenter / 日志",
  "@drec/post-process": "concat / burn / ass / merge / ffmpeg / fonts",
  "@drec/tui": "Ink 终端控制台 (独立 bundle)",
  "@drec/ffmpeg-recorder-extra": "logStreamMeta + detectDevice",
  "@drec/record-engine": "通用 PollingRecorder<br/>下载引擎: ffmpeg(.ts) / mesio(.flv)",
  "@drec/douyin-live": "douyinPlatform<br/>stream(a_bogus 取流) + danmaku(自有 TS WS)",
  "@drec/bilibili-live": "bilibiliPlatform<br/>getStream + connectDanmu(WBI + 二进制 WS)",
  "@drec/kuaishou-live": "kuaishouPlatform<br/>取流 = 直播页 __INITIAL_STATE__(无弹幕)",
  "@drec/manager": "RecordingSession 会话生命周期<br/>onLive→connectDanmu / 断流重连 / drain",
  "@drec/app": "db/store/hub-store(文件版规则)/ daemon/scheduler/task-manager<br/>web(api+server)/ login(扫码)/ upload / anchor",
  "@drec/orchestrator": "Transport(local/ssh/tailscale-ssh) / identity 聚类<br/>select 选优 / reconciler / pipeline / SyncLedger",
  "@drec/cli": "record / merge / burn / probe + task 命令组<br/>providers-register: 注册平台 + 引擎",
};
const NODE_ID = {
  "@drec/core": "core", "@drec/observability": "observ", "@drec/post-process": "post",
  "@drec/tui": "tui", "@drec/ffmpeg-recorder-extra": "extra", "@drec/record-engine": "engine",
  "@drec/douyin-live": "douyin", "@drec/bilibili-live": "bilibili", "@drec/kuaishou-live": "kuaishou",
  "@drec/manager": "manager", "@drec/app": "app", "@drec/orchestrator": "orch", "@drec/cli": "cli",
};

function buildMermaid() {
  // 包 → 分组合并(同 rank 的包放一个 subgraph)。
  const byRank = new Map();
  for (const p of pkgs) {
    if (!PKG_BLURB[p.name]) throw new Error(`PKG_BLURB 缺 ${p.name} 的职责描述(新增包必须补)`);
    if (!NODE_ID[p.name]) throw new Error(`NODE_ID 缺 ${p.name} 的 mermaid 节点 id`);
    const arr = byRank.get(p.rank) ?? [];
    arr.push(p);
    byRank.set(p.rank, arr);
  }
  const ranksSorted = [...byRank.keys()].sort((a, b) => b - a); // 高层在上
  const lines = ["flowchart TB"];
  for (const r of ranksSorted) {
    const label = (RANK_LABEL[r] ?? `rank ${r}`).replace(" · ", " · ");
    const gid = `L${String(r).replace(".", "")}`;
    lines.push(`  subgraph ${gid}["${label}"]`);
    for (const p of byRank.get(r)) {
      lines.push(`    ${NODE_ID[p.name]}["<b>${p.dir}</b><br/>${PKG_BLURB[p.name]}"]`);
    }
    lines.push("  end");
  }
  lines.push("");
  // 边:从真实依赖算(不写死)。按源包 rank 降序便于阅读。
  const edgeLines = [];
  for (const p of [...pkgs].sort((a, b) => b.rank - a.rank)) {
    for (const d of [...p.deps].sort()) {
      if (!NODE_ID[d]) continue; // 忽略非本图包
      edgeLines.push(`  ${NODE_ID[p.name]} --> ${NODE_ID[d]}`);
    }
  }
  lines.push(...edgeLines);
  lines.push("");
  // 接缝着色。
  const platIds = pkgs.filter((p) => SEMANTIC[p.name] === "platform").map((p) => NODE_ID[p.name]);
  const engIds = pkgs.filter((p) => SEMANTIC[p.name] === "engine").map((p) => NODE_ID[p.name]);
  lines.push("  classDef axisPlat fill:#dcfce7,stroke:#16a34a,color:#14532d;");
  lines.push("  classDef axisEng fill:#ffedd5,stroke:#ea580c,color:#7c2d12;");
  if (platIds.length) lines.push(`  class ${platIds.join(",")} axisPlat;`);
  if (engIds.length) lines.push(`  class ${engIds.join(",")} axisEng;`);
  return lines.join("\n");
}

const MERMAID = buildMermaid();

const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>直播录制 · 架构图</title>
<!-- ⚠️ 本文件由 scripts/gen-architecture.mjs 生成,请勿手改。
     数据源:packages/*/package.json + test/arch/layering.test.ts + git log。
     重新生成:node scripts/gen-architecture.mjs (--days N 换热度窗口) -->
<style>
  :root{
    --canvas:#020617; --mask:#0f172a; --panel:#0b1220; --ink:#fff; --muted:#94a3b8; --dim:#64748b;
    --border:#1e293b; --accent:#22d3ee;
    --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  html[data-theme="light"]{
    --canvas:#f8fafc; --mask:#fff; --panel:#fff; --ink:#0f172a; --muted:#475569; --dim:#94a3b8;
    --border:#e2e8f0; --accent:#0891b2;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--canvas);color:var(--ink);font-family:var(--mono);line-height:1.55;
       background-image:radial-gradient(circle at 1px 1px, color-mix(in srgb,var(--border) 60%, transparent) 1px, transparent 0);
       background-size:22px 22px;}
  .wrap{max-width:1240px;margin:0 auto;padding:34px 22px 80px}
  header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:8px}
  h1{font-size:1.55rem;margin:0;letter-spacing:-.025em;font-weight:700}
  .sub{color:var(--muted);font-size:.8rem;margin:6px 0 0}
  .gen{color:var(--dim);font-size:.68rem;margin:8px 0 0}
  .tools{display:flex;gap:8px}
  .tbtn{background:var(--mask);border:1px solid var(--border);color:var(--ink);font:inherit;font-size:.7rem;
        padding:7px 12px;border-radius:.5rem;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .tbtn:hover{border-color:var(--accent);color:var(--accent)}
  h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);font-weight:700;
     margin:38px 0 14px;display:flex;align-items:center;gap:10px}
  h2::after{content:"";flex:1;height:1px;background:var(--border)}
  .legend{display:flex;flex-wrap:wrap;gap:14px;font-size:.68rem;color:var(--muted);margin-bottom:18px}
  .lg{display:inline-flex;align-items:center;gap:6px}
  .lg i{width:9px;height:9px;border-radius:2px;display:inline-block}
  .heatkey{display:flex;align-items:center;gap:10px;font-size:.66rem;color:var(--dim);margin:-6px 0 18px}
  .heatbar-demo{width:150px;height:9px;border-radius:5px;background:linear-gradient(90deg,#1e293b,#334155,#fbbf24,#fb7185)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:10px}
  .band{margin-bottom:16px}
  .blabel{font-size:.63rem;font-weight:700;color:var(--dim);letter-spacing:.1em;text-transform:uppercase;margin:0 0 8px}
  .card{border:1px solid var(--border);border-radius:.85rem;padding:12px 14px;position:relative;overflow:hidden;
        transition:transform .12s ease,border-color .12s ease;min-width:0;
        background:color-mix(in oklab, var(--role) var(--mix), var(--panel))}
  .card:hover{transform:translateY(-2px);border-color:var(--accent)}
  .card .rail{position:absolute;left:0;top:0;bottom:0;width:3px}
  .card .t{font-weight:700;font-size:.84rem;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .card .pkg{font-size:.6rem;color:var(--dim);margin-top:2px;word-break:break-all}
  .card .m{font-size:.66rem;color:var(--muted);margin-top:9px;display:flex;gap:10px;flex-wrap:wrap}
  .card .m b{color:var(--ink);font-weight:600}
  .seam{font-size:.55rem;font-weight:800;letter-spacing:.06em;border-radius:999px;padding:2px 7px;
        border:1px solid currentColor;opacity:.95}
  .hbar{margin-top:9px;height:4px;border-radius:3px;background:var(--border);overflow:hidden}
  .hbar>i{display:block;height:100%;border-radius:3px}
  .flow-svg{width:100%;height:auto;display:block;background:var(--panel);border:1px solid var(--border);border-radius:.85rem;padding:6px}
  .fbox{fill:color-mix(in oklab, var(--role) 12%, var(--panel))}
  .fnode .fl{fill:var(--ink);font-family:var(--mono);font-size:12.5px;font-weight:600}
  .fnode .fs{fill:var(--muted);font-family:var(--mono);font-size:10.5px}
  .fnode{transition:filter .15s ease}
  .fnode:hover{filter:brightness(1.35)}
  .fedge{fill:none;stroke:var(--dim);stroke-width:1.5;stroke-dasharray:5 4;animation:dash 1.2s linear infinite}
  @keyframes dash{to{stroke-dashoffset:-18}}
  .note{margin-top:12px;border:1px solid color-mix(in oklab,var(--accent) 40%, var(--border));
        border-radius:.75rem;padding:11px 14px;font-size:.72rem;color:var(--muted);background:color-mix(in oklab,var(--accent) 6%, transparent)}
  .note b{color:var(--accent)}
  table{width:100%;border-collapse:collapse;font-size:.72rem}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
  th{font-size:.62rem;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);font-weight:700}
  td.n{text-align:right;font-variant-numeric:tabular-nums}
  td code{color:var(--accent);font-size:.7rem}
  .edge{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:5px 18px;font-size:.68rem;color:var(--muted)}
  .edge span{white-space:nowrap}
  .edge em{color:var(--dim);font-style:normal}
  @media(max-width:640px){.grid{grid-template-columns:1fr}h1{font-size:1.25rem}}
  @media print{body{background:#fff}.fedge{animation:none}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>直播录制 · 架构图</h1>
      <p class="sub">抖音 / B站 / 快手直播录制 + 弹幕 + 多节点 hub 后处理。两个可插拔接缝:平台轴 + 引擎轴。</p>
      <p class="gen">由 scripts/gen-architecture.mjs 生成 · 热度窗口近 ${DAYS} 天 · ${new Date().toISOString().slice(0,16).replace("T"," ")}</p>
    </div>
    <div class="tools">
      <button class="tbtn" id="theme">◐ 主题</button>
      <button class="tbtn" onclick="window.print()">⎙ 打印</button>
    </div>
  </header>

  <h2>包热图(按依赖层 · 颜色 = 语义角色 · 亮度 = 变更热度)</h2>
  <div class="legend">${legend}</div>
  <div class="heatkey"><span>冷(少改)</span><span class="heatbar-demo"></span><span>热(常改)</span>
    <span>·</span><span>卡片右下进度条 = 该包近 ${DAYS} 天提交数占比</span></div>

  ${[...new Set(all.map((p) => p.rank))].map((rank) => {
    const group = all.filter((p) => p.rank === rank);
    return `<div class="band">
      <div class="blabel">${esc(RANK_LABEL[rank] ?? `rank ${rank}`)}</div>
      <div class="grid">${group.map((p) => {
        const role = roleOf(p.name);
        const seam = SEMANTIC[p.name] === "platform" ? `<span class="seam" style="color:${role.c}">平台轴</span>`
          : SEMANTIC[p.name] === "engine" ? `<span class="seam" style="color:${role.c}">引擎轴</span>` : "";
        return `<div class="card" style="${cardStyle(p)}" title="${esc(p.name)} · ${p.loc} LOC · ${p.files} 文件 · ${p.srcTests} 测试 · 近 ${DAYS} 天 ${p.churn} 次提交">
          <span class="rail" style="background:${role.c}"></span>
          <div class="t">${esc(p.dir)}${seam}</div>
          <div class="pkg">${esc(p.name)}</div>
          <div class="m"><span><b>${p.loc}</b> LOC</span><span><b>${p.files}</b> 文件</span><span><b>${p.srcTests}</b> 测试</span><span><b>${p.churn}</b> Δ</span></div>
          <div class="hbar"><i style="width:${heatBar(p)}%;background:${role.c}"></i></div>
        </div>`;
      }).join("")}</div>
    </div>`;
  }).join("\n  ")}

  <h2>运行流程</h2>
  ${FLOWS.map((f) => `<div class="band">
    <div class="blabel">${esc(f.title)} — ${esc(f.sub)}</div>
    ${flowSvg(f)}
    ${f.note ? `<div class="note"><b>实验特性</b> · ${esc(f.note)}</div>` : ""}
  </div>`).join("\n  ")}

  <h2>包明细</h2>
  <table>
    <thead><tr><th>包</th><th>层</th><th>角色</th><th class="n">LOC</th><th class="n">文件</th><th class="n">测试</th><th class="n">近 ${DAYS} 天提交</th></tr></thead>
    <tbody>${all.map((p) => `<tr>
      <td><code>${esc(p.dir)}</code></td>
      <td>${esc(RANK_LABEL[p.rank] ?? p.rank)}</td>
      <td><span style="color:${roleOf(p.name).c}">●</span> ${esc(roleOf(p.name).name)}</td>
      <td class="n">${p.loc}</td><td class="n">${p.files}</td><td class="n">${p.srcTests}</td><td class="n">${p.churn}</td>
    </tr>`).join("\n    ")}</tbody>
  </table>

  <h2>依赖边</h2>
  <div class="edge">${edges.map(([a,b]) => `<span>${esc(a.replace("@drec/",""))} <em>→</em> ${esc(b.replace("@drec/",""))}</span>`).join("")}</div>

  <div class="note">
    <b>接新平台</b> = 写一个 <code>&lt;平台&gt;-live</code>(实现 Platform:getStream / getLiving / connectDanmu? / matchUrl)+ providers-register.ts 注册一行 → 引擎白嫖 record-engine。<br>
    <b>加新引擎</b> = record-engine 加一个 DownloadEngine 策略 + registerEngine 一行 → 所有平台立即可用。<br>
    <b>热图含义</b>:orchestrator / app / web / cli 是改动热点;平台包与引擎包改动少 —— 这正是抽象的目的(接缝稳定)。<br>
    <b>本图自动生成</b>,不会与 architecture.md 漂移;手改会被下次生成覆盖。
  </div>
</div>
<script>
  const root = document.documentElement;
  document.getElementById("theme").onclick = () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  };
</script>
</body>
</html>
`;

/** 把 mermaid 依赖图写进 architecture.md 的锚定段落(幂等)。 */
function patchMarkdown(checkOnly) {
  const md = readFileSync(MD_PATH, "utf-8");
  const i = md.indexOf(MD_BEGIN);
  const j = md.indexOf(MD_END);
  if (i < 0 || j < 0) {
    console.error(`architecture.md 缺锚定标记 ${MD_BEGIN} / ${MD_END}`);
    process.exit(1);
  }
  const body = `${MD_BEGIN}\n\n\`\`\`mermaid\n${MERMAID}\n\`\`\`\n\n${MD_END}`;
  const next = md.slice(0, i) + body + md.slice(j + MD_END.length);
  if (next === md) return false;
  if (!checkOnly) writeFileSync(MD_PATH, next);
  return true;
}

if (CHECK) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf-8") : "";
  const strip = (s) => s.replace(/生成 · 热度窗口近 \d+ 天 · [^<]*/, "");
  const htmlDrift = strip(cur) !== strip(html);
  const mdDrift = patchMarkdown(true);
  if (htmlDrift || mdDrift) {
    const which = [htmlDrift && "architecture.html", mdDrift && "architecture.md"].filter(Boolean).join(" / ");
    console.error(`${which} 与仓库不一致,请跑: node scripts/gen-architecture.mjs`);
    process.exit(1);
  }
  console.log("architecture.html + architecture.md 与仓库一致 ✓");
} else {
  writeFileSync(OUT, html);
  const mdChanged = patchMarkdown(false);
  console.log(`wrote ${OUT} (${all.length} 包, ${edges.length} 依赖边, 热度窗口 ${DAYS}d)`);
  console.log(`patched ${MD_PATH}${mdChanged ? " (mermaid 已更新)" : " (mermaid 无变化)"}`);
}
