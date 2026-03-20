"""测试任务管理器"""

import tempfile
from datetime import datetime, time as dt_time
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest
from pathlib import Path

from src.task_manager import TaskManager


@pytest.fixture
def tm(tmp_path):
    """创建使用临时 DB 的 TaskManager"""
    db_path = str(tmp_path / "test_tasks.db")
    return TaskManager(db_path=db_path)


def test_create_task(tm):
    """创建任务"""
    task = tm.create_task(
        url="https://live.douyin.com/123",
        quality="hd",
        segment_min=15,
        enable_record=True,
        enable_screenshot=True,
    )
    assert task.id is not None
    assert task.url == "https://live.douyin.com/123"
    assert task.quality == "hd"
    assert task.segment_min == 15
    assert task.enable_record is True
    assert task.enable_screenshot is True
    assert task.status == "pending"


def test_list_tasks(tm):
    """列出任务"""
    tm.create_task(url="https://live.douyin.com/111")
    tm.create_task(url="https://live.douyin.com/222")
    tasks = tm.list_tasks()
    assert len(tasks) == 2
    assert tasks[0].url == "https://live.douyin.com/111"
    assert tasks[1].url == "https://live.douyin.com/222"


def test_get_task(tm):
    """获取单个任务"""
    created = tm.create_task(url="https://live.douyin.com/123")
    task = tm.get_task(created.id)
    assert task is not None
    assert task.url == "https://live.douyin.com/123"


def test_get_task_not_found(tm):
    """获取不存在的任务"""
    assert tm.get_task(999) is None


def test_delete_task(tm):
    """删除任务"""
    task = tm.create_task(url="https://live.douyin.com/123")
    assert tm.delete_task(task.id) is True
    assert tm.get_task(task.id) is None


def test_delete_nonexistent_task(tm):
    """删除不存在的任务"""
    assert tm.delete_task(999) is False


def test_delete_running_task(tm):
    """不能删除运行中的任务"""
    task = tm.create_task(url="https://live.douyin.com/123")
    tm._update_task_status(task.id, "running")
    assert tm.delete_task(task.id) is False


def test_create_task_defaults(tm):
    """创建任务默认值"""
    task = tm.create_task(url="https://live.douyin.com/123")
    assert task.quality == "origin"
    assert task.segment_min == 30
    assert task.enable_record is True
    assert task.enable_screenshot is False
    assert task.status == "pending"
    assert task.name is None
    assert task.cookies is None


def test_update_task_status(tm):
    """更新任务状态"""
    task = tm.create_task(url="https://live.douyin.com/123")
    tm._update_task_status(task.id, "running")
    updated = tm.get_task(task.id)
    assert updated.status == "running"


def test_update_task_stopped(tm):
    """停止任务会设置 stopped_at"""
    task = tm.create_task(url="https://live.douyin.com/123")
    tm._update_task_status(task.id, "stopped")
    updated = tm.get_task(task.id)
    assert updated.status == "stopped"
    assert updated.stopped_at is not None


def test_update_task_name(tm):
    """更新任务名称"""
    task = tm.create_task(url="https://live.douyin.com/123")
    tm._update_task_name(task.id, "主播小花")
    updated = tm.get_task(task.id)
    assert updated.name == "主播小花"


def test_recover_running_tasks(tmp_path):
    """重启后 running 状态恢复为 stopped"""
    db_path = str(tmp_path / "test_tasks.db")
    tm1 = TaskManager(db_path=db_path)
    task = tm1.create_task(url="https://live.douyin.com/123")
    tm1._update_task_status(task.id, "running")

    # 模拟重启
    tm2 = TaskManager(db_path=db_path)
    recovered = tm2.get_task(task.id)
    assert recovered.status == "stopped"


def test_preview_control(tm):
    """预览控制"""
    assert tm.get_preview_task_id() is None
    tm.set_preview(1)
    assert tm.get_preview_task_id() == 1
    tm.set_preview(None)
    assert tm.get_preview_task_id() is None


def test_preview_frame_no_worker(tm):
    """没有 worker 时预览帧为 None"""
    tm.set_preview(999)
    assert tm.get_preview_frame() is None


def test_start_nonexistent_task(tm):
    """启动不存在的任务"""
    with pytest.raises(ValueError, match="不存在"):
        tm.start_task(999)


def test_broadcast(tm):
    """日志广播"""
    q = tm.add_log_queue()
    tm.broadcast("测试消息", task_name="测试")
    line = q.get_nowait()
    assert "[测试]" in line
    assert "测试消息" in line
    tm.remove_log_queue(q)


def test_log_queue_full(tm):
    """日志队列满时不阻塞"""
    import queue
    q = queue.Queue(maxsize=1)
    tm._log_queues.append((q, None))
    q.put("占位")
    # 应该不会阻塞
    tm.broadcast("第二条消息")
    # 满的队列会被移除
    assert all(stored_q is not q for stored_q, _ in tm._log_queues)


# ── 本地视频任务测试 ──────────────────────────────────────────


def test_create_local_task(tm, tmp_path):
    """创建本地视频任务"""
    video = tmp_path / "test.mp4"
    video.touch()
    task = tm.create_local_task(video_path=str(video), task_type="portrait")
    assert task.id is not None
    assert task.task_type == "portrait"
    assert task.status == "pending"
    assert task.name == "test"
    assert task.progress == 0.0


def test_create_local_task_highlight(tm, tmp_path):
    """创建高能时刻任务"""
    video = tmp_path / "test.mp4"
    video.touch()
    task = tm.create_local_task(video_path=str(video), task_type="highlight", name="我的视频")
    assert task.task_type == "highlight"
    assert task.name == "我的视频"


def test_create_local_task_file_not_found(tm):
    """文件不存在时创建失败"""
    with pytest.raises(FileNotFoundError, match="文件不存在"):
        tm.create_local_task(video_path="/nonexistent/video.mp4")


def test_list_local_tasks(tm, tmp_path):
    """列出本地任务"""
    v1 = tmp_path / "a.mp4"
    v2 = tmp_path / "b.mp4"
    v1.touch()
    v2.touch()
    tm.create_local_task(video_path=str(v1))
    tm.create_local_task(video_path=str(v2))
    tasks = tm.list_local_tasks()
    assert len(tasks) == 2


def test_get_local_task(tm, tmp_path):
    """获取单个本地任务"""
    video = tmp_path / "test.mp4"
    video.touch()
    created = tm.create_local_task(video_path=str(video))
    task = tm.get_local_task(created.id)
    assert task is not None
    assert task.name == "test"


def test_get_local_task_not_found(tm):
    """获取不存在的本地任务"""
    assert tm.get_local_task(999) is None


def test_delete_local_task(tm, tmp_path):
    """删除本地任务"""
    video = tmp_path / "test.mp4"
    video.touch()
    task = tm.create_local_task(video_path=str(video))
    assert tm.delete_local_task(task.id) is True
    assert tm.get_local_task(task.id) is None


def test_delete_local_task_not_found(tm):
    """删除不存在的本地任务"""
    assert tm.delete_local_task(999) is False


def test_delete_running_local_task(tm, tmp_path):
    """不能删除运行中的本地任务"""
    video = tmp_path / "test.mp4"
    video.touch()
    task = tm.create_local_task(video_path=str(video))
    tm._update_local_task(task.id, status="running")
    assert tm.delete_local_task(task.id) is False


def test_update_local_task(tm, tmp_path):
    """更新本地任务字段"""
    video = tmp_path / "test.mp4"
    video.touch()
    task = tm.create_local_task(video_path=str(video))
    tm._update_local_task(task.id, progress=50.0, progress_text="帧处理: 500/1000")
    updated = tm.get_local_task(task.id)
    assert updated.progress == 50.0
    assert updated.progress_text == "帧处理: 500/1000"


def test_start_nonexistent_local_task(tm):
    """启动不存在的本地任务"""
    with pytest.raises(ValueError, match="不存在"):
        tm.start_local_task(999)


def test_recover_running_local_tasks(tmp_path):
    """重启后 running 状态的本地任务恢复为 error"""
    db_path = str(tmp_path / "test_tasks.db")
    video = tmp_path / "test.mp4"
    video.touch()

    tm1 = TaskManager(db_path=db_path)
    task = tm1.create_local_task(video_path=str(video))
    tm1._update_local_task(task.id, status="running")

    # 模拟重启
    tm2 = TaskManager(db_path=db_path)
    recovered = tm2.get_local_task(task.id)
    assert recovered.status == "error"
    assert recovered.error_msg == "服务重启，任务中断"


# ── 定时调度测试 ──────────────────────────────────────────


def test_create_task_with_schedule(tm):
    """创建带调度的任务，验证字段存储"""
    task = tm.create_task(
        url="https://live.douyin.com/123",
        schedule_enabled=True,
        schedule_timezone="Asia/Tokyo",
        schedule_start="20:00",
        schedule_stop="02:00",
    )
    assert task.schedule_enabled is True
    assert task.schedule_timezone == "Asia/Tokyo"
    assert task.schedule_start == "20:00"
    assert task.schedule_stop == "02:00"

    # 从 DB 重新读取验证持久化
    loaded = tm.get_task(task.id)
    assert loaded.schedule_enabled is True
    assert loaded.schedule_timezone == "Asia/Tokyo"
    assert loaded.schedule_start == "20:00"
    assert loaded.schedule_stop == "02:00"


def test_create_task_schedule_defaults(tm):
    """创建任务时调度字段默认值"""
    task = tm.create_task(url="https://live.douyin.com/123")
    assert task.schedule_enabled is False
    assert task.schedule_timezone == "Asia/Shanghai"
    assert task.schedule_start == "00:00"
    assert task.schedule_stop == "23:59"


def test_is_in_schedule_disabled(tm):
    """schedule_enabled=False 时始终返回 True"""
    task = tm.create_task(
        url="https://live.douyin.com/123",
        schedule_enabled=False,
        schedule_start="09:00",
        schedule_stop="18:00",
    )
    assert TaskManager._is_in_schedule(task) is True


def test_is_in_schedule_same_day(tm):
    """同日窗口 (09:00~18:00)"""
    task = tm.create_task(
        url="https://live.douyin.com/123",
        schedule_enabled=True,
        schedule_timezone="Asia/Shanghai",
        schedule_start="09:00",
        schedule_stop="18:00",
    )
    # 模拟 14:00 — 在窗口内
    mock_dt = datetime(2026, 2, 26, 14, 0, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    with patch("src.task_manager.datetime") as mock_datetime:
        mock_datetime.now.return_value = mock_dt
        mock_datetime.side_effect = lambda *a, **kw: datetime(*a, **kw)
        assert TaskManager._is_in_schedule(task) is True

    # 模拟 06:00 — 在窗口外
    mock_dt = datetime(2026, 2, 26, 6, 0, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    with patch("src.task_manager.datetime") as mock_datetime:
        mock_datetime.now.return_value = mock_dt
        mock_datetime.side_effect = lambda *a, **kw: datetime(*a, **kw)
        assert TaskManager._is_in_schedule(task) is False

    # 模拟 20:00 — 在窗口外
    mock_dt = datetime(2026, 2, 26, 20, 0, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    with patch("src.task_manager.datetime") as mock_datetime:
        mock_datetime.now.return_value = mock_dt
        mock_datetime.side_effect = lambda *a, **kw: datetime(*a, **kw)
        assert TaskManager._is_in_schedule(task) is False


def test_is_in_schedule_cross_midnight(tm):
    """跨午夜窗口 (22:00~03:00)"""
    task = tm.create_task(
        url="https://live.douyin.com/123",
        schedule_enabled=True,
        schedule_timezone="Asia/Shanghai",
        schedule_start="22:00",
        schedule_stop="03:00",
    )
    # 模拟 23:00 — 在窗口内
    mock_dt = datetime(2026, 2, 26, 23, 0, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    with patch("src.task_manager.datetime") as mock_datetime:
        mock_datetime.now.return_value = mock_dt
        mock_datetime.side_effect = lambda *a, **kw: datetime(*a, **kw)
        assert TaskManager._is_in_schedule(task) is True

    # 模拟 01:00 — 在窗口内
    mock_dt = datetime(2026, 2, 27, 1, 0, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    with patch("src.task_manager.datetime") as mock_datetime:
        mock_datetime.now.return_value = mock_dt
        mock_datetime.side_effect = lambda *a, **kw: datetime(*a, **kw)
        assert TaskManager._is_in_schedule(task) is True

    # 模拟 10:00 — 在窗口外
    mock_dt = datetime(2026, 2, 26, 10, 0, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    with patch("src.task_manager.datetime") as mock_datetime:
        mock_datetime.now.return_value = mock_dt
        mock_datetime.side_effect = lambda *a, **kw: datetime(*a, **kw)
        assert TaskManager._is_in_schedule(task) is False


# ── _is_rec_log 过滤测试 ──────────────────────────────────────────────────────

def test_is_rec_log_dlr():
    assert TaskManager._is_rec_log("[DLR] 直播录制完成") is True

def test_is_rec_log_danmu():
    assert TaskManager._is_rec_log("[弹幕] 断线重连") is True

def test_is_rec_log_detect():
    assert TaskManager._is_rec_log("[检测] 立刻检查直播状态...") is True

def test_is_rec_log_schedule():
    assert TaskManager._is_rec_log("[定时] 当前不在窗口") is True

def test_is_rec_log_stream_title():
    assert TaskManager._is_rec_log("直播标题: 测试直播") is True

def test_is_rec_log_stream_info():
    assert TaskManager._is_rec_log("流信息: 1920x1080") is True

def test_is_rec_log_device_info():
    assert TaskManager._is_rec_log("直播设备: iPhone") is True

def test_is_rec_log_unrelated():
    """普通主播名/状态日志不写入录制日志"""
    assert TaskManager._is_rec_log("主播名: 一勺小苏打") is False
    assert TaskManager._is_rec_log("已启用: 录制, 弹幕") is False
    assert TaskManager._is_rec_log("URL: https://live.douyin.com/123") is False


# ── broadcast 双层日志写入测试 ─────────────────────────────────────────────────

def test_broadcast_writes_server_log(tm, tmp_path):
    """broadcast 写入服务器日志（全量）"""
    from src.task_manager import TaskWorker
    task = tm.create_task(url="https://live.douyin.com/123")
    log_file = tmp_path / "server.log"
    worker = TaskWorker(log_file=log_file)
    tm._workers[task.id] = worker

    tm.broadcast("主播名: 测试", task_name="测试", task_id=task.id)
    assert log_file.exists()
    assert "主播名: 测试" in log_file.read_text()


def test_broadcast_rec_log_only_rec_messages(tm, tmp_path):
    """rec_log_file 只写录制相关消息，不写普通启动日志"""
    from src.task_manager import TaskWorker
    task = tm.create_task(url="https://live.douyin.com/123")
    server_log = tmp_path / "server.log"
    rec_log = tmp_path / "rec.log"
    worker = TaskWorker(log_file=server_log, rec_log_file=rec_log)
    tm._workers[task.id] = worker

    tm.broadcast("主播名: 测试", task_name="测试", task_id=task.id)
    tm.broadcast("[DLR] 直播录制完成", task_name="测试", task_id=task.id)
    tm.broadcast("[弹幕] 断线重连", task_name="测试", task_id=task.id)

    server_content = server_log.read_text()
    rec_content = rec_log.read_text()

    assert "主播名: 测试" in server_content
    assert "[DLR] 直播录制完成" in server_content
    assert "[弹幕] 断线重连" in server_content
    assert "主播名: 测试" not in rec_content
    assert "[DLR] 直播录制完成" in rec_content
    assert "[弹幕] 断线重连" in rec_content
