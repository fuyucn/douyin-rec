/**
 * plans/036 T8:清理结果与 core `survivingArtifacts` 逐组合一致(对照用例)。
 * 期望值是**手写的旧口径**(重构前 `xmlKeepRule` + `cleanupSourcesShared` 的行为),不是从被测函数推出来的。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { survivingArtifacts } from "@drec/core";
import { SyncLedger } from "./ledger.js";
import { cleanupSourcesShared, stageVideoLeftovers, xmlKeepRule, type PipelineCleanup } from "./pipeline.js";
import type { Transport } from "./transport.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bools = [false, true] as const;

/** 旧口径(重构前的行为表),逐字对应原 `xmlKeepRule` / `cleanupSourcesShared` 逻辑。 */
function legacy(c: Required<PipelineCleanup>, keepNodeXml: boolean, merge: boolean) {
  const delNodeXml = keepNodeXml ? false : !c.stageAfterDone;
  return {
    nodeSeg: c.sourceAfterDone,
    nodeXml: c.sourceAfterDone && delNodeXml,
    stageSeg: merge && c.stageSourceAfterMerge,
    stageXml: merge && c.stageSourceAfterMerge && c.stageAfterDone,
  };
}

async function runCleanup(c: Required<PipelineCleanup>, keepNodeXml: boolean, merge: boolean) {
  dir = mkdtempSync(path.join(tmpdir(), "survivors-cleanup-"));
  const node = path.join(dir, "node"); const stage = path.join(dir, "stage");
  mkdirSync(node); mkdirSync(stage);
  const files = {
    nodeSeg: path.join(node, "a.ts"), nodeXml: path.join(node, "a.xml"),
    stageSeg: path.join(stage, "a.ts"), stageXml: path.join(stage, "a.xml"), stageAss: path.join(stage, "a.ass"),
  };
  for (const p of Object.values(files)) writeFileSync(p, "x");
  const transport = { id: "n1", cleanup: async (ps: string[]) => { for (const p of ps) rmSync(p, { force: true }); } } as unknown as Transport;
  const ledger = new SyncLedger(path.join(dir, "t.db"));
  const out = await cleanupSourcesShared({
    streamKey: "douyin:1:2026-01-01", ledger, transports: new Map([["n1", transport]]),
    members: [{ workerId: "n1", rec: { tsFiles: [files.nodeSeg], xmlPath: files.nodeXml } }],
    cleanup: c, ...(merge ? { stagePulledSources: [files.stageSeg] } : {}),
    ...(keepNodeXml ? { keepNodeXml: true } : {}),
    rmStage: async (ps) => { for (const p of ps) rmSync(p, { force: true }); }, log: () => {},
  });
  expect(out.ok).toBe(true);
  return {
    nodeSeg: !existsSync(files.nodeSeg), nodeXml: !existsSync(files.nodeXml),
    stageSeg: !existsSync(files.stageSeg), stageXml: !existsSync(files.stageXml),
    stageAss: !existsSync(files.stageAss),
  };
}

describe("cleanupSourcesShared × survivingArtifacts 逐组合对照(sourceAfterDone × stageAfterDone × stageSourceAfterMerge × keepNodeXml × 交付模式)", () => {
  for (const sourceAfterDone of bools) for (const stageAfterDone of bools) for (const stageSourceAfterMerge of bools)
    for (const keepNodeXml of bools) for (const merge of bools) {
      const c = { sourceAfterDone, stageAfterDone, stageSourceAfterMerge };
      it(`sourceAfterDone=${sourceAfterDone} stageAfterDone=${stageAfterDone} stageSourceAfterMerge=${stageSourceAfterMerge} keepNodeXml=${keepNodeXml} ${merge ? "合并" : "分P"}`, async () => {
        const got = await runCleanup(c, keepNodeXml, merge);
        const want = legacy(c, keepNodeXml, merge);
        expect(got.nodeSeg).toBe(want.nodeSeg);
        expect(got.nodeXml).toBe(want.nodeXml);
        expect(got.stageSeg).toBe(want.stageSeg);
        expect(got.stageXml).toBe(want.stageXml);
        expect(got.stageAss).toBe(want.stageXml); // .ass 与 .xml 同口径
        // 与留存清单一致:被删 ⇔ 不在留存清单(cleanupSourcesShared 本身只管这两步,stageAfterDone 的整场清空另见下)。
        const s = survivingArtifacts({ pipeline: { cleanup: c } }, { stageHasXmlCopy: !keepNodeXml });
        expect(got.nodeSeg).toBe(!s.nodeSourceSegments);
        expect(got.nodeXml).toBe(c.sourceAfterDone && !s.nodeXml);
        if (merge && c.stageSourceAfterMerge) expect(got.stageSeg).toBe(!s.stageSourceSegments);
      });
    }
});

describe("survivingArtifacts 清单", () => {
  const rule = (cleanup: PipelineCleanup) => ({ pipeline: { cleanup } });

  it("四组合 × 两种 xml 副本模式:xml 永不两处同时删光(只要开了 sourceAfterDone 之外的任何组合)", () => {
    for (const sourceAfterDone of bools) for (const stageAfterDone of bools) for (const stageHasXmlCopy of bools) {
      const s = survivingArtifacts(rule({ sourceAfterDone, stageAfterDone }), { stageHasXmlCopy });
      expect(s.nodeXml || s.stageXml).toBe(true);
    }
  });

  it("stageAfterDone=false:成品 / 源段副本 / 边车副本 / xml 都留在 stage;节点 xml 随节点源删(有 stage 副本)", () => {
    const s = survivingArtifacts(rule({ sourceAfterDone: true }), { stageHasXmlCopy: true });
    expect(s).toEqual({ nodeSourceSegments: false, stageSourceSegments: true, stageProducts: true, nodeXml: false, stageXml: true, stageSidecarCopies: true });
  });

  it("stageAfterDone=true:stage 整个清空(含边车副本),节点 xml 必留", () => {
    const s = survivingArtifacts(rule({ sourceAfterDone: true, stageAfterDone: true }), { stageHasXmlCopy: true });
    expect(s).toEqual({ nodeSourceSegments: false, stageSourceSegments: false, stageProducts: false, nodeXml: true, stageXml: false, stageSidecarCopies: false });
  });

  it("节点侧(stageHasXmlCopy:false)× stageAfterDone=false → 节点 xml 留存(最后一份)", () => {
    const s = survivingArtifacts(rule({ sourceAfterDone: true }), { stageHasXmlCopy: false });
    expect(s.nodeXml).toBe(true);
  });

  it("缺 pipeline / cleanup(老规则)→ 什么都不删,全部留存", () => {
    for (const r of [{}, { pipeline: {} }]) {
      expect(survivingArtifacts(r, { stageHasXmlCopy: true })).toEqual({
        nodeSourceSegments: true, stageSourceSegments: true, stageProducts: true, nodeXml: true, stageXml: true, stageSidecarCopies: true,
      });
    }
  });

  it("stageSourceAfterMerge 只摘 stage 源段副本,成品 / 边车副本不动", () => {
    const s = survivingArtifacts(rule({ stageSourceAfterMerge: true }), { stageHasXmlCopy: true });
    expect(s.stageSourceSegments).toBe(false);
    expect(s.stageProducts).toBe(true);
    expect(s.stageSidecarCopies).toBe(true);
  });

  it("xmlKeepRule 是清单的薄封装,四个旧断言不变", () => {
    expect([xmlKeepRule("node", false), xmlKeepRule("stage", false), xmlKeepRule("node", true), xmlKeepRule("stage", true)]).toEqual([true, false, false, true]);
  });

  it("边车副本归属:stageAfterDone 时 stageVideoLeftovers 返回 stage 边车副本 ⇔ 清单说它不留存;成品 / xml 不在其中", () => {
    dir = mkdtempSync(path.join(tmpdir(), "survivors-sidecar-"));
    for (const n of ["a.session.json", "a.ts", "product.mp4", "a.xml", "a.ass"]) writeFileSync(path.join(dir, n), "x");
    const left = stageVideoLeftovers(dir).map((p) => path.basename(p));
    expect(left).toContain("a.session.json");
    expect(left).not.toContain("a.xml");
    expect(survivingArtifacts(rule({ stageAfterDone: true }), { stageHasXmlCopy: true }).stageSidecarCopies).toBe(false);
    expect(survivingArtifacts(rule({ stageAfterDone: false }), { stageHasXmlCopy: true }).stageSidecarCopies).toBe(true);
  });
});
