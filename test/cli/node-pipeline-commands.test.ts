/**
 * node-pipeline-commands.test.ts — `_node-pipeline` 的数据根解析(自审发现的线上缺陷)。
 *
 * 缺陷:master 经 ssh 调 `_node-pipeline <dataRoot> <b64>` 时**不设** `DOUYIN_REC_ROOT` env
 * (只有 systemd 的 `Environment=` 为空、ssh 非登录 shell)。此时 `applyNodeDataRoot` 曾写成
 * `process.env.DOUYIN_REC_ROOT = drecRoot()`,而 `drecRoot()` 在 env 为空时回落**默认根
 * `./output-data`** —— 于是节点侧把数据根错设成 `<cwd>/output-data`:
 *   ① 产物落到 `<cwd>/output-data/stage` 而非 `<root>/stage`;
 *   ② 限流库 `<cwd>/output-data/db/douyin-rec.db` 父目录不存在 → sqlite 打不开 →
 *      UploadGate fail-closed 静默冷却 30 分钟才尝试上传(线上实测整场「卡住」)。
 * 修复:入参 dataRoot 才是权威,直接写进 env(绝对化)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyNodeDataRoot } from "../../packages/cli/src/node-pipeline-commands.js";

const original = process.env.DOUYIN_REC_ROOT;
afterEach(() => {
  if (original === undefined) delete process.env.DOUYIN_REC_ROOT;
  else process.env.DOUYIN_REC_ROOT = original;
});

describe("applyNodeDataRoot", () => {
  it("env 为空 + 显式 dataRoot → env 设为该 dataRoot(不是默认 ./output-data)", async () => {
    delete process.env.DOUYIN_REC_ROOT;
    const root = join(tmpdir(), "drec-node-root");
    await applyNodeDataRoot(root);
    expect(process.env.DOUYIN_REC_ROOT).toBe(root);
  });

  it("相对 dataRoot → 绝对化(避免随 cwd 漂移)", async () => {
    delete process.env.DOUYIN_REC_ROOT;
    await applyNodeDataRoot("relative-root");
    expect(process.env.DOUYIN_REC_ROOT!.startsWith("/")).toBe(true);
    expect(process.env.DOUYIN_REC_ROOT!.endsWith("relative-root")).toBe(true);
  });

  it("env 已指向同一 dataRoot → 保持不变(幂等)", async () => {
    const root = join(tmpdir(), "drec-same-root");
    process.env.DOUYIN_REC_ROOT = root;
    await applyNodeDataRoot(root);
    expect(process.env.DOUYIN_REC_ROOT).toBe(root);
  });
});

/**
 * `readNodeResult` 是 `_node-result` 的核心:文件不存在/损坏 → null(master 按确认没成处理)。
 * 命令层始终 exit 0(见 node-pipeline-commands.ts),这里只钉住「无文件 → null」这一条,
 * 保证 master 的 `transport.nodeResult` 在旧/空节点上拿到 null 而不是异常。
 */
describe("_node-result 读结果文件的空态", () => {
  it("stage 子目录不存在 → null(而非抛错)", async () => {
    const { readNodeResult } = await import("../../packages/app/src/node-pipeline.js");
    const { sanitizeStreamKey } = await import("@drec/core");
    const missing = join(tmpdir(), "no-such-root-98765", sanitizeStreamKey("douyin:1:2026-10-12"));
    expect(readNodeResult(missing)).toBeNull();
  });
});

/**
 * issue #2 A2:`_node-abort <dataRoot> <streamKey>` 命令的**注册/契约**(不触发 action 体)。
 *
 * action 体 `import("@drec/app")` 在 vitest 下不可解析(平台包 ESM 坑,见 AGENTS.md),故这里只钉
 * 命令**确实挂上、参数签名与 hidden 正确、且带 action** —— 这是 master 经 ssh 调用能否命中命令的前提。
 * 终止逻辑本身(`abortNodeExecutor` 安全杀进程/cmdline 校验)在 app 侧单测覆盖(见 node-pipeline.test.ts)。
 */
import { Command } from "commander";
import { registerNodePipelineCommands } from "../../packages/cli/src/node-pipeline-commands.js";

describe("_node-abort 命令注册(issue #2 A2)", () => {
  it("注册后存在 _node-abort,参数 <dataRoot> <streamKey> 必填、hidden、带 action", () => {
    const program = new Command();
    registerNodePipelineCommands(program);
    const cmd = program.commands.find((c) => c.name() === "_node-abort");
    expect(cmd, "`_node-abort` 未注册(master 的 ssh 调用会 unknown command)").toBeDefined();
    expect(cmd!.registeredArguments.map((a) => a.name())).toEqual(["dataRoot", "streamKey"]);
    expect(cmd!.registeredArguments.map((a) => a.required)).toEqual([true, true]);
    expect(cmd!._hidden).toBe(true); // 隐藏命令:不在 --help 出现
    // 必须有 .action 处理器,否则命令注册了也什么都不做(静默失败)。
    expect((cmd as unknown as { _actionHandler?: unknown })._actionHandler).toBeTypeOf("function");
  });

  it("既有节点侧命令仍在(新增 _node-abort 不挤掉 _node-result/_node-pipeline)", () => {
    const program = new Command();
    registerNodePipelineCommands(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(["_node-capabilities", "_node-pipeline", "_node-result", "_node-abort", "_zero-disk-report"]));
  });
});

describe("_zero-disk-report 命令注册(issue #331)", () => {
  it("存在、隐藏、<dataRoot> 必填、带 action(master 的 ssh 轮询依赖它;缺失 = 旧节点语义)", () => {
    const program = new Command();
    registerNodePipelineCommands(program);
    const cmd = program.commands.find((c) => c.name() === "_zero-disk-report");
    expect(cmd, "`_zero-disk-report` 未注册").toBeDefined();
    expect(cmd!.registeredArguments.map((a) => a.name())).toEqual(["dataRoot"]);
    expect(cmd!._hidden).toBe(true);
    expect((cmd as unknown as { _actionHandler?: unknown })._actionHandler).toBeTypeOf("function");
  });
});
