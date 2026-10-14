#!/usr/bin/env python3
"""开 issue 前的隐私闸门。

用法:
    python3 scripts/issue-guard.py <body-file> [more-files ...]
    gh issue view 12 --json body -q .body | python3 scripts/issue-guard.py -
    python3 scripts/issue-guard.py --diff origin/feat/hub-optimization   # 只扫 PR 新增行(CI 用)

--diff <base> 模式:对 `git diff -U0 <base>...HEAD` 只扫**新增行**(历史内容不会把 CI 卡红)。
规则与上面一致,额外三条约定(只为让源码里的正常引用不误报,隐私向的规则不放松):
  - 源码类文件(.ts/.tsx/.mjs/.js/.py/.sh/.yml/.yaml/.json)的新增行不套「文件名」「凭证类」
    「主机名」「streamKey」四条语义词规则(代码和测试夹具里写 foo.ts / cookie / vps2 /
    douyin:xxx 是这个仓库的日常);房间号长数字 / BV / IP / 本机路径仍然拦。
  - 文档等非源码文件全规则生效,但「文件名」命中的名字若是仓库已跟踪文件的 basename
    (`git ls-files`,即源码/文档文件名)视为源码文件名放行;录像/字幕/产物类文件名
    (仓库里不存在的)仍然拦。
  - 生成物 docs/architecture.html 整个跳过(由 scripts/gen-architecture.mjs 从包清单、plans/ 现算,
    内容含 vps1 / rooms.json 这类角色名与文件名;隐私应在生成源头把关,不在产物上重复扫)。
  - 行内含 `issue-guard: allow` 标记的新增行整行跳过(确属测试夹具/假数据时用,须在评审中说明)。

命中任何规则就打印行号和命中的片段，并以非 0 退出 —— 不要带着这些内容
`gh issue create`。issue 正文和评论都要过一遍，评论是事后补的，最容易漏。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

CODE_SUFFIXES = (".ts", ".tsx", ".mjs", ".js", ".py", ".sh", ".yml", ".yaml", ".json")
ALLOW_MARK = "issue-guard: allow"
GENERATED_SKIP = {"docs/architecture.html"}
FILENAME_RULE = "文件名"
# 源码里是语义词/夹具、不是泄露的规则:--diff 模式下对源码类文件不生效。
CODE_SKIP_RULES = {FILENAME_RULE, "主机名", "streamKey", "cookie/webhook"}


def tracked_basenames() -> set[str]:
    proc = subprocess.run(["git", "ls-files"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return {Path(f).name for f in proc.stdout.splitlines()} if proc.returncode == 0 else set()

# (名字, 正则, 说明)。宁可变红让人确认，也不要默认放过。
RULES: list[tuple[str, str, str]] = [
    ("房间号/长数字", r"(?<!\d)\d{8,}(?!\d)", "抖音/B站房间号、taskId、aid 等"),
    ("BV 号", r"BV[0-9A-Za-z]{8,}", "B站稿件号"),
    ("IP 地址", r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)", "节点 IP"),
    ("本机路径", r"(?:/Users/|/home/|~/)[\w./\-]+", "家目录、节点路径"),
    ("streamKey", r"\b(?:douyin|bilibili|kuaishou):[\w:.\-]+", "内部场次键"),
    ("文件名", r"\b\w[\w.\-]*\.(?:ts|mp4|flv|xml|ass|json)\b", "录像/字幕文件名"),
    ("cookie/webhook", r"(?i)\b(?:cookie|webhook|token|secret|authkey)\b", "凭证类"),
    # 「master / worker」是允许的角色说法，只拦真实主机名样式（vps1、node-a、*.local 等）。
    ("主机名", r"(?i)\bvps\s*\d+\b|\b[\w\-]+\.(?:local|internal|lan)\b", "真实节点主机名（用「master / 某个 worker」指代）"),
]


def scan(text: str, source: str) -> list[str]:
    hits: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for name, pattern, why in RULES:
            for match in re.finditer(pattern, line):
                hits.append(
                    f"{source}:{lineno}: [{name}] {why} -> {match.group(0)!r}"
                )
    return hits


def added_lines(base: str) -> list[tuple[str, int, str]]:
    """解析 `git diff -U0 <base>...HEAD`,返回 (文件, 新文件行号, 行内容) 的新增行。"""
    proc = subprocess.run(
        ["git", "diff", "-U0", "--no-color", "--no-ext-diff", f"{base}...HEAD"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        print(f"git diff 失败(base={base!r}): {proc.stderr.strip()}", file=sys.stderr)
        raise SystemExit(2)
    out: list[tuple[str, int, str]] = []
    path, lineno = "", 0
    for raw in proc.stdout.splitlines():
        if raw.startswith("+++ "):
            path = raw[4:].removeprefix("b/") if raw != "+++ /dev/null" else ""
        elif raw.startswith("@@"):
            m = re.search(r"\+(\d+)", raw)
            lineno = int(m.group(1)) if m else 0
        elif raw.startswith("+") and not raw.startswith("+++") and path:
            out.append((path, lineno, raw[1:]))
            lineno += 1
    return out


def scan_diff(base: str) -> list[str]:
    hits: list[str] = []
    known = tracked_basenames()
    for path, lineno, line in added_lines(base):
        if ALLOW_MARK in line or path in GENERATED_SKIP:
            continue
        is_code = path.endswith(CODE_SUFFIXES)
        for name, pattern, why in RULES:
            if is_code and name in CODE_SKIP_RULES:
                continue
            for match in re.finditer(pattern, line):
                if name == FILENAME_RULE and Path(match.group(0)).name in known:
                    continue
                hits.append(f"{path}:{lineno}: [{name}] {why} -> {match.group(0)!r}")
    return hits


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2

    if argv[0] == "--diff":
        if len(argv) != 2:
            print("用法: issue-guard.py --diff <base>", file=sys.stderr)
            return 2
        diff_hits = scan_diff(argv[1])
        if diff_hits:
            print("diff 新增行发现疑似隐私，先脱敏再提交：", file=sys.stderr)
            for hit in diff_hits:
                print("  " + hit, file=sys.stderr)
            return 1
        print("diff 新增行未发现疑似隐私。")
        return 0

    all_hits: list[str] = []
    for arg in argv:
        if arg == "-":
            all_hits += scan(sys.stdin.read(), "<stdin>")
        else:
            path = Path(arg)
            if not path.exists():
                print(f"找不到文件: {arg}", file=sys.stderr)
                return 2
            all_hits += scan(path.read_text(encoding="utf-8"), arg)

    if all_hits:
        print("发现疑似隐私，先脱敏再开 issue / 发评论：", file=sys.stderr)
        for hit in all_hits:
            print("  " + hit, file=sys.stderr)
        return 1

    print("未发现疑似隐私，可以开 issue。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
