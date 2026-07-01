/**
 * load-env.ts — 副作用模块:裸跑(非 docker)时,从 `<cwd>/.env` 加载环境变量(如
 * `DOUYIN_REC_ROOT`),让「项目级配置文件」不止 docker(`docker compose` 原生读 `.env`)能用,
 * 本地/VPS 裸跑 `node dist/douyin-rec.mjs ...` 也能用同一份 `.env` 配数据根,不用每次手写
 * `DOUYIN_REC_ROOT=... node dist/...`。
 *
 * **必须是 cli.ts 的第一个 import**:`@drec/app` 的 `DEFAULT_COOKIES` 在模块加载时就读
 * `process.env.DOUYIN_REC_ROOT`(经 `rootBiliupCookies()`)算默认值;ESM 的 import 按书写顺序
 * 先跑完前一个再跑下一个,所以这个副作用模块排最前才能在那之前把 `.env` 灌进 `process.env`。
 *
 * 用 Node 24 内置 `process.loadEnvFile`(零依赖,同 `node:sqlite` 一样吃现成的运行时能力),
 * 不引入 dotenv。`.env` 不存在则静默跳过(多数裸跑场景没有,只有想自定义数据根才需要)。
 * docker 容器内没有拷 `.env` 进镜像,这里天然是 no-op,不影响容器行为。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (e) {
    // .env 存在但解析失败(极少见,格式错)→ 只警告,不阻断启动(env var 仍可手动传)。
    console.warn(`[load-env] 读取 ${envPath} 失败,忽略: ${(e as Error).message}`);
  }
}
