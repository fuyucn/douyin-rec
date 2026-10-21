/**
 * Source guard for issue #331: the hub-managed (side node) zero-disk path in the CLI.
 *
 * Behavior is unit-tested next to each helper; these assertions pin the wiring the unit tests
 * cannot see: the `record` child must verify before uploading, must not read the node's own rule
 * directory for metadata, must report through a receipt instead of its own ledger, and the master's
 * spec builder must go through the single decision point.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const cli = readFileSync(join(ROOT, "packages/cli/src/cli.ts"), "utf-8");

function streamUploadBlock(): string {
  const start = cli.indexOf("if (streamUploadEnabled) {");
  const end = cli.indexOf("\n    // 节点侧原地替换容器(issue #137)", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return cli.slice(start, end);
}

describe("record --stream-upload on a hub-managed node", () => {
  const block = streamUploadBlock();

  it("verifies the delivered metadata + account before anything is uploaded, and exits non-zero on refusal", () => {
    const i = block.indexOf("zeroDiskNodePreflight(process.env[ZERO_DISK_DELIVERY_ENV])");
    expect(i).toBeGreaterThan(-1);
    expect(block.indexOf("process.exit(2)", i)).toBeGreaterThan(i);
    expect(block.indexOf("runLivePump({", i)).toBeGreaterThan(block.indexOf("process.exit(2)", i));
  });

  it("takes metadata only from the delivered object (manual flags are ignored when managed)", () => {
    expect(block).toContain("const manual");
    expect(block).toContain("delivery ? {} : o");
    // the title/tag/tid/visibility come from the delivered meta, not the node's own defaults
    expect(block).toMatch(/const streamMeta = delivery\s*\? \{ tid: delivery\.meta\.tid, tag: delivery\.meta\.tag, private: delivery\.meta\.private/);
    expect(block).not.toMatch(/o\.streamUpload(Tid|Tag|Private)/); // only through `manual`
    // all three title resolvers receive the delivered meta
    expect((block.match(/\.\.\.metaOverride/g) ?? []).length).toBe(3);
  });

  it("uses the verified credential path and the shared account accounting", () => {
    expect(block).toContain("managedCookies ?? zeroDiskUploadCookie(");
    expect(block).toContain("makeNodeSubmitGate({ cookiesPath: uploadCookies");
  });

  it("a managed run reports through the reporter (status + receipt) and never writes the node's own ledger", () => {
    const managed = block.indexOf("if (reporter) {");
    const legacy = block.indexOf("else if (res.ok && res.bvid) {", managed);
    expect(managed).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(managed);
    expect(block.slice(managed, legacy)).toContain("reporter.finish(");
    expect(block.slice(managed, legacy)).not.toContain("recordStreamUpload(");
    // the legacy (master-local) branch is the only recordStreamUpload caller
    expect(block.slice(legacy)).toContain("recordStreamUpload(");
    // part progress and failure paths reach the reporter too
    expect(block).toContain("reporter?.partConfirmed(info)");
    expect(block).toContain("reporter?.failed(");
  });
});

describe("master spec builder", () => {
  it("decides per node through planZeroDiskSpec and ships the delivery with the spec", () => {
    expect(cli).toContain("planZeroDiskSpec({");
    expect(cli).toContain("...(zeroDiskDelivery ? { zeroDiskDelivery } : {})");
    expect(cli).toContain("allowsPush: zeroDiskFleet.allowsPush(workerId)");
    expect(cli).toContain("ruleError: zeroDiskRuleError(src.streamUpload");
    expect(cli).toContain("masterCookiesPath: hubCfg.cookies");
  });
  it("probes capabilities before building specs and polls receipts after applying them", () => {
    const refresh = cli.indexOf("zeroDiskFleet.refreshSupport(");
    const apply = cli.indexOf("await t.applyTasks({ desired");
    const poll = cli.indexOf("zeroDiskFleet.poll(");
    expect(refresh).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(refresh);
    expect(poll).toBeGreaterThan(apply);
  });
});
