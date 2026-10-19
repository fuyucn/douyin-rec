/**
 * timezone.ts — 时区**由 config 决定,不看 host/容器的 TZ 环境变量**。
 *
 * 之前的做法是把时区交给 docker-compose/systemd 的 `Environment: TZ=...` 去设——这有个真实
 * 踩过的坑:host 层的环境变量**很难从进程外部内省**(`ssh vps date` 显示的是 ssh 会话自己的
 * 环境,不是目标服务进程的;得挖 `/proc/<pid>/environ` 才能确认服务实际用的哪个 TZ,曾因此
 * 误判过一次 VPS 时区)。改成 config(sqlite `settings` 表,同 defaultCookies/mesioPath 一路)
 * 驱动后:唯一真理源是这一个设置,`applyTimezone()` 在启动时**显式覆盖** `process.env.TZ`
 * (不管 host 传进来什么),且把最终生效值打进启动日志——一眼可查,不用再挖进程环境。
 *
 * 可行性已验证:Node/V8 的 Date 本地时间转换每次调用都重新看当前 `process.env.TZ`,不是
 * 进程启动时锁定一次——运行期改它,下一次 `new Date().getHours()` 立刻反映新值。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_TITLE_TIMEZONE, isValidTimeZone, resolveTimeZone } from "@drec/core";
import { resolveDbPath } from "./db.js";
import type { TaskStore } from "./store.js";

/**
 * 未配置时的默认时区。**北京时间**(Asia/Shanghai,无夏令时)——项目录的都是国内主播,排期本质上
 * 是按主播的北京时间开播习惯定的;之前默认美西时间(有夏令时)会导致排期在每年 3 月/11 月
 * 悄悄漂移 1 小时(相对主播的真实开播时刻),多节点(docker+VPS)各自按自己 host 时区走还可能
 * 因夏令时切换时机不同步而彼此错开。北京时间常年固定,不会有这些问题。
 */
export const DEFAULT_TIMEZONE = DEFAULT_TITLE_TIMEZONE;

/** 校验是不是一个 Intl 认得的 IANA 时区名(如 "America/Los_Angeles"/"Asia/Shanghai")。 */
export const isValidTimezone = isValidTimeZone;

/** `settings.timezone` → 生效时区(空/非法 → 缺省北京时间)。**不看** process.env.TZ / 宿主机本地时区。 */
export function effectiveTimezone(store: Pick<TaskStore, "getSetting">): string {
  return resolveTimeZone(store.getSetting("timezone"));
}

/**
 * 从 `settings.timezone` 读时区并**立即应用**(`process.env.TZ = 解析结果`,覆盖 host/容器原有值)。
 * 未设置 → 用 {@link DEFAULT_TIMEZONE}。设置了但不是合法 IANA 时区名 → 警告 + 回落默认(不让一个
 * 打错的值悄悄让所有 schedule 窗口/日志时间戳都算错)。
 * 返回最终生效的时区名,供调用方打日志(`task serve` 启动时输出,一眼可查当前用的是哪个)。
 */
export function applyTimezone(store: TaskStore): string {
  const configured = (store.getSetting("timezone") ?? "").trim();
  let tz = DEFAULT_TIMEZONE;
  if (configured) {
    if (isValidTimezone(configured)) tz = configured;
    else console.warn(`[tz] settings.timezone="${configured}" 不是合法 IANA 时区名,回落默认 ${DEFAULT_TIMEZONE}`);
  }
  process.env.TZ = tz;
  return tz;
}

/**
 * 独立 CLI 入口(record / merge / burn / upload 等不经 `task serve` 的命令)用:
 * 只读打开数据库取 `settings.timezone`,写进 `process.env.TZ`(与 {@link applyTimezone} 同一口径)。
 * 不走 `TaskStore`(会跑迁移、写库);库存在但没有该设置 → 缺省北京时间;库不存在 / 读库失败 → 保留继承的有效 TZ,否则北京;不抛错(issue #158)。
 * 子进程由 `serve` 拉起时库里的值与继承的 env 一致,这里只是幂等地再设一遍。
 */
export function applyTimezoneFromDb(dbPath: string = resolveDbPath()): string {
  let configured: string | null = null;
  let readFailed = false;
  try {
    if (!existsSync(dbPath)) {
      readFailed = true; // 库不存在(如 serve 以自定义 --db 起、子进程找不到库;或 ssh 会话无 env)→ 同样保留继承的有效 TZ
    } else {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value?: string } | undefined;
        configured = row?.value ?? null;
      } finally {
        db.close();
      }
    }
  } catch {
    readFailed = true; // 无 settings 表 / 被锁 / 损坏
  }
  // 无库 / 读失败时保留已继承的有效 TZ(serve 拉起子进程时 env 已是设置值);库在但没设该项 → 缺省北京。
  const tz = readFailed && isValidTimeZone(process.env.TZ ?? "") ? process.env.TZ! : resolveTimeZone(configured);
  process.env.TZ = tz;
  return tz;
}

/** 带 `<dataRoot>` 参数的隐藏命令(`_inventory` 等)读的库:`<dataRoot>/db/douyin-rec.db`(与命令本体同一路径,不看 cwd/env 默认根)。 */
export function dbPathForDataRoot(dataRoot: string): string {
  return join(dataRoot, "db", "douyin-rec.db");
}

/**
 * hub 台账库路径:`<db>` → `<db>-sync.db`。与 serve 侧同一推导(`resolveDbPath(...).replace`),
 * 抽成函数免得两处漂移 —— 写错会让 0 落盘的上传结果记到另一个库、UI 永远看不到。
 */
export function syncDbPathFor(dbPath: string): string {
  return dbPath.replace(/\.db$/, "-sync.db");
}
