/**
 * issue-state.py:迁移表合法性、非法迁移拒绝、标签唯一化、隐私闸门、close 角色(issue #78)。
 * 用假 gh(ISSUE_STATE_GH)记录写调用,不碰远端。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "issue-state.py");
const table = JSON.parse(readFileSync(join(ROOT, "scripts", "issue-state.json"), "utf-8")) as {
  states: string[];
  transitions: Record<string, string[]>;
};

let dir: string;
let fakeGh: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "issue-state-"));
  fakeGh = join(dir, "gh");
  // issue view 回 $FAKE_VIEW;label list 回 $FAKE_LABELS;其余写调用追加进 $FAKE_LOG。
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
if [[ "$1 $2" == "issue view" ]]; then echo "$FAKE_VIEW"; exit 0; fi
if [[ "$1 $2" == "label list" ]]; then echo "\${FAKE_LABELS:-[]}"; exit 0; fi
printf '%s\\n' "$*" >> "$FAKE_LOG"
`,
  );
  chmodSync(fakeGh, 0o755);
});

function run(args: string[], labels: string[] = [], reason?: string) {
  const log = join(dir, `log-${Math.random().toString(36).slice(2)}`);
  const argv = [SCRIPT, ...args];
  if (reason !== undefined) {
    const rf = join(dir, `reason-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(rf, reason);
    argv.push("--reason-file", rf);
  }
  const r = spawnSync("python3", argv, {
    encoding: "utf-8",
    env: {
      ...process.env,
      ISSUE_STATE_GH: fakeGh,
      FAKE_LOG: log,
      FAKE_VIEW: JSON.stringify({ labels: labels.map((name) => ({ name })) }),
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : [];
  return { status: r.status, out: r.stdout, err: r.stderr, calls };
}
const check = (from: string, to: string) =>
  spawnSync("python3", [SCRIPT, "--check", from, to], { encoding: "utf-8" }).status;

describe("迁移表", () => {
  it("所有目标状态都已声明,且无自环", () => {
    for (const [from, tos] of Object.entries(table.transitions)) {
      for (const to of tos) {
        expect(to === "closed" || table.states.includes(to)).toBe(true);
        expect(to).not.toBe(from);
      }
    }
    for (const s of table.states) expect(table.transitions).toHaveProperty(s);
    expect(table.transitions).toHaveProperty("");
  });
  it("主干路径合法", () => {
    const path = ["-", "accept", "in-progress", "in-review", "待验证", "closed"];
    for (let i = 0; i < path.length - 1; i++) expect(check(path[i], path[i + 1])).toBe(0);
    for (const [a, b] of [["in-review", "rework-1"], ["rework-1", "in-review"], ["in-review", "rework-2"], ["rework-2", "needs-decision"]])
      expect(check(a, b)).toBe(0);
  });
  it("任意状态可去 needs-decision / blocked(终态 decline 之外的活跃态)", () => {
    for (const s of table.states.filter((x) => x !== "decline" && x !== "blocked" && x !== "needs-decision"))
      expect(check(s, "needs-decision")).toBe(0);
    for (const s of table.states.filter((x) => x !== "decline" && x !== "blocked"))
      expect(check(s, "blocked")).toBe(0);
  });
  it("非法迁移被拒", () => {
    for (const [a, b] of [["accept", "待验证"], ["in-progress", "accept"], ["-", "in-review"], ["待验证", "in-progress"], ["rework-1", "待验证"], ["in-progress", "rework-1"]])
      expect(check(a, b), `${a}→${b}`).toBe(1);
  });
});

describe("迁移执行", () => {
  it("合法迁移:一次 edit 删旧标签加新标签,再评论带机器标记", () => {
    const r = run(["78", "in-progress", "--agent", "codex"], ["accept", "enhancement"]);
    expect(r.status).toBe(0);
    expect(r.calls[0]).toContain("issue edit 78 --remove-label accept --add-label in-progress");
    expect(r.calls[0]).not.toContain("enhancement");
    expect(r.calls[1]).toMatch(/^issue comment 78 --body .*<!-- issue-state: from=accept to=in-progress role=impl agent=codex at=\S+ -->/s);
  });
  it("非法迁移:退出码 1,不发任何写调用", () => {
    const r = run(["78", "待验证"], ["accept"]);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });
  it("分步票(#253):in-review → in-progress 合法但必须带原因;accept → in-progress 仍不需要", () => {
    expect(check("in-review", "in-progress")).toBe(0);
    const bare = run(["78", "in-progress"], ["in-review"]);
    expect(bare.status).toBe(1);
    expect(bare.err).toContain("哪一步已合并");
    expect(bare.calls).toEqual([]);
    const ok = run(["78", "in-progress"], ["in-review"], "N1 已合并,开始 N2");
    expect(ok.status).toBe(0);
    expect(ok.calls.join("\n")).toContain("--add-label in-progress");
    expect(run(["78", "in-progress"], ["accept"]).status).toBe(0);
  });
  it("多个状态标签:拒绝(3);--from 指明后清掉全部旧状态标签", () => {
    const amb = run(["78", "in-review"], ["accept", "in-progress"]);
    expect(amb.status).toBe(3);
    expect(amb.calls).toEqual([]);
    const fix = run(["78", "in-review", "--from", "in-progress"], ["accept", "in-progress"]);
    expect(fix.status).toBe(0);
    expect(fix.calls[0]).toMatch(/--remove-label accept --remove-label in-progress --add-label in-review|--remove-label in-progress --remove-label accept --add-label in-review/);
  });
  it("--from 不是该票当前标签 → 1,不绕迁移表、不发写调用", () => {
    const r = run(["78", "待验证", "--from", "in-review"], ["accept"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("不是该 issue 当前挂的状态标签");
    expect(r.calls).toEqual([]);
  });
  it("多标签 + 伪造 --from:真正的绕过路径 → 1,绝不写", () => {
    // The single-label case above is also caught by the "no --from on a single
    // label" rule. Only this case proves the membership check itself: without
    // it, `in-review` is treated as the current state and the script removes
    // both real labels while adding a state the issue never reached.
    const r = run(["78", "待验证", "--from", "in-review"], ["accept", "in-progress"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("不是该 issue 当前挂的状态标签");
    expect(r.calls).toEqual([]);
  });
  it("单标签票传 --from → 1(不需要也不允许,避免掩盖标签漂移)", () => {
    const r = run(["78", "in-progress", "--from", "accept"], ["accept"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("不需要 --from");
    expect(r.calls).toEqual([]);
  });
  it("--from - 只在无状态标签时成立", () => {
    expect(run(["78", "accept", "--from", "-"], ["enhancement"]).status).toBe(0);
    const bad = run(["78", "in-progress", "--from", "-"], ["accept"]);
    expect(bad.status).toBe(1);
    expect(bad.calls).toEqual([]);
    // Without the guard, "-" would look like an empty state and `→ accept` is
    // legal from it — silently overwriting an existing in-review label.
    const bypass = run(["78", "accept", "--from", "-"], ["in-review"]);
    expect(bypass.status).toBe(1);
    expect(bypass.calls).toEqual([]);
  });
  it("无状态标签起步:只加不删", () => {
    const r = run(["5", "accept"], ["enhancement"]);
    expect(r.status).toBe(0);
    expect(r.calls[0]).toBe("issue edit 5 --add-label accept --repo fuyucn/douyin-rec");
  });
  it("需要理由的迁移缺 reason → 1", () => {
    expect(run(["78", "rework-1"], ["in-review"]).status).toBe(1);
  });
  it("needs-decision 缺「决定三行」→ 1;写全 → 0", () => {
    expect(run(["78", "needs-decision"], ["in-progress"], "要决定什么:x").status).toBe(1);
    const ok = run(["78", "needs-decision"], ["in-progress"], "要决定什么:是否继续\n不做会怎样:卡住\n建议选项:继续");
    expect(ok.status).toBe(0);
  });
  it("reason 含隐私 → 4,且标签未被改(闸门先于任何写)", () => {
    const r = run(["78", "rework-1"], ["in-review"], "路径 /Users/someone/x 有问题"); // issue-guard: allow
    expect(r.status).toBe(4);
    expect(r.calls).toEqual([]);
  });
});

describe("close 只归实现侧", () => {
  it("review 角色 close → 1", () => {
    const r = run(["78", "closed", "--close", "--role", "review"], ["待验证"], "依据:验证通过");
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });
  it("closed 必须带 --close,反之亦然", () => {
    expect(run(["78", "closed"], ["待验证"], "依据").status).toBe(1);
    expect(run(["78", "待验证", "--close"], ["in-review"]).status).toBe(1);
  });
  it("impl 从 待验证 close:删标签 + 评论 + close", () => {
    const r = run(["78", "closed", "--close"], ["待验证"], "依据:四条门禁全过");
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("issue ")).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["issue edit", "issue comment", "issue close"]);
    expect(r.calls[0]).toContain("--remove-label 待验证");
  });
  it("旧口径 accept + 待验证:--from 待验证 可 close,并一次删掉两个标签", () => {
    const r = run(["78", "closed", "--close", "--from", "待验证"], ["accept", "待验证"], "依据:四条门禁全过");
    expect(r.status).toBe(0);
    expect(r.calls[0]).toMatch(/--remove-label accept --remove-label 待验证|--remove-label 待验证 --remove-label accept/);
    expect(r.calls[0]).not.toContain("--add-label");
    const verbs = r.calls.map((c) => c.startsWith("issue ") ? c.split(" ").slice(0, 2).join(" ") : "marker");
    expect(verbs).toEqual(["issue edit", "issue comment", "marker", "marker", "issue close"]);
  });
  it("非 待验证/decline 起点不能 close", () => {
    expect(run(["78", "closed", "--close"], ["in-progress"], "依据").status).toBe(1);
  });
});

describe("--ensure-labels", () => {
  it("只补建缺失的状态标签", () => {
    const log = join(dir, "log-ensure");
    const r = spawnSync("python3", [SCRIPT, "--ensure-labels"], {
      encoding: "utf-8",
      env: { ...process.env, ISSUE_STATE_GH: fakeGh, FAKE_LOG: log, FAKE_LABELS: JSON.stringify([{ name: "accept" }, { name: "in-progress" }]) },
    });
    expect(r.status).toBe(0);
    const made = readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => l.split(" ")[2]);
    expect(made).toContain("in-review");
    expect(made).toContain("rework-1");
    expect(made).not.toContain("accept");
  });
});
