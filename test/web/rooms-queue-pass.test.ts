import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "packages", "web", "src");
const ROOMS = readFileSync(join(SRC, "pages", "RoomsPage.tsx"), "utf-8");
const QUEUE = readFileSync(join(SRC, "pages", "QueuePage.tsx"), "utf-8");
const QUEUE_LIVE = readFileSync(join(SRC, "components", "QueueLive.tsx"), "utf-8");
const CSS = readFileSync(join(SRC, "index.css"), "utf-8");

/**
 * #552 rooms+queue 减法 pass 的展示层回归：
 * 钉住筛选 chip 化、告警一条一条、WorkersPanel 自 rooms 退场、queue 空组隐藏与
 * 全站方形状态点——撤掉任一实现，对应用例变红。
 */
describe("rooms list subtractive pass (#552)", () => {
  it("filters are aria-pressed chips, not a tablist telemetry band", () => {
    expect(ROOMS).toContain('className="room-filters mb-4" role="group"');
    expect(ROOMS).toContain('aria-pressed={filter === f}');
    expect(ROOMS).not.toContain('role="tablist"');
    expect(ROOMS).not.toContain('role="tab"');
    expect(ROOMS).not.toContain("telemetry-cell");
  });

  it("node entry is a plain /nodes link, WorkersPanel is gone from rooms", () => {
    expect(ROOMS).toContain('to="/nodes"');
    expect(ROOMS).not.toContain("WorkersPanel");
    expect(ROOMS).not.toContain("openWorkers");
  });

  it("alert band lists up to 3 rooms, one row each", () => {
    expect(ROOMS).toContain("rm-alert-list");
    expect(ROOMS).toContain("attention.slice(0, 3)");
    expect(ROOMS).not.toContain("room.alertCount");
  });

  it("empty state distinguishes the attention filter", () => {
    expect(ROOMS).toContain('attentionOnly={filter === "attention"}');
    expect(ROOMS).toContain('attentionOnly ? t("rooms.noAttention")');
  });

  it("status detail keeps 2 lines and platform chip drops the 10px uppercase badge", () => {
    expect(ROOMS).toContain('className="status-detail"');
    expect(ROOMS).toContain("room-plat-chip");
    expect(ROOMS).not.toContain('!text-[10px] uppercase');
    expect(CSS).toMatch(/\.status-detail \{[^}]*-webkit-line-clamp: 2/s);
    expect(CSS).toMatch(/\.room-plat-chip \{[^}]*font-size: 11\.5px/s);
  });

  it("schedule lives under the room cell, not as its own column", () => {
    expect(ROOMS).toContain("room-sched");
    expect(ROOMS).not.toContain('t("room.colSchedule")');
  });

  it("icon actions survive: start/stop/logs/edit keep their icon form", () => {
    expect(ROOMS).toContain('<Square className="w-4 h-4"');
    expect(ROOMS).toContain('<Play className="w-4 h-4"');
    expect(ROOMS).toContain('<Pencil className="w-4 h-4"');
    expect(ROOMS).toContain("<FileText className=\"w-4 h-4\" />");
  });
});

describe("queue visual pass (#552)", () => {
  it("overview band is quiet data: no duplicated numbers (F1), no icons in counts, square health dot", () => {
    // F1(hy4): <b>{n}</b> 与文案 {n} 是同一个数字的两套写法 —— 不允许再出现数字重复
    expect(QUEUE).not.toContain("<b>{counts.running}</b>");
    expect(QUEUE).toContain('t("queue.flow.count.running", { n: counts.running })');
    expect(QUEUE).not.toContain("<Loader2 className=\"w-3.5 h-3.5\" />{t(\"queue.flow.count.running\"");
    expect(CSS).toMatch(/\.queue-node-health \.dot \{ width: 7px; height: 7px; border-radius: 2px/s);
  });

  it("groups lose the card box; empty groups hide; a single idle bar covers the all-empty page", () => {
    expect(CSS).toMatch(/\.queue-group \{ border: 0;/);
    expect(CSS).toContain('.queue-group[data-empty="true"] { display: none; }');
    expect(CSS).toContain(".queue-idle-bar");
    expect(QUEUE).toContain('data-empty={empty || undefined}');
    expect(QUEUE).toContain('t("queue.flow.idle", { n: flow.counts.done })');
  });

  it("attention rows carry the only strong colour (2px left rule) with severity variants", () => {
    expect(CSS).toContain('.queue-row[data-group="attention"] { border-left: 2px solid var(--error);');
    expect(CSS).toContain('.queue-row[data-group="attention"][data-severity="warning"] { border-left-color: var(--warning); }');
    expect(CSS).not.toContain('.queue-group[data-group="attention"] { border-color:');
  });

  it("resource pool is one quiet line, not a 3-cell telemetry band", () => {
    expect(QUEUE_LIVE).toContain("queue-pool-line");
    expect(QUEUE_LIVE).not.toContain("telemetry-bar");
    expect(QUEUE_LIVE).not.toContain("<Gauge");
    expect(QUEUE_LIVE).not.toContain("<ArrowRight");
    expect(QUEUE_LIVE).not.toContain("<Timer");
  });

  it("step pipeline drops mono 11px chips, glyph pulse and decorative borders", () => {
    expect(CSS).toMatch(/\.queue-flow-step \{[^}]*font-family: var\(--font-sans\); font-size: 12\.5px/s);
    expect(CSS).toContain(".queue-flow-step[data-state=\"current\"] .queue-flow-glyph { color: var(--accent); animation: none; }");
    expect(CSS).not.toContain("queue-pulse");
    // 分隔点用可读的 muted 色,不是几乎不可见的 hairline
    expect(CSS).toMatch(/\.queue-flow-step \+ \.queue-flow-step::before \{ content: "·"; margin-right: 8px; color: var\(--muted-soft\); \}/);
  });

  it("action buttons are quiet 12.5px text, not bordered 11px chips", () => {
    expect(CSS).toMatch(/\.queue-action-btn \{[^}]*font: 400 12\.5px\/1 var\(--font-sans\)/s);
    expect(CSS).not.toMatch(/\.queue-action-btn \{[^}]*border: 1px solid/s);
  });

  it("live lanes align with flow rows: no card, no phase rail, no entrance animation", () => {
    expect(CSS).toMatch(/\.live-lane \{[^}]*animation: none;/s);
    expect(CSS).toContain(".live-lane::before {\n  display: none;\n}");
    expect(CSS).not.toContain("@keyframes lane-in");
  });

  it("node queue section title joins the 15px group-title level", () => {
    expect(QUEUE).toContain('className="queue-support-title"');
    expect(QUEUE.split("section-label").length - 1).toBe(0);
    expect(CSS).toMatch(/\.queue-support-title \{ font-size: 15px; font-weight: 600;/);
  });
});
