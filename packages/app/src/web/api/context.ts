/**
 * web/api/context.ts — 各域 handler 共享的**上下文与辅助**(T-22 第 1 步)。
 *
 * 从原 web/api.ts 的 makeApi() 闭包里抽出:凡被 ≥2 个域用到的辅助都放这里,
 * 避免域文件之间互相 import(会造成循环)。各域统一签名 `buildXxx(ctx: ApiCtx)`。
 */
import { join } from "node:path";
import {
  listPlatforms, platformForRoom, validateTitleTemplate, validateLooseTitleTemplate,
  type WorkerDTO, type HubRulePayload, type HubRuleDTO, type BiliupAuthStatus, type RecordingWorkerStatusDTO,
} from "@drec/core";
import * as hubStore from "../../hub-store.js";
import * as workerStore from "../../worker-store.js";
import { rootHubDir, rootHubConfig, resolveOutputDir } from "../../paths.js";
import { resolveTaskCookies, type Task } from "../../store.js";
import { readBiliupCookieHeader } from "../../upload/biliup.js";
import { listHubJobs } from "../../hub-jobs.js";
import { hasSessionCookie, parseCookieExpiry } from "../../cookie-utils.js";
import type { ApiDeps, ApiResult, CookieStatus, TaskView, TaskDetailView } from "./types.js";

/** 各域 handler 拿到的共享上下文(依赖 + 解析好的路径 + 复用辅助)。 */
export interface ApiCtx {
  deps: ApiDeps;
  store: ApiDeps["store"];
  manager: ApiDeps["manager"];
  /** hub 任务配置目录(文件版,现读不缓存)。 */
  hubDir: string;
  /** hub.config.json 路径(worker 数组真理源)。 */
  hubConfigPath: string;
  // ── 共享辅助 ──
  err: (status: number, message: string) => ApiResult;
  isHubSourceTask: (id: number) => boolean;
  workerToDto: (w: workerStore.WorkerConfig) => WorkerDTO;
  resolveAnchorBg: (taskId: number, room: string, opts?: { throttleMs?: number }) => void;
  view: (t: Task) => TaskView;
  detailView: (t: Task) => TaskDetailView;
  validateWorkers: (input: HubRulePayload) => string | null;
  validatePipeline: (input: HubRulePayload) => string | null;
  hubRuleView: (r: hubStore.HubRule) => HubRuleDTO;
  recordingError: (sourceTaskId: number | null | undefined, roomSlug: string) => string | null;
  recordingsDir: (t: Task) => string | null;
  platformCookie: (platform: string) => { value: string | null; source: CookieStatus["source"] };
  biliupStatus: () => BiliupAuthStatus;
  validCookiePlatform: (platform: string) => boolean;
  sanitizeSeg: (name: string) => string;
  normWebhook: (v: string | null | undefined) => string | null;
  toUseCookie: (v: number | boolean | undefined) => boolean;
  cookieStatus: (platform: string, value: string | null, source?: CookieStatus["source"]) => CookieStatus;
}

/** 建上下文:解析路径 + 构造共享辅助(行为与拆分前 makeApi 闭包一致)。 */
export function buildCtx(deps: ApiDeps): ApiCtx {
  const { store, manager } = deps;
  const hubDir = deps.hubDir ?? rootHubDir();
  const hubConfigPath = deps.hubConfigPath ?? rootHubConfig();

  const err = (status: number, message: string): ApiResult => ({ status, body: { error: message } });

  // 该任务是否被任一 hub 规则绑定为 source task(只有这类任务变更后才需立即同步)。
  // 不按 rule.enabled 过滤(规则停用时 sourceTaskId 仍指向该任务;是否下发由 desiredFor 决定)。
  const isHubSourceTask = (id: number): boolean =>
    hubStore.listHubRules(hubDir).some((r) => r.recording?.sourceTaskId === id);

  const workerToDto = (w: workerStore.WorkerConfig): WorkerDTO => ({
    id: w.id, name: w.name ?? w.id, kind: w.kind, host: w.host, dataRoot: w.dataRoot, apiUrl: w.apiUrl,
    capabilities: w.capabilities,
  });

  // 后台抓主播名写回 store(创建/改房间号时)。去重/节流:同一任务抓取中跳过;throttleMs 窗口内不重抓。
  const anchorInFlight = new Set<number>();
  const anchorLastAttempt = new Map<number, number>();
  const resolveAnchorBg = (taskId: number, room: string, opts: { throttleMs?: number } = {}): void => {
    if (anchorInFlight.has(taskId)) return;
    if (opts.throttleMs && opts.throttleMs > 0) {
      const last = anchorLastAttempt.get(taskId) ?? 0;
      if (Date.now() - last < opts.throttleMs) return;
    }
    anchorInFlight.add(taskId);
    anchorLastAttempt.set(taskId, Date.now());
    void (async () => {
      let r = room;
      const platform = platformForRoom(r);
      const slug = platform.extractRoomSlug(r);
      if (deps.resolveShortUrl && platform.resolveShortUrl && !/^\d+$/.test(slug)) {
        const roomId = await deps.resolveShortUrl(r).catch(() => null);
        if (roomId) { r = platform.roomToUrl(roomId); store.updateTask(taskId, { room: r }); }
      }
      if (deps.resolveAnchor) {
        const t = store.getTask(taskId);
        const cookies = t ? resolveTaskCookies(t, store.getDefaultCookies()) : null;
        const name = await deps.resolveAnchor(r, cookies).catch(() => null);
        if (name) store.setAnchorName(taskId, name);
      }
    })().catch(() => {}).finally(() => anchorInFlight.delete(taskId));
  };

  // 显示用主播名:运行时(录制中 [主播] 日志解析)优先,否则持久化的(创建时抓的)。
  const view = (t: Task): TaskView => {
    let workers: RecordingWorkerStatusDTO[] | undefined;
    let hubRule: TaskView["hubRule"];
    if (deps.recordingWorkers || deps.hubEnabled) {
      const platform = platformForRoom(t.room);
      const roomSlug = platform.extractRoomSlug(t.room);
      if (deps.recordingWorkers) workers = deps.recordingWorkers(platform.id, roomSlug);
      if (deps.hubEnabled) {
        const rule = hubStore.getHubRule(hubDir, hubStore.hubKey(platform.id, roomSlug));
        if (rule) {
          const p = rule.pipeline ?? {};
          const steps = ["plain"];
          if (p.steps?.burnDanmu !== false) steps.push("danmu");
          if (p.steps?.burnLivechat !== false) steps.push("livechat");
          let lastRun: { state: string; bv: string | null } | null = null;
          if (deps.syncDbPath) {
            const r = listHubJobs(deps.syncDbPath, { room: rule.key, limit: 1 }).jobs[0];
            if (r) lastRun = { state: r.state, bv: r.bv };
          }
          hubRule = {
            key: rule.key, enabled: rule.enabled, steps,
            uploadMode: p.upload?.mode === "upload" ? "upload" : "stage", lastRun,
          };
        }
      }
    }
    return {
      ...t,
      running: manager.isRunning(t.id),
      anchorName: manager.getAnchorName(t.id) ?? t.anchorName,
      recording: manager.isRecording(t.id),
      // 空数组不下发:前端 recordingWorkers?.length 判定依赖它。
      ...(workers && workers.length > 0 ? { recordingWorkers: workers } : {}),
      ...(hubRule ? { hubRule } : {}),
    };
  };
  const detailView = (t: Task): TaskDetailView => ({ ...view(t), runtime: manager.getRuntime(t.id) });

  // workers 校验:present 时必须是非空 string[] 且每个 id 真实存在(幽灵 id 会静默漏录)。
  const validateWorkers = (input: HubRulePayload): string | null => {
    if (!("workers" in input) || input.workers === undefined) return null;
    const w = input.workers;
    if (!Array.isArray(w) || w.length === 0) return "workers 必须是非空 worker id 列表";
    if (!w.every((x) => typeof x === "string" && x.trim().length > 0)) return "workers 每项必须是非空字符串(worker id)";
    const known = new Set(workerStore.listWorkers(hubConfigPath).map((x) => x.id));
    const missing = w.map((x) => String(x).trim()).filter((x) => !known.has(x));
    if (missing.length > 0) return `workers 含未配置的 worker id: ${[...new Set(missing)].join(", ")}`;
    return null;
  };
  const validatePipeline = (input: HubRulePayload): string | null => {
    const tmpl = input.pipeline?.upload?.titleTemplate;
    if (tmpl != null && String(tmpl).trim()) {
      const e = validateTitleTemplate(String(tmpl));
      if (e) return e;
    }
    for (const loose of [input.pipeline?.upload?.submissionTitleTemplate, input.pipeline?.upload?.partTitleTemplate]) {
      if (loose == null || !String(loose).trim()) continue;
      const e = validateLooseTitleTemplate(String(loose));
      if (e) return e;
    }
    return null;
  };

  // hub 规则 → DTO:补 anchorName(若有同 roomSlug 的录制任务,显示其主播名/任务名)。
  const hubRuleView = (r: hubStore.HubRule): HubRuleDTO => {
    const srcTask = r.recording?.sourceTaskId
      ? store.listTasks().find(
          (task) => task.id === r.recording!.sourceTaskId &&
            platformForRoom(task.room).extractRoomSlug(task.room) === r.roomSlug,
        ) ?? null
      : null;
    const t = srcTask ?? store.listTasks().find(
      (task) => platformForRoom(task.room).extractRoomSlug(task.room) === r.roomSlug,
    );
    const anchorName = t ? manager.getAnchorName(t.id) ?? t.anchorName ?? null : null;
    const taskName = t?.name ?? null;
    return {
      key: r.key, roomSlug: r.roomSlug,
      room: r.room || srcTask?.room || "",
      platform: r.platform, enabled: r.enabled, pipeline: r.pipeline,
      workers: r.workers, requires: r.requires, recording: r.recording,
      sourceTask: srcTask
        ? { id: srcTask.id, room: srcTask.room, name: srcTask.name, anchorName: srcTask.anchorName, enabled: srcTask.enabled }
        : null,
      anchorName, taskName,
    };
  };

  const recordingError = (sourceTaskId: number | null | undefined, roomSlug: string): string | null => {
    if (!sourceTaskId) return null;
    const t = store.getTask(Number(sourceTaskId));
    if (!t) return "recording.sourceTaskId 指向的任务不存在";
    if (platformForRoom(t.room).extractRoomSlug(t.room) !== roomSlug) return "recording.sourceTaskId 与规则房间不一致";
    return null;
  };

  // 名字净化成单个安全路径段(与 @drec/record-engine 的 sanitizePathSegment 同规则)。
  const sanitizeSeg = (name: string): string =>
    name.replace(/[/\\:*?"<>|]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/\s+/g, " ").trim();

  const recordingsDir = (t: Task): string | null => {
    const outDir = resolveOutputDir(t.outDir);
    const anchor = manager.getAnchorName(t.id) ?? t.anchorName ?? "";
    const sub = (t.name ? sanitizeSeg(t.name) : "") || (anchor ? sanitizeSeg(anchor) : "");
    return sub ? join(outDir, sub) : null;
  };

  const platformCookie = (platform: string): { value: string | null; source: CookieStatus["source"] } => {
    const stored = store.getPlatformCookies(platform);
    if (stored) return { value: stored, source: "settings" };
    return { value: null, source: "none" };
  };
  const biliupStatus = (): BiliupAuthStatus => {
    const value = readBiliupCookieHeader(deps.biliupCookiesPath)?.trim() ?? "";
    return {
      set: value.length > 0,
      hasSession: value.length > 0 && hasSessionCookie(value, "bilibili"),
      length: value.length,
      source: value ? "biliup" : "none",
    };
  };
  const validCookiePlatform = (platform: string): boolean => listPlatforms().some((p) => p.id === platform);

  const normWebhook = (v: string | null | undefined): string | null => {
    const s = (v ?? "").trim();
    return s.length > 0 ? s : null;
  };
  const toUseCookie = (v: number | boolean | undefined): boolean => (v === undefined ? true : Boolean(v));

  const cookieStatus = (platform: string, value: string | null, source: CookieStatus["source"] = value ? "settings" : "none"): CookieStatus => {
    const v = (value ?? "").trim();
    return {
      platform,
      set: v.length > 0,
      hasSession: v.length > 0 && hasSessionCookie(v, platform),
      length: v.length,
      expiresAt: platform === "douyin" && v.length > 0 ? parseCookieExpiry(v) : null,
      source: v ? source : "none",
    };
  };

  return {
    deps, store, manager, hubDir, hubConfigPath,
    err, isHubSourceTask, workerToDto, resolveAnchorBg, view, detailView,
    validateWorkers, validatePipeline, hubRuleView, recordingError, recordingsDir,
    platformCookie, biliupStatus, validCookiePlatform,
    sanitizeSeg, normWebhook, toUseCookie, cookieStatus,
  };
}
