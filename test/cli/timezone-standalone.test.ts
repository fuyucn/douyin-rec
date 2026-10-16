/**
 * issue #155:不经 `task serve` 的独立 CLI 入口也必须应用 settings.timezone(否则 stamp/标题落回宿主机本地时区)。
 * 用 --import 预加载钩子在进程退出时打印最终 process.env.TZ,避开对具体命令输出的依赖。
 * 依赖已构建的 dist/douyin-rec.mjs(`pnpm bundle`),未构建则跳过。
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";

const BUNDLE = resolve(__dirname, "../../dist/douyin-rec.mjs");

function runMerge(env: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cli-tz-"));
  const hook = join(d, "hook.mjs");
  writeFileSync(hook, `process.on("exit", () => process.stderr.write("FINAL_TZ=" + process.env.TZ + "\\n"));`);
  const r = spawnSync("node", ["--import", hook, BUNDLE, "merge", "--in", d, "--merge-sessions"], {
    encoding: "utf-8", timeout: 60_000, env: { ...process.env, ...env },
  });
  return /FINAL_TZ=(\S+)/.exec(r.stderr)?.[1] ?? `<none:${r.stderr.slice(0, 200)}>`;
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
  it("无库 → 缺省北京时间(宿主机 TZ 为美西也不跟随)", () => {
    const d = mkdtempSync(join(tmpdir(), "cli-tz-nodb-"));
    expect(runMerge({ DOUYIN_REC_DB: join(d, "none.db"), TZ: "America/Los_Angeles" })).toBe("Asia/Shanghai");
  });
});
