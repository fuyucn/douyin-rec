/**
 * web/api/login.ts — 扫码登录(QR)会话启停
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildLogin(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import type { LoginManagerLike } from "./types.js";

export function buildLogin(ctx: ApiCtx) {
  const { deps, err } = ctx;
  const login = deps.login;
  return {
    async startLogin(input: { platform?: string } = {}): Promise<ApiResult> {
      if (!login) {
        return err(501, "扫码登录不可用（请用手动 cookie）");
      }
      const platform = (input.platform ?? "douyin").trim() || "douyin";
      if (platform !== "douyin" && platform !== "bilibili" && platform !== "kuaishou") return err(400, `平台不支持扫码登录: ${platform}`);
      try {
        const { sessionId, qrPng } = await login.start(platform);
        return { status: 200, body: { sessionId, qrPng } };
      } catch (e) {
        return err(500, `启动扫码登录失败: ${(e as Error).message}`);
      }
    },

    async pollLogin(sessionId: string): Promise<ApiResult> {
      if (!login) {
        return err(501, "扫码登录不可用（请用手动 cookie）");
      }
      const r = await login.poll(sessionId);
      if (r.state === "unknown") return err(404, `未找到登录会话: ${sessionId}`);
      // The manager already persisted the cookie to the platform settings on
      // confirmed; we do NOT surface the raw cookie here (privacy). The UI just
      // refreshes GET /api/cookie to see the new status.
      return { status: 200, body: { state: r.state } };
    },
  };
}
