/**
 * arch-path-guard.test.ts — 钉死「顶层 test 用例归类只依赖相对仓库根路径」(issue #20)。
 *
 * 背景:scripts/gen-architecture.mjs 把 test/ 下的用例按「路径含包名」粗归类到各包
 * (架构热图的「测试数」来源)。issue #11 实测:CI 检出目录名含仓库名/包名时,旧的
 * 「直接用绝对路径判断」写法会把 ROOT 目录名里的关键词误当成包名 → 同名包被虚高
 * → 架构守护在 CI 恒红。PR #19 改成 `relative(ROOT, t)` 后修好,但此前只靠「CI 目录名
 * 恰好含 douyin-rec」被动守护,缺一条本地可复现的独立用例。本测试补上:
 *
 *   1. 用夹具 ROOT(目录名本身 == 包名 `douyin-live`)污染绝对路径;
 *   2. 断言新写法(relative)的归类结果与 ROOT 目录名无关(污染 ROOT == 干净 ROOT);
 *   3. 内联旧写法(直接取绝对路径小写)作反例,证明它被 ROOT 目录名带偏(同名包虚高);
 *   4. 覆盖 `-live` 后缀包短名匹配(douyin/bilibili/kuaishou)+ src 基线与顶层新增两类来源
 *      + relFn 注入(证明归类只用传入的相对串,与绝对 ROOT 解耦)。
 *
 * 纯测试:只 import scripts/ 下的纯归类模块,不碰运行时、不跑真实生成器。
 */
import { describe, it, expect } from "vitest";
import { assignTopTestsToPackages } from "../../scripts/test-package-classify.mjs";

type Pkg = { dir: string; srcTests: number };

// 夹具:每个包的「src 内已计好用例数」基线(代表来源①:packages/<p>/src 的 .test)。
function makePkgs(): Pkg[] {
  return [
    { dir: "douyin-live", srcTests: 1 },
    { dir: "bilibili-live", srcTests: 4 },
    { dir: "kuaishou-live", srcTests: 1 },
    { dir: "app", srcTests: 6 },
    { dir: "manager", srcTests: 1 },
    { dir: "core", srcTests: 7 },
    { dir: "orchestrator", srcTests: 22 },
  ];
}

// 顶层 test 用例的「相对仓库根」布局(代表来源②:顶层 test/ 目录)。
const REL_LAYOUT = [
  "test/app/store.test.ts", // → app
  "test/app/task-manager.test.ts", // → app + manager(short "manager")
  "test/douyin/room.test.ts", // → douyin-live(short "douyin")
  "test/bilibili/gift.test.ts", // → bilibili-live(short "bilibili")
  "test/kuaishou/flow.test.ts", // → kuaishou-live(short "kuaishou")
  "test/douyin-live/legacy.test.ts", // → douyin-live(完整 dir 名匹配)
  "test/arch/layering.test.ts", // → 不匹配任何包
];

// 把相对布局拼成某个 ROOT 下的绝对路径(模拟不同检出目录)。
const toAbs = (root: string, rel: string[]): string[] => rel.map((r) => `${root}/${r}`);

// 旧写法(反例):直接拿**绝对路径**小写判断 —— ROOT 目录名会污染。逐字复刻 PR #19 之前的逻辑。
function assignTopTestsOLD_BUGGY(pkgs: Pkg[], absFiles: string[]): void {
  for (const t of absFiles) {
    const base = t.toLowerCase(); // ← 绝对路径含 ROOT 目录名,这正是 bug 根因
    for (const p of pkgs) {
      const short = p.dir.replace(/-live$/, "").replace(/-/g, "");
      if (base.includes(p.dir) || base.includes(short)) p.srcTests += 1;
    }
  }
}

// 干净检出上的期望归类(只来自相对路径,与 ROOT 目录名无关):
const EXPECTED_NEW: Record<string, number> = {
  "douyin-live": 3, // 基线 1 + room + legacy
  "bilibili-live": 5, // 基线 4 + gift
  "kuaishou-live": 2, // 基线 1 + flow
  app: 8, // 基线 6 + store + task-manager
  manager: 2, // 基线 1 + task-manager
  core: 7,
  orchestrator: 22,
};

// 注入确定性的「(root, abs) → 相对」还原器:剥掉 `${root}/` 前缀。
// 同时断言调用方传入的 root 与夹具一致 → 证明归类只使用 relative(root, file) 的相对串。
const relFrom = (root: string) => (from: string, abs: string): string => {
  if (from !== root) throw new Error(`夹具自洽检查: 期望 from=${root}, 实得 ${from}`);
  const prefix = `${root}/`;
  if (!abs.startsWith(prefix)) throw new Error(`夹具自洽检查: ${abs} 不在 ${prefix} 下`);
  return abs.slice(prefix.length);
};

const asMap = (pkgs: Pkg[]): Record<string, number> =>
  Object.fromEntries(pkgs.map((p) => [p.dir, p.srcTests]));

// 夹具 ROOT:目录名本身 == 包名 `douyin-live`(也含 short "douyin"),模拟被污染的检出目录。
const POLLUTED_ROOT = "/ci-runner/douyin-live/checkout";
// 对照 ROOT:目录名不含任何包名关键词。两者相对布局完全相同。
const CLEAN_ROOT = "/home/dev/work/checkout";

describe("架构守护:顶层 test 归类只依赖相对仓库根路径(issue #20)", () => {
  it("新写法:归类结果与 ROOT 目录名无关(污染 ROOT == 干净 ROOT)", () => {
    const polluted = assignTopTestsToPackages(
      makePkgs(), toAbs(POLLUTED_ROOT, REL_LAYOUT), POLLUTED_ROOT, relFrom(POLLUTED_ROOT),
    );
    const clean = assignTopTestsToPackages(
      makePkgs(), toAbs(CLEAN_ROOT, REL_LAYOUT), CLEAN_ROOT, relFrom(CLEAN_ROOT),
    );
    expect(asMap(polluted)).toEqual(EXPECTED_NEW);
    expect(asMap(clean)).toEqual(EXPECTED_NEW);
    // 两个 ROOT 名字不同,结果逐包相同 → 证明只取决于 relative(ROOT, file)。
    expect(asMap(polluted)).toEqual(asMap(clean));
  });

  it("反例:旧写法(绝对路径判断)被 ROOT 目录名带偏,且只污染同名包", () => {
    const pollutedAbs = toAbs(POLLUTED_ROOT, REL_LAYOUT);
    const old = makePkgs();
    assignTopTestsOLD_BUGGY(old, pollutedAbs);
    const neu = assignTopTestsToPackages(
      makePkgs(), pollutedAbs, POLLUTED_ROOT, relFrom(POLLUTED_ROOT),
    );
    const oldMap = asMap(old);
    const newMap = asMap(neu);
    // 旧写法把「每个」顶层用例都误算进 douyin-live(ROOT 目录名含该包名)→ 虚高。
    expect(oldMap["douyin-live"]).toBe(1 + REL_LAYOUT.length);
    // 新写法免疫:仍为 3。
    expect(newMap["douyin-live"]).toBe(EXPECTED_NEW["douyin-live"]);
    expect(oldMap["douyin-live"]).not.toBe(newMap["douyin-live"]);
    // 污染只命中同名包,其余包新旧一致(证明这是目录名污染,而非普遍错分)。
    for (const dir of Object.keys(oldMap)) {
      if (dir === "douyin-live") continue;
      expect(oldMap[dir]).toBe(newMap[dir]);
    }
  });

  it("`-live` 后缀包的短名匹配(douyin/bilibili/kuaishou)+ 完整 dir 名匹配", () => {
    const single = (dir: string, rel: string): number =>
      asMap(assignTopTestsToPackages(
        [{ dir, srcTests: 0 }], [`${CLEAN_ROOT}/${rel}`], CLEAN_ROOT, relFrom(CLEAN_ROOT),
      ))[dir];
    expect(single("douyin-live", "test/douyin/room.test.ts")).toBe(1); // short 命中
    expect(single("douyin-live", "test/douyin-live/legacy.test.ts")).toBe(1); // dir 命中,每文件同包只 +1
    expect(single("douyin-live", "test/notify/notifier.test.ts")).toBe(0); // 不含关键词
    expect(single("bilibili-live", "test/bilibili/gift.test.ts")).toBe(1);
    expect(single("kuaishou-live", "test/kuaishou/flow.test.ts")).toBe(1);
  });

  it("两类来源:src 基线保留,顶层用例在其上累加(不覆盖、不重复计数)", () => {
    const map = asMap(assignTopTestsToPackages(
      makePkgs(), toAbs(CLEAN_ROOT, REL_LAYOUT), CLEAN_ROOT, relFrom(CLEAN_ROOT),
    ));
    expect(map.app).toBe(8); // 基线 6 + 两个顶层 app
    expect(map.manager).toBe(2); // 基线 1 + task-manager(short 匹配)
  });

  it("relFn 注入:归类只使用传入的相对串(证明与绝对 ROOT 解耦)", () => {
    const mapOf = (relFn: (from: string, abs: string) => string) =>
      asMap(assignTopTestsToPackages([{ dir: "douyin-live", srcTests: 0 }], ["/whatever/a.test.ts"], "/ignored", relFn))["douyin-live"];
    expect(mapOf(() => "test/arch/a.test.ts")).toBe(0);
    expect(mapOf(() => "test/douyin/a.test.ts")).toBe(1);
  });
});
