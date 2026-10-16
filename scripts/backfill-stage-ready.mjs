#!/usr/bin/env node
/**
 * backfill-stage-ready.mjs — 给**存量**台账补写 stage 正常收口的 error 标记(issue #188)。
 *
 * 背景:修复前,stage 模式正常收口落 `needs_manual` 时不写 error;同时「所有节点均断流」这条
 * **真事故**也不写 error。修复后新写入都带原因,但存量行仍为空 —— 部署后会全部显示成红灯。
 * 只看 error 无法区分两者,故本脚本**只报告不修改**,由人逐条判定后再用 `--apply` 落库。
 *
 * 用法:
 *   node scripts/backfill-stage-ready.mjs <sync.db>            # 只读,列出候选 + 判定依据
 *   node scripts/backfill-stage-ready.mjs <sync.db> --apply    # 仅对判为 stage 正常收口的行补写
 *
 * 判定规则(保守,宁可不改也不误标):
 *   state='needs_manual' AND error 为空
 *   AND 已完成 merge 步骤
 *   AND 没有任何上传类节点(upload_plain / append_*)进入过 running/done/blocked
 *   AND 没有 clean_source 失败记录
 * 排除「所有节点均断流」:那条路径止步于 select(不会到 merge),故 merge done 已天然排除。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const UPLOAD_NODES = ["upload_plain", "append_danmu", "append_livechat", "node_upload"];

function main(argv) {
  const args = argv.slice(2);
  const dbPath = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");
  if (!dbPath) {
    console.error("用法: node scripts/backfill-stage-ready.mjs <sync.db> [--apply]");
    process.exit(2);
  }
  if (!existsSync(dbPath)) {
    console.error(`台账不存在: ${dbPath}(路径不对?先确认数据根)`);
    process.exit(2);
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  const rows = db.prepare(
    "SELECT streamKey, updatedAt FROM sync_jobs WHERE state = 'needs_manual' AND (error IS NULL OR TRIM(error) = '')",
  ).all();

  const stepPhase = (key, step) => db.prepare(
    "SELECT phase FROM sync_job_steps WHERE streamKey = ? AND step = ? ORDER BY at DESC LIMIT 1",
  ).get(key, step)?.phase ?? null;

  const uploadTouched = (key) => db.prepare(
    `SELECT COUNT(*) AS n FROM sync_node_states
     WHERE streamKey = ? AND node IN (${UPLOAD_NODES.map(() => "?").join(",")})
       AND state IN ('running','done','blocked','failed')`,
  ).get(key, ...UPLOAD_NODES)?.n ?? 0;

  const cleanFailed = (key) => db.prepare(
    `SELECT COUNT(*) AS n FROM sync_job_steps
     WHERE streamKey = ? AND step LIKE 'clean%' AND phase = 'failed'`,
  ).get(key)?.n ?? 0;

  const stageReady = [];
  const unknown = [];
  for (const r of rows) {
    const merge = stepPhase(r.streamKey, "merge");
    const up = uploadTouched(r.streamKey);
    const cf = cleanFailed(r.streamKey);
    if (merge === "done" && up === 0 && cf === 0) stageReady.push(r);
    else unknown.push({ ...r, merge, uploadNodes: up, cleanFailed: cf });
  }

  const stamp = STAGE_READY_TEXT;
  for (const r of stageReady) {
    if (apply) {
      db.prepare("UPDATE sync_jobs SET error = ? WHERE streamKey = ? AND state = 'needs_manual' AND (error IS NULL OR TRIM(error) = '')")
        .run(stamp, r.streamKey);
    }
  }

  console.log(`空 error 的 needs_manual: ${rows.length}`);
  console.log(`判为 stage 正常收口(建议补写): ${stageReady.length}${apply ? " —— 已写入" : " —— 加 --apply 才写入"}`);
  for (const r of stageReady) console.log(`  + ${r.streamKey}`);
  console.log(`无法判定,需人工看: ${unknown.length}`);
  for (const r of unknown) {
    console.log(`  ? ${r.streamKey} merge=${r.merge} uploadNodes=${r.uploadNodes} cleanFailed=${r.cleanFailed}`);
  }
  db.close();
}

const STAGE_READY_TEXT = (await import("../packages/core/src/hub-ledger-contract.ts")).STAGE_READY;
main(process.argv);
