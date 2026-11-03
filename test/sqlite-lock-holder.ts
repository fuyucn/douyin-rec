/**
 * 测试辅助:在**另一个 OS 线程**里持有 sqlite 写事务一段时间,再提交。
 *
 * 为什么不能用同线程的 setTimeout:busy_timeout 的等待发生在 sqlite C 层(睡眠重试),
 * 主线程事件循环不转,定时器不会触发 —— 只有 worker_threads 这样的真线程能在主线程
 * 阻塞在同步 sqlite 调用里时释放锁。issue #428 的并发测试(台账写、删除历史)都用它。
 */
import { Worker } from "node:worker_threads";

const WORKER_SRC = `
const { DatabaseSync } = require("node:sqlite");
const { parentPort, workerData } = require("node:worker_threads");
const db = new DatabaseSync(workerData.dbPath);
db.exec("BEGIN IMMEDIATE");
parentPort.postMessage("locked");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
  parentPort.postMessage("released");
}, workerData.releaseMs);
`;

export interface WriteLock {
  /** worker 已拿到写事务(BEGIN IMMEDIATE 成功)——此时主线程去写必撞锁。 */
  locked: Promise<void>;
  /** worker 已提交并释放锁。 */
  released: Promise<void>;
}

/** 持有 `<dbPath>` 的写事务 `releaseMs` 毫秒;`released` 完成后 worker 被回收。 */
export function holdWriteLock(dbPath: string, releaseMs: number): WriteLock {
  const w = new Worker(WORKER_SRC, { eval: true, workerData: { dbPath, releaseMs } });
  let notifyLocked!: () => void;
  let notifyReleased!: () => void;
  const locked = new Promise<void>((res) => { notifyLocked = res; });
  const released = new Promise<void>((res) => { notifyReleased = res; });
  w.on("message", (m: string) => {
    if (m === "locked") notifyLocked();
    else if (m === "released") notifyReleased();
  });
  // 错误不上抛:锁拿不到时主流程的超时/异常自己会暴露;这里 terminate 防线程泄漏。
  w.on("error", () => { /* 主流程自行暴露 */ });
  released.finally(() => { void w.terminate(); });
  return { locked, released };
}
