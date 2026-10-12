#!/usr/bin/env python3
"""开 issue 前的隐私闸门。

用法:
    python3 scripts/issue-guard.py <body-file> [more-files ...]
    gh issue view 12 --json body -q .body | python3 scripts/issue-guard.py -

命中任何规则就打印行号和命中的片段，并以非 0 退出 —— 不要带着这些内容
`gh issue create`。issue 正文和评论都要过一遍，评论是事后补的，最容易漏。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

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


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2

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
