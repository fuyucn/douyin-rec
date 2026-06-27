import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHubConfigExample } from "../../packages/app/src/paths.js";

/**
 * 数据根初始化时种 hub-config.example.json 模板。
 * 幂等:无 DOUYIN_REC_ROOT 跳过;已存在不覆盖;路径据 root 填充。
 */
describe("ensureHubConfigExample（init-time scaffold）", () => {
  const prev = process.env.DOUYIN_REC_ROOT;
  afterEach(() => {
    if (prev === undefined) delete process.env.DOUYIN_REC_ROOT;
    else process.env.DOUYIN_REC_ROOT = prev;
  });

  it("无 DOUYIN_REC_ROOT → 跳过(返回 undefined,不写文件)", () => {
    delete process.env.DOUYIN_REC_ROOT;
    expect(ensureHubConfigExample()).toBeUndefined();
  });

  it("有 root 且文件不存在 → 写模板,字段据 root 填充", () => {
    const root = mkdtempSync(join(tmpdir(), "hubroot-"));
    process.env.DOUYIN_REC_ROOT = root;
    const path = ensureHubConfigExample();
    expect(path).toBe(join(root, "config", "hub-config.example.json"));
    const cfg = JSON.parse(readFileSync(path!, "utf-8"));
    expect(cfg.platform).toBe("douyin");
    expect(cfg.tenants[0]).toMatchObject({ id: "local", kind: "local", dataRoot: root });
    expect(cfg.tenants[1].kind).toBe("tailscale-ssh");
    expect(cfg.cookies).toBe(join(root, "config", "biliup", "cookies.json"));
    expect(cfg.stageDir).toBe(join(root, "stage"));
    expect(cfg.uploadMode).toBe("stage-only"); // 保守默认
    expect(cfg.settleMs).toBe(90000);
  });

  it("文件已存在 → 不覆盖(返回 undefined,保留用户改动)", () => {
    const root = mkdtempSync(join(tmpdir(), "hubroot2-"));
    process.env.DOUYIN_REC_ROOT = root;
    ensureHubConfigExample(); // 首次写
    const path = join(root, "config", "hub-config.example.json");
    writeFileSync(path, '{"mine":true}', "utf-8"); // 用户改动
    expect(ensureHubConfigExample()).toBeUndefined(); // 第二次跳过
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ mine: true }); // 未被覆盖
    expect(existsSync(path)).toBe(true);
  });
});
