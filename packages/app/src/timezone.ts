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
import type { TaskStore } from "./store.js";

/**
 * 未配置时的默认时区。**北京时间**(Asia/Shanghai,无夏令时)——项目录的都是国内主播,排期本质上
 * 是按主播的北京时间开播习惯定的;之前默认美西时间(有夏令时)会导致排期在每年 3 月/11 月
 * 悄悄漂移 1 小时(相对主播的真实开播时刻),多节点(docker+VPS)各自按自己 host 时区走还可能
 * 因夏令时切换时机不同步而彼此错开。北京时间常年固定,不会有这些问题。
 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** 校验是不是一个 Intl 认得的 IANA 时区名(如 "America/Los_Angeles"/"Asia/Shanghai")。 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
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
