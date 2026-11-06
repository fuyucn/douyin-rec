import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  nodeUploadPhaseLabel,
  nodeUploadStateLabel,
  partChainFields,
  partChainPolledAgo,
  partChainProgressPct,
  queueBadges,
  queueText,
  stepLabel,
  type PartChainUpload,
  type TFunc,
} from "../../packages/web/src/lib/queue-chain";

const WEB = join(__dirname, "..", "..", "packages", "web", "src");

/** Same extraction as scripts/check-i18n.mjs: i18n.tsx pulls React in, so do not import it. */
function loadDict(): { zh: Record<string, unknown>; en: Record<string, unknown> } {
  const src = readFileSync(join(WEB, "lib", "i18n.tsx"), "utf-8");
  const eq = src.indexOf("=", src.indexOf("const DICT"));
  const open = src.indexOf("{", eq);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  return (0, eval)("(" + src.slice(open, end) + ")");
}

const dict = loadDict();

function valueAt(lang: Record<string, unknown>, key: string): string | null {
  let cur: unknown = lang;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : null;
}

function makeT(lang: "zh" | "en"): TFunc {
  return (key, vars) => {
    const raw = valueAt(dict[lang], key);
    if (raw == null) return key;
    return Object.entries(vars ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), raw);
  };
}

const t = makeT("zh");

const NOW = new Date("2026-11-05T04:40:00Z").getTime();
const NOT_BEFORE = new Date("2026-11-05T04:34:00Z").getTime();

function upload(overrides: Partial<PartChainUpload> = {}): PartChainUpload {
  return {
    nodeId: "node-a",
    phase: "part-chain",
    state: "reconciling",
    step: "transfer",
    attempts: 2,
    notBefore: NOT_BEFORE,
    heartbeatAt: new Date("2026-11-05T04:39:00Z").getTime(),
    polledAt: NOW,
    progress: { doneBytes: 40e6, totalBytes: 100e6, bps: 2e6 },
    error: null,
    ...overrides,
  };
}

const USED_KEYS = [
  "queue.nodeUpload.partChain",
  "queue.nodeUpload.notBefore",
  "queue.nodeUpload.attempt",
  "queue.nodeUpload.heartbeat",
  "queue.nodeUpload.polledAgo",
  "queue.phase.reconciling",
  "queue.phase.reconcilingTip",
  "hub.jobs.stepNode.upload_part",
  "hub.jobs.stepNode.cleanup_part",
  "hub.jobs.stepNode.reconcile_part",
  ...["pending", "running", "reconciling", "skipped", "done", "failed", "uncertain", "cancelled"]
    .map((state) => `queue.nodeUpload.state.${state}`),
  ...["gate_wait", "transfer", "submit"].map((step) => `queue.nodeUpload.step.${step}`),
];

describe("queue chain i18n keys", () => {
  it("uses real zh/en dictionary keys (missing or typoed key goes red)", () => {
    const missingZh = USED_KEYS.filter((key) => valueAt(dict.zh, key) == null);
    const missingEn = USED_KEYS.filter((key) => valueAt(dict.en, key) == null);
    expect(missingZh).toEqual([]);
    expect(missingEn).toEqual([]);
  });
});

describe("queue chain presentation facts", () => {
  it("adds no badge without a node-upload status", () => {
    expect(queueBadges({ nodeUpload: null }, t)).toEqual([]);
    expect(queueBadges({ nodeUpload: { phase: "biliup", state: "running" } }, t)).toEqual([]);
  });

  it("shows the part-chain badge from the node-upload phase", () => {
    expect(queueBadges({ nodeUpload: { phase: "part-chain", state: "running" } }, t))
      .toEqual([{ kind: "part-chain", label: "分 P 链" }]);
  });

  it("shows reconciling from NodeUploadStatusDTO.state, not the hub job state", () => {
    expect(queueBadges({ nodeUpload: { phase: "part-chain", state: "reconciling" } }, t)).toEqual([
      { kind: "part-chain", label: "分 P 链" },
      {
        kind: "reconciling",
        label: "自动对账中",
        title: valueAt(dict.zh, "queue.phase.reconcilingTip"),
      },
    ]);
  });

  it("maps chain kinds and translates node-upload phase/state labels", () => {
    expect(stepLabel(t, "upload-part")).toBe("上传分 P");
    expect(stepLabel(t, "cleanup-part")).toBe("清理分 P");
    expect(stepLabel(t, "reconcile-part")).toBe("对账分 P");
    expect(stepLabel(t, "unknown-step")).toBe("unknown-step");
    expect(nodeUploadPhaseLabel(t, "part-chain")).toBe("分 P 链");
    expect(nodeUploadStateLabel(t, "reconciling")).toBe("自动对账中");
    expect(nodeUploadStateLabel(t, "mystery")).toBe("mystery");
    expect(queueText(t, "missing.key", "raw-value")).toBe("raw-value");
  });

  it("prints translated backend part-chain fields in a fixed order", () => {
    expect(partChainFields(upload(), t, "12:34", NOW)).toEqual([
      "自动对账中",
      "传输中",
      "第 2 次",
      "最早重试 12:34",
      "心跳 60前",
    ]);
    expect(partChainProgressPct(upload())).toBe(40);
    expect(partChainProgressPct(upload({ progress: null }))).toBeNull();
    expect(partChainPolledAgo(upload({ polledAt: NOW - 9_000 }), t, NOW)).toBe("状态更新于 9 秒前");
    expect(partChainPolledAgo(upload({ polledAt: NOW - 9_000 }), t, NOW)).not.toContain("stale");
  });

  it("has the same key set in zh and en", () => {
    for (const key of USED_KEYS) {
      expect(valueAt(dict.en, key), key).not.toBeNull();
      expect(valueAt(dict.zh, key), key).not.toBeNull();
    }
  });
});
