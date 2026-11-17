import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { applyNodeDataRoot } from "./node-pipeline-commands.js";
import { runWithUploadQuota } from "./upload-quota.js";

type UposApi = typeof import("@drec/zero-upload");
interface UploadRequest { files: string[]; title: string; tid: number; tag: string; private?: boolean }

async function preuploadWithBackoff(api: UposApi, cookies: string, name: string, totalSize: number) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.preupload({ cookiesPath: cookies, fileName: name, totalSize, line: "txa" });
    } catch (e) {
      if (!(e instanceof api.UposRateLimited) || attempt >= 8) throw e;
      const wait = Math.min(30_000 * 2 ** attempt, 300_000);
      process.stderr.write(`[upos] 601 限流,${wait / 1000}s 后重试 preupload (第 ${attempt + 1} 次): ${name}\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function uploadPart(api: UposApi, cookies: string, file: string) {
  if (!existsSync(file)) throw new Error(`文件不存在: ${file}`);
  const t0 = Date.now();
  const buf = readFileSync(file);
  const name = basename(file);
  const session = await preuploadWithBackoff(api, cookies, name, buf.length);
  const chunks = await api.uploadChunks({
    session, totalSize: buf.length,
    readChunk: async (i, size) => buf.subarray(i * session.bucket.chunkSize, i * session.bucket.chunkSize + size),
  });
  const done = await api.complete({ session, parts: chunks });
  if (!done.ok) throw new Error(`complete 失败: ${JSON.stringify(done.raw).slice(0, 400)}`);
  const stem = done.stem;
  if (!stem) throw new Error(`complete 未返回可用 UPOS stem: ${JSON.stringify(done.raw).slice(0, 400)}`);
  return { file: name, stem, bytes: buf.length, ms: Date.now() - t0 };
}

async function uploadArchive(api: UposApi, cookies: string, req: UploadRequest) {
  const parts: Array<Awaited<ReturnType<typeof uploadPart>>> = [];
  const videos: Array<{ filename: string; title: string }> = [];
  for (const file of req.files) {
    const part = await uploadPart(api, cookies, file);
    parts.push(part);
    videos.push({ filename: part.stem, title: part.file.replace(/\.[^.]+$/, "") });
  }
  const r = await api.submitStudio({
    cookiesPath: cookies, title: req.title, tid: req.tid, tag: req.tag,
    private: req.private !== false, videos,
  });
  if (!r.ok) throw new Error(`submit 失败: ${JSON.stringify(r.raw).slice(0, 400)}`);
  return { ok: true, bvid: r.bvid, aid: r.aid, parts };
}

async function runUposUpload(dataRoot: string, b64: string): Promise<void> {
  try {
    await applyNodeDataRoot(dataRoot);
    const api = await import("@drec/zero-upload");
    const req = JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as UploadRequest;
    if (!req.files?.length) throw new Error("files must not be empty");
    const cookies = process.env.BILIUP_COOKIE ?? join(dataRoot, "config", "biliup", "cookies.json");
    if (!existsSync(cookies)) throw new Error(`cookies 不存在: ${cookies}`);
    const result = await runWithUploadQuota(
      { cookiesPath: cookies, log: (m) => process.stderr.write(`[upos] ${m}\n`) },
      () => uploadArchive(api, cookies, req),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n");
    process.exitCode = 1;
  }
}

export function registerUposUploadCommand(program: Command): void {
  program
    .command("_upos-upload <dataRoot> <base64>", { hidden: true })
    .description("(internal) stream local files straight to UPOS and create a private archive")
    .action(runUposUpload);
}
