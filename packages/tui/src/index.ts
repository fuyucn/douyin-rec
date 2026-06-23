/**
 * tui/index.ts — 启动 Ink TUI。由 `task tui` 命令按需 import（ink/react 是 esbuild
 * external，运行时从 node_modules 解析；故 TUI 只在 host 上跑，docker serve 不受影响）。
 */
import { render } from "ink";
import { createElement } from "react";
import { App } from "./App.js";
import { TuiApi } from "./api.js";

export async function launchTui(opts: { api: string }): Promise<void> {
  // Ink 需要交互式 TTY（raw mode）。非 TTY（管道/CI/后台）下给一句干净提示，不抛 Ink 堆栈。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("[tui] 需在交互式终端(TTY)里运行：node dist/douyin-rec.mjs task tui");
    process.exitCode = 1;
    return;
  }
  const api = new TuiApi(opts.api);
  if (!(await api.ping())) {
    console.error(
      `[tui] ⚠ 暂时连不上 serve: ${opts.api}\n` +
        `    先在另一个终端/容器启动：node dist/douyin-rec.mjs task serve --port 7860\n` +
        `    （界面仍会打开，连上后自动显示任务）`,
    );
  }
  const { waitUntilExit } = render(createElement(App, { api, apiBase: opts.api }));
  await waitUntilExit();
}
