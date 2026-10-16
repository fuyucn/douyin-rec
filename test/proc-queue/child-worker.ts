// 多进程测试的子进程入口(由 store-multiproc.test.ts 经 esbuild 打成单文件后 spawn,不被 vitest 直接收集)。
//   argv: <mode: open|claim> <dbPath> <startAtEpochMs> [owner]
// 到 startAtEpochMs 才动手(自旋对齐),让多进程尽量同时撞同一把锁。
import { ProcQueueStore } from "@drec/proc-queue";

const [mode, dbPath, startAt, owner = "A"] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* 自旋对齐起跑线 */ }
try {
  const store = new ProcQueueStore(dbPath);
  if (mode === "claim") {
    const ids: string[] = [];
    for (;;) {
      const j = store.claim({ kinds: ["fake"], owner });
      if (!j) break;
      ids.push(j.jobId);
    }
    process.stdout.write(JSON.stringify(ids));
  } else {
    process.stdout.write("[]");
  }
  store.close();
} catch (e) {
  process.stderr.write(`FAIL: ${(e as Error).message}`);
  process.exit(1);
}
