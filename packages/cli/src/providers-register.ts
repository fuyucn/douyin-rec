/**
 * providers-register.ts — 注册内置平台 + 下载引擎(副作用模块)。
 *
 * 由 CLI 入口 `import "./providers-register.js"` 触发。集中在这里拉入具体实现,使
 * core 注册表(engine/platform)保持纯净、可测。
 *
 * - 平台:接第二平台 = 写 <平台>-core 实现 Platform + 在此 registerPlatform 一行。
 * - 引擎:ffmpeg / mesio 两个通用下载引擎(@drec/record-engine);录制器 = 通用
 *   PollingRecorder + 选中的 engine(见 cli.ts / cli-task.ts)。
 *
 * 弹幕已收进 Platform.connectDanmu,不再有弹幕 provider 注册。
 * 原「每平台 × ffmpeg/mesio」4 个录制器 provider 已删,收敛为引擎策略。
 */
import { registerEngine, registerPlatform, registerProcessor } from "@drec/core";
import { douyinPlatform } from "@drec/douyin-live";
import { bilibiliPlatform } from "@drec/bilibili-live";
import { kuaishouPlatform } from "@drec/kuaishou-live";
import { ffmpegEngine, mesioEngine } from "@drec/record-engine";
import { existsSync } from "node:fs";
import { makeBiliupProcessor, remuxProcessor, uploadPrepProcessor } from "@drec/processors";
import { openNodeUploadGate, resolveUploadAccountKey, rootBiliupCookies } from "@drec/app";

// ── 平台 ────────────────────────────────────────────────────────────────────
// 接第二平台:写 <平台>-core 实现 Platform + 在此 registerPlatform 一行。
registerPlatform(douyinPlatform, { default: true });
registerPlatform(bilibiliPlatform); // bilibili
registerPlatform(kuaishouPlatform); // 快手(取流 = 直播页 __INITIAL_STATE__;无弹幕)

// ── 下载引擎 ──────────────────────────────────────────────────────────────────
// 通用录制器(PollingRecorder)按 task.engine / platform.defaultEngine 选其一。
registerEngine(ffmpegEngine);
registerEngine(mesioEngine);

// ── 后处理处理器 ──────────────────────────────────────────────────────────────
// 加处理器 = `@drec/processors` 里一个模块 + 此处一行(与上面 registerPlatform / registerEngine 并列)。
registerProcessor(remuxProcessor);
registerProcessor(uploadPrepProcessor);
// biliup on a node: same account rate-limit gate and local cookies as the blocking node pipeline (plan 038 T15b).
// One gate per process: the runner lives in the long-running serve process, so a gate per job would leak a
// sqlite handle per upload (the gate exposes no close); the store itself serialises across processes.
let nodeUploadGate: ReturnType<typeof openNodeUploadGate> | undefined;
registerProcessor(makeBiliupProcessor({
  gate: () => (nodeUploadGate ??= openNodeUploadGate()),
  accountKey: resolveUploadAccountKey,
  localCookies: () => {
    const local = process.env.BILIUP_COOKIE ?? rootBiliupCookies();
    return existsSync(local) ? local : null;
  },
}));

// ── 弹幕 ──────────────────────────────────────────────────────────────────────
// 弹幕不再走「按名查 provider」注册表 —— 已收进 Platform.connectDanmu()(抖音见 @drec/douyin-live
// 的 DouyinDanmuSource);任务只剩 danmu 开关(0/1),来源由命中平台决定。
