/**
 * worker-store.ts — 文件版 worker(录制节点)配置存储。真理源 = hub.config.json 的 workers 数组。
 * 读时不缓存 → UI 与手改文件天然同步;原子写(temp+rename)保留所有非 worker 字段。
 * 分层:纯文件 CRUD,零 orchestrator 依赖(app L4)。id 分配/默认 name/tenants→workers 迁移/local 保护都在这里。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { WorkerConfig } from "@drec/core";

// 契约在 core(orchestrator 也要用同一形状);这里 re-export 保持既有调用点不变。
export type { WorkerConfig } from "@drec/core";

const KINDS = new Set(["local", "ssh", "tailscale-ssh"]);

interface HubConfigFile { workerSeq?: number; workers?: WorkerConfig[]; tenants?: WorkerConfig[]; [k: string]: unknown }

function readConfig(path: string): HubConfigFile {
  try { return JSON.parse(readFileSync(path, "utf-8")) as HubConfigFile; }
  catch { return {}; } // 缺失/坏 JSON → 空(list 返 []);create 会写出合法文件
}

/** 归一 workers 数组:workers ?? tenants(旧键 back-compat)。不改盘,只读。 */
function workersOf(cfg: HubConfigFile): WorkerConfig[] {
  return cfg.workers ?? cfg.tenants ?? [];
}

/** 原子写:临时文件 + rename。迁移 tenants→workers(删旧键)。保留其余字段。 */
function writeConfig(path: string, cfg: HubConfigFile, workers: WorkerConfig[], workerSeq: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const next: HubConfigFile = { ...cfg, workers, workerSeq };
  delete next.tenants; // 迁移:统一到 workers
  const tmp = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

function validate(kind: string, host: string | undefined, dataRoot: string | undefined): void {
  if (!KINDS.has(kind)) throw new Error(`未知 worker kind: ${kind}(合法: ${[...KINDS].join("/")})`);
  if (!dataRoot) throw new Error("dataRoot 必填");
  if ((kind === "ssh" || kind === "tailscale-ssh") && !host) throw new Error(`${kind} 类型需要 host`);
}

/**
 * 归一能力标签:去空白、去空串、去重(保持首次出现顺序)。空/全空 → undefined(= 不写该字段,
 * 保持 hub.config.json 干净;向后兼容没有该字段的旧配置)。
 */
function normalizeCapabilities(caps: string[] | undefined): string[] | undefined {
  if (!caps) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of caps) {
    const c = String(raw ?? "").trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.length > 0 ? out : undefined;
}

export function listWorkers(configPath: string): WorkerConfig[] {
  return workersOf(readConfig(configPath));
}

export function createWorker(
  configPath: string,
  input: {
    name?: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string; capabilities?: string[];
    /**
     * 显式指定 worker id(通常是节点自报的稳定 nodeId)。给了就用它,不再自分配 `worker-N`。
     * 已存在同 id → 抛错(防重复添加),由调用方提示用户。
     */
    id?: string;
  },
): WorkerConfig {
  validate(input.kind, input.host, input.dataRoot);
  const cfg = readConfig(configPath);
  const workers = [...workersOf(cfg)];
  // 单调 seq:cfg.workerSeq 起,跳过任何已存在的 worker-N(绝不复用/碰撞)。
  const prevSeq = cfg.workerSeq ?? 0;
  let seq = prevSeq + 1;
  const has = (id: string): boolean => workers.some((w) => w.id === id);
  let id: string;
  const explicit = (input.id ?? "").trim();
  if (explicit) {
    if (explicit === "local") throw new Error("id 'local' 是 master 自身保留 id");
    if (has(explicit)) throw new Error(`worker id 已存在: ${explicit}`);
    id = explicit;
    seq = prevSeq; // 显式 id 不占序号 → 不推进 workerSeq(否则白白跳号)
  } else {
    while (has(`worker-${seq}`)) seq++;
    id = `worker-${seq}`;
  }
  const name = (input.name ?? "").trim() || input.host || (explicit ? id : `Worker ${seq}`);
  const w: WorkerConfig = { id, name, kind: input.kind, dataRoot: input.dataRoot };
  if (input.host) w.host = input.host;
  if (input.apiUrl) w.apiUrl = input.apiUrl;
  const caps = normalizeCapabilities(input.capabilities);
  if (caps) w.capabilities = caps;
  workers.push(w);
  writeConfig(configPath, cfg, workers, seq);
  return w;
}

export function updateWorker(
  configPath: string,
  id: string,
  patch: { name?: string; kind?: string; host?: string; dataRoot?: string; apiUrl?: string; capabilities?: string[] },
): WorkerConfig | null {
  const cfg = readConfig(configPath);
  const workers = [...workersOf(cfg)];
  const i = workers.findIndex((w) => w.id === id);
  if (i < 0) return null;
  const cur = workers[i];
  // local(master 自身)保护:不可改 kind(可改 name/host/dataRoot)。
  if (id === "local" && patch.kind != null && patch.kind !== cur.kind) throw new Error("local worker(master 自身)不可改 kind");
  const next: WorkerConfig = { ...cur };
  if (patch.name != null) next.name = patch.name.trim() || cur.name;
  if (patch.kind != null) next.kind = patch.kind;
  if (patch.host != null) next.host = patch.host || undefined;
  if (patch.dataRoot != null) next.dataRoot = patch.dataRoot;
  if (patch.apiUrl != null) next.apiUrl = patch.apiUrl || undefined;
  // capabilities:显式传才覆盖(空数组 = 清空能力);未传沿用。
  if (patch.capabilities != null) {
    const caps = normalizeCapabilities(patch.capabilities);
    if (caps) next.capabilities = caps;
    else delete next.capabilities;
  }
  validate(next.kind, next.host, next.dataRoot);
  workers[i] = next;
  writeConfig(configPath, cfg, workers, cfg.workerSeq ?? 0);
  return next;
}

export function deleteWorker(configPath: string, id: string): boolean {
  if (id === "local") throw new Error("local worker(master 自身)不可删除");
  const cfg = readConfig(configPath);
  const workers = workersOf(cfg);
  const next = workers.filter((w) => w.id !== id);
  if (next.length === workers.length) return false; // 不存在
  writeConfig(configPath, cfg, next, cfg.workerSeq ?? 0);
  return true;
}

/** 整体重排版序:ids 必须与现有 worker 集合完全相等,按数组顺序写回(数组序 = 显示序)。 */
export function reorderWorkers(configPath: string, ids: string[]): WorkerConfig[] {
  const cfg = readConfig(configPath);
  const workers = workersOf(cfg);
  const byId = new Map(workers.map((w) => [w.id, w]));
  if (ids.length !== workers.length || ids.some((id) => !byId.has(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`重排失败: 顺序与现有 worker 不匹配(现有 ${workers.length} 个)`);
  }
  const next = ids.map((id) => byId.get(id)!);
  writeConfig(configPath, cfg, next, cfg.workerSeq ?? 0);
  return next;
}
