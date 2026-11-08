/**
 * access-stats.ts — 「哪些 API 真的被调用过」的轻量计数器（为精简审计取证用）。
 *
 * 为什么需要它:删 `/hub`、`/stats` 这类入口前,必须有「没人用」的证据;线上没有 HTTP 访问日志
 * (server 只打业务日志),靠推测删入口和靠猜上线一样危险。
 *
 * 口径:
 *  - 计数的是**路由 handler 名**(`matchRoute` 的 name),不是原始 URL —— 不落路径参数,不泄露房间 key;
 *  - 内存计数 + 30s 防抖原子落盘,重启后从文件续算(观察期跨重启不断档);
 *  - 键数封顶(防构造 URL 撑爆内存),超出后只累加 MAX_KEYS 之外的通用桶;
 *  - 落盘失败只记一次 warn,不让审计功能影响服务。
 *
 * 读法:master 的 `<root>/config/access-stats.json`。
 *   `listHubRules` 命中 ⇒ /hub 页有人在用;`stats` 命中 ⇒ /stats 有人在看。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_KEYS = 400;
const OVERFLOW_KEY = "(other)";
const SAVE_DEBOUNCE_MS = 30_000;

interface Snapshot {
  version: 1;
  /** 首次观察时间(毫秒);重启不重置。 */
  sinceMs: number;
  updatedAtMs: number;
  counts: Record<string, number>;
}

export class AccessStats {
  private counts = new Map<string, number>();
  private sinceMs = 0;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private warned = false;

  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (m: string) => void = () => {},
  ) {
    this.load();
  }

  /** 读回上一次的快照;文件缺失/损坏 = 从零开始(不抛)。 */
  load(): void {
    let raw: string;
    try {
      if (!existsSync(this.file)) return;
      raw = readFileSync(this.file, "utf-8");
    } catch {
      return;
    }
    try {
      const snap = JSON.parse(raw) as Partial<Snapshot>;
      const counts = snap.counts;
      if (!counts || typeof counts !== "object") return;
      for (const [key, value] of Object.entries(counts)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) this.counts.set(key, value);
      }
      this.sinceMs = typeof snap.sinceMs === "number" ? snap.sinceMs : 0;
    } catch {
      // 损坏文件当作不存在 —— 观察数据丢一次,比让服务起不来好。
    }
  }

  /** 记一次命中。`handler` 是路由名(如 `listHubRules`、`stats`)。 */
  record(handler: string): void {
    if (!handler) return;
    if (this.sinceMs === 0) this.sinceMs = this.now();
    const key = this.counts.has(handler) ? handler : this.counts.size >= MAX_KEYS ? OVERFLOW_KEY : handler;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.dirty = true;
    this.schedule();
  }

  snapshot(): Snapshot {
    return {
      version: 1,
      sinceMs: this.sinceMs,
      updatedAtMs: this.now(),
      counts: Object.fromEntries([...this.counts].sort((a, b) => b[1] - a[1])),
    };
  }

  /** 立即落盘(退出前/测试用)。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.log(`[access-stats] 写入失败(审计数据不更新,服务继续): ${String(error)}`);
      }
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }
}
