#!/usr/bin/env python3
"""审查门禁第 0 步:机械检查 PR 正文是否按 .github/pull_request_template.md 填全。

用法:
    python3 scripts/pr-gate.py <PR号>                       # gh 取正文/标题/改动文件
    python3 scripts/pr-gate.py --body-file F [--title T] [--files a,b,c] [--no-guard]   # 离线

输出:第一行恒为 `PASS` 或 `FAIL`;FAIL 后每行一条缺项。退出码 PASS=0 / FAIL=1 / 取数失败=2。
缺项 ⇒ 不派 Opus 审查,直接打回返工(缺项清单原样贴到 PR 评论)。
检查项:Fixes #N、各必填段非空(模板里的 HTML 注释与「待填」不算内容)、自审五项各「发现→修复」或
「无+理由」、变异验证含 FAIL 与 PASS 两段输出、验证命令含 pnpm test / pnpm typecheck 与输出、
版本声明合理(feat/fix 须 bump patch,或声明不 bump 且改动不触运行时)、正文过 issue-guard.py。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GUARD = HERE / "issue-guard.py"

REQUIRED_SECTIONS = ["改动范围", "验证方式", "自审五项", "变异验证", "验证命令与输出", "评论采纳情况", "回写位置", "残余风险", "版本"]
SELF_REVIEW_ITEMS = ["边界", "并发", "静默失败", "一致性", "分层"]
RUNTIME_PATHS = ("packages/", "package.json", "Dockerfile", "docker-compose", "dist/")
# 独立占位词才算:TODO/TBD 前后不是路径/单词字符(放行 TODO.md、T-90 之类),
# 三个以上句点两侧都是 ASCII 路径字符时是 git 范围(origin/x...HEAD),不算省略号。
PLACEHOLDER = re.compile(
    r"待填|<填写>|…{2,}"
    r"|(?<![\w/.\-])(?:TODO|TBD)(?![\w/\-]|\.\w)"
    r"|(?<![A-Za-z0-9_/\-])\.{3,}|\.{3,}(?![A-Za-z0-9_/\-])"
)


def strip_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


def split_sections(body: str) -> dict[str, str]:
    """按 `## 标题` 切段;标题取第一个空白/括号前的词作 key(「自审五项(…)」→「自审五项」)。"""
    out: dict[str, str] = {}
    cur: str | None = None
    for line in strip_comments(body).splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m and not line.startswith("###"):
            cur = re.split(r"[\s(（:：]", m.group(1), maxsplit=1)[0]
            out[cur] = ""
        elif cur is not None:
            out[cur] += line + "\n"
    return out


def has_content(text: str) -> bool:
    t = text.strip()
    return bool(t) and not PLACEHOLDER.search(t)


def check_self_review(sec: str) -> list[str]:
    errs: list[str] = []
    for item in SELF_REVIEW_ITEMS:
        m = re.search(rf"^[ \t]*[-*][ \t]*\**{item}\**[ \t]*[:：][ \t]*(.*)$", sec, re.M)
        if not m or not m.group(1).strip():
            errs.append(f"自审五项缺「{item}」(格式 `- {item}: 发现→修复` 或 `- {item}: 无(理由)`)")
            continue
        v = m.group(1).strip()
        if PLACEHOLDER.search(v):
            errs.append(f"自审「{item}」仍是占位内容")
        elif v.startswith("无"):
            reason = re.sub(r"^无[\s:：,，、—\-(（]*", "", v).rstrip(")）").strip()
            if len(reason) < 4:
                errs.append(f"自审「{item}」写了「无」但没给理由")
        elif "→" not in v and "修复" not in v:
            errs.append(f"自审「{item}」须写「发现→修复」或「无(理由)」")
    return errs


def fenced_blocks(text: str) -> list[str]:
    return re.findall(r"```[^\n]*\n(.*?)```", text, re.S)


def check_mutation(sec: str) -> list[str]:
    # 两段:撤修复 → FAIL 输出;复原 → PASS 输出。各自要有代码块,且块内含对应结论。
    parts = re.split(r"^###\s+", sec, flags=re.M)[1:]
    fail_blocks: list[str] = []
    pass_blocks: list[str] = []
    for p in parts:
        title = p.splitlines()[0] if p.strip() else ""
        blocks = fenced_blocks(p)
        if "FAIL" in title or "撤" in title:
            fail_blocks += blocks
        elif "PASS" in title or "复原" in title:
            pass_blocks += blocks
    errs: list[str] = []
    if not any(b.strip() and "FAIL" in b for b in fail_blocks):
        errs.append("变异验证缺「撤修复」段的 FAIL 输出(### 撤修复(FAIL) 下放含 FAIL 的代码块)")
    if not any(b.strip() and "PASS" in b.upper().replace("PASSED", "PASS") for b in pass_blocks):
        errs.append("变异验证缺「复原」段的 PASS 输出(### 复原(PASS) 下放含 PASS 的代码块)")
    return errs


def check_version(sec: str, title: str, files: list[str] | None) -> list[str]:
    typ = re.match(r"^\s*(\w+)", title or "")
    kind = typ.group(1).lower() if typ else ""
    bump = re.search(r"(\d+)\.(\d+)\.(\d+)\s*(?:→|->|=>|到)\s*(\d+)\.(\d+)\.(\d+)", sec)
    skip = re.search(r"无需\s*bump|不\s*bump|不适用", sec)
    if bump:
        a = tuple(int(x) for x in bump.groups()[:3])
        b = tuple(int(x) for x in bump.groups()[3:])
        if not (b[:2] == a[:2] and b[2] == a[2] + 1):
            return [f"版本声明应为 patch +1,实际 {a} → {b}"]
        return []
    if skip:
        touched = [f for f in (files or []) if f.startswith(RUNTIME_PATHS)]
        if touched:
            return [f"声明不 bump,但改动触及运行时路径: {', '.join(touched[:3])}"]
        if kind in ("feat", "fix") and files is None:
            return []  # 离线且没给文件清单:无法核对,放行(gh 模式一定有清单)
        return [] if len(sec.strip()) >= 8 else ["不 bump 需写明理由"]
    if kind in ("feat", "fix"):
        return ["feat/fix 须声明版本(`0.0.X → 0.0.Y`)或写明「无需 bump + 理由」(仅 scripts/docs/test/.github 改动)"]
    return [] if has_content(sec) else ["版本段为空(非 feat/fix 也要写「无需 bump」)"]


def run_guard(body: str) -> list[str]:
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as tf:
        tf.write(body)
        tmp = tf.name
    try:
        p = subprocess.run([sys.executable, str(GUARD), tmp], capture_output=True, text=True)
    finally:
        os.unlink(tmp)
    if p.returncode == 0:
        return []
    return ["PR 正文未过隐私闸门(issue-guard.py): " + (p.stderr.strip().replace(tmp, "<body>"))]


def gate(body: str, title: str = "", files: list[str] | None = None, guard: bool = True) -> list[str]:
    errs: list[str] = []
    if not re.search(r"(?im)^\s*(?:Fixes|Closes|Resolves)\s+#\d+", strip_comments(body)):
        errs.append("缺 `Fixes #N`(独占一行)")
    secs = split_sections(body)
    for name in REQUIRED_SECTIONS:
        if name not in secs:
            errs.append(f"缺必填段「## {name}」")
        elif not has_content(secs[name]):
            errs.append(f"「{name}」为空或仍是占位")
    if "验证方式" in secs and has_content(secs["验证方式"]) and not re.search(r"无需部署|部署后实跑", secs["验证方式"]):
        errs.append("「验证方式」须写明「无需部署」或「部署后实跑」")
    if "自审五项" in secs:
        errs += check_self_review(secs["自审五项"])
    if "变异验证" in secs:
        errs += check_mutation(secs["变异验证"])
    if "验证命令与输出" in secs:
        v = secs["验证命令与输出"]
        for cmd in ("pnpm test", "pnpm typecheck"):
            if cmd not in v:
                errs.append(f"「验证命令与输出」缺 `{cmd}`")
        if not any(b.strip() for b in fenced_blocks(v)):
            errs.append("「验证命令与输出」缺真实输出(代码块)")
    if "版本" in secs:
        errs += check_version(secs["版本"], title, files)
    if guard:
        errs += run_guard(strip_comments(body))
    return errs


def fetch_pr(pr: str, repo: str) -> dict:
    gh = os.environ.get("PR_GATE_GH", "gh")
    p = subprocess.run([gh, "pr", "view", pr, "--repo", repo, "--json", "body,title,files"], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "gh pr view 失败")
    return json.loads(p.stdout)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pr", nargs="?")
    ap.add_argument("--body-file")
    ap.add_argument("--title", default="")
    ap.add_argument("--files", default=None, help="逗号分隔的改动文件(离线核对版本声明)")
    ap.add_argument("--repo", default="fuyucn/douyin-rec")
    ap.add_argument("--no-guard", action="store_true")
    a = ap.parse_args(argv)
    files = [f for f in a.files.split(",") if f] if a.files is not None else None
    if a.body_file:
        body, title = Path(a.body_file).read_text(encoding="utf-8"), a.title
    elif a.pr:
        try:
            d = fetch_pr(a.pr, a.repo)
        except (RuntimeError, ValueError) as e:
            print(f"取 PR 失败: {e}", file=sys.stderr)
            return 2
        body, title = d.get("body") or "", d.get("title") or ""
        files = [f["path"] for f in d.get("files", [])]
    else:
        print(__doc__, file=sys.stderr)
        return 2
    errs = gate(body, title, files, guard=not a.no_guard)
    if errs:
        print("FAIL")
        for e in errs:
            print(f"- 缺项: {e}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
