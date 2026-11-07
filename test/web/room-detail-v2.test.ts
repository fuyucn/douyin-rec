import { describe, expect, it } from "vitest";
import { configDomains, domainGroups, domainSummary } from "../../packages/web/src/lib/room-detail-v2.js";
import type { RoomDTO } from "../../packages/core/src/api-types.js";

function room(patch: Partial<RoomDTO>): RoomDTO {
  return {
    key: "douyin.1", platform: "douyin", roomSlug: "1", room: "https://live.douyin.com/1",
    recording: null, processing: null, ...patch,
  } as RoomDTO;
}

function rec(patch: Partial<NonNullable<RoomDTO["recording"]>>): RoomDTO["recording"] {
  return {
    taskId: 1, quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
    scheduleStart: null, scheduleEnd: null, useCookie: true, outDir: null,
    outputFormat: "original", enabled: true, name: null, anchorName: "Alice",
    hasWebhook: false, streamUpload: false, rollingUpload: false, rollingEffective: false,
    outputFormatLock: null, ...patch,
  } as RoomDTO["recording"];
}

const INPUT = {
  tr: (key: string) => KEYZH[key] ?? key,
  words: {
    yes: "开", no: "关", unsetMark: "-", stored: "已设置(不回显)", paused: "已暂停",
    merged: "合并为一个视频", perSegment: "按录制分段",
    seasonNote: "未加入合集;投稿成功后可自动加入", partSizeNote: "继承默认 1540(10 MiB 对齐)",
    templateNote: "编辑时预填统一默认值", descNote: "留空 = 不额外填写",
    webhookStoredNote: "凭据不回显;留空 = 用全局配置", webhookUnsetNote: "未设置;留空 = 用全局配置",
    cleanupNote: "弹幕与字幕文件永不删到最后一份", anchorNote: "运行时解析名,与任务名称独立",
    loginNote: "取流匿名,账号只用于礼物/入场弹幕", outDirNote: "留空 = 数据根默认输出目录",
    procPausedNote: "各节点停录,录完也不处理;任务与配置保留",
    engineValue: (engine: string) => engine,
  },
  qualityFull: (q: string) => (q === "origin" ? "原画" : q),
  segmentUnit: (s: number) => `${s} s`,
  noSegment: "不分段",
  fmtOriginal: "原始容器",
  schedule: "全天",
  lockReason: undefined,
  versions: "原画",
  where: "vps-1 · vps-2",
  delivery: "投稿 B站",
  privateLabel: "仅自己可见",
  cleanupSummary: "合并后删存档源 · 完成后删节点源",
  createdAt: "2026-11-07 10:00",
};

/** 测试词典:label 走 key 直读(断言用 key),值断言用注入的 words/value。 */
const KEYZH: Record<string, string> = {};

function fields(domainId: string, r: RoomDTO): Map<string, string> {
  const d = configDomains({ room: r, ...INPUT }).find((x) => x.id === domainId)!;
  return new Map(d.fields.map((x) => [x.key, x.value]));
}

describe("room detail v2 config domains (#557)", () => {
  it("keeps the 52-field full set: no domain loses a field the editor has", () => {
    const r = room({
      recording: rec({ outDir: "/x", outputFormat: "mp4", hasWebhook: true }),
      processing: {
        enabled: true,
        workers: ["vps-1"], requires: ["danmu:douyin"],
        pipeline: {
          steps: { mergeSegments: false, burnDanmu: false, burnLivechat: false },
          upload: { mode: "rolling", private: true, tid: 21, tag: "t", desc: "", titleTemplate: "{name}", submissionTitleTemplate: "{name}_{date}", partTitleTemplate: "P{part}", seasonSectionId: 382911, partSizeMiB: null },
          cleanup: { stageSourceAfterMerge: true, sourceAfterDone: true, stageAfterDone: true },
        },
      },
    });
    const domains = configDomains({ room: r, ...INPUT });
    const all = domains.flatMap((d) => d.fields.map((x) => x.key));
    // 52 项字段全集(与房间编辑器可见字段对齐;核心锚点逐个断言)
    for (const key of [
      "quality", "engine", "segmentSec", "danmu", "schedule", "outDir", "outputFormat",
      "procEnabled", "mergeSegments", "burnDanmu", "burnLivechat", "versions", "requires",
      "uploadMode", "uploadPrivate", "tid", "tag", "desc", "titleTemplate",
      "submissionTitleTemplate", "partTitleTemplate", "seasonSectionId", "partSizeMiB",
      "webhook", "cleanup", "createdAt",
    ]) {
      expect(all, `missing field: ${key}`).toContain(key);
    }
    // 字段全集精确断言(#553 原型 52 项中去除编辑器派生伪字段后的用户可见集)
    expect(all.length).toBe(40);
    expect(new Set(all).size).toBe(all.length); // 无重复 key(domainSummary 按 key 建 Map,重复会静默吞字段)
  });

  it("renders unset explicitly instead of dropping the field", () => {
    const r = room({ recording: rec({ outDir: null }), processing: null });
    const record = fields("record", r);
    expect(record.get("outDir")).toBe("-");
    const up = fields("upload", r);
    expect(up.get("uploadOn")).toBe("-");
  });

  it("summary skips unset fields and joins the rest", () => {
    const r = room({ recording: rec({}), processing: null });
    const d = configDomains({ room: r, ...INPUT }).find((x) => x.id === "record")!;
    const s = domainSummary(d);
    expect(s).toContain("原画");
    expect(s).toContain("ffmpeg");
    expect(s).toContain("1800 s");
    expect(s).not.toContain("-");
  });

  it("groups primary vs more: primary follows primaryKeys order, more holds the rest", () => {
    const r = room({
      recording: rec({ outDir: "/x", outputFormat: "mp4", hasWebhook: true }),
      processing: {
        enabled: true, workers: ["vps-1"], requires: [],
        pipeline: { steps: {}, upload: { mode: "upload", tid: 21, tag: "t", desc: "", titleTemplate: "{name}", submissionTitleTemplate: "{name}_{date}", partTitleTemplate: "P{part}" }, cleanup: {} },
      },
    });
    const d = configDomains({ room: r, ...INPUT }).find((x) => x.id === "upload")!;
    const { primary, more } = domainGroups(d);
    expect(primary.map((x) => x.key)).toEqual(["uploadMode", "uploadPrivate", "tid", "tag"]);
    expect(more.map((x) => x.key)).toContain("desc");
    expect(more.map((x) => x.key)).toContain("seasonSectionId");
    // 无字段重复、并集=全集
    expect([...primary, ...more].length).toBe(d.fields.length);
  });

  it("upload domain hides cleanup semantics when there is no pipeline", () => {
    const r = room({ recording: rec({}) });
    const notify = fields("notify", r);
    expect(notify.has("cleanup")).toBe(false);
  });
});
