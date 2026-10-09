/**
 * web/api.ts — HTTP-FREE request handlers for the web UI(**组装点**)。
 *
 * 每个 handler 收已解析的输入(ids / JSON body)返回 `{ status, body }`,不碰 node:http
 * (唯一知道 socket 的是 server.ts)。依赖经 `makeApi({ store, manager })` 注入;manager 走
 * 窄接口 `ManagerLike`,便于用 mock 测试(见 test/app/web-api.test.ts)。
 *
 * ⚠️ **本文件只做组装**(T-22 第 1 步):原 1321 行 / 单函数 909 行 / 53 个方法,现按域拆到
 * `web/api/*.ts`,这里只 buildCtx + 合并各域方法对象。加/改端点请去对应域文件:
 *   tasks.ts(任务 CRUD/启停/平台) · cookies.ts · login.ts · settings.ts · merge.ts
 *   hub-rules.ts · hub-jobs.ts · workers.ts
 * 公共类型在 `web/api/types.ts`,共享辅助在 `web/api/context.ts`。
 */
import { buildCtx } from "./api/context.js";
import { buildTasks } from "./api/tasks.js";
import { buildCookies } from "./api/cookies.js";
import { buildLogin } from "./api/login.js";
import { buildSettings } from "./api/settings.js";
import { buildMerge } from "./api/merge.js";
import { buildHubRules } from "./api/hub-rules.js";
import { buildHubJobs } from "./api/hub-jobs.js";
import { buildWorkers } from "./api/workers.js";
import type { Api, ApiDeps } from "./api/types.js";

// 公共类型/常量 re-export:既有引用(`web/api.js` 的 makeApi / ApiDeps / ManagerLike …)不变。
export type { Api, ApiDeps, ApiResult, ManagerLike, LoginManagerLike, TaskView, TaskDetailView,
  CreateTaskInput, UpdateTaskInput, CookieStatus } from "./api/types.js";
export { DEFAULT_COOKIES_KEY } from "../login/login-manager.js";
// cookie 纯解析工具已下沉到 app/cookie-utils(T-22 第 2 步);这里 re-export 兼容既有引用。
export { parseCookieExpiry } from "../cookie-utils.js";

/** Build the handler set bound to the injected store + manager. */
export function makeApi(deps: ApiDeps): Api {
  const ctx = buildCtx(deps);
  return {
    ...buildTasks(ctx),
    ...buildCookies(ctx),
    ...buildLogin(ctx),
    ...buildSettings(ctx),
    ...buildMerge(ctx),
    ...buildHubRules(ctx),
    ...buildHubJobs(ctx),
    ...buildWorkers(ctx),
  };
}
