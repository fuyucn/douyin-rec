/**
 * paths.ts — 单一数据根(DOUYIN_REC_ROOT)+ 固定内部布局。
 *
 *   <root>/db/douyin-rec.db          数据库(含抖音账号 cookie)
 *   <root>/recordings/               录像输出
 *   <root>/stage/                    hub 合成暂存(合并/烧录中间产物)
 *   <root>/logs/hub/<平台>_<房间号>/  hub 场次日志(永久保留;不放 stage,清理 stage 不会带走日志)
 *   <root>/config/biliup/cookies.json  biliup B站上传 cookie
 *   <root>/config/hub.config.json    hub 全局配置;<root>/config/hub/       hub 每房间任务配置
 *
 * **root 永远有值**:未设 `DOUYIN_REC_ROOT` 时默认 `DEFAULT_ROOT`("./output-data",相对启动 cwd)——
 * 所有运行数据(db/recordings/stage/config)收进这一个目录,不再散落在项目根(旧默认各自 `./recordings`、
 * `./douyin-rec.db`、`./stage`、`./config/hub` 平铺在 cwd)。类比 docker 的 `docker-data/`(那里 root 固定
 * 由 compose 设为容器内 `/data`,不受此默认影响)。
 * 解析优先级(各处一致):专用 env(DOUYIN_REC_DB / DOUYIN_REC_OUTPUT / BILIUP_COOKIE)
 * > 由 DOUYIN_REC_ROOT(或其默认值)派生的固定子路径。专用 env 仍可单独覆盖某一项。
 */
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseOutputLayout, type PathLayout } from "@drec/core";
import { procQueueDbPath as procQueueDbPathOf } from "@drec/proc-queue";
import { hostname as osHostname } from "node:os";

/** 未设 DOUYIN_REC_ROOT 时的默认数据根(相对启动 cwd)。db/recordings/stage/config 都收在这一个目录下。 */
export const DEFAULT_ROOT = "./output-data";

/**
 * hub 全局配置模板内容。**单一真相 = 仓库源文件 `configs/hub.config.example.json`**。
 * 打包(`pnpm bundle`)时 esbuild 经 `define` 把该文件文本内联成 `__HUB_CONFIG_EXAMPLE__`(单文件运行时无仓库目录);
 * 非打包(tsx/vitest)`__HUB_CONFIG_EXAMPLE__` 未声明 → 从仓库源文件读(相对本文件定位 repo 根)。
 */
declare const __HUB_CONFIG_EXAMPLE__: string | undefined;
function hubConfigExampleText(): string {
  if (typeof __HUB_CONFIG_EXAMPLE__ !== "undefined" && __HUB_CONFIG_EXAMPLE__) return __HUB_CONFIG_EXAMPLE__;
  return readFileSync(new URL("../../../configs/hub.config.example.json", import.meta.url), "utf-8");
}

/** 数据根:DOUYIN_REC_ROOT(去空白)未设 → 回落 {@link DEFAULT_ROOT}。永远返回有值的路径。 */
export function drecRoot(): string {
  const r = (process.env.DOUYIN_REC_ROOT ?? "").trim();
  return r.length > 0 ? r : DEFAULT_ROOT;
}

/** <root>/config。 */
export function rootConfigDir(): string {
  return join(drecRoot(), "config");
}

/**
 * <root>/config/hub.config.json(多节点编排全局「实际生效」配置;复制自 .example 后改)。
 * **兼容**:新路径不存在但旧 `hub-config.json` 在 → 返回旧路径(平滑迁移,老部署不中断)。
 */
export function rootHubConfig(): string {
  const d = rootConfigDir();
  const cur = join(d, "hub.config.json");
  const old = join(d, "hub-config.json");
  if (!existsSync(cur) && existsSync(old)) return old; // 迁移兼容:只在新文件缺失时回退旧名
  return cur;
}

/** <root>/config/hub —— 每房间 hub 任务配置文件目录(一房间一 {roomSlug}.json)。 */
export function rootHubDir(): string {
  return join(rootConfigDir(), "hub");
}

/** <root>/config/hub/{roomSlug}.json —— 单个房间的 hub 任务配置文件路径。 */
export function rootHubTaskConfig(roomSlug: string): string {
  return join(rootHubDir(), `${roomSlug}.json`);
}

/**
 * 数据根初始化时**复制一份多节点编排配置模板**到 `<root>/config/hub.config.example.json`。
 * 内容逐字来自仓库源文件 `configs/hub.config.example.json`(见 `hubConfigExampleText`,bundle 内联 / dev 读源文件)。
 * 幂等:文件已存在则不覆盖(保留用户改动)。返回写入路径,已存在返回 undefined。
 * 模板是占位值(dataRoot=/data、host=CHANGE-ME、uploadMode=stage-only)——复制后按环境改;字段说明见 docs/multi-node-sync.md「配置」。
 */
export function ensureHubConfigExample(): string | undefined {
  const cfgDir = rootConfigDir();
  const path = join(cfgDir, "hub.config.example.json");
  if (existsSync(path)) return undefined;
  mkdirSync(cfgDir, { recursive: true });
  // 顺带建 hub/ 任务目录(空也建,UI/手放任务文件即用)。
  try { mkdirSync(join(cfgDir, "hub"), { recursive: true }); } catch { /* 忽略 */ }
  writeFileSync(path, hubConfigExampleText(), "utf-8");
  return path;
}

/** <root>/db/douyin-rec.db。 */
export function rootDbPath(): string {
  return join(drecRoot(), "db", "douyin-rec.db");
}

/** <root>/db/proc-queue.db —— 处理任务表;路径单点在 `@drec/proc-queue`,此处只转发(不受 `--db` 覆盖)。 */
export function procQueueDbPath(): string {
  return procQueueDbPathOf(drecRoot());
}

/** <root>/recordings。 */
export function rootOutputDir(): string {
  return join(drecRoot(), "recordings");
}

/** <root>/stage —— hub 合成暂存(合并/烧录中间产物;上传后可按 cleanup 配置清理)。 */
export function rootStageDir(): string {
  return join(drecRoot(), "stage");
}

/** <root>/logs —— hub 场次日志根(`logs/hub/<平台>_<房间号>/<场次>.log`,永久保留,不在 stage 内)。 */
export function rootLogsDir(): string {
  return join(drecRoot(), "logs");
}

/**
 * <root>/config/output-layout.json —— this node's LOCAL switch for the room-directory layout (issue #336):
 * `{"layout":"room"}` makes NEW recording sessions and NEW stage session dirs use `<name>_<platform>_<room>/`.
 * Absent / unreadable / anything else = legacy. It is a file in the data root (not an env var) so ssh-launched
 * hidden commands, which do not inherit the service environment, see the same value. Each node flips its own
 * switch, which keeps mixed-version fleets safe: a node that has not been switched keeps the old layout.
 */
export function rootOutputLayoutPath(root?: string): string {
  return join(root ? join(root, "config") : rootConfigDir(), "output-layout.json");
}

/** Current layout switch of this node; read on every call (the file is the single source of truth). */
export function readOutputLayout(root?: string): PathLayout {
  try {
    const raw = JSON.parse(readFileSync(rootOutputLayoutPath(root), "utf-8")) as { layout?: unknown } | null;
    return parseOutputLayout(raw?.layout);
  } catch {
    return "legacy";
  }
}

/** <root>/config/biliup/cookies.json。 */
export function rootBiliupCookies(): string {
  return join(drecRoot(), "config", "biliup", "cookies.json");
}

/**
 * <root>/config/node.json —— 本节点的**稳定身份**(nodeId/hostname/createdAt)。
 * `root` 可选:省略用 {@link drecRoot}(本进程数据根);显式传用于「探测别的数据根」(如 master
 * 从 UI 探测 local worker 时 cfg.dataRoot 与自身 drecRoot 可能不同)。
 */
export function rootNodeIdentityPath(root?: string): string {
  return join(root ? join(root, "config") : rootConfigDir(), "node.json");
}

/** 节点身份文件的内容。nodeId 首次生成后**永久不变**(跨重启/换 master/迁移都保持)。 */
export interface NodeIdentity {
  /**
   * 稳定唯一 id:**16 字符小写 hex**(8 字节随机 = 64 位),首次启动生成并持久化。
   *
   * 为什么不是 uuid v4:uuid 36 字符带连字符,在 UI/日志/URL 里偏长。8 字节 hex 同样够用
   * (碰撞概率 2^-64 量级,节点数远小于此),且只含 `[0-9a-f]` —— 满足 worker id 路由
   * `/api/hub/workers/([A-Za-z0-9_-]+)` 与日志可读性(一眼认出是 id 而非人写的昵称)。
   */
  nodeId: string;
  /** 生成时的主机名(仅作显示提示,可被 master 覆盖 name)。 */
  hostname: string;
  /** 首次生成时间(ISO)。 */
  createdAt: string;
}

/**
 * 读本节点身份;不存在则**首次自动生成并落盘**(`<root>/config/node.json`)。
 *
 * 为什么要它:此前 worker 的 id 由 **master** 按 `workerSeq` 分配(`worker-1`/`worker-2`…)——
 * 删了重建就换号 → hub 规则里引用的 id 变幽灵、身份丢失。改为节点**自生成稳定 id**,
 * master 只读不改:同一台机器永远同一个 id,换 master / 重启 / 迁移都不变。
 *
 * 幂等:已存在则原样返回(绝不重写 nodeId)。坏 JSON → 重新生成(容错,不抛)。
 */
function safeHostname(): string {
  try { return osHostname(); } catch { return ""; }
}

export function ensureNodeIdentity(root?: string): NodeIdentity {
  const path = rootNodeIdentityPath(root);
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<NodeIdentity>;
    if (raw?.nodeId && typeof raw.nodeId === "string" && raw.nodeId.trim()) {
      return { nodeId: raw.nodeId, hostname: raw.hostname ?? "", createdAt: raw.createdAt ?? "" };
    }
  } catch { /* 缺失/坏 JSON → 下面重新生成 */ }
  const id: NodeIdentity = {
    // 8 字节 → 16 字符 hex(短、随机、URL/路径安全,见 NodeIdentity.nodeId 注释)。
    nodeId: randomBytes(8).toString("hex"),
    // `process.env.HOSTNAME` 在 ssh 非登录 shell 里常为空 → 用 os.hostname() 兜底(仅显示用,失败不致命)。
    hostname: ((process.env.HOSTNAME ?? "").trim() || safeHostname()),
    createdAt: new Date().toISOString(),
  };
  try {
    mkdirSync(root ? join(root, "config") : rootConfigDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(id, null, 2) + "\n", "utf-8");
  } catch { /* 只读环境 → 内存里仍返回可用 id;下次启动会再试 */ }
  return id;
}

/**
 * 解析输出目录(录像)。**录制端(record-args)与合成端(api recordingsDir)必须用同一函数**,
 * 否则录到一处、合成去另一处找。优先级:任务 outDir > DOUYIN_REC_OUTPUT > <root>/recordings。
 */
export function resolveOutputDir(taskOutDir?: string | null): string {
  return taskOutDir ?? process.env.DOUYIN_REC_OUTPUT ?? rootOutputDir();
}
