/** reinforce-metrics.py --loop:返工率 / 逃逸率 / 待验证停留 / 台账拒绝计数;离线与降级(issue #78)。 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "reinforce-metrics.py");
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function run(args: string[], fixture?: unknown, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "metrics-"));
  const argv = [SCRIPT, "--loop", ...args];
  if (fixture) {
    const f = join(dir, "fx.json");
    writeFileSync(f, JSON.stringify(fixture));
    argv.push("--fixture", f);
  }
  const py = spawnSync("which", ["python3"], { encoding: "utf-8" }).stdout.trim();
  const r = spawnSync(py, argv, { encoding: "utf-8", env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout, dir };
}

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
