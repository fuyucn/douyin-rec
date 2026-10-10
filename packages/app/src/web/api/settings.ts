/**
 * web/api/settings.ts — 全局设置:webhook / 通知开关 / mesio / 抖音 API 模式 / 时区 / 版本
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildSettings(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { APP_VERSION } from "../../version.js";
import { resolveMesioBin } from "@drec/record-engine";
import { DOUYIN_API_MODES, DEFAULT_DOUYIN_API_MODE, normalizeDouyinApiMode } from "@drec/core";
import { applyTimezone, isValidTimezone, DEFAULT_TIMEZONE } from "../../timezone.js";
import type { NotifWebhookToggles } from "@drec/observability";
import { resolveWebhookToggles, DEFAULT_WEBHOOK_TOGGLES } from "@drec/observability";
import { readResources, writeResources, validateResources, DEFAULT_HUB_RESOURCES, type HubResources } from "../../hub-config-store.js";

export function buildSettings(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, hubConfigPath,
    err } = ctx;
  return {
    /**
     * GET /api/hub/resources —— 资源闸门当前生效值(T15)。
     *
     * 回 `source` 让 UI 知道「改完会写去哪」:arg-file/root-file 写文件、settings 写 settings 表、
     * inline 无法持久化(此时 PUT 直接 400,而不是假装保存成功)。
     */
    getHubResources(): ApiResult {
      const resolved = deps.hubConfigSource?.();
      if (!resolved) return err(400, "hub 未启用或未配置");
      return {
        status: 200,
        body: {
          resources: readResources(resolved.path ?? hubConfigPath),
          source: resolved.source,
          path: resolved.path ?? null,
          defaults: DEFAULT_HUB_RESOURCES,
        },
      };
    },

    /**
     * PUT /api/hub/resources —— 改并行度等,**立即生效**(ResourcePool 每轮热读,无需重启)。
     *
     * 写回按 source 分派:
     *   - arg-file / root-file → 原子写那个文件(只覆盖 resources 键,workers 等原样保留)
     *   - settings            → 写回 settings 表的 hubConfig(保留其中其它键)
     *   - inline              → 400。**内联配置无法持久化**,假装成功等于骗用户:
     *     重启后配置消失,而他以为生效了。
     */
    putHubResources(patch: Partial<HubResources>): ApiResult {
      const resolved = deps.hubConfigSource?.();
      if (!resolved) return err(400, "hub 未启用或未配置");
      const verr = validateResources(patch ?? {});
      if (verr) return err(400, verr);            // 先校验,不写坏配置
      if (resolved.source === "inline") {
        return err(400, "当前 hub 配置是 --hub-config 内联 JSON,无法持久化修改;请改为配置文件");
      }
      if (resolved.source === "settings") {
        try {
          const cfg = JSON.parse(resolved.json ?? "{}") as Record<string, unknown>;
          cfg.resources = { ...(cfg.resources as object ?? {}), ...patch };
          store.setSetting("hubConfig", JSON.stringify(cfg, null, 2));
        } catch (e) {
          return err(400, `settings 里的 hub 配置不是合法 JSON,拒绝覆写: ${(e as Error).message}`);
        }
      } else {
        if (!resolved.path) return err(400, "无法定位 hub 配置文件");
        writeResources(resolved.path, patch);
      }
      return {
        status: 200,
        body: { resources: readResources(resolved.path ?? hubConfigPath), source: resolved.source },
      };
    },

    getWebhook(): ApiResult {
      // webhook URL 本身是凭证:接口不回显原文,只告知是否已配置(覆盖时整段粘贴新的)。
      const set = (store.getSetting("discordWebhook") ?? "").trim().length > 0;
      return { status: 200, body: { webhook: "", hasWebhook: set } };
    },

    setWebhook(input: { webhook?: string }): ApiResult {
      // 全局 Discord webhook(任务未自带时回落)。空串=清除。注:CLI --discord-webhook / env
      // DISCORD_WEBHOOK 若设置会优先于此(见 cli-task globalHook)。
      store.setSetting("discordWebhook", (input.webhook ?? "").trim());
      const set = (store.getSetting("discordWebhook") ?? "").trim().length > 0;
      return { status: 200, body: { webhook: "", hasWebhook: set } };
    },

    async testWebhook(input: { content?: string }): Promise<ApiResult> {
      // 测试已保存的全局 webhook:用与 DiscordNotifier 相同的 { content } 负载直接 POST。
      const hook = (store.getSetting("discordWebhook") ?? "").trim();
      if (!hook) return err(400, "尚未保存全局 webhook");
      const content = (input.content ?? "").trim() || "douyin-rec test";
      try {
        const r = await fetch(hook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return err(502, `Discord 返回 HTTP ${r.status}`);
        return { status: 200, body: { ok: true, code: r.status } };
      } catch (e) {
        return err(502, `发送失败:${(e as Error).message}`);
      }
    },

    getNotifSettings(): ApiResult {
      return { status: 200, body: resolveWebhookToggles(store.getSetting("notifWebhookToggles")) };
    },

    setNotifSettings(input: Partial<NotifWebhookToggles>): ApiResult {
      const current = resolveWebhookToggles(store.getSetting("notifWebhookToggles"));
      const merged: NotifWebhookToggles = { ...current };
      for (const k of Object.keys(DEFAULT_WEBHOOK_TOGGLES) as Array<keyof NotifWebhookToggles>) {
        if (typeof input[k] === "boolean") merged[k] = input[k]!;
      }
      store.setSetting("notifWebhookToggles", JSON.stringify(merged));
      return { status: 200, body: resolveWebhookToggles(store.getSetting("notifWebhookToggles")) };
    },

    getVersion(): ApiResult {
      return { status: 200, body: { version: APP_VERSION } };
    },

    getMesioPath(): ApiResult {
      // mesioPath = 用户显式覆盖(空=用默认)。default = 留空时引擎实际会用的路径(本机解析:
      // 继承的 MESIO_PATH env > <cwd>/bin/mesio > 裸 mesio),供 UI 占位符提示。
      return {
        status: 200,
        body: { mesioPath: store.getSetting("mesioPath") ?? "", default: resolveMesioBin() },
      };
    },

    setMesioPath(input: { mesioPath?: string }): ApiResult {
      // 空串=清除 → spawn 时不注入 MESIO_PATH → 引擎回落 bin/mesio 默认。改设置下次起录即生效(无需重启)。
      store.setSetting("mesioPath", (input.mesioPath ?? "").trim());
      return {
        status: 200,
        body: { mesioPath: store.getSetting("mesioPath") ?? "", default: resolveMesioBin() },
      };
    },

    getDouyinApiMode(): ApiResult {
      // 空 = 未设置 → 用默认(balance)。UI 用 default 提示当前生效值。
      const raw = (store.getSetting("douyinApiMode") ?? "").trim();
      return {
        status: 200,
        body: { mode: raw, default: DEFAULT_DOUYIN_API_MODE, effective: normalizeDouyinApiMode(raw), options: [...DOUYIN_API_MODES] },
      };
    },

    setDouyinApiMode(input: { mode?: string }): ApiResult {
      // 非法值回落默认(balance),不报错 —— 与 mesioPath 的「宽松存、用时归一」一致。
      const mode = normalizeDouyinApiMode(input.mode);
      // 存归一后的值(而非原样):避免设置里留非法串、UI 回显与生效值不一致。
      store.setSetting("douyinApiMode", mode);
      // 改设置下次 spawn 生效(env 注入,无需重启 serve)。
      return {
        status: 200,
        body: { mode, default: DEFAULT_DOUYIN_API_MODE, effective: mode, options: [...DOUYIN_API_MODES] },
      };
    },

    getTimezone(): ApiResult {
      return {
        status: 200,
        body: { timezone: store.getSetting("timezone") ?? "", default: DEFAULT_TIMEZONE, effective: process.env.TZ ?? "" },
      };
    },

    setTimezone(input: { timezone?: string }): ApiResult {
      const v = (input.timezone ?? "").trim();
      if (v && !isValidTimezone(v)) return err(400, `不是合法的 IANA 时区名: ${v}`);
      store.setSetting("timezone", v);
      // 立即应用(覆盖 process.env.TZ),daemon 下一次 tick 的 schedule 窗口判定即刻用新时区,不用重启。
      const effective = applyTimezone(store);
      return { status: 200, body: { timezone: v, default: DEFAULT_TIMEZONE, effective } };
    },
  };
}
