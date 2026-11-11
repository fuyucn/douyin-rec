/**
 * upload-call.ts — orchestrator 侧对 `UploadTarget` 的两个薄调用(阶段 1b 步 2)。
 *
 * 为什么要有这一层:调用方手里是 `UploadOpts`(video/videos/cookies/title/tag/tid/public/desc),
 * 而契约要 `CreateArchiveInput`(cred/files/policy/title/...)。映射只发生在这里一处,
 * 免得 workflow / segment / 续跑三条路径各写一份、慢慢走样。
 *
 * **语义不变的关键**:target 实现内部就是委托旧链(`uploadPlain` / `appendGroup`),而「结果不确定」
 * 在 target 里表达成 `proof: "unknown"`(不抛)。旧链则是抛错。上层现有的 `shouldRetry`
 * 判定是按「错误」写的(`isUploadRateLimited` 才重试、`isAppendAmbiguous` 一律不重试),
 * 所以这里把 `unknown` **重新抛成结构化错误**,让上层保持原有判定——不重试、交给上传类
 * 失败门禁转人工。这样接驱动的同时,重试与转人工的口径一个字节都没变。
 */
import { APPEND_AMBIGUOUS_MARKER, PLAIN_NO_BV_MARKER, type UploadOpts } from "./upload-contract.js";
import type { UploadChildHooks, UploadPolicy, UploadTarget } from "./upload-target.js";

/** 平台不可配的硬策略:关水印 + 自制;可见性由调用方给(默认仅自己)。 */
function policyOf(opts: UploadOpts): UploadPolicy {
  return { visibility: opts.public ? "public" : "private", watermark: false, copyright: "self" };
}

/** 建稿:返回 BV;`proof` 不是 created 时抛 `[plain-no-bv]`,上层不重试(避免建出第二份稿)。 */
export async function createArchive(upload: UploadTarget, opts: UploadOpts, hooks?: UploadChildHooks): Promise<string> {
  const files = (opts.videos && opts.videos.length > 0 ? opts.videos : opts.video ? [opts.video] : []).map((path) => ({ path }));
  const r = await upload.create({
    cred: { targetId: upload.id, locator: opts.cookies },
    title: opts.title,
    files,
    policy: policyOf(opts),
    desc: opts.desc,
    // **原样透传**:旧链把 `tag` 整个交给 biliup 的 `--tag`,不切分、不 trim。target 侧再
    // `.join(",")` 还原,所以这里必须放一个元素,拆开再拼会把 "a, b" 变成 "a,b"。
    tags: opts.tag ? [opts.tag] : [],
    tid: opts.tid,
    ...(hooks ? { hooks } : {}),
  });
  if (r.proof !== "created" || !r.ref?.id) {
    throw new Error(`${PLAIN_NO_BV_MARKER} 建稿结果不确定(proof=${r.proof}),不重试,转人工核对`);
  }
  return r.ref.id;
}

/** append:成功即返回;`proof` 不是 observed 时抛 `[append-ambiguous]`,上层不重试(避免重复分 P)。 */
export async function appendArchive(upload: UploadTarget, o: { bv: string; files: string[]; cookies: string; public: boolean }, hooks?: UploadChildHooks): Promise<void> {
  const r = await upload.append({
    cred: { targetId: upload.id, locator: o.cookies },
    ref: { targetId: upload.id, id: o.bv },
    files: o.files.map((path) => ({ path })),
    policy: { visibility: o.public ? "public" : "private", watermark: false, copyright: "self" },
    ...(hooks ? { hooks } : {}),
  });
  if (r.proof !== "observed") {
    throw new Error(`${APPEND_AMBIGUOUS_MARKER} append 结果不确定(proof=${r.proof}),不重试,转人工核对`);
  }
}
