export interface TenantConfig { id: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string; }

export interface NodeRecording {
  roomSlug: string;
  sessionBase: string;       // 如 一勺小苏打_2026-06-27_07-54-33
  tsFiles: string[];         // 绝对/相对该节点路径
  xmlPath?: string;
  durationSec: number;       // 实录总时长(各段之和)
  startMs: number;           // 首段开录 epoch ms
  endMs: number;             // 末段收录 epoch ms
  totalGapSec: number;       // 断流缺口总秒数(来自 gaps sidecar)
}
export interface NodeInventory { tenantId: string; recordings: NodeRecording[]; }

export interface Transport {
  readonly id: string;
  listInventory(): Promise<NodeInventory>;
  isDone(roomSlug: string): Promise<boolean>;
  pull(remotePaths: string[], localDir: string): Promise<void>;
}

type Factory = (cfg: TenantConfig) => Transport;
const registry = new Map<string, Factory>();

export function registerTransport(kind: string, factory: Factory): void { registry.set(kind, factory); }
export function getTransport(cfg: TenantConfig): Transport {
  const f = registry.get(cfg.kind);
  if (!f) throw new Error(`未注册的 transport kind: ${cfg.kind}`);
  return f(cfg);
}
/** 测试用：清空注册表。 */
export function _resetTransports(): void { registry.clear(); }
