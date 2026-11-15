// issue #699:队列 upload-part 的传输守护只认 `ss -tinpH` 的 bytes_acked。镜像不装 iproute2 时
// readTcpAcked 恒为 null,守护走「无证据不杀」分支(stall detection paused),一次挂住的 biliup
// 最长要等 maxWallMs(24h) 才收尾,期间该订单后续分 P 全被顺序阻断——房间看着还在录,稿件分 P
// 不再增长。这类回归不会让任何单测变红,只能在镜像定义上扫。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

describe("镜像必须带 ss(iproute2)供 biliup 传输守护采样(#699)", () => {
  it("Dockerfile 的 master 与 worker 两个变体都安装 iproute2", () => {
    const text = readFileSync(join(ROOT, "Dockerfile"), "utf-8");
    // 两个变体各一条 apt-get install;每个都必须含 iproute2,否则对应角色的上传会退化成「无证据」。
    const installs = text.split("\n").filter((l) => /apt-get install -y --no-install-recommends/.test(l));
    expect(installs.length).toBe(2); // master / worker
    for (const line of installs) expect(line).toContain("iproute2");
  });

  it("守护的采样命令与镜像里提供的包对应(ss 来自 iproute2)", () => {
    const src = readFileSync(join(ROOT, "packages", "bilibili-upload", "src", "biliup-progress.ts"), "utf-8");
    // 采样命令一旦换成别的工具,上面那条「装 iproute2」的守护就失效了,所以在这里钉住两者绑定。
    // 必须扫**全部** execFile* 调用点:只查一处的话,新加一条别的采样命令就能绕过这个守护。
    const commands = [...src.matchAll(/execFile(?:Sync)?\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) expect(cmd).toBe("ss");
    expect(src).toContain("-tinpH");
  });
});