#!/usr/bin/env python3
"""开 issue 前的隐私闸门。

用法:
    python3 scripts/issue-guard.py <body-file> [more-files ...]
    gh issue view 12 --json body -q .body | python3 scripts/issue-guard.py -
    python3 scripts/issue-guard.py --diff origin/feat/hub-optimization   # 只扫 PR 新增行(CI 用)

--diff <base> 模式:对 `git diff -U3 <base>...HEAD` 只扫**新增行**(历史内容不会把 CI 卡红;新增块上方 3 行未改动
上下文只用来拼接跨行凭证,命中必须落到新增行上)。
规则与上面一致,额外四条约定(只为让源码里的正常引用不误报,隐私向的规则不放松):
  - 源码类文件(.ts/.tsx/.mjs/.js/.py/.sh/.yml/.yaml)的新增行不套「文件名」「凭证类」
    「主机名」「streamKey」四条语义词规则(代码和测试夹具里写 foo.ts / cookie / vps2 /
    douyin:xxx 是这个仓库的日常);房间号长数字 / BV / IP / 本机路径仍然拦。
  - 文档等非源码文件全规则生效,但「文件名」命中的名字若是仓库已跟踪文件的 basename
    (`git ls-files`,即源码/文档文件名)视为源码文件名放行;录像/字幕/产物类文件名
    (仓库里不存在的)仍然拦。
  - 生成物 docs/architecture.html 与 .json 文件只豁免「文件名」「主机名」两条(生成物由
    scripts/gen-architecture.mjs 现算,含角色名与文件名;json 夹具/配置里写文件名、节点角色名是常态);
    IP、稿件号、长数字、本机路径、登录凭证键值对照常扫(真实数据写进生成物/json 也能拦住)。
  - 行内含 `issue-guard: allow` 标记的新增行只在测试夹具里跳过(test/ 目录或 *.test.* 文件);
    其它位置的标记无效、照常扫描。跳过的行数与位置会打印出来,供评审核对。

命中任何规则就打印行号和命中的片段，并以非 0 退出 —— 不要带着这些内容
`gh issue create`。issue 正文和评论都要过一遍，评论是事后补的，最容易漏。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

CODE_SUFFIXES = (".ts", ".tsx", ".mjs", ".js", ".py", ".sh", ".yml", ".yaml")
ALLOW_MARK = "issue-guard: allow"
GENERATED = {"docs/architecture.html"}
FILENAME_RULE = "文件名"
# Generated output and .json: only the role-name / filename rules are waived.
NARROW_SKIP_RULES = {FILENAME_RULE, "主机名"}
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
    # Login-cookie key/value pairs (douyin / bilibili / kuaishou session keys) with a real-looking value.
    ("登录凭证键值", r"(?i)\b(?:sessionid(?:_ss)?|sid_guard|sid_tt|uid_tt|odin_tt|ttwid|passport_csrf_token|"
     r"sessdata|bili_jct|dedeuserid(?:__ckmd5)?|buvid3|kuaishou\.server\.web_(?:st|ph))"
     r"[\"']?\s*[=:]\s*[\"']?[A-Za-z0-9%_\-|]{16,}", "登录 cookie 键值对"),
    # 「master / worker」是允许的角色说法，只拦真实主机名样式（vps1、node-a、*.local 等）。
    ("主机名", r"(?i)\bvps\s*\d+\b|\b[\w\-]+\.(?:local|internal|lan)\b", "真实节点主机名（用「master / 某个 worker」指代）"),
]

# Rules matched across lines (the cookie file is usually pretty-printed, one field per line).
MULTILINE_RULES: list[tuple[str, str, str]] = [
    # biliup cookies.json layout: {"name": "SESSDATA", "value": "..."}.
    ("登录凭证键值", r"(?i)\"name\"\s*:\s*\"(?:sessdata|bili_jct|dedeuserid(?:__ckmd5)?|sid|buvid3|sessionid)\""
     r"\s*,\s*\"value\"\s*:\s*\"[^\"\n]{16,}", "登录 cookie 键值对(name/value 形态)"),
    ("登录凭证键值", r"(?i)\"value\"\s*:\s*\"[^\"\n]{16,}\"\s*,\s*\"name\"\s*:\s*"
     r"\"(?:sessdata|bili_jct|dedeuserid(?:__ckmd5)?|sid|buvid3|sessionid)\"", "登录 cookie 键值对(value/name 形态)"),
]


def scan_block(text: str, source: str, first_line: int, added_from: int = 0) -> list[str]:
    """Apply MULTILINE_RULES to a block of consecutive lines starting at first_line.

    `added_from` is the character offset where the added lines begin: leading context lines may help a
    match, but a match that ends inside the context alone is old content and must not be reported.
    """
    hits: list[str] = []
    for name, pattern, why in MULTILINE_RULES:
        for match in re.finditer(pattern, text):
            if match.end() <= added_from:
                continue
            lineno = first_line + text.count("\n", 0, match.start())
            hits.append(f"{source}:{lineno}: [{name}] {why} -> {' '.join(match.group(0).split())!r}")
    return hits


def scan(text: str, source: str) -> list[str]:
    hits: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for name, pattern, why in RULES:
            for match in re.finditer(pattern, line):
                hits.append(
                    f"{source}:{lineno}: [{name}] {why} -> {match.group(0)!r}"
                )
    return hits + scan_block(text, source, 1)


# Context lines kept before an added block so a credential field split across lines still matches
# (`"name": "SESSDATA"` on an unchanged line, only `"value"` added). Kept small: the multi-line rules
# only need the neighbouring fields, and a bigger window would pull unrelated history into the match.
CONTEXT_LINES = 3


def added_lines(base: str) -> list[tuple[str, int, str, list[str]]]:
    """解析 `git diff -U3 <base>...HEAD`,返回 (文件, 新文件行号, 行内容, 该行之前 3 行上下文)。"""
    proc = subprocess.run(
        ["git", "diff", f"-U{CONTEXT_LINES}", "--no-color", "--no-ext-diff", f"{base}...HEAD"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        print(f"git diff 失败(base={base!r}): {proc.stderr.strip()}", file=sys.stderr)
        raise SystemExit(2)
    out: list[tuple[str, int, str, list[str]]] = []
    path, lineno, in_hunk = "", 0, False
    context: list[str] = []
    for raw in proc.stdout.splitlines():
        if raw.startswith("diff "):
            in_hunk = False
            context = []
        elif raw.startswith("@@"):
            in_hunk = True
            context = []
            m = re.search(r"\+(\d+)", raw)
            lineno = int(m.group(1)) if m else 0
        elif in_hunk:
            # Inside a hunk an added line may itself start with "++"; it is content, not a header.
            if raw.startswith("+") and path:
                out.append((path, lineno, raw[1:], list(context)))
                lineno += 1
                context = []
            elif raw.startswith("-"):
                continue  # removed lines never exist in the new file
            elif raw.startswith(" "):
                # An allow-marked fixture line must not come back as context and be scanned again.
                if ALLOW_MARK in raw and is_fixture(path):
                    context = []
                    lineno += 1
                    continue
                context.append(raw[1:])
                if len(context) > CONTEXT_LINES:
                    context.pop(0)
                lineno += 1
        elif raw.startswith("+++ "):
            path = raw[4:].strip('"').removeprefix("b/") if raw != "+++ /dev/null" else ""
    return out


def is_fixture(path: str) -> bool:
    """Only test fixtures may use the allow mark: files under test/ or named *.test.*."""
    return path.startswith("test/") or "/test/" in path or ".test." in Path(path).name


def skipped_rules(path: str) -> set[str]:
    if path in GENERATED or path.endswith(".json"):
        return NARROW_SKIP_RULES
    if path.endswith(CODE_SUFFIXES):
        return CODE_SKIP_RULES
    return set()


def scan_diff(base: str) -> tuple[list[str], list[str]]:
    """Return (hits, allowed) where allowed lists fixture lines skipped via the allow mark."""
    hits: list[str] = []
    allowed: list[str] = []
    known = tracked_basenames()
    block: list[str] = []
    block_path, block_start, block_next = "", 0, 0
    block_ctx: list[str] = []

    def flush_block() -> None:
        if block:
            # The block's reported first line must line up with the context that precedes it, so a
            # match landing on a context line still prints the right line number.
            added_from = sum(len(c) + 1 for c in block_ctx)
            hits.extend(scan_block("\n".join([*block_ctx, *block]), block_path, block_start - len(block_ctx), added_from))
            block.clear()
            block_ctx.clear()

    for path, lineno, line, ctx in added_lines(base):
        if ALLOW_MARK in line and is_fixture(path):
            allowed.append(f"{path}:{lineno}")
            flush_block()
            continue
        # Consecutive added lines of one file form a block for the multi-line rules. The unchanged
        # lines directly above it join the block: a credential can be split across them.
        if path != block_path or lineno != block_next:
            flush_block()
            block_path, block_start = path, lineno
            block_ctx = list(ctx[-CONTEXT_LINES:])
        block.append(line)
        block_next = lineno + 1
        skip = skipped_rules(path)
        for name, pattern, why in RULES:
            if name in skip:
                continue
            for match in re.finditer(pattern, line):
                if name == FILENAME_RULE and Path(match.group(0)).name in known:
                    continue
                hits.append(f"{path}:{lineno}: [{name}] {why} -> {match.group(0)!r}")
    flush_block()
    return hits, allowed


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2

    if argv[0] == "--diff":
        if len(argv) != 2:
            print("用法: issue-guard.py --diff <base>", file=sys.stderr)
            return 2
        diff_hits, allowed = scan_diff(argv[1])
        if allowed:
            print(f"allow 标记跳过 {len(allowed)} 行(仅测试夹具): " + ", ".join(allowed), file=sys.stderr)
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
