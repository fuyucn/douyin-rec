/**
 * 架构分层守护(零依赖,替代 eslint no-restricted-imports —— 本项目无 eslint 工具链)。
 *
 * 扫 packages/*\/package.json 的 @drec/* 依赖图,断言依赖只能「向下」:每个包的 rank
 * 必须严格大于它依赖的任何包。新增包若未在 RANKS 登记 → 失败,强制为它显式定层(避免
 * 悄悄引入跨层耦合)。这守护的是 cli/app → manager → 插件 → 平台 core/base → core 的单向分层。
 *
 * 分层(rank 越小越底层,只能被更高层依赖):
 *   0 基础叶子:契约 core / 后处理 post-process / TUI / ffmpeg 附加
 *   1 平台共享层:通用录制器 + ffmpeg/mesio 引擎 record-engine
 *   1.5 平台 core:douyin-live / bilibili-live(实现 Platform)
 *   3 编排:manager(会话生命周期)
 *   4 有状态应用:app(db + 任务调度 + web)
 *   5 入口:cli(组装全部 + 注册插件)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PKG_DIR = join(import.meta.dirname, "..", "..", "packages");

/** 每个 @drec/* 包的层级。新增包必须在此登记(否则测试失败,逼你想清楚它属哪层)。 */
const RANKS: Record<string, number> = {
  // 0 基础叶子(纯契约 / 后处理 / TUI / ffmpeg 附加)
  "@drec/core": 0,
  "@drec/post-process": 0,
  "@drec/tui": 0,
  "@drec/ffmpeg-recorder-extra": 0,
  // 1 共享层:通用录制器 + ffmpeg/mesio 引擎策略(record-engine)
  "@drec/record-engine": 1,
  // 1.5 平台 core(实现 Platform 契约 + connectDanmu)。弹幕 WS 基类是 douyin-live
  //     自己的(ListenerDanmuSource),弹幕 XML 写入已下沉至 manager。
  "@drec/douyin-live": 1.5,
  "@drec/bilibili-live": 1.5,
  // 3 编排 → 4 应用 → 5 入口
  "@drec/manager": 3,
  "@drec/app": 4,
  "@drec/orchestrator": 4.5,
  "@drec/cli": 5,
  // 6 多节点编排:跨节点同步流水线(依赖 app/core/post-process)
  "@drec/orchestrator": 6,
};

interface PkgInfo {
  name: string;
  drecDeps: string[];
}

function loadPackages(): PkgInfo[] {
  const out: PkgInfo[] = [];
  for (const p of readdirSync(PKG_DIR)) {
    const pj = join(PKG_DIR, p, "package.json");
    if (!existsSync(pj)) continue;
    const j = JSON.parse(readFileSync(pj, "utf-8")) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    if (!j.name?.startsWith("@drec/")) continue; // 跳过前端等非 @drec 包
    const drecDeps = Object.keys(j.dependencies ?? {}).filter((d) => d.startsWith("@drec/"));
    out.push({ name: j.name, drecDeps });
  }
  return out;
}

describe("架构分层(依赖只能向下)", () => {
  const pkgs = loadPackages();

  it("每个 @drec/* 包都在 RANKS 登记了层级", () => {
    const unranked = pkgs.map((p) => p.name).filter((n) => RANKS[n] === undefined);
    expect(unranked, `新增包未定层,请在 test/arch/layering.test.ts 的 RANKS 登记: ${unranked.join(", ")}`).toEqual([]);
  });

  it("没有向上/同层依赖(dep 的 rank 必须严格小于依赖方)", () => {
    const violations: string[] = [];
    for (const p of pkgs) {
      const myRank = RANKS[p.name];
      if (myRank === undefined) continue; // 上一条已断言
      for (const dep of p.drecDeps) {
        const depRank = RANKS[dep];
        if (depRank === undefined) continue;
        if (depRank >= myRank) {
          violations.push(`${p.name}(L${myRank}) → ${dep}(L${depRank}) 违反向下依赖`);
        }
      }
    }
    expect(violations, `分层违规:\n  ${violations.join("\n  ")}`).toEqual([]);
  });

  it("core 是纯契约层,不依赖任何 @drec 包", () => {
    const core = pkgs.find((p) => p.name === "@drec/core");
    expect(core?.drecDeps ?? []).toEqual([]);
  });
});
