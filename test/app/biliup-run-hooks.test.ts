import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBiliup, isAllFilesUploadedLine } from "../../packages/app/src/upload/biliup.js";

/** 把假 `biliup` 脚本放进临时目录并前置到 PATH,跑完还原。 */
async function withFakeBiliup<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "fake-biliup-"));
  writeFileSync(join(dir, "biliup"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "biliup"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
}

describe("isAllFilesUploadedLine", () => {
  it("只认 biliup 传完、提交前的那一行", () => {
    expect(isAllFilesUploadedLine("All files uploaded successfully, checkpoint removed")).toBe(true);
    expect(isAllFilesUploadedLine("uploading part 3/9")).toBe(false);
    expect(isAllFilesUploadedLine("")).toBe(false);
  });
});

describe("runBiliup 观测回调(issue #204)", () => {
  it("onSpawn 给出 pid;onLine 按整行回调(\\r 进度条与 \\n 都算行尾,stderr 同样),返回值不变", async () => {
    const lines: string[] = [];
    let pid: number | undefined;
    const out = await withFakeBiliup(
      "printf 'part 1\\rpart 2\\nAll files uploaded succ'; sleep 0.2; printf 'essfully\\nBV1abcdefghi\\n'; echo 'warn on stderr' >&2",
      () => runBiliup(["upload"], { onSpawn: (p) => { pid = p; }, onLine: (l) => lines.push(l) }),
    );
    expect(typeof pid).toBe("number");
    expect(lines).toContain("part 1");
    expect(lines).toContain("part 2");
    expect(lines).toContain("All files uploaded successfully"); // 跨 chunk 的半行被拼回整行
    expect(lines).toContain("warn on stderr");
    expect(out).toContain("BV1abcdefghi"); // 合并输出不受回调影响
  });

  it("回调抛错不影响上传结果", async () => {
    const out = await withFakeBiliup("echo BV1zzzzzzzzz", () => runBiliup(["upload"], {
      onSpawn: () => { throw new Error("boom spawn"); },
      onLine: () => { throw new Error("boom line"); },
    }));
    expect(out).toContain("BV1zzzzzzzzz");
  });

  it("非零退出仍然 reject,错误带输出末尾", async () => {
    await expect(withFakeBiliup("echo 'bad cookie' >&2; exit 7", () => runBiliup(["upload"], { onLine: () => {} })))
      .rejects.toThrow(/rc=7.*bad cookie/);
  });

  it("不传回调时行为与旧签名一致", async () => {
    const out = await withFakeBiliup("echo BV1plainplain", () => runBiliup(["upload"]));
    expect(out).toContain("BV1plainplain");
  });
});
