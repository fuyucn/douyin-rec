/**
 * app/process/credential-file.ts — 录制子进程登录凭证的 0600 临时文件。
 *
 * 凭证不能走 argv(同机 `ps` 可见、超时报错可能连参数写进日志),改写到数据根下
 * `<root>/run/` 的私有文件,再用 `--cookies-file` 传路径。写入失败直接抛错,**绝不回退 argv**。
 */
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { drecRoot } from "../paths.js";

/** 凭证文件目录(0700)。绝对路径:子进程 cwd 可能与 serve 不同。 */
export function credentialDir(): string {
  return resolve(drecRoot(), "run");
}

/**
 * 原子写入凭证文件并返回其绝对路径:先写同目录 0600 临时文件再 rename,
 * 读者永远看不到半截内容,文件从创建起就是 0600(不存在先宽后紧的窗口)。
 * 任何 fs 错误原样抛出(不吞)。同一任务重复 spawn 会覆盖上一份。
 */
export function writeCredentialFile(taskId: number, credential: string): string {
  const dir = credentialDir();
  const path = join(dir, `record-${taskId}.cred`);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // recursive mkdir 对已存在目录不改权限
    writeFileSync(tmp, credential, { mode: 0o600, flag: "w" });
    chmodSync(tmp, 0o600); // 忽略 umask / 覆盖已有临时文件时保留的旧权限
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 尽力清理临时文件;原始错误更重要 */
    }
    throw new Error(`写入录制登录凭证文件失败(${path}): ${(e as Error).message}`);
  }
  return path;
}

/** 删除凭证文件;不存在视为已清理。 */
export function removeCredentialFile(path: string): void {
  rmSync(path, { force: true });
}

/** Names written by writeCredentialFile: `record-<id>.cred` and its `.<pid>.tmp` staging file. */
const CREDENTIAL_NAME = /^record-\d+\.cred(\.\d+\.tmp)?$/;

/**
 * Startup sweep: remove credential files left behind when a previous serve was killed before
 * its children exited. Children read the file once at startup, so nothing alive still needs it.
 * Only touches names this module writes; a missing dir is a no-op. Per-file failures are
 * returned (not thrown) so one bad entry cannot block serve startup, but they are never silent.
 */
export function sweepCredentialFiles(): { removed: number; failed: string[] } {
  const dir = credentialDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, failed: [] };
    return { removed: 0, failed: [`${dir}: ${(e as Error).message}`] };
  }
  let removed = 0;
  const failed: string[] = [];
  for (const name of names) {
    if (!CREDENTIAL_NAME.test(name)) continue;
    try {
      rmSync(join(dir, name), { force: true });
      removed++;
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { removed, failed };
}
