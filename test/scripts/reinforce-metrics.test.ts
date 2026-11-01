/** reinforce-metrics.py --loop:返工率 / 逃逸率 / 待验证停留 / 台账拒绝计数;离线与降级(issue #78)。 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "reinforce-metrics.py");
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function run(args: string[], fixture?: unknown, env: Record<string, string> = {}) {
  const py = spawnSync("which", ["python3"], { encoding: "utf-8" }).stdout.trim();
  const r = spawnSync(py, [SCRIPT, "--loop", ...withFixture(args, fixture)], { encoding: "utf-8", env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout, dir: tmpdir() };
}

/** 非 --loop 全量报告:含「台账收口」段,需离线 fixture 避免调 gh。 */
function runFull(args: string[], fixture?: unknown, env: Record<string, string> = {}) {
  const py = spawnSync("which", ["python3"], { encoding: "utf-8" }).stdout.trim();
  const r = spawnSync(py, [SCRIPT, ...withFixture(args, fixture)], { encoding: "utf-8", env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout };
}

function withFixture(args: string[], fixture?: unknown): string[] {
  if (!fixture) return args;
  const f = join(mkdtempSync(join(tmpdir(), "metrics-fx-")), "fx.json");
  writeFileSync(f, JSON.stringify(fixture));
  return [...args, "--fixture", f];
}

/** 在 dir 下造可执行 shim:记录 argv 到 logPath,再执行 body。PATH 限定到 dir 才生效。 */
function makeShim(dir: string, name: string, logPath: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/bash\necho "$*" >> ${JSON.stringify(logPath)}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// 台账一行的 -json 输出(shim/容器里都返回这份)。
const LEDGER_ROWS = JSON.stringify([{
  streamKey: "douyin:100:2026-01-01", state: "done", bv: "BV1xx", error: null,
  // updatedAt 用当前时间:报告按窗口过滤,老时间会被滤掉导致收口 0。
  updatedAt: Date.now(), startMs: Date.now() - 3_600_000, winnerWorker: "local",
}]);

const marker = (to: string, at: string) => `<!-- issue-state: from=x to=${to} role=review agent=a at=${at} -->`;

const fixture = {
  prs: [
    { number: 1, title: "fix(app): 上传核验卡住", body: "Fixes #10", mergedAt: hoursAgo(100), reviews: [], comments: [] },
    {
      number: 2, title: "fix(hub): 磁盘写满", body: "Fixes #11", mergedAt: hoursAgo(50),
      reviews: [{ state: "CHANGES_REQUESTED" }], comments: [{ body: "打回:缺测试" }],
    },
    { number: 3, title: "feat(web): x", body: "Fixes #12", mergedAt: hoursAgo(10), reviews: [], comments: [] },
    { number: 4, title: "old", body: "Fixes #13", mergedAt: hoursAgo(24 * 40), reviews: [], comments: [] },
  ],
  issues: [
    { number: 10, title: "上传核验 分P 卡住 失败", state: "CLOSED", createdAt: hoursAgo(200), labels: [{ name: "incident" }], comments: [] },
    // 合并后 24h 内、同根因 → 逃逸
    { number: 20, title: "上传核验 分P 又卡住", state: "OPEN", createdAt: hoursAgo(76), labels: [{ name: "incident" }], comments: [] },
    // 合并 48h 之后 → 不算
    { number: 21, title: "上传核验 分P 再次", state: "OPEN", createdAt: hoursAgo(20), labels: [{ name: "incident" }], comments: [] },
    { number: 11, title: "磁盘写满", state: "CLOSED", createdAt: hoursAgo(80), labels: [], comments: [] },
    { number: 12, title: "x", state: "OPEN", createdAt: hoursAgo(30), updatedAt: hoursAgo(1), labels: [{ name: "待验证" }],
      comments: [{ body: marker("待验证", hoursAgo(10)) }] },
  ],
};

describe("reinforce-metrics.py --loop", () => {
  it("返工率 / 分布 / 逃逸 / 待验证停留", () => {
    const r = run(["--days", "7"], fixture);
    expect(r.status).toBe(0);
    expect(r.out).toContain("1/3 (33%)"); // 窗口内 3 个已结 PR(第 4 个太老),1 个被打回
    expect(r.out).toMatch(/打回轮数分布 0\/1\/2\/3\+\s+2\/0\/1\/0/); // PR#2 = 1 review + 1 评论 = 2 轮
    expect(r.out).toContain("1/3 (33%)");
    expect(r.out).toContain("#1→#20");
    expect(r.out).not.toContain("#21");
    expect(r.out).toMatch(/待验证 停留\s+1 张: #12 1\dh|待验证 停留\s+1 张: #12 \dh/);
  });
  it("逃逸阈值:两词重叠不算逃逸,三词算", () => {
    const mk = (incTitle: string) => ({
      prs: [{ number: 7, title: "fix(app): zyxwv qrstu lmnop", body: "Fixes #40", mergedAt: hoursAgo(30), reviews: [], comments: [] }],
      issues: [
        { number: 40, title: "src", state: "CLOSED", createdAt: hoursAgo(60), labels: [], comments: [] },
        { number: 41, title: incTitle, state: "OPEN", createdAt: hoursAgo(10), labels: [{ name: "incident" }], comments: [] },
      ],
    });
    expect(run(["--days", "7"], mk("zyxwv qrstu again")).out).not.toContain("#7→#41");
    expect(run(["--days", "7"], mk("zyxwv qrstu lmnop again")).out).toContain("#7→#41");
  });
  it("issue 上的 rework 状态标记也计入打回轮数", () => {
    const fx = {
      prs: [{ number: 5, title: "x", body: "Fixes #30", mergedAt: hoursAgo(5), reviews: [], comments: [] }],
      issues: [{ number: 30, title: "t", state: "OPEN", createdAt: hoursAgo(9), labels: [], comments: [{ body: marker("rework-1", hoursAgo(6)) }] }],
    };
    expect(run(["--days", "7"], fx).out).toMatch(/0\/1\/0\/0/);
  });
  it("分步 PR(Part of #N,#253)同样关联 issue:其 rework 标记计入打回轮数", () => {
    const fx = {
      prs: [{ number: 6, title: "x", body: "Part of #31", mergedAt: hoursAgo(5), reviews: [], comments: [] }],
      issues: [{ number: 31, title: "t", state: "OPEN", createdAt: hoursAgo(9), labels: [], comments: [{ body: marker("rework-1", hoursAgo(6)) }] }],
    };
    expect(run(["--days", "7"], fx).out).toMatch(/0\/1\/0\/0/);
  });
  it("台账拒绝:有日志则计数,无日志跳过并标注", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const log = join(dir, "l.log");
    writeFileSync(log, "a\n[ledger] 拒绝非法状态转换 k: a → b\n[ledger] 拒绝状态转换 k2\nb\n");
    expect(run(["--days", "7", "--ledger-log", log], fixture).out).toMatch(/拒绝` 计数\s+2\(日志文件\)/);
    expect(run(["--days", "7"], fixture).out).toContain("未提供 --ledger-log");
    expect(run(["--days", "7", "--ledger-log", join(dir, "nope")], fixture).out).toContain("日志文件不可读");
  });
  it("空窗口不除零", () => {
    const r = run(["--days", "7"], { prs: [], issues: [] });
    expect(r.status).toBe(0);
    expect(r.out).toContain("n/a");
  });
  it("无 gh 且无 fixture → 优雅降级(退出 0,标注跳过)", () => {
    const r = run(["--days", "7"], undefined, { PATH: "/nonexistent-dir" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("跳过 —— gh 不可用");
  });
});

describe("reinforce-metrics.py 台账读取(issue #428 复审)", () => {
  // 台账已切 WAL 且在 Docker bind mount 上:宿主机任何方式打开(含 sqlite3 -readonly,仍写 -shm、锁不跨 VM)
  // 都不安全 —— 只有两档:容器内 readOnly(默认容器 douyin-rec)→ 宿主 immutable=1 快照(标注可能旧)。
  // 显式 --db-container 失败不降级。shim 法:PATH 限定到只含 fake docker/sqlite3 的目录,断言发出的命令行。
  const ledgerDb = (dir: string) => {
    const db = join(dir, "douyin-rec-sync.db");
    writeFileSync(db, ""); // 只需存在;实际读取走 shim
    return db;
  };
  const immutableOnly = `if [[ "$*" == *"immutable=1"* ]]; then echo '${LEDGER_ROWS}'; exit 0; fi\nexit 1`;

  it("--db-container:docker exec 进容器 node:sqlite readOnly 读,宿主文件不存在也能读", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "metrics-shim-"));
    const log = join(shimDir, "docker.log");
    makeShim(shimDir, "docker", log, `echo '${LEDGER_ROWS}'`);
    const r = runFull(["--days", "7", "--db", join(shimDir, "no-such-sync.db"), "--db-container", "drec-master"],
      fixture, { PATH: shimDir });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("数据来源：容器内只读(docker exec drec-master)");
    expect(r.out).toContain("收口场次（done + needs_manual + failed）：1");
    const logged = readFileSync(log, "utf-8");
    expect(logged).toContain("exec drec-master node -e");
    expect(logged).toContain("readOnly:true");
    expect(logged).toContain("/output-data/db/no-such-sync.db");
  });

  it("默认容器名 douyin-rec(compose 的 container_name):不传 --db-container 也走容器内只读", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "metrics-shim-"));
    const log = join(shimDir, "docker.log");
    makeShim(shimDir, "docker", log, `echo '${LEDGER_ROWS}'`);
    const r = runFull(["--days", "7", "--db", join(shimDir, "douyin-rec-sync.db")], fixture, { PATH: shimDir });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("数据来源：容器内只读(docker exec douyin-rec)");
    expect(readFileSync(log, "utf-8")).toContain("exec douyin-rec node -e");
  });

  it("--db-container-path:覆盖容器内路径;默认取 /output-data/db/<--db 文件名>(不丢文件名,也不用宿主目录)", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "metrics-shim-"));
    const log = join(shimDir, "docker.log");
    makeShim(shimDir, "docker", log, `echo '${LEDGER_ROWS}'`);
    const r = runFull(["--days", "7", "--db", "/some/host/dir/x-sync.db", "--db-container-path", "/data/custom/y.db"],
      fixture, { PATH: shimDir });
    expect(r.status, r.out).toBe(0);
    const logged = readFileSync(log, "utf-8");
    expect(logged).toContain("/data/custom/y.db");
    expect(logged).not.toContain("/some/host/dir");
    expect(logged).not.toContain("/output-data/db/x-sync.db");
  });

  it("显式 --db-container 读取失败:不降级,退出非 0,stderr 说明原因,且绝不碰宿主 sqlite3", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "metrics-shim-"));
    makeShim(shimDir, "docker", join(shimDir, "docker.log"), "exit 1");
    const sqlLog = join(shimDir, "sqlite3.log");
    makeShim(shimDir, "sqlite3", sqlLog, `echo '${LEDGER_ROWS}'`);
    const py = spawnSync("which", ["python3"], { encoding: "utf-8" }).stdout.trim();
    const r = spawnSync(py, [SCRIPT, "--days", "7", "--db", ledgerDb(shimDir), "--db-container", "gone", ...withFixture([], fixture)],
      { encoding: "utf-8", env: { ...process.env, PATH: shimDir } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--db-container gone 读取失败");
    expect(r.stdout).not.toContain("数据来源");
    expect(() => readFileSync(sqlLog, "utf-8")).toThrow(); // sqlite3 从未被调用
  });

  it("未显式传容器(默认 douyin-rec)失败:降级 immutable=1 快照并标注原因,命令里没有 -readonly", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "metrics-shim-"));
    makeShim(shimDir, "docker", join(shimDir, "docker.log"), "exit 1");
    const log = join(shimDir, "sqlite3.log");
    makeShim(shimDir, "sqlite3", log, immutableOnly);
    const r = runFull(["--days", "7", "--db", ledgerDb(shimDir)], fixture, { PATH: shimDir });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("容器 douyin-rec 不可用");
    expect(r.out).toContain("宿主 immutable 快照(可能读到旧/撕裂数据)");
    const logged = readFileSync(log, "utf-8");
    expect(logged).toContain("immutable=1");
    expect(logged).not.toContain("-readonly");
  });

  it("空表:immutable 快照成功但零行输出(sqlite3 -json 零行不打印)→ 空结果而非「不可读」", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "metrics-shim-"));
    makeShim(shimDir, "sqlite3", join(shimDir, "l.log"),
      `if [[ "$*" == *"immutable=1"* ]]; then exit 0; fi\nexit 1`);
    const r = runFull(["--days", "7", "--db", ledgerDb(shimDir)], fixture, { PATH: shimDir });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("宿主 immutable 快照");
    expect(r.out).toContain("收口场次（done + needs_manual + failed）：0");
  });

  it("台账不可得:数据来源如实标注,报告不炸(退出 0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-shim-"));
    const missing = runFull(["--days", "7", "--db", join(dir, "nope-sync.db")], fixture, { PATH: "/nonexistent-dir" });
    expect(missing.status, missing.out).toBe(0);
    expect(missing.out).toContain("台账不存在");
    expect(missing.out).toContain("收口场次（done + needs_manual + failed）：0");
    writeFileSync(join(dir, "gone-sync.db"), ""); // 文件在,但无 sqlite3/docker 可用 → 读不了
    const unreadable = runFull(["--days", "7", "--db", join(dir, "gone-sync.db")], fixture, { PATH: "/nonexistent-dir" });
    expect(unreadable.status, unreadable.out).toBe(0);
    expect(unreadable.out).toContain("台账不可读");
  });
});
