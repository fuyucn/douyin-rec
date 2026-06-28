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

  it("有 root 且文件不存在 → 逐字复制仓库源文件 configs/hub-config.example.json", () => {
    const root = mkdtempSync(join(tmpdir(), "hubroot-"));
    process.env.DOUYIN_REC_ROOT = root;
    const path = ensureHubConfigExample();
    expect(path).toBe(join(root, "config", "hub-config.example.json"));
    // 复制内容必须逐字等于仓库源模板(单一真相)。vitest cwd=repo 根。
    const source = readFileSync(join(process.cwd(), "configs/hub-config.example.json"), "utf-8");
    const written = readFileSync(path!, "utf-8");
    expect(written).toBe(source);
    // 抽查关键字段(占位模型:dataRoot=/data,uploadMode 保守 stage-only)。
    const cfg = JSON.parse(written);
    expect(cfg.platform).toBe("douyin");
    expect(cfg.tenants[0].kind).toBe("local");
    expect(cfg.tenants[1].kind).toBe("tailscale-ssh");
    expect(cfg.uploadMode).toBe("stage-only");
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
