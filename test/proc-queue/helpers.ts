// proc-queue 测试公用:临时数据根、假时钟、假处理器、造 job。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobIdOf, type ProcessJob, type Processor } from "@drec/core";
import { ProcQueueStore } from "@drec/proc-queue";

export interface Env {
  root: string;
  dbPath: string;
  rec: string;
  clock: { t: number };
  now: () => number;
  open: (o?: { isPidAlive?: (pid: number) => boolean; busyTimeoutMs?: number; readOnly?: boolean }) => ProcQueueStore;
  file: (name: string, content?: string) => string;
  job: (name: string, over?: Partial<ProcessJob>) => ProcessJob;
  cleanup: () => void;
}

export function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "procq-"));
  const rec = join(root, "recordings");
  mkdirSync(rec, { recursive: true });
  const clock = { t: Date.now() };
  const now = (): number => clock.t;
  const dbPath = join(root, "db", "proc-queue.db");
  const stores: ProcQueueStore[] = [];
  return {
    root, dbPath, rec, clock, now,
    open: (o = {}) => {
      const s = new ProcQueueStore(dbPath, { now, ...o });
      stores.push(s);
      return s;
    },
    file: (name, content = "x") => {
      const p = join(rec, name);
      writeFileSync(p, content);
      return p;
    },
    // 默认 inputs[0] = 新建的真实文件;logicalKey 用 `@` 占位让 store 回填 fileTag。
    job: (name, over = {}) => {
      const input = join(rec, name);
      try { writeFileSync(input, "x", { flag: "wx" }); } catch { /* 已存在 */ }
      const kind = over.kind ?? "fake";
      const logicalKey = over.logicalKey ?? `task1:${name}@`;
      const generation = over.generation ?? 1;
      return {
        jobId: jobIdOf(kind, logicalKey, generation), kind, logicalKey, generation,
        inputs: [input], params: {}, replaceInputs: false, owner: { taskId: 1 }, createdAt: clock.t,
        ...over,
      };
    },
    cleanup: () => {
      for (const s of stores) s.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface Gate<T = void> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}
export function gate<T = void>(): Gate<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

export function fakeProcessor(over: Partial<Processor> = {}): Processor {
  return {
    kind: "fake", resource: "cpu", lane: "copy", retryable: true, interruptible: true,
    validate: () => null, estimateDiskBytes: () => 0,
    run: async () => ({ outputs: [] }),
    ...over,
  };
}
