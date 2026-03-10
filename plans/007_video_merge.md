# Plan 007: 视频分段合并功能

## 目标

将 ffmpeg segment muxer 生成的分段 `.ts` 文件合并为 `.mp4`，同时支持烧录弹幕版本。

**输出文件**：
- `{前缀}.mp4` — 无损合并（-c copy），仅换容器，秒级完成
- `{前缀}_danmu.ass` — 合并后的弹幕文件（外挂字幕，保留备用）
- `{前缀}_danmu.mp4` — 弹幕烧录版（libx264 重编码，依赖 `{前缀}.mp4` 先存在）

---

## 新增文件

```
src/
└── merge/
    ├── __init__.py
    └── merger.py          # 全部核心逻辑
```

改动现有文件：
- `main.py` — 新增 `merge` 子命令
- `src/ui/app.py` — 新增两个 API 路由
- `src/ui/static/index.html` — 详情页新增「录制组」section

---

## 核心数据结构

```python
@dataclass
class RecordingGroup:
    prefix: str              # e.g. "树.🌱_2026-03-10_12-02-41"
    output_dir: Path
    ts_files: list[Path]     # 排序后的 .ts 分段（完整列表）
    ass_map: dict[int, Path] # 段索引 → ass 路径（仅存在的文件）
    # 注：ass_map 的 key 对应 ts_files 的索引，用于正确计算时间偏移

    @property
    def merged_mp4(self) -> Path:
        return self.output_dir / f"{self.prefix}.mp4"

    @property
    def merged_ass(self) -> Path:
        return self.output_dir / f"{self.prefix}_danmu.ass"

    @property
    def merged_danmu_mp4(self) -> Path:
        return self.output_dir / f"{self.prefix}_danmu.mp4"

    @property
    def already_merged(self) -> bool:
        return self.merged_mp4.exists()
```

---

## 关键函数

```python
def discover_groups(output_dir: Path, exclude_last: bool = False) -> list[RecordingGroup]:
    """
    扫描目录，按前缀分组，返回可合并的录制组。
    exclude_last=True 时每组排除最后一段（用于录制中的任务，防止合并未完成的段）。
    正则: r"^(.+)_(\d+)\.ts$"  注意 \d+ 而非 \d{3}，支持超过 999 段。
    """

def get_segment_duration(ts_path: Path) -> float:
    """
    用 ffprobe 获取 .ts 文件实际时长（秒）。
    ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1
    失败时抛出 RuntimeError（上层捕获后跳过弹幕合并，日志警告）。
    """

def merge_ass_files(
    ts_files: list[Path],    # 完整的 ts 列表，用于计算各段偏移
    ass_map: dict[int, Path], # 段索引 → ass 文件
    output_path: Path,
) -> None:
    """
    两阶段合并 ASS：
    阶段 1（头部）：从 ass_map 中第一个存在的 ASS 文件复制头部（到 [Events] Format 行为止）
    阶段 2（弹幕行）：对每个 ts 段，累计偏移 = sum(前 N 段的实际时长)，
                     若该段有 ass 文件则读取 Dialogue: 行，加偏移后写入
    """

def merge_group(
    group: RecordingGroup,
    log_fn: Callable[[str], None] | None = None,
    do_plain: bool = True,
    do_danmu: bool = True,
    overwrite: bool = False,
) -> dict:
    """
    合并一个录制组。
    - do_plain: 生成 {prefix}.mp4（-c copy）
    - do_danmu: 生成 {prefix}_danmu.mp4（需先有 plain mp4）
    - 若 do_danmu=True 但 plain mp4 不存在，自动先执行 plain merge
    - ffmpeg 失败时删除残留的不完整输出文件
    - plain merge 成功后用 ffprobe 做基本校验（-v error）
    返回: {"plain_mp4": str | None, "danmu_mp4": str | None, "skipped": bool}
    """
```

---

## ASS 时间格式（与 ass_writer.py 保持一致）

`ass_writer.py` 使用 `'%02d:%02d:%05.2f' % _sec2hms(sec)`，输出如 `00:01:05.23`。

```python
def _sec2hms(sec: float) -> tuple[int, int, float]:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return h, m, s

def _parse_ass_time(s: str) -> float:
    """'00:01:05.23' → 秒（float）。支持 \d+ 小时位。"""
    m = re.match(r"(\d+):(\d{2}):(\d{2}\.\d{2})", s)
    h, mi, se = int(m[1]), int(m[2]), float(m[3])
    return h * 3600 + mi * 60 + se

def _format_ass_time(sec: float) -> str:
    """秒 → '00:01:05.23'，与 ass_writer.py 格式完全一致。"""
    h, m, s = _sec2hms(sec)
    return '%02d:%02d:%05.2f' % (h, m, s)
```

---

## ASS 合并两阶段算法

```python
def merge_ass_files(ts_files, ass_map, output_path):
    # 先用 ffprobe 获取所有段时长，构建累计偏移列表
    durations = []
    for ts in ts_files:
        durations.append(get_segment_duration(ts))

    offsets = [0.0]
    for d in durations[:-1]:
        offsets.append(offsets[-1] + d)
    # offsets[i] = 段 i 的 Dialogue 行需要加的秒数

    with open(output_path, 'w', encoding='utf-8') as out:
        # 阶段 1：写头部（取 ass_map 中索引最小的文件）
        first_idx = min(ass_map.keys())
        header_done = False
        for line in ass_map[first_idx].read_text(encoding='utf-8').splitlines():
            if not header_done:
                out.write(line + '\n')
                # [Events] 节的 Format 行是头部最后一行
                if line.startswith('Format: Layer, Start, End,'):
                    header_done = True

        # 阶段 2：按段顺序写 Dialogue 行（加偏移）
        for i, ts in enumerate(ts_files):
            if i not in ass_map:
                continue
            offset = offsets[i]
            for line in ass_map[i].read_text(encoding='utf-8').splitlines():
                if not line.startswith('Dialogue:'):
                    continue
                # Dialogue: Layer,Start,End,Style,...,Text
                # split maxsplit=9 保留 Text 字段中的逗号（move tag 等）
                parts = line.split(',', 9)
                parts[1] = _format_ass_time(_parse_ass_time(parts[1]) + offset)
                parts[2] = _format_ass_time(_parse_ass_time(parts[2]) + offset)
                out.write(','.join(parts) + '\n')
```

---

## ffmpeg 命令

### 无损合并（-c copy）

```bash
# 临时 concat list（绝对路径，用完删除）
file '/abs/path/前缀_000.ts'
file '/abs/path/前缀_001.ts'
...

ffmpeg -y -f concat -safe 0 -i /tmp/concat_xxxxx.txt \
    -c copy \
    -movflags +faststart \
    output.mp4
```

临时文件用 `tempfile.NamedTemporaryFile(suffix=".txt", delete=False)`，用 `try/finally` 确保清理。

### 弹幕烧录（libx264，依赖 plain mp4 已存在）

```bash
# cwd 设为 ASS 文件所在目录，避免中文/特殊字符路径转义问题
# 传文件名（相对路径）而非绝对路径
ffmpeg -y -i output.mp4 \
    -vf "ass=前缀_danmu.ass" \
    -c:v libx264 -preset fast -crf 20 \
    -c:a copy \
    -movflags +faststart \
    output_danmu.mp4
```

### ffmpeg 失败处理

```python
proc = subprocess.run([...], capture_output=True)
if proc.returncode != 0:
    output_file.unlink(missing_ok=True)  # 删除残留不完整文件
    raise RuntimeError(f"ffmpeg 失败: {proc.stderr.decode()[-500:]}")
```

### 合并后校验

```python
check = subprocess.run(
    ['ffprobe', '-v', 'error', str(output_mp4)],
    capture_output=True
)
if check.returncode != 0:
    output_mp4.unlink(missing_ok=True)
    raise RuntimeError("输出文件校验失败")
```

---

## 录制组发现 (`discover_groups`)

```python
_SEGMENT_RE = re.compile(r"^(.+)_(\d+)\.ts$")  # \d+ 支持超过 999 段

def discover_groups(output_dir: Path, exclude_last: bool = False) -> list[RecordingGroup]:
    groups: dict[str, list[tuple[int, Path]]] = {}

    for ts in sorted(output_dir.glob("*.ts")):
        m = _SEGMENT_RE.match(ts.name)
        if not m:
            continue
        prefix, idx = m.group(1), int(m.group(2))
        groups.setdefault(prefix, []).append((idx, ts))

    result = []
    for prefix, items in sorted(groups.items()):
        items.sort()
        all_ts = [p for _, p in items]

        if exclude_last and len(all_ts) > 1:
            all_ts = all_ts[:-1]  # 排除最后一段（录制中可能未完成）

        ass_map = {}
        for i, ts in enumerate(all_ts):
            ass = output_dir / (ts.stem + "_danmu.ass")
            if ass.exists():
                ass_map[i] = ass

        result.append(RecordingGroup(
            prefix=prefix,
            output_dir=output_dir,
            ts_files=all_ts,
            ass_map=ass_map,
        ))

    return result
```

---

## CLI 子命令

```bash
python main.py merge PATH [--prefix PREFIX] [--no-danmu] [--overwrite]
```

- `PATH`：
  - 若为 `task_{id}` 子目录（含 `.ts` 文件）→ 直接扫描该目录
  - 若为根 output 目录（含 `task_*` 子目录）→ 递归扫描所有 `task_*` 子目录
- `--prefix`：只合并指定前缀
- `--no-danmu`：跳过弹幕版生成
- `--overwrite`：覆盖已存在的 `.mp4`

```python
def cmd_merge(args):
    from src.merge.merger import discover_groups, merge_group
    from pathlib import Path

    root = Path(args.path)
    # 自动检测：是根目录还是 task 子目录
    task_dirs = sorted(root.glob("task_*")) if any(root.glob("task_*/")) else [root]

    for task_dir in task_dirs:
        groups = discover_groups(task_dir)
        if args.prefix:
            groups = [g for g in groups if g.prefix == args.prefix]
        for group in groups:
            if group.already_merged and not args.overwrite:
                print(f"跳过（已合并）: {group.prefix}")
                continue
            print(f"合并: {group.prefix} ({len(group.ts_files)} 段)")
            result = merge_group(
                group, log_fn=print,
                do_danmu=not args.no_danmu,
                overwrite=args.overwrite,
            )
            if result.get('plain_mp4'):
                print(f"  => {result['plain_mp4']}")
            if result.get('danmu_mp4'):
                print(f"  => {result['danmu_mp4']}")
```

---

## Web UI API（`src/ui/app.py`）

### GET `/api/tasks/{id}/segments`

返回录制组列表，附带解析出的日期/时间字段供 UI 分组展示：

```python
import re
_PREFIX_DT_RE = re.compile(r"^.+_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})$")

@app.get("/api/tasks/{task_id}/segments")
async def list_segments(task_id: int):
    t = task_manager.get_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)

    output_dir = Path(_task_output_dir(t))
    if not output_dir.exists():
        return {"groups": []}

    from src.merge.merger import discover_groups
    # running 任务排除最后一段弹幕，防止合并未完成的 ass 文件
    is_running = (t.status == "running")
    groups = discover_groups(output_dir, exclude_last=is_running)

    result = []
    for g in groups:
        m = _PREFIX_DT_RE.match(g.prefix)
        result.append({
            "prefix": g.prefix,
            "date": m.group(1) if m else None,        # "2026-03-10"
            "time": m.group(2).replace("-", ":") if m else None,  # "12:02:41"
            "segment_count": len(g.ts_files),
            "has_danmu": len(g.ass_map) > 0,
            "merged": g.already_merged,
            "danmu_merged": g.merged_danmu_mp4.exists(),
        })
    return {"groups": result}
```

### POST `/api/tasks/{id}/merge`

立即返回，后台执行，进度通过现有 SSE 日志流输出：

```python
_merging_prefixes: set[str] = set()  # 模块级，防止并发重复合并

@app.post("/api/tasks/{task_id}/merge")
async def merge_segments(task_id: int, request: Request):
    t = task_manager.get_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)

    body = await request.json()
    prefix = body.get("prefix", "").strip()
    do_danmu = body.get("burn_danmu", True)
    overwrite = body.get("overwrite", False)

    lock_key = f"{task_id}:{prefix}"
    if lock_key in _merging_prefixes:
        return JSONResponse({"error": "正在合并中，请稍候"}, status_code=409)

    output_dir = Path(_task_output_dir(t))
    from src.merge.merger import discover_groups, merge_group

    groups = discover_groups(output_dir)
    target = next((g for g in groups if g.prefix == prefix), None)
    if target is None:
        return JSONResponse({"error": f"未找到前缀: {prefix}"}, status_code=404)

    if target.already_merged and not overwrite:
        # 若只是要烧录弹幕而 plain mp4 已存在，允许继续
        if not do_danmu or target.merged_danmu_mp4.exists():
            return JSONResponse({"error": "已合并，传 overwrite:true 强制覆盖"}, status_code=409)

    def _run():
        _merging_prefixes.add(lock_key)
        try:
            log_fn = lambda msg: task_manager.broadcast(task_id, msg)
            merge_group(target, log_fn=log_fn, do_danmu=do_danmu, overwrite=overwrite)
        finally:
            _merging_prefixes.discard(lock_key)

    # 立即返回，后台线程执行（进度通过 SSE 日志流可见）
    import threading
    threading.Thread(target=_run, daemon=True).start()

    return {"ok": True, "status": "merging", "message": "合并已启动，请查看日志"}
```

> **注意**：`task_manager.broadcast` 方法名需与实际代码对齐（实现时确认）。

---

## Web UI 前端（`index.html`）

在 `renderDetailView` 末尾的 innerHTML 中，任务信息卡片之后插入：

```html
<div class="card bg-base-200 mb-4">
  <div class="card-body py-3 px-4">
    <div class="flex items-center justify-between mb-2">
      <h3 class="font-semibold text-sm">录制组</h3>
      <button class="btn btn-ghost btn-xs" onclick="loadSegments(${id})">刷新</button>
    </div>
    <div id="segmentsList" class="text-sm">加载中...</div>
  </div>
</div>
```

**UI 按日期分组展示**（`loadSegments` JS 函数）：

```
录制组                                          [刷新]
├── 2026-03-08
│   └── 12:02:41  6段  [弹幕]  [合并] [烧录弹幕]
├── 2026-03-09
│   └── 09:15:00  4段  [弹幕]  [已合并] [烧录弹幕]
└── 2026-03-10
    ├── 11:30:22  8段  [弹幕]  [已合并] [弹幕已合并]
    └── 20:05:11  2段         [合并]
```

新增 JS 函数（避免 onclick 内联字符串注入，用 data 属性）：

```javascript
async function loadSegments(taskId) {
  const el = document.getElementById('segmentsList');
  try {
    const r = await fetch(`/api/tasks/${taskId}/segments`);
    const d = await r.json();
    if (!d.groups?.length) {
      el.innerHTML = '<span class="opacity-40 text-xs">暂无录制组</span>';
      return;
    }

    // 按日期分组
    const byDate = {};
    for (const g of d.groups) {
      const date = g.date || '未知日期';
      (byDate[date] = byDate[date] || []).push(g);
    }

    el.innerHTML = Object.entries(byDate).map(([date, groups]) => `
      <div class="mb-2">
        <div class="text-xs font-semibold opacity-50 mb-1">${esc(date)}</div>
        ${groups.map(g => `
          <div class="flex flex-wrap items-center gap-2 py-1 pl-3 border-b border-base-300 last:border-0">
            <span class="font-mono text-xs w-20 shrink-0">${esc(g.time || g.prefix)}</span>
            <span class="badge badge-outline badge-xs">${g.segment_count}段</span>
            ${g.has_danmu ? '<span class="badge badge-info badge-outline badge-xs">弹幕</span>' : ''}
            ${g.merged
              ? '<span class="badge badge-success badge-outline badge-xs">已合并</span>'
              : `<button class="btn btn-xs btn-outline"
                   data-task="${taskId}" data-prefix="${esc(g.prefix)}" data-danmu="false"
                   onclick="mergeGroup(this)">合并</button>`
            }
            ${g.has_danmu && !g.danmu_merged
              ? `<button class="btn btn-xs btn-outline btn-info"
                   data-task="${taskId}" data-prefix="${esc(g.prefix)}" data-danmu="true"
                   onclick="mergeGroup(this)">烧录弹幕</button>`
              : (g.danmu_merged ? '<span class="badge badge-info badge-xs">弹幕已合并</span>' : '')
            }
          </div>
        `).join('')}
      </div>
    `).join('');
  } catch {
    el.innerHTML = '<span class="text-error text-xs">加载失败</span>';
  }
}

async function mergeGroup(btn) {
  const taskId = btn.dataset.task;
  const prefix = btn.dataset.prefix;
  const burnDanmu = btn.dataset.danmu === 'true';
  btn.disabled = true;
  btn.textContent = '启动中...';
  try {
    const r = await fetch(`/api/tasks/${taskId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, burn_danmu: burnDanmu }),
    });
    const d = await r.json();
    if (!r.ok) {
      alert(d.error);
      btn.disabled = false;
      btn.textContent = burnDanmu ? '烧录弹幕' : '合并';
      return;
    }
    btn.textContent = '合并中...（见日志）';
    // 30 秒后刷新录制组列表（plain merge 通常秒级完成）
    setTimeout(() => loadSegments(taskId), 30000);
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
    btn.textContent = burnDanmu ? '烧录弹幕' : '合并';
  }
}
```

`renderDetailView` 末尾调用 `loadSegments(id)` 自动加载。

---

## 注意事项

| # | 问题 | 处理方式 |
|---|------|---------|
| 1 | 分段超 999 段 | 正则用 `\d+` |
| 2 | 中文路径 + `-vf ass=` | 设 `cwd` 为 ASS 文件目录，传文件名 |
| 3 | 录制中合并最后一段 | `discover_groups(exclude_last=True)` |
| 4 | ffmpeg 失败残留文件 | `returncode != 0` 时删除输出文件 |
| 5 | 合并后文件校验 | ffprobe `-v error` 校验 |
| 6 | 烧录弹幕依赖 plain mp4 | 不存在时自动先 plain merge |
| 7 | ASS 时间格式 | 严格复用 `_sec2hms + %05.2f`，与 `ass_writer.py` 一致 |
| 8 | ASS 头部边界 | 两阶段：先写头部到 `Format:` 行，再写各段 Dialogue |
| 9 | 并发重复合并 | `_merging_prefixes` set 做并发锁 |
| 10 | ASS 文件保留 | `{prefix}_danmu.ass` 作为独立产物保留（VLC/MPV 可用）|
| 11 | 段缺失（不连续）| 按实际文件顺序计算偏移，日志警告 |
| 12 | broadcast 方法名 | 实现前确认 `task_manager` 实际方法名 |
