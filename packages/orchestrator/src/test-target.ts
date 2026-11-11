/**
 * test-target.ts — 测试专用:把「旧式两个函数」包成一个 `UploadTarget`。
 *
 * 阶段 1b 起 `PipelineDeps` 只有 `upload: UploadTarget`,但几十个编排层用例写的是
 * 「注入 `uploadPlain` / `appendGroup` 两个 mock,再断言它们被调了几次」。用这个壳把
 * 旧写法保留下来,断言对象仍是原来那两个 `vi.fn`,不必为了换契约把用例全重写一遍。
 *
 * 生产代码**不得**使用它:真实装配在 `cli`(注入 `createBiliupFileTarget()`)。
 */
import type { AppendPartsInput, CreateArchiveInput, UploadTarget } from "@drec/core";

export function fakeUploadTarget(o: {
  uploadPlain?: (plain: { video?: string; videos?: string[]; cookies: string; title: string; tid: number; tag: string; public: boolean; desc?: string }) => Promise<string>;
  appendGroup?: (o: { bv: string; files: string[]; cookies: string; public: boolean }) => Promise<void>;
} = {}): UploadTarget & { uploadPlain: unknown; appendGroup: unknown } {
  const t: UploadTarget = {
    id: "fake",
    platformIds: ["bilibili"],
    resolveCredential: () => ({ targetId: "fake", locator: "" }),
    accountKey: () => "fake",
    hardPolicy: () => ({ visibility: "private", watermark: false, copyright: "self" }),
    defaults: () => ({ tid: 21, tags: [], titleMaxLength: 80, maxParts: null }),
    async create(input: CreateArchiveInput) {
      const videos = input.files.map((f) => f.path);
      const bv = await (o.uploadPlain ?? (async () => "BV1FAKE"))({
        videos,
        cookies: input.cred.locator,
        title: input.title,
        tid: input.tid ?? 21,
        tag: (input.tags ?? []).join(","),
        public: input.policy.visibility === "public",
        desc: input.desc,
      });
      return { proof: "created" as const, ref: { targetId: "fake", id: bv } };
    },
    async append(input: AppendPartsInput) {
      await (o.appendGroup ?? (async () => {}))({
        bv: input.ref.id,
        files: input.files.map((f) => f.path),
        cookies: input.cred.locator,
        public: input.policy.visibility === "public",
      });
      return { proof: "observed" as const };
    },
    inspect: async () => null,
    findRecent: async () => "none",
    classifyError: () => ({ kind: "permanent", reason: "test" }),
    capabilities: { appendGranularity: "group", seasons: false },
  };
  // 暴露两个旧 mock 引用:既有用例仍在 `h.deps.uploadPlain` 上做断言,这里给它一条通路。
  return Object.assign(t, { uploadPlain: o.uploadPlain, appendGroup: o.appendGroup });
}
