# 为什么引入 DLR 子进程架构能解决 rc=-11 / ByteVC1 问题

## 一句话结论

**代码本身不是问题，执行环境才是。** 把相同的 DLR 代码"复制"进来在 uvicorn 进程内运行，和把 DLR 作为独立子进程运行，**fork 时继承的父进程状态完全不同**，这导致了截然相反的稳定性。

---

## 背景：rc=-11 是什么

`rc=-11` = ffmpeg 以退出码 `-11` 退出 = **SIGSEGV（段错误）**。

ffmpeg 本身非常稳定，通常不会无故崩溃。第二次录制开始时才出现、而第一次正常的现象强烈暗示：**问题来自 ffmpeg 进程创建时继承的父进程状态**，而不是 ffmpeg 本身的 bug。

---

## 根因：fork 在多线程进程中的危险性

### uvicorn 的内部状态

uvicorn 是异步 Web 服务器，启动后内部同时维护：

- asyncio 事件循环线程
- 多个任务 worker 线程（每个录制任务一个）
- Python GIL 及内部锁（import lock、内存分配器锁等）
- 已打开的 socket、文件描述符、日志 handler 的锁

### fork 的问题

`subprocess.Popen` 在 Unix 上通过 `fork()` + `exec()` 创建子进程。

`fork()` 的语义是"**复制调用线程，冻结其他所有线程**"：

```
uvicorn 进程（4 个线程同时运行）
  Thread-1: asyncio loop（正在持有 socket 锁）
  Thread-2: task worker（正在持有日志 handler 锁）
  Thread-3: 正在调用 fork() ← 只有这个线程被复制
  Thread-4: 正在持有 pymalloc 锁

        fork()
          ↓
子进程（只有 Thread-3）
  但 Thread-1 的 socket 锁 ✓ 已锁定，无线程可解锁
  Thread-2 的日志锁 ✓ 已锁定，无线程可解锁
  Thread-4 的 pymalloc 锁 ✓ 已锁定，无线程可解锁
```

子进程中这些锁**永远处于锁定状态，且没有线程去释放它们**。

当 ffmpeg 或 Python 在 `fork` 后 `exec` 之前的短暂窗口期内（或 `preexec_fn` 回调中）尝试：
- 分配内存（触碰 pymalloc 锁）
- 写日志（触碰日志 handler 锁）
- 初始化信号处理

就会**死锁 → 操作系统强制终止 → SIGSEGV**。

### 为什么第一次不崩、第二次崩

第一次：uvicorn 刚启动，线程少、锁争用低，`fork()` 恰好命中锁空闲的时间窗口。
第二次及之后：多个 worker 线程已经在跑，各种锁持有时间变长，`fork()` 越来越容易在锁被持有时发生。

这也解释了为什么加了 `preexec_fn`（重置信号）**无法根治**：信号重置没有解决锁继承问题，只是修了一个症状。

---

## 为什么 DLR 子进程架构解决了这个问题

### 架构对比

| | 旧架构（复制 DLR 代码） | 新架构（DLR 子进程） |
|---|---|---|
| DLR 代码在哪里运行 | uvicorn 进程内（同一个 Python 进程） | 独立的新 Python 进程 |
| ffmpeg 的父进程 | uvicorn（多线程、有锁） | DLR 子进程（单线程、干净） |
| fork 时继承的锁 | uvicorn 全部线程锁 | 无（exec 出来的新进程） |
| 进程组隔离 | 无 | `start_new_session=True` |

### 关键区别

```
旧架构：
uvicorn → fork() → ffmpeg
         ↑ 继承 uvicorn 的全部锁状态

新架构：
uvicorn → Popen(start_new_session=True) → DLR 新 Python 进程
                                               ↓
                                          DLR → fork() → ffmpeg
                                               ↑ DLR 进程是单线程干净状态
```

`Popen` 启动 DLR 时，操作系统执行的是 `fork()` + `execve(python)`。
`execve` 会**完全替换进程映像**——所有继承的锁、文件描述符、内存分配器状态全部清零，换成一个全新的 Python 解释器。

DLR 在这个干净的进程里启动后，再去 `fork()` + `exec()` ffmpeg 时，没有任何多线程锁的包袱，ffmpeg 稳定启动。

---

## ByteVC1 问题的根因

ByteVC1（`codec=bytevc1`）是字节跳动自研的私有视频编解码器，**标准 ffmpeg 不支持**。

### 旧架构的问题

旧架构自己实现了流地址选择逻辑（`src/input/live.py` + `src/dlr/spider.py`），需要：
1. 从抖音 API 拿到所有可用流 URL
2. 解析每个 URL 的 codec 参数
3. 过滤掉 ByteVC1，选 H.264/H.265

这套逻辑迭代了十几个版本（见 git log），仍然有边界情况漏网：
- 某些 URL 路径（`/third/`、`/or4/`、`/stage/`）不带 `codec=` 参数
- CDN 返回的 URL 在实际请求时动态路由到 ByteVC1 节点
- `hevc_supported=true` 参数触发服务端返回 ByteVC1 变体

每次修复一个路径，新的漏网情况又出现，最终形成了大量脆弱的启发式判断代码。

### 新架构的解法

DLR 自己内部实现了成熟的流选择逻辑，经过更大规模的用户验证。我们通过 `config.ini` 直接告诉 DLR 想要的画质，DLR 负责所有流 URL 选择细节。

我们不再需要理解抖音流 URL 的内部格式，这部分逻辑交给专门维护它的 DLR 项目。

---

## 总结

| 问题 | 根因 | 旧修复方式 | 为什么没用 | 新架构的解法 |
|---|---|---|---|---|
| rc=-11 SIGSEGV | fork 继承多线程锁 | preexec_fn 重置信号 | 只重置了信号，没解决锁 | DLR 从干净进程 fork ffmpeg |
| ByteVC1 崩溃 | 自有流选择逻辑有盲区 | 不断添加 codec 检测启发式 | 抖音 URL 格式不固定 | 将流选择完全委托给 DLR |

两个问题的共同教训：**在别人已经解决的领域重新造轮子，会反复踩已知的坑。**
