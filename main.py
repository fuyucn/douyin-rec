"""视频自动截图系统 - 主入口"""

import argparse
import logging
import signal
import sys
import time
from pathlib import Path

from src.config import load_config

logger = logging.getLogger(__name__)

# 优雅退出标志
_shutdown = False


def _signal_handler(signum, frame):
    global _shutdown
    if _shutdown:
        logger.warning("强制退出")
        sys.exit(1)
    logger.info("收到退出信号，正在优雅关闭...")
    _shutdown = True


def setup_logging(verbose: bool = False):
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _get_source_name(source) -> str | None:
    """从视频源获取名称 (主播昵称或文件名)"""
    from src.input.live import DouyinLiveSource
    if isinstance(source, DouyinLiveSource) and source.streamer_name:
        return source.streamer_name
    return None


def cmd_portrait(args):
    """主播好看照片截取"""
    global _shutdown
    config = load_config(args.config)
    if args.output_dir:
        config.storage.output_dir = args.output_dir
    if getattr(args, "quality", None):
        config.input.quality = args.quality

    from src.extract.extractor import FrameExtractor
    from src.filter.pipeline import FilterPipeline
    from src.input.local import LocalVideoSource
    from src.input.live import DouyinLiveSource
    from src.storage.manager import StorageManager

    pipeline = FilterPipeline(config)
    extractor = FrameExtractor(fps=config.input.extract_fps)

    if "douyin.com" in args.source or args.source.startswith(("http://", "https://")):
        source = DouyinLiveSource(args.source, config=config.input)
    else:
        source = LocalVideoSource(args.source)

    # 用 --name 覆盖, 否则自动检测
    name = getattr(args, "name", None)
    segment_scores = []  # 当前分段的候选帧
    saved_count = 0

    # 分段参数: CLI --segment 覆盖 config
    segment_duration = getattr(args, "segment", None)
    if segment_duration is None:
        segment_duration = config.input.segment_duration
    next_segment_boundary = segment_duration if segment_duration > 0 else float("inf")

    headed = getattr(args, "headed", False)
    display = None
    if headed:
        from src.display import FrameDisplay
        display = FrameDisplay()

    def _flush_segment(scores, storage, label=""):
        """对当前分段做 top-k 选择并保存"""
        nonlocal saved_count
        if not scores:
            return
        top = pipeline.select_top_k(scores, config.aesthetic.top_k)
        for s in top:
            storage.save_screenshot(s, category="portrait")
            saved_count += 1
        logger.info(
            "分段%s保存 %d 张 (候选 %d, 总计: %d)",
            label, len(top), len(scores), saved_count,
        )

    logger.info("开始处理: %s", args.source)
    try:
        with source:
            # 连接后获取主播名字
            if not name:
                name = _get_source_name(source) or Path(args.source).stem
            storage = StorageManager(config.storage, name=name)
            logger.info("输出目录: %s", storage.output_dir)
            if segment_duration > 0:
                logger.info("分段处理: 每 %.0f 秒输出一次结果", segment_duration)

            # 计算视频总时长 (直播流为 0)
            total_duration = 0.0
            total_frames = source.total_frames
            if total_frames and total_frames > 0:
                total_duration = total_frames / source.fps

            for frame_info in extractor.extract_frames(source):
                if _shutdown:
                    logger.info("用户中断，停止处理")
                    break

                # 分段边界检查: 到达边界时保存当前段
                if frame_info.timestamp >= next_segment_boundary:
                    _flush_segment(
                        segment_scores, storage,
                        label=f" [{next_segment_boundary - segment_duration:.0f}s-{next_segment_boundary:.0f}s] ",
                    )
                    segment_scores.clear()
                    next_segment_boundary += segment_duration

                if headed:
                    score, details = pipeline.process_frame_detailed(frame_info)
                    if score is not None:
                        segment_scores.append(score)
                        status = "\u2713 SAVED"
                    else:
                        reason = details.get("reject_reason", "rejected")
                        status = f"\u2717 {reason}"

                    quit_requested = display.show(
                        frame=frame_info.frame,
                        blur_score=details.get("blur_score"),
                        face_info=details.get("face_info"),
                        aesthetic_score=details.get("aesthetic_score"),
                        status=status,
                        saved_count=saved_count,
                        timestamp=frame_info.timestamp,
                        total_duration=total_duration,
                    )
                    if quit_requested:
                        _shutdown = True
                else:
                    score = pipeline.process_frame(frame_info)
                    if score is not None:
                        segment_scores.append(score)

                if len(segment_scores) % 10 == 0 and len(segment_scores) > 0:
                    logger.info("已收集 %d 张候选照片 (时间: %.1fs)", len(segment_scores), frame_info.timestamp)
    finally:
        if display is not None:
            display.close()

    # 保存最后一段剩余
    _flush_segment(segment_scores, storage, label=" [最终] ")

    if saved_count == 0:
        logger.warning("未找到符合条件的照片")
        return

    logger.info("完成! 共保存 %d 张照片到 %s", saved_count, storage.output_dir)


def cmd_highlight(args):
    """高能时刻检测"""
    config = load_config(args.config)
    if args.output_dir:
        config.storage.output_dir = args.output_dir

    from src.highlight.detector import HighlightDetector
    from src.storage.manager import StorageManager

    storage = StorageManager(config.storage)
    detector = HighlightDetector(config)

    logger.info("开始高能时刻检测: %s", args.source)
    moments = detector.detect(args.source)

    if not moments:
        logger.warning("未检测到高能时刻")
        return

    for moment in moments:
        clip = storage.save_highlight(moment)
        logger.info(
            "高能时刻 [%.1f-%.1fs] 分类=%s 评分=%.2f: %s",
            moment.start_time,
            moment.end_time,
            moment.result.category.value,
            moment.result.score,
            moment.result.description,
        )

    logger.info("完成! 共检测到 %d 个高能时刻", len(moments))


def cmd_live(args):
    """抖音直播流处理"""
    global _shutdown
    config = load_config(args.config)
    if args.output_dir:
        config.storage.output_dir = args.output_dir
    if args.cookies:
        config.input.cookies_file = args.cookies
    if getattr(args, "quality", None):
        config.input.quality = args.quality

    from src.extract.extractor import FrameExtractor
    from src.filter.pipeline import FilterPipeline
    from src.input.live import DouyinLiveSource
    from src.storage.manager import StorageManager

    pipeline = FilterPipeline(config)
    extractor = FrameExtractor(fps=config.input.extract_fps)

    source = DouyinLiveSource(args.source, config=config.input)
    name = getattr(args, "name", None)
    batch_scores = []
    saved_count = 0
    recorder = None

    headed = getattr(args, "headed", False)
    display = None
    if headed:
        from src.display import FrameDisplay
        display = FrameDisplay()

    logger.info("连接直播流: %s", args.source)
    try:
        with source:
            if not name:
                name = _get_source_name(source) or "live"
            storage = StorageManager(config.storage, name=name)
            logger.info("主播: %s  输出目录: %s", name, storage.output_dir)

            # --record: 同步启动录制
            if getattr(args, "record", False) and source.stream_url:
                from src.recorder import StreamRecorder
                rec_path, _ = StreamRecorder.make_output_path(name, storage.output_dir)
                recorder = StreamRecorder(source.stream_url, rec_path)
                recorder.start()

            for frame_info in extractor.extract_frames(source):
                if _shutdown:
                    logger.info("用户中断，停止处理")
                    break

                if headed:
                    score, details = pipeline.process_frame_detailed(frame_info)
                    if score is not None:
                        batch_scores.append(score)
                        status = "\u2713 SAVED"
                    else:
                        reason = details.get("reject_reason", "rejected")
                        status = f"\u2717 {reason}"

                    quit_requested = display.show(
                        frame=frame_info.frame,
                        blur_score=details.get("blur_score"),
                        face_info=details.get("face_info"),
                        aesthetic_score=details.get("aesthetic_score"),
                        status=status,
                        saved_count=saved_count,
                        timestamp=frame_info.timestamp,
                    )
                    if quit_requested:
                        _shutdown = True
                else:
                    score = pipeline.process_frame(frame_info)
                    if score is not None:
                        batch_scores.append(score)

                # 每收集 50 张候选就做一次 Top-K 保存
                if len(batch_scores) >= 50:
                    top = pipeline.select_top_k(batch_scores, config.aesthetic.top_k)
                    for s in top:
                        storage.save_screenshot(s, category="portrait")
                        saved_count += 1
                    logger.info("批次保存 %d 张 (总计: %d)", len(top), saved_count)
                    batch_scores.clear()
    finally:
        if recorder is not None:
            recorder.stop()
        if display is not None:
            display.close()

    # 保存剩余
    if batch_scores:
        top = pipeline.select_top_k(batch_scores, config.aesthetic.top_k)
        for s in top:
            storage.save_screenshot(s, category="portrait")
            saved_count += 1

    logger.info("直播流处理完成! 共保存 %d 张照片", saved_count)


def cmd_task(args):
    """任务管理 CLI 子命令"""
    from src.task_manager import TaskManager

    config = load_config(args.config)
    tm = TaskManager(output_dir=config.storage.output_dir)
    action = args.task_action

    if action == "add":
        enable_record = not getattr(args, "no_record", False)
        task = tm.create_task(
            url=args.url,
            name=getattr(args, "name", None),
            quality=getattr(args, "quality", "origin"),
            segment_min=getattr(args, "segment", 30),
            enable_record=enable_record,
            enable_screenshot=getattr(args, "screenshot", False),
        )
        features = []
        if task.enable_record:
            features.append("录制")
        if task.enable_screenshot:
            features.append("截图")
        print(f"已创建任务 #{task.id}: {task.url}")
        print(f"  功能: {', '.join(features)}  画质: {task.quality}  分段: {task.segment_min}min")

    elif action == "list":
        tasks = tm.list_tasks()
        if not tasks:
            print("暂无任务")
            return
        for t in tasks:
            features = []
            if t.enable_record:
                features.append("录制")
            if t.enable_screenshot:
                features.append("截图")
            name = t.name or "-"
            print(f"  #{t.id:<4} [{t.status:<8}] {name:<12} {t.url}")
            print(f"        功能: {', '.join(features)}  画质: {t.quality}  分段: {t.segment_min}min")

    elif action == "remove":
        task = tm.get_task(args.task_id)
        if task is None:
            print(f"任务 #{args.task_id} 不存在")
            sys.exit(1)
        if task.status == "running":
            print(f"任务 #{args.task_id} 正在运行，请先停止")
            sys.exit(1)
        ok = tm.delete_task(args.task_id)
        if ok:
            print(f"已删除任务 #{args.task_id}")
        else:
            print(f"删除任务 #{args.task_id} 失败")
            sys.exit(1)


def cmd_record(args):
    """纯录制直播流为 .ts 文件（支持分段 + 等待开播）"""
    if getattr(args, "ui", False):
        import uvicorn
        import src.ui.app as app_module
        if getattr(args, "output_dir", None):
            from src.task_manager import TaskManager
            app_module.task_manager = TaskManager(output_dir=args.output_dir)
        port = getattr(args, "port", 7860)
        logger.info("启动 Web UI: http://0.0.0.0:%d", port)
        uvicorn.run(app_module.app, host="0.0.0.0", port=port)
        return

    if not args.source:
        parser_error = "record 命令需要提供直播间 URL（或使用 --ui 启动 Web 界面）"
        print(f"error: {parser_error}", file=sys.stderr)
        sys.exit(1)

    global _shutdown
    config = load_config(args.config)
    if args.cookies:
        config.input.cookies_file = args.cookies
    if getattr(args, "quality", None):
        config.input.quality = args.quality

    from src.input.live import DouyinLiveSource
    from src.recorder import StreamRecorder
    from src.storage.manager import StorageManager

    segment_min = getattr(args, "segment", 0) or 0
    segment_sec = segment_min * 60
    wait = getattr(args, "wait", False)

    source = DouyinLiveSource(args.source, config=config.input)
    name = getattr(args, "name", None)

    # 先获取主播名
    source.extract_streamer_info()
    if not name:
        name = source.streamer_name or "live"
    storage = StorageManager(config.storage, name=name)
    logger.info("主播: %s", name)

    while not _shutdown:
        # 提取流地址（可选等待开播）
        if wait:
            import threading
            stop_evt = threading.Event()
            def _check_shutdown():
                while not _shutdown:
                    time.sleep(0.5)
                stop_evt.set()
            watcher = threading.Thread(target=_check_shutdown, daemon=True)
            watcher.start()
            try:
                stream_url = source.wait_for_live(stop_event=stop_evt)
            except InterruptedError:
                break
        else:
            logger.info("提取直播流地址: %s", args.source)
            stream_url = source._extract_stream_url()

        source._stream_url = stream_url

        rec_path, display = StreamRecorder.make_output_path(
            name, storage.output_dir, segment=segment_sec > 0,
        )
        logger.info("录制文件: %s", display)

        recorder = StreamRecorder(stream_url, rec_path, segment_duration=segment_sec)
        try:
            recorder.start()
            while not _shutdown and recorder.is_running:
                time.sleep(1)
        finally:
            recorder.stop()

        # 不等待模式或用户中断: 退出循环
        if not wait or _shutdown:
            break
        logger.info("直播流断开，重新等待开播...")

    logger.info("录制完成")



def main():
    parser = argparse.ArgumentParser(description="视频自动截图系统")
    parser.add_argument("--config", default="config.yaml", help="配置文件路径")
    parser.add_argument("--output-dir", help="输出目录 (覆盖配置文件)")
    parser.add_argument("-v", "--verbose", action="store_true", help="详细日志")
    parser.add_argument("--headed", action="store_true", help="弹窗实时显示视频画面和标注")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # portrait 子命令
    p_portrait = subparsers.add_parser("portrait", help="截取主播好看照片")
    p_portrait.add_argument("source", help="视频文件路径或直播间 URL")
    p_portrait.add_argument("--name", help="主播/视频名称 (用于输出目录, 直播流自动获取)")
    p_portrait.add_argument("--segment", type=float, help="分段处理间隔秒数 (默认 300s=5min, 0=不分段)")
    p_portrait.add_argument("--quality", choices=["origin", "uhd", "hd", "sd", "ld"],
                            help="直播画质: origin(原画) uhd(蓝光) hd(高清) sd(标清) ld(流畅)")

    # highlight 子命令
    p_highlight = subparsers.add_parser("highlight", help="检测高能时刻")
    p_highlight.add_argument("source", help="视频文件路径")
    p_highlight.add_argument("--name", help="视频名称 (用于输出目录)")

    # live 子命令
    p_live = subparsers.add_parser("live", help="抖音直播流处理")
    p_live.add_argument("source", help="抖音直播间 URL")
    p_live.add_argument("--name", help="主播名称 (默认自动获取)")
    p_live.add_argument("--cookies", help="Cookies 文件路径")
    p_live.add_argument("--quality", choices=["origin", "uhd", "hd", "sd", "ld"],
                        help="直播画质: origin(原画) uhd(蓝光) hd(高清) sd(标清) ld(流畅)")
    p_live.add_argument("--record", action="store_true", help="同时录制直播流为 .ts 文件")

    # task 子命令组
    p_task = subparsers.add_parser("task", help="管理录制任务")
    task_sub = p_task.add_subparsers(dest="task_action", required=True)

    p_add = task_sub.add_parser("add", help="添加任务")
    p_add.add_argument("url", help="直播间 URL")
    p_add.add_argument("--name", help="主播名称")
    p_add.add_argument("--quality", default="origin",
                        choices=["origin", "uhd", "hd", "sd", "ld"],
                        help="直播画质")
    p_add.add_argument("--segment", type=int, default=30,
                        help="分段时长 (分钟, 默认 30, 0=不分段)")
    p_add.add_argument("--no-record", action="store_true",
                        help="不录制 (仅截图)")
    p_add.add_argument("--screenshot", action="store_true",
                        help="启用截图")

    task_sub.add_parser("list", help="列出所有任务")

    p_rm = task_sub.add_parser("remove", help="删除任务")
    p_rm.add_argument("task_id", type=int, help="任务 ID")

    # record 子命令
    p_record = subparsers.add_parser("record", help="纯录制直播流为 .ts 文件")
    p_record.add_argument("source", nargs="?", default=None, help="抖音直播间 URL (--ui 模式下可省略)")
    p_record.add_argument("--name", help="主播名称 (默认自动获取)")
    p_record.add_argument("--cookies", help="Cookies 文件路径")
    p_record.add_argument("--quality", choices=["origin", "uhd", "hd", "sd", "ld"],
                          help="直播画质: origin(原画) uhd(蓝光) hd(高清) sd(标清) ld(流畅)")
    p_record.add_argument("--segment", type=int, default=0,
                          help="分段时长 (分钟, 默认 0=不分段)")
    p_record.add_argument("--wait", action="store_true",
                          help="未开播时等待而非退出")
    p_record.add_argument("--ui", action="store_true",
                          help="启动 Web 录制控制台 (替代 CLI 模式)")
    p_record.add_argument("--port", type=int, default=7860,
                          help="Web UI 端口 (配合 --ui 使用)")

    args = parser.parse_args()

    setup_logging(args.verbose)
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    commands = {
        "portrait": cmd_portrait,
        "highlight": cmd_highlight,
        "live": cmd_live,
        "record": cmd_record,
        "task": cmd_task,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
