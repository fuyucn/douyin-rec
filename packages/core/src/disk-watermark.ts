/**
 * 磁盘水位(GB)解析口径的唯一真理源。daemon(app)/ reconciler / 节点侧上传闸门(orchestrator)/ cli
 * 组合根共用,避免各处自写 `diskMinGB ?? 10` 而对非数字配置(字符串/NaN)口径失真、闸门被静默绕过。
 *
 * 语义:
 *  - 缺省(undefined/null)→ 默认 10GB,不告警;
 *  - 有限数字 `> 0` → 原值;`<= 0` → 0(显式关闭);
 *  - 其它(字符串/NaN/Infinity/对象…)→ 回落默认 10GB,并经 `warn` 告警(绝不静默)。
 */

/** 磁盘水位缺省值(GB)。 */
export const DEFAULT_DISK_MIN_GB = 10;

/**
 * 从 `statfs` 结果算可用字节。**必须优先用 `frsize`**:macOS 上的 Docker/OrbStack
 * bind mount 会把 `bsize` 报成 1MiB(而 `frsize` 仍是 4096),用 `bsize` 会把可用空间放大 256 倍 ——
 * master 的数据根就挂在这种卷上,水位闸门因此永不触发(实测报 9.8TB,真实只有 38GB)。
 * Linux 上两者相等,行为不变。两者都拿不到时回落 `bsize`。
 */
export function freeBytesOf(st: { bavail: number | bigint; bsize: number | bigint; frsize?: number | bigint }): number {
  const unit = Number(st.frsize ?? st.bsize) || Number(st.bsize) || 0;
  return Number(st.bavail) * unit;
}

/** 可用空间(GB),口径与 {@link freeBytesOf} 一致。 */
export function freeGBOf(st: Parameters<typeof freeBytesOf>[0]): number {
  return freeBytesOf(st) / 1e9;
}

export type DiskMinGBSource = "配置" | "默认" | "关闭";

export function resolveDiskMinGB(
  raw: unknown,
  warn?: (msg: string) => void,
): { gb: number; source: DiskMinGBSource } {
  if (raw === undefined || raw === null) return { gb: DEFAULT_DISK_MIN_GB, source: "默认" };
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 0 ? { gb: raw, source: "配置" } : { gb: 0, source: "关闭" };
  }
  warn?.(`[disk] resources.diskMinGB=${JSON.stringify(raw) ?? String(raw)} 不是有效数字,回落默认 ${DEFAULT_DISK_MIN_GB}GB`);
  return { gb: DEFAULT_DISK_MIN_GB, source: "默认" };
}
