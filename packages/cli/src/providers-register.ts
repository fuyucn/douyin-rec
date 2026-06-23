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
import { registerEngine, registerPlatform } from "@drec/core";
import { douyinPlatform } from "@drec/douyin-live";
import { bilibiliPlatform } from "@drec/bilibili-live";
import { ffmpegEngine, mesioEngine } from "@drec/record-engine";

// ── 平台 ────────────────────────────────────────────────────────────────────
// 接第二平台:写 <平台>-core 实现 Platform + 在此 registerPlatform 一行。
registerPlatform(douyinPlatform, { default: true });
registerPlatform(bilibiliPlatform); // bilibili(取流为骨架 stub,见 @drec/bilibili-live)

// ── 下载引擎 ──────────────────────────────────────────────────────────────────
// 通用录制器(PollingRecorder)按 task.engine / platform.defaultEngine 选其一。
registerEngine(ffmpegEngine);
registerEngine(mesioEngine);

// ── 弹幕 ──────────────────────────────────────────────────────────────────────
// 弹幕不再走「按名查 provider」注册表 —— 已收进 Platform.connectDanmu()(抖音见 @drec/douyin-live
// 的 DouyinDanmuSource);任务只剩 danmu 开关(0/1),来源由命中平台决定。
