#!/usr/bin/env python3
"""issue 状态标签迁移的唯一入口(状态标签唯一化 + 合法迁移校验 + 评论过隐私闸门)。

用法:
    python3 scripts/issue-state.py <issue> <to> [--reason-file F] [--role impl|review]
                                   [--agent NAME] [--from STATE] [--repo R] [--dry-run]
    python3 scripts/issue-state.py <issue> closed --close --reason-file F   # 仅 impl 侧
    python3 scripts/issue-state.py --check <from|-> <to>                    # 只查迁移表,不碰 gh
    python3 scripts/issue-state.py --ensure-labels [--dry-run]              # 补建缺失的状态标签

<to> ∈ accept / in-progress / in-review / rework-1 / rework-2 / 待验证 / needs-decision / decline / blocked / closed。
迁移表在 scripts/issue-state.json。流程:读当前状态标签 → 校验迁移 → reason 文件过
issue-guard.py → 一次 `gh issue edit` 删全部旧状态标签 + 加新标签 → 评论(末行带机器可读标记)。
校验与隐私闸门失败都在改标签之前退出;标签改成功但评论失败时,可能留下没有评论的标签变更,可先用 --dry-run 预检。

退出码: 0 成功 | 1 非法迁移/参数 | 2 用法错误 | 3 当前状态歧义(多个状态标签,用 --from 指明)
        4 隐私闸门命中 | 5 gh 调用失败。
--from 必须真是该票当前挂的状态标签(单标签票不需要它;无标签票用 "-"),否则退出码 1。
环境变量 ISSUE_STATE_GH 可替换 gh 可执行文件(测试注入用)。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TABLE_PATH = HERE / "issue-state.json"
GUARD = HERE / "issue-guard.py"
MARKER_PREFIX = "<!-- issue-state:"


def load_table(path: Path = TABLE_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def check_transition(table: dict, cur: str, to: str) -> str | None:
    """合法返回 None,否则返回原因。cur=\"\" 表示无状态标签。"""
    if cur not in table["transitions"]:
        return f"未知当前状态 {cur!r}"
    if to != "closed" and to not in table["states"]:
        return f"未知目标状态 {to!r}"
    if to not in table["transitions"][cur]:
        allowed = ", ".join(table["transitions"][cur]) or "(无)"
        return f"非法迁移 {cur or '(无)'} → {to};{cur or '(无)'} 只能去: {allowed}"
    return None


def state_marker(frm: str, to: str, agent: str, role: str, now: datetime) -> str:
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"{MARKER_PREFIX} from={frm or '-'} to={to} role={role} agent={agent} at={stamp} -->"


def build_comment(reason: str, marker: str) -> str:
    body = reason.rstrip("\n")
    return (body + "\n\n" if body else "") + marker + "\n"


def run_guard(path: Path) -> tuple[int, str]:
    p = subprocess.run([sys.executable, str(GUARD), str(path)], capture_output=True, text=True)
    return p.returncode, (p.stderr or p.stdout).strip()


class Gh:
    def __init__(self, repo: str, dry: bool):
        self.bin = os.environ.get("ISSUE_STATE_GH", "gh")
        self.repo = repo
        self.dry = dry

    def read(self, *args: str) -> str:
        p = subprocess.run([self.bin, *args, "--repo", self.repo], capture_output=True, text=True)
        if p.returncode != 0:
            raise RuntimeError(p.stderr.strip() or "gh 失败")
        return p.stdout

    def write(self, *args: str) -> None:
        cmd = [self.bin, *args, "--repo", self.repo]
        if self.dry:
            print("DRY-RUN " + " ".join(cmd))
            return
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            raise RuntimeError(p.stderr.strip() or "gh 失败")


def current_states(gh: Gh, issue: str, table: dict) -> list[str]:
    out = gh.read("issue", "view", issue, "--json", "labels")
    names = [l["name"] for l in json.loads(out).get("labels", [])]
    return [n for n in names if n in table["states"]]


def ensure_labels(gh: Gh, table: dict) -> int:
    have = {l["name"] for l in json.loads(gh.read("label", "list", "--limit", "200", "--json", "name"))}
    for name in table["states"]:
        if name in have:
            continue
        meta = table["labels"][name]
        gh.write("label", "create", name, "--color", meta["color"], "--description", meta["description"])
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="issue 状态迁移唯一入口", add_help=True)
    ap.add_argument("issue", nargs="?")
    ap.add_argument("to", nargs="?")
    ap.add_argument("--check", nargs=2, metavar=("FROM", "TO"))
    ap.add_argument("--ensure-labels", action="store_true")
    ap.add_argument("--reason-file")
    ap.add_argument("--role", choices=["impl", "review"], default="impl")
    ap.add_argument("--agent", default="agent")
    ap.add_argument("--from", dest="frm", default=None, help="显式指定当前状态(歧义时用;\"-\" 表示无)")
    ap.add_argument("--close", action="store_true")
    ap.add_argument("--repo", default="fuyucn/douyin-rec")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--table", type=Path, default=TABLE_PATH)
    a = ap.parse_args(argv)
    table = load_table(a.table)
    gh = Gh(a.repo, a.dry_run)

    if a.check:
        frm = "" if a.check[0] == "-" else a.check[0]
        err = check_transition(table, frm, a.check[1])
        if err:
            print(err, file=sys.stderr)
            return 1
        print("OK")
        return 0

    if a.ensure_labels:
        try:
            return ensure_labels(gh, table)
        except RuntimeError as e:
            print(f"gh 失败: {e}", file=sys.stderr)
            return 5

    if not a.issue or not a.to:
        print(__doc__, file=sys.stderr)
        return 2
    to = a.to

    # close 只属于实现侧,且必须显式 --close;review 场景永不调。
    if (to == "closed") != a.close:
        print("closed 与 --close 必须同时出现(close 是显式动作)", file=sys.stderr)
        return 1
    if to == "closed" and a.role not in table["closeRoles"]:
        print(f"role={a.role} 不允许 close(close 只归实现侧收口)", file=sys.stderr)
        return 1

    try:
        present = current_states(gh, a.issue, table)
    except (RuntimeError, ValueError) as e:
        print(f"读取 issue 标签失败: {e}", file=sys.stderr)
        return 5
    if a.frm is not None:
        cur = "" if a.frm == "-" else a.frm
        # `--from` exists to resolve an ambiguous label set, not to override it.
        # Accepting an arbitrary value would let a caller bypass the transition
        # table (e.g. claim "in-review" on an issue that only has `accept`) and
        # leave the old label behind.
        if cur == "" and present:
            have = ", ".join(present) or "(none)"
            print(
                f"--from - 表示无状态标签,但该 issue 当前挂着: {have}",
                file=sys.stderr,
            )
            return 1
        if cur and cur not in present:
            have = ", ".join(present) or "(none)"
            print(
                f"--from {cur or '-'} 不是该 issue 当前挂的状态标签(实际: {have})",
                file=sys.stderr,
            )
            return 1
        if len(present) == 1 and cur:
            print(
                f"只有单个状态标签 {present[0]},不需要 --from;确认无误后去掉该参数重试",
                file=sys.stderr,
            )
            return 1
    elif len(present) > 1:
        print(f"当前有多个状态标签 {present},状态必须唯一;用 --from 指明真实当前状态以修复", file=sys.stderr)
        return 3
    else:
        cur = present[0] if present else ""

    err = check_transition(table, cur, to)
    if err:
        print(err, file=sys.stderr)
        return 1

    reason = ""
    if a.reason_file:
        rp = Path(a.reason_file)
        if not rp.exists():
            print(f"找不到 reason 文件: {rp}", file=sys.stderr)
            return 2
        reason = rp.read_text(encoding="utf-8")
    if to in table["reasonRequired"] and not reason.strip():
        print(f"迁移到 {to} 必须带 --reason-file(写明原因)", file=sys.stderr)
        return 1
    # Per-transition requirement: a staged issue going back to in-progress must say which step merged.
    if [cur, to] in table.get("reasonRequiredTransitions", []) and not reason.strip():
        print(f"迁移 {cur or '(无)'} → {to} 必须带 --reason-file(写明哪一步已合并、下一步做什么)", file=sys.stderr)
        return 1
    if to == "needs-decision":
        missing = [m for m in table["needsDecisionMarkers"] if m not in reason]
        if missing:
            print(f"needs-decision 评论缺「决定三行」: {', '.join(missing)}", file=sys.stderr)
            return 1

    marker = state_marker(cur, to, a.agent, a.role, datetime.now(timezone.utc))
    comment = build_comment(reason, marker)
    # 隐私闸门:对「最终要发的评论全文」过一遍,先于任何远端写操作。
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as tf:
        tf.write(comment)
        tmp = Path(tf.name)
    try:
        code, msg = run_guard(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    if code != 0:
        print("隐私闸门未通过,未改任何标签:\n" + msg, file=sys.stderr)
        return 4

    try:
        edit = ["issue", "edit", a.issue]
        for old in sorted(set(present) | ({cur} if cur else set())):
            if old != to:
                edit += ["--remove-label", old]
        if to != "closed":
            edit += ["--add-label", to]
        if len(edit) > 3:
            gh.write(*edit)
        gh.write("issue", "comment", a.issue, "--body", comment)
        if to == "closed":
            gh.write("issue", "close", a.issue)
    except RuntimeError as e:
        print(f"gh 写入失败: {e}", file=sys.stderr)
        return 5
    print(f"#{a.issue}: {cur or '(无)'} → {to}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
