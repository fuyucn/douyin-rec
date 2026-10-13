/**
 * test-package-classify.mjs — 「顶层 test/ 用例按包名归类」的纯逻辑(无副作用、可 import)。
 *
 * 从 scripts/gen-architecture.mjs 抽出(issue #20)。归类**只依赖相对仓库根的路径**:
 * 绝对路径会含仓库/检出目录名(如 CI 上 `douyin-rec/douyin-rec`),旧写法据此判断会把
 * 每个顶层用例误算进同名包,导致架构守护在 CI 恒红(issue #11 / PR #19)。把这段抽成纯函数,
 * 就能在 test/arch/arch-path-guard.test.ts 里用「目录名本身含包名关键词」的夹具 ROOT
 * 钉死这个回归——无需真实跑一遍生成器。
 *
 * 语义与原内联写法逐字一致,重构前后每包归类计数必须完全相同。
 */
import { relative } from "node:path";

/**
 * 把顶层 test 用例逐个归到匹配的包上,就地累加 `pkg.srcTests`(与原生成器行为一致)。
 *
 * @param {{dir: string, srcTests: number}[]} pkgs 各包(含已计好的 src 内用例数);就地累加。
 * @param {string[]} topTestFiles 顶层 test 用例的**绝对**路径列表。
 * @param {string} root 仓库根绝对路径。归类只取相对它的路径。
 * @param {(from: string, to: string) => string} [relFn] 注入的「(root, abs)→相对」函数,
 *        默认即 node:path 的 relative(仅为让单测可注入确定性相对化;生产调用不传)。
 * @returns {{dir: string, srcTests: number}[]} 同一个 pkgs(便于链式/断言)。
 */
export function assignTopTestsToPackages(pkgs, topTestFiles, root, relFn = relative) {
  for (const t of topTestFiles) {
    // 必须用**相对 ROOT 的路径**归类:绝对路径含仓库目录名(如 CI 检出目录
    // `douyin-rec/douyin-rec`),会让每个顶层用例被误算进同名包(issue #11)。
    const base = relFn(root, t).toLowerCase();
    for (const p of pkgs) {
      const short = p.dir.replace(/-live$/, "").replace(/-/g, "");
      if (base.includes(p.dir) || base.includes(short)) p.srcTests += 1;
    }
  }
  return pkgs;
}
