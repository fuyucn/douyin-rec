/**
 * 0 落盘路径必须注册 SIGUSR2 handler —— 源码守护(P1 回归)。
 *
 * 事故:0 落盘分支(此前在 `cli record --stream-upload` 里)只注册了 SIGINT/SIGTERM。
 * daemon 窗口结束发的是 SIGUSR2,Node 对无人处理的 SIGUSR2 的默认动作是**立即终止进程**,
 * 于是:①在录的那一段被腰斩,`--stream-upload-spool none` 下没有本地副本,视频永久丢失;
 * ②`ChildRecorderProcess.stopGraceful` 在发信号**前**就置 `expected=true`,task 日志因此打印
 * 「直播自然收播,排空完成,已停止」—— 一句与事实相反的话,用户据此认为没丢片。
 *
 * 为什么用 grep 守护而不是只靠行为用例:行为用例在真子进程里(见 live-pump.test.ts 的
 * 「真子进程」describe),覆盖的是信号语义;但「CLI 那边到底有没有把 handler 装上」
 * 只能靠读源码 —— 删掉那一行,子进程测试仍然全绿。这正是历史上反复出问题的形状。
 *
 * 判定:0 落盘分支的源码里必须同时出现
 *   `process.on("SIGUSR2"` 与 `drainSignal`
 * 且两者都落在 `stream-upload` 相关代码块内。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = "packages/cli/src/cli.ts";

/** 取 `--stream-upload` 分支:从 streamUploadEnabled 的启用点取到该分支的 `return`。 */
function zeroDiskSection(src: string): string {
  const start = src.indexOf("streamUploadEnabled) {");
  if (start < 0) throw new Error("0 落盘分支锚点消失:`streamUploadEnabled) {`");
  const end = src.indexOf("\n      return;\n", start);
  if (end < 0) throw new Error("0 落盘分支的 `return` 消失(drain handler 可能被挪出了分支)");
  return src.slice(start, end);
}

describe("0 落盘路径必须注册 SIGUSR2(P1 源码守护)", () => {
  const src = readFileSync(join(ROOT, CLI), "utf-8");
  const section = zeroDiskSection(src);

  it("分支内注册了 SIGUSR2 handler", () => {
    expect(section).toContain('process.on("SIGUSR2"');
  });

  it("分支内把 drain 信号传给了 pump(handler 不是空转)", () => {
    expect(section).toContain("drainSignal:");
  });

  it("0 落盘分支必须留在进程内等开播,且等待中被停止不算失败(issue #308)", () => {
    // The pump waits in-process and only returns `idle` on a requested stop. Exiting non-zero for
    // it made TaskManager restart the task in a loop; the only failures are `ok:false` runs.
    expect(section).toContain("waitForBroadcast: true");
    expect(section).toContain('res.outcome !== "no-stream"'); // backstop (review #280 P1)
    expect(section).not.toMatch(/outcome === "idle"[^\n]*process\.exit\(1\)/);
  });

  it("排空/停止在日志里留痕(不留痕 = 与卡死无法区分)", () => {
    expect(section).toMatch(/停止录制并中止当前分 P/);
  });

  it("分支内 SIGUSR2 与其他信号用不同信号量(排空 ≠ 硬停)", () => {
    // SIGINT/SIGTERM → abort(腰斩在录段);SIGUSR2 → drain(传完当前段)。
    // 若三者共用一个 AbortController,排空就变成硬停。
    const sigusr2 = section.slice(section.indexOf('process.on("SIGUSR2"'));
    const block = sigusr2.slice(0, sigusr2.indexOf(");") + 2);
    expect(block).toMatch(/drain/);
    expect(block).not.toMatch(/abort\.abort\(\)/);
  });
});
