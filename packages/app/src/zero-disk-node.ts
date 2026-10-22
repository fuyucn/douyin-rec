/**
 * zero-disk-node.ts — node-side half of "zero-disk on a single side node" (issue #331).
 *
 * A hub-managed node never reads master configuration: the master delivers the upload metadata,
 * the expected account key and a fallback credential path inside the task spec. This module owns
 * (1) the pre-start verification that refuses loudly instead of falling back to defaults,
 * (2) the status file + receipt files the master polls through `_zero-disk-report`, and
 * (3) the master-side builder of the delivery object (single source of what gets shipped).
 * Receipts and status are plain JSON files: read-only for the master, written atomically.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  biliAccountKeyFromCookiesJson,
  isKnownAccountKey,
  normalizeZeroDiskReceipt,
  zeroDiskStreamKey,
  normalizeZeroDiskStatus,
  parseZeroDiskDelivery,
  zeroDiskAccountVerdict,
  type ZeroDiskDelivery,
  type ZeroDiskNodeStatus,
  type ZeroDiskReceipt,
  type ZeroDiskRefusal,
  type ZeroDiskReport,
  type UploadGateStore,
  openUploadLimitStore,
} from "@drec/core";
import { platformForRoom } from "@drec/core";
import {
  NODE_UPLOAD_COOLDOWN_MS, NODE_UPLOAD_RATE_LIMIT, NODE_UPLOAD_WINDOW_MS, openNodeUploadGate, resolveUploadAccountKey,
} from "./node-pipeline.js";
import { resolveRollingUploadMeta } from "./rolling-upload.js";
import { rootBiliupCookies, rootConfigDir, rootDbPath } from "./paths.js";

/** Receipts older than this are pruned by the node (the master has long applied them). */
export const ZERO_DISK_RECEIPT_TTL_MS = 30 * 24 * 3600_000;

export type ZeroDiskCredentialSource = "env" | "node-default" | "delivered-path";

/**
 * Pick the upload login file on the node. Order is fixed: the node's own login first (the
 * existing node-side upload behavior: BILIUP_COOKIE, then the data-root default), then the path
 * the master delivered. Only existence is checked here; identity is verified separately.
 */
export function resolveNodeUploadCredential(o: {
  env?: NodeJS.ProcessEnv;
  nodeDefaultPath?: string;
  deliveredPath?: string;
  exists?: (p: string) => boolean;
}): { path: string; source: ZeroDiskCredentialSource } | null {
  const exists = o.exists ?? existsSync;
  const envPath = (o.env ?? process.env).BILIUP_COOKIE?.trim();
  if (envPath && exists(envPath)) return { path: envPath, source: "env" };
  const nodeDefault = o.nodeDefaultPath ?? rootBiliupCookies();
  if (exists(nodeDefault)) return { path: nodeDefault, source: "node-default" };
  if (o.deliveredPath && exists(o.deliveredPath)) return { path: o.deliveredPath, source: "delivered-path" };
  return null;
}

export type ZeroDiskPreflight =
  | { ok: true; delivery: ZeroDiskDelivery; cookiesPath: string; credentialSource: ZeroDiskCredentialSource }
  | { ok: false; refusal: ZeroDiskRefusal };

/**
 * Everything that must hold before a hub-managed node may start a zero-disk upload. Any failure
 * is a refusal with a stable code; there is no fallback to defaults, because publishing to the
 * wrong account or with the wrong visibility cannot be undone.
 */
export function zeroDiskNodePreflight(
  rawDelivery: string | null | undefined,
  o: {
    env?: NodeJS.ProcessEnv;
    nodeDefaultPath?: string;
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string;
  } = {},
): ZeroDiskPreflight {
  const refuse = (code: ZeroDiskRefusal["code"], message: string): ZeroDiskPreflight => ({ ok: false, refusal: { code, message } });
  if (!rawDelivery) return refuse("delivery_missing", "master did not deliver zero-disk upload metadata for this task");
  let parsed: unknown;
  try { parsed = JSON.parse(rawDelivery); } catch { return refuse("delivery_missing", "delivered zero-disk metadata is not valid JSON"); }
  const d = parseZeroDiskDelivery(parsed);
  if (!d.ok) return refuse("delivery_missing", d.error);
  const cred = resolveNodeUploadCredential({
    ...(o.env ? { env: o.env } : {}),
    ...(o.nodeDefaultPath ? { nodeDefaultPath: o.nodeDefaultPath } : {}),
    ...(d.value.credentialPath ? { deliveredPath: d.value.credentialPath } : {}),
    ...(o.exists ? { exists: o.exists } : {}),
  });
  if (!cred) return refuse("credential_missing", "no upload login file found on this node");
  let nodeKey: string;
  try {
    nodeKey = biliAccountKeyFromCookiesJson((o.readFile ?? ((p: string) => readFileSync(p, "utf-8")))(cred.path));
  } catch {
    return refuse("credential_missing", "upload login file on this node is unreadable");
  }
  const verdict = zeroDiskAccountVerdict(d.value.accountKey, nodeKey);
  if (verdict) return { ok: false, refusal: verdict };
  return { ok: true, delivery: d.value, cookiesPath: cred.path, credentialSource: cred.source };
}

/**
 * Pre-spawn check for a hub-managed zero-disk task. A refusal is also written to the status file so
 * the master console can show the reason (account mismatch, missing metadata, ...) without log access.
 */
export function preflightManagedZeroDiskTask(task: { room: string; zeroDiskDelivery: string | null }): ZeroDiskPreflight {
  const r = zeroDiskNodePreflight(task.zeroDiskDelivery);
  if (!r.ok) {
    const p = platformForRoom(task.room);
    writeZeroDiskStatus({
      platform: p.id,
      roomSlug: p.extractRoomSlug(task.room),
      state: "refused",
      code: r.refusal.code,
      message: r.refusal.message,
      parts: 0,
    });
  }
  return r;
}

// ───────────────────────── status + receipts (node-written, master-polled) ─────────────────────────

export function zeroDiskNodeDir(): string {
  return join(rootConfigDir(), "zero-disk");
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_");

/** Atomic JSON write (tmp + rename): the master may read at any moment. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n");
  renameSync(tmp, path);
}

type StatusFile = ZeroDiskNodeStatus & { pid?: number };

const statusPath = (platform: string, roomSlug: string): string =>
  join(zeroDiskNodeDir(), "status", `${safeName(platform)}.${safeName(roomSlug)}.json`);

/** Write the per-room status. Failures are swallowed: status is observability, never a reason to stop uploading. */
export function writeZeroDiskStatus(s: Omit<ZeroDiskNodeStatus, "v" | "updatedAt">, now: number = Date.now()): void {
  try {
    const file: StatusFile = { v: 1, ...s, updatedAt: now, pid: process.pid };
    writeJsonAtomic(statusPath(s.platform, s.roomSlug), file);
  } catch { /* observability only */ }
}

/**
 * Persist the outcome of one finished run. Written once per run id and never overwritten, so a
 * re-poll or a restarted master cannot see a different answer for the same run. Throws on write
 * failure: the caller must say so loudly, because the archive exists but the master cannot learn it.
 */
export function writeZeroDiskReceipt(r: Omit<ZeroDiskReceipt, "v">, now: number = Date.now()): { written: boolean } {
  const dir = join(zeroDiskNodeDir(), "receipts");
  const path = join(dir, `${safeName(r.id)}.json`);
  if (existsSync(path)) return { written: false };
  writeJsonAtomic(path, { v: 1, ...r });
  pruneReceipts(dir, now);
  return { written: true };
}

function pruneReceipts(dir: string, now: number): void {
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > ZERO_DISK_RECEIPT_TTL_MS) rmSync(p, { force: true });
    }
  } catch { /* best effort */ }
}

function readJsonDir(dir: string): unknown[] {
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out: unknown[] = [];
  for (const f of names) {
    try { out.push(JSON.parse(readFileSync(join(dir, f), "utf-8"))); } catch { /* skip torn/foreign file */ }
  }
  return out;
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * `_zero-disk-report` body: receipts + per-room status. A status stuck at "running" whose process
 * is gone is reported as "stopped" (killed / crashed), so the console never shows a dead run as live.
 */
export function buildZeroDiskReport(o: { isAlive?: (pid: unknown) => boolean } = {}): ZeroDiskReport {
  const alive = o.isAlive ?? pidAlive;
  const receipts = readJsonDir(join(zeroDiskNodeDir(), "receipts"))
    .map(normalizeZeroDiskReceipt)
    .filter((r): r is ZeroDiskReceipt => r !== null)
    .sort((a, b) => a.atMs - b.atMs);
  const status: ZeroDiskNodeStatus[] = [];
  for (const raw of readJsonDir(join(zeroDiskNodeDir(), "status"))) {
    const s = normalizeZeroDiskStatus(raw);
    if (!s) continue;
    const pid = (raw as { pid?: unknown }).pid;
    status.push(s.state === "running" && !alive(pid) ? { ...s, state: "stopped" } : s);
  }
  return { v: 1, receipts, status };
}

// ───────────────────────── master side: what to ship ─────────────────────────

export type ZeroDiskDeliveryBuild =
  | { ok: true; delivery: ZeroDiskDelivery }
  | { ok: false; error: string };

/**
 * Resolve the delivery object for one room x node. The metadata is resolved ONCE here with the
 * same resolver the local zero-disk path uses (rule > hub.config uploadDefaults > built-ins), so a
 * node and the master can never disagree on title / partition / tags / visibility.
 * The account key is the master-configured upload account; if it cannot be identified nothing is
 * shipped, because the node could not be verified against it.
 */
export function buildZeroDiskDelivery(o: {
  platform: string;
  roomSlug: string;
  /** Node data root as configured on the master (for the fallback credential path). */
  workerDataRoot?: string;
  masterCookiesPath?: string;
}): ZeroDiskDeliveryBuild {
  const accountKey = resolveUploadAccountKey(o.masterCookiesPath);
  if (!isKnownAccountKey(accountKey)) {
    return { ok: false, error: "主控的 B 站上传账号无法识别(未登录或登录文件缺少账号 ID),无法校验节点账号,暂不下发 0 落盘" };
  }
  const { meta, private: isPrivate } = resolveRollingUploadMeta(o.platform, o.roomSlug);
  return {
    ok: true,
    delivery: {
      v: 1,
      meta: {
        tid: meta.tid,
        tag: meta.tag,
        private: isPrivate,
        ...(meta.desc ? { desc: meta.desc } : {}),
        ...(meta.titleTemplate ? { titleTemplate: meta.titleTemplate } : {}),
        ...(meta.submissionTitleTemplate ? { submissionTitleTemplate: meta.submissionTitleTemplate } : {}),
        ...(meta.partTitleTemplate ? { partTitleTemplate: meta.partTitleTemplate } : {}),
      },
      accountKey,
      ...(o.workerDataRoot ? { credentialPath: posix.join(o.workerDataRoot, "config", "biliup", "cookies.json") } : {}),
    },
  };
}

// ───────────────────────── shared upload-account accounting ─────────────────────────

/**
 * Account accounting for zero-disk archive submissions on a node (issue #331, item 7).
 *
 * Zero-disk holds a live stream for hours, so it can never wait on the account gate the way a
 * queued upload does (a 30 minute cooldown here would drop live video). Instead it is a good
 * neighbour: every submit is recorded in the same per-account window rolling / queue uploads on this
 * node wait on, and a rate-limit answer cools that account for them. Its own bounded retry stays.
 */
export function makeNodeSubmitGate(o: {
  cookiesPath: string;
  log?: (m: string) => void;
  store?: UploadGateStore;
  now?: () => number;
}): { noteSubmit(): void; noteRateLimited(): void } {
  const log = o.log ?? ((m: string) => console.error(m));
  const now = o.now ?? Date.now;
  const store = o.store ?? openUploadLimitStore(rootDbPath(), { log });
  const gate = openNodeUploadGate({ store, warn: log });
  const key = resolveUploadAccountKey(o.cookiesPath);
  return {
    noteSubmit(): void {
      // A refused claim (window full / cooling) means other uploads already use the quota; the live
      // submit proceeds anyway, but say so, so contention is visible in the task log.
      const claimed = store.tryClaim
        ? store.tryClaim(key, now(), NODE_UPLOAD_WINDOW_MS, NODE_UPLOAD_RATE_LIMIT)
        : false;
      if (!claimed) log("[live-pump] account upload window is busy or cooling; submitting anyway (live stream cannot wait)");
    },
    noteRateLimited(): void {
      gate.recordRateLimit(key, NODE_UPLOAD_COOLDOWN_MS);
    },
  };
}

/**
 * Decide how a zero-disk room is sent to one node (the single decision point for the spec builder).
 *
 * - local node (the master itself) and non-zero-disk rooms: untouched.
 * - not assigned to this node: nothing to deliver (the spec is disabled anyway).
 * - the rule itself violates the one-node policy (hand-edited file: no node / several nodes / burn):
 *   sent DISABLED with the reason on EVERY side node, so no node can create a second archive.
 * - node does not advertise support (old / unknown): sent DISABLED, so an old bundle never starts it
 *   with defaults; the console shows why (see ZeroDiskFleet.view).
 * - delivery cannot be built (master account unknown): sent DISABLED with a reason, never defaulted.
 *   Exception: a node that was already sent a good delivery keeps it (`stale`), because disabling the
 *   task stops a live upload, and the cause is usually a transient read of the master's login file.
 * - otherwise: sent enabled together with the resolved delivery object.
 */
export function planZeroDiskSpec(o: {
  streamUpload: boolean;
  workerId: string;
  assigned: boolean;
  enabled: boolean;
  allowsPush: boolean;
  /** `zeroDiskRuleError(true, rule)` of the room's hub rule; non-null blocks every side node. */
  ruleError?: string | null;
  build: () => ZeroDiskDeliveryBuild;
  /** Last delivery successfully built for this (node, room); reused only when a rebuild fails. */
  lastGood?: ZeroDiskDelivery;
}): { enabled: boolean; delivery?: ZeroDiskDelivery; blocked?: string; stale?: string } {
  if (!o.streamUpload || o.workerId === "local" || !o.assigned) return { enabled: o.enabled };
  if (o.ruleError) return { enabled: false, blocked: o.ruleError };
  if (!o.allowsPush) return { enabled: false };
  const built = o.build();
  if (built.ok) return { enabled: o.enabled, delivery: built.delivery };
  if (o.lastGood) return { enabled: o.enabled, delivery: o.lastGood, stale: built.error };
  return { enabled: false, blocked: built.error };
}

// ───────────────────────── run reporter (one per `record` process) ─────────────────────────

/**
 * Status + receipt bookkeeping of one managed zero-disk run. The CLI feeds it pump events; every
 * file write is the node's half of the master contract (`_zero-disk-report`).
 */
export function createZeroDiskReporter(o: {
  platform: string;
  roomSlug: string;
  /** Process start; makes the receipt id unique per run and stable across re-polls. */
  startMs?: number;
  now?: () => number;
}): {
  running(): void;
  partConfirmed(info: { count: number; bvid?: string }): void;
  /** `receiptError` is set when the archive exists but the receipt could not be persisted. */
  finish(res: { ok: boolean; bvid?: string; error?: string; segments: number }): { receiptWritten: boolean; receiptError?: string };
  failed(message: string): void;
} {
  const now = o.now ?? Date.now;
  const startMs = o.startMs ?? now();
  let parts = 0;
  let bvid: string | undefined;
  const write = (state: "running" | "finished" | "failed", message?: string): void => {
    writeZeroDiskStatus({
      platform: o.platform,
      roomSlug: o.roomSlug,
      state,
      parts,
      ...(bvid ? { bvid } : {}),
      ...(message ? { message: message.slice(0, 300) } : {}),
    });
  };
  return {
    running: () => write("running"),
    partConfirmed(info): void {
      parts = info.count;
      if (info.bvid) bvid = info.bvid;
      write("running");
    },
    finish(res): { receiptWritten: boolean; receiptError?: string } {
      if (res.bvid) bvid = res.bvid;
      parts = Math.max(parts, res.segments);
      if (!(res.ok && res.bvid)) {
        // Nothing was delivered by this run (idle / stopped while waiting) or it failed: no receipt.
        write(res.ok ? "finished" : "failed", res.error);
        return { receiptWritten: false };
      }
      try {
        // Same key formula as the master-local path: own `-zd` namespace + run start (issue #324).
        const atMs = now();
        const streamKey = zeroDiskStreamKey(o.platform, o.roomSlug, startMs);
        const r = writeZeroDiskReceipt({ id: `${o.platform}:${o.roomSlug}:${startMs}`, platform: o.platform, roomSlug: o.roomSlug, streamKey, startMs, bvid: res.bvid, parts, atMs }, atMs);
        write("finished");
        return { receiptWritten: r.written };
      } catch (e) {
        const msg = `archive uploaded but the receipt could not be written, the master ledger will not record it: ${(e as Error).message}`;
        write("failed", msg);
        return { receiptWritten: false, receiptError: msg };
      }
    },
    failed: (message) => write("failed", message),
  };
}
