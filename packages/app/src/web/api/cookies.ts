/**
 * web/api/cookies.ts — 平台 cookie 状态 / 设置 / 清除 + biliup 登录态
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildCookies(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { listPlatforms } from "@drec/core";
import { DEFAULT_COOKIES_KEY } from "../../login/login-manager.js";

export function buildCookies(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, hubConfigPath,
    err, platformCookie, cookieStatus, validCookiePlatform, biliupStatus } = ctx;
  return {
    listCookies(): ApiResult {
      return {
        status: 200,
        body: {
          platforms: listPlatforms().map((p) => {
            const c = platformCookie(p.id);
            return cookieStatus(p.id, c.value, c.source);
          }),
        },
      };
    },

    getCookie(platform = "douyin"): ApiResult {
      if (!validCookiePlatform(platform)) return err(404, `未知平台: ${platform}`);
      const c = platformCookie(platform);
      return { status: 200, body: cookieStatus(platform, c.value, c.source) };
    },

    setCookie(input: { cookie?: string }, platform = "douyin"): ApiResult {
      if (!validCookiePlatform(platform)) return err(404, `未知平台: ${platform}`);
      const cookie = (input.cookie ?? "").trim();
      if (!cookie) return err(400, "cookie 不能为空");
      store.setPlatformCookies(platform, cookie);
      return { status: 200, body: cookieStatus(platform, cookie, "settings") };
    },

    clearCookie(platform = "douyin"): ApiResult {
      if (!validCookiePlatform(platform)) return err(404, `未知平台: ${platform}`);
      store.setPlatformCookies(platform, "");
      const c = platformCookie(platform);
      return { status: 200, body: cookieStatus(platform, c.value, c.source) };
    },

    getBiliupStatus(): ApiResult {
      return { status: 200, body: biliupStatus() };
    },
  };
}
