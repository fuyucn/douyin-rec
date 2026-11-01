// 多进程测试的子进程入口(由 store-multiproc.test.ts 经 esbuild 打成单文件后 spawn,不被 vitest 直接收集)。
//   argv: <mode: open|claim|acquire> <dbPath> <startAtEpochMs> [owner]
// 到 startAtEpochMs 才动手(自旋对齐),让多进程尽量同时撞同一把锁。
import { ProcQueueStore } from "@drec/proc-queue";

const [mode, dbPath, startAt, owner = "A"] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* 自旋对齐起跑线 */ }
try {
  // acquire 模式隔离 pid 存活干扰(isPidAlive 恒真):胜者进程先退出也不允许被当作死 pid 接管,
  // 只验证读-判定-写的事务原子性(#432);claim/open 仍用真实 pid 探活。
  const store = mode === "acquire"
    ? new ProcQueueStore(dbPath, { isPidAlive: () => true })
    : new ProcQueueStore(dbPath);
  if (mode === "claim") {
    const ids: string[] = [];
    for (;;) {
      const j = store.claim({ kinds: ["fake"], owner });
      if (!j) break;
      ids.push(j.jobId);
    }
    process.stdout.write(JSON.stringify(ids));
  } else if (mode === "acquire") {
    // 只抢租约不认领:验证 acquireLease 读-判定-写的事务原子性(#432)。
    process.stdout.write(JSON.stringify(store.acquireLease("fake", owner, { pid: process.pid, leaseMs: 600_000 })));
  } else {
    process.stdout.write("[]");
  }
  store.close();
} catch (e) {
  process.stderr.write(`FAIL: ${(e as Error).message}`);
  process.exit(1);
}
