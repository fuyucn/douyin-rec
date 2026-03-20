# Plan 011: danmu_merge_types 配置 + merger.py XML 支持

## 背景

弹幕现在同时记录 chat/gift/member 三种类型（XML sidecar），但烧录到视频时不应默认包含全部类型。
需要在任务层面配置"合并时包含哪些弹幕类型"，并更新 merger.py 使用 XML 作为主数据源。

## 配置设计

`RecordingTask` 新增字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `danmu_merge_types` | str | `"danmaku,gift"` | 合并时包含的弹幕类型，逗号分隔 |

可选值：`danmaku`（聊天弹幕）、`gift`（礼物）、`member`（入场提醒）

默认只包含 `danmaku,gift`，`member` 需手动开启（入场提醒太密集影响观看）。

## 改动范围

| 文件 | 改动 |
|------|------|
| `src/storage/database.py` | 新增 `danmu_merge_types` 字段 |
| `src/task_manager.py` | `_migrate_db` 补迁移行，`create_task` 加参数 |
| `src/ui/app.py` | task 响应包含字段，create 接受字段，merge 端点传 `danmu_types` |
| `src/merge/merger.py` | `RecordingGroup` 加 `xml_map` + `has_danmu`，`merge_group` 加 `danmu_types` 参数，XML 优先路径 |

## merger.py XML 合并逻辑

```
有 XML → 按 record_start 偏移合并 → 按 danmu_types 过滤 → AssWriter 渲染 ASS → ffmpeg 烧录
无 XML → fallback: ffprobe 偏移合并 ASS → ffmpeg 烧录（旧格式向后兼容）
```

`discover_groups()` 同时扫描 `.xml` 和 `.ass` 文件，存入 `xml_map` / `ass_map`。
`has_danmu` 属性：`bool(xml_map) or bool(ass_map)`。
