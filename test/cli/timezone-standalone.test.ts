/**
 * issue #155:不经 `task serve` 的独立 CLI 入口也必须应用 settings.timezone(否则 stamp/标题落回宿主机本地时区)。
 * 用 --import 预加载钩子在进程退出时打印最终 process.env.TZ,避开对具体命令输出的依赖。
 * 依赖已构建的 dist/douyin-rec.mjs(`pnpm bundle`),未构建则跳过。
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";

const BUNDLE = resolve(__dirname, "../../dist/douyin-rec.mjs");

function runCli(args: (d: string) => string[], env: Record<string, string>, unset: string[] = []): string {
  const d = mkdtempSync(join(tmpdir(), "cli-tz-"));
  const hook = join(d, "hook.mjs");
  writeFileSync(hook, `process.on("exit", () => process.stderr.write("FINAL_TZ=" + process.env.TZ + "\\n"));`);
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  for (const k of unset) delete e[k];
  const r = spawnSync("node", ["--import", hook, BUNDLE, ...args(d)], {
    encoding: "utf-8", timeout: 60_000, env: e as NodeJS.ProcessEnv, cwd: d,
  });
  return /FINAL_TZ=(\S+)/.exec(r.stderr)?.[1] ?? `<none:${r.stderr.slice(0, 200)}>`;
}

function runMerge(env: Record<string, string>): string {
  return runCli((d) => ["merge", "--in", d, "--merge-sessions"], env);
}

describe.skipIf(!existsSync(BUNDLE))("独立 CLI 入口应用设置时区(issue #155)", () => {
  it("库里设了时区 → 命令执行前 TZ = 设置值(覆盖宿主机 TZ)", () => {
    const d = mkdtempSync(join(tmpdir(), "cli-tz-db-"));
    const db = join(d, "t.db");
    const s = new TaskStore(db);
    s.setSetting("timezone", "Asia/Tokyo");
    s.db.close();
    expect(runMerge({ DOUYIN_REC_DB: db, TZ: "America/Los_Angeles" })).toBe("Asia/Tokyo");
  });
  it("库存在但没设时区 → 缺省北京时间(宿主机 TZ 为美西也不跟随)", () => {
    const d = mkdtempSync(join(tmpdir(), "cli-tz-nosetting-"));
    const db = join(d, "t.db");
    new TaskStore(db).db.close();
    expect(runMerge({ DOUYIN_REC_DB: db, TZ: "America/Los_Angeles" })).toBe("Asia/Shanghai");
  });
  it("库不存在(自定义库路径启动的子进程找不到库)→ 保留继承的有效 TZ,不覆盖成默认(issue #158)", () => {
    const d = mkdtempSync(join(tmpdir(), "cli-tz-nodb-"));
    expect(runMerge({ DOUYIN_REC_DB: join(d, "none.db"), TZ: "Asia/Tokyo" })).toBe("Asia/Tokyo");
  });
  it("隐藏命令带数据根:按 <dataRoot>/db 的时区,不读默认库路径(issue #158)", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-tz-root-"));
    mkdirSync(join(root, "db"), { recursive: true });
    const s = new TaskStore(join(root, "db", "douyin-rec.db"));
    s.setSetting("timezone", "Asia/Tokyo");
    s.db.close();
    // ssh 会话形态:无 DOUYIN_REC_DB / DOUYIN_REC_ROOT,cwd 下无默认库;宿主机 TZ 为美西
    const tz = runCli(() => ["_disk", root], { TZ: "America/Los_Angeles" }, ["DOUYIN_REC_DB", "DOUYIN_REC_ROOT"]);
    expect(tz).toBe("Asia/Tokyo");
  });
});
