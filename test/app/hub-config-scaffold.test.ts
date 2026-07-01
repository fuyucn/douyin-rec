import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHubConfigExample, drecRoot, DEFAULT_ROOT } from "../../packages/app/src/paths.js";
import { resolveHubConfigJson } from "../../packages/app/src/cli-task.js";
import type { TaskStore } from "../../packages/app/src/store.js";

/** 极简假 store:resolveHubConfigJson 只用到 getSetting("hubConfig")。 */
const fakeStore = (hubConfig?: string): TaskStore =>
  ({ getSetting: (k: string) => (k === "hubConfig" ? hubConfig : undefined) }) as unknown as TaskStore;

/**
 * 数据根初始化时种 hub-config.example.json 模板。
 * 幂等:已存在不覆盖;路径据 root(显式 DOUYIN_REC_ROOT,或未设时的默认 DEFAULT_ROOT)填充。
 */
describe("ensureHubConfigExample（init-time scaffold）", () => {
  const prev = process.env.DOUYIN_REC_ROOT;
  afterEach(() => {
    if (prev === undefined) delete process.env.DOUYIN_REC_ROOT;
    else process.env.DOUYIN_REC_ROOT = prev;
  });

  it("无 DOUYIN_REC_ROOT → drecRoot() 回落默认根 DEFAULT_ROOT(不再是「跳过」)", () => {
    // 纯函数断言,不调用 ensureHubConfigExample()——它真的会写文件,若在真实 cwd(仓库根)下
    // 以默认根跑会往 <cwd>/output-data/ 写东西,污染仓库(曾经这样跑过一次,已手动清理)。
    delete process.env.DOUYIN_REC_ROOT;
    expect(drecRoot()).toBe(DEFAULT_ROOT);
  });

  it("有 root 且文件不存在 → 逐字复制仓库源文件 configs/hub.config.example.json", () => {
    const root = mkdtempSync(join(tmpdir(), "hubroot-"));
    process.env.DOUYIN_REC_ROOT = root;
    const path = ensureHubConfigExample();
    expect(path).toBe(join(root, "config", "hub.config.example.json"));
    // 复制内容必须逐字等于仓库源模板(单一真相)。vitest cwd=repo 根。
    const source = readFileSync(join(process.cwd(), "configs/hub.config.example.json"), "utf-8");
    const written = readFileSync(path!, "utf-8");
    expect(written).toBe(source);
    // 抽查关键字段(占位模型:dataRoot=/data;upload 默认在 uploadDefaults)。
    const cfg = JSON.parse(written);
    expect(cfg.platform).toBe("douyin");
    expect(cfg.tenants[0].kind).toBe("local");
    expect(cfg.tenants[1].kind).toBe("tailscale-ssh");
    expect(cfg.uploadDefaults.tid).toBe(21);
    expect(cfg.settleMs).toBe(90000);
  });

  it("文件已存在 → 不覆盖(返回 undefined,保留用户改动)", () => {
    const root = mkdtempSync(join(tmpdir(), "hubroot2-"));
    process.env.DOUYIN_REC_ROOT = root;
    ensureHubConfigExample(); // 首次写
    const path = join(root, "config", "hub.config.example.json");
    writeFileSync(path, '{"mine":true}', "utf-8"); // 用户改动
    expect(ensureHubConfigExample()).toBeUndefined(); // 第二次跳过
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ mine: true }); // 未被覆盖
    expect(existsSync(path)).toBe(true);
  });
});

/**
 * hub 配置解析优先级:--hub-config(文件路径→读 / 否则内联 JSON) > settings.hubConfig > <root>/config/hub-config.json。
 * 即把 .example 复制成 hub-config.json 改完,serve --hub 自动加载。
 */
describe("resolveHubConfigJson（配置解析优先级）", () => {
  const prev = process.env.DOUYIN_REC_ROOT;
  afterEach(() => {
    if (prev === undefined) delete process.env.DOUYIN_REC_ROOT;
    else process.env.DOUYIN_REC_ROOT = prev;
  });

  it("--hub-config 是内联 JSON 串 → 原样返回", () => {
    delete process.env.DOUYIN_REC_ROOT;
    expect(resolveHubConfigJson('{"platform":"douyin"}', fakeStore())).toBe('{"platform":"douyin"}');
  });

  it("--hub-config 是存在的文件路径 → 读文件内容", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubcfg-"));
    const f = join(dir, "h.json");
    writeFileSync(f, '{"from":"file"}');
    expect(resolveHubConfigJson(f, fakeStore())).toBe('{"from":"file"}');
  });

  it("无 arg + settings.hubConfig 有值 → 用 settings", () => {
    delete process.env.DOUYIN_REC_ROOT;
    expect(resolveHubConfigJson(undefined, fakeStore('{"from":"db"}'))).toBe('{"from":"db"}');
  });

  it("无 arg + 无 settings + <root>/config/hub-config.json 存在 → 自动读该文件", () => {
    const root = mkdtempSync(join(tmpdir(), "hubroot-cfg-"));
    process.env.DOUYIN_REC_ROOT = root;
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "hub-config.json"), '{"from":"root-file"}');
    expect(resolveHubConfigJson(undefined, fakeStore())).toBe('{"from":"root-file"}');
  });

  it("都没有 → undefined(serve --hub 会跳过)", () => {
    delete process.env.DOUYIN_REC_ROOT;
    expect(resolveHubConfigJson(undefined, fakeStore())).toBeUndefined();
  });
});
