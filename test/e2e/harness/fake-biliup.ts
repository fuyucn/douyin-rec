/**
 * 假 biliup(E2E 脚手架):替换「biliup 外部进程 + B站」,**不改被测代码**。
 *
 * 做法:实现 `run(argv) => Promise<string>` —— 即 `packages/app/src/upload/biliup.ts` 里
 * `uploadPlain` / `appendGroup` 本就开放的注入接缝。真实包装(换线重试、`parseBV`、append 幂等
 * 核对 `countParts`、`APPEND_AMBIGUOUS_MARKER`、argv 构造)全部照跑;被替换的只有「spawn biliup」。
 * 因此对外暴露的 `uploadPlain` / `appendGroup` / `countVideoParts` 与真实包装**签名一致**,
 * 可直接注入 `PipelineDeps`、`RollingUploader` 的 `*Raw` 接缝,或用 `vi.mock` 顶替 biliup 模块。
 *
 * 可注入的故障(见 {@link Fault}):超时 / 网关错误 / 结果不确定 / 进程被杀。
 */
import { basename } from "node:path";
import type { UploadOpts } from "@drec/core";

/** 真实 biliup 包装(由调用方 `vi.importActual` 取得,避免与 `vi.mock` 自指)。 */
export interface RealBiliup {
  uploadPlain(o: { plain: UploadOpts; run?: (argv: string[]) => Promise<string>; lines?: readonly string[] }): Promise<string>;
  appendGroup(o: {
    cookies: string; bv: string; files: string[]; public?: boolean;
    run?: (argv: string[]) => Promise<string>;
    countParts?: () => Promise<number | null>;
  }): Promise<void>;
}

export type FaultMode =
  /** 网关超时:**未提交**;文案命中真实包装的「可换线重试」判定。 */
  | "gateway-timeout"
  /** 请求超时:同上(文案不同,B站侧未提交)。 */
  | "timeout"
  /** 结果不确定:**服务端已提交**,但客户端只收到可重试错误(没拿到响应)。 */
  | "ambiguous"
  /** 进程被杀(SIGKILL):`applied` 决定被杀前服务端是否已提交。非重试类错误,直接冒泡。 */
  | "killed";

export interface Fault {
  op: "upload" | "append";
  mode: FaultMode;
  /** 命中几次 run 调用后失效(默认 1)。真实包装每次失败会换线再调 run,故「整次包装失败」需 ≥ 线路数。 */
  times?: number;
  /** 仅 `killed` 有意义:被杀前是否已在服务端提交(默认 false)。 */
  applied?: boolean;
  /** 仅命中某类文件(basename 满足);缺省全部命中。 */
  match?: (files: string[]) => boolean;
}

export interface FakeArchive {
  bv: string;
  title: string;
  /** 分 P 文件名(basename),按提交顺序。 */
  parts: string[];
  /** 稿件元数据口径(取自 argv):关水印 / 仅自己可见。 */
  watermarkOff: boolean;
  onlySelf: boolean;
}

export interface FakeCall {
  op: "upload" | "append";
  files: string[];
  bv?: string;
  line?: string;
  /** ok = 已提交且成功返回;lost = 已提交但客户端没拿到响应;rejected = 未提交。 */
  outcome: "ok" | "lost" | "rejected";
}

function parseFlags(argv: string[]): { op: "upload" | "append"; files: string[]; flags: Map<string, string> } {
  const i = argv.findIndex((a) => a === "upload" || a === "append");
  if (i < 0) throw new Error(`fake-biliup: 不认识的 argv: ${argv.join(" ")}`);
  const op = argv[i] as "upload" | "append";
  const rest = argv.slice(i + 1);
  const flags = new Map<string, string>();
  const files: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (a.startsWith("--")) { flags.set(a, rest[k + 1] ?? ""); k++; } else files.push(a);
  }
  return { op, files, flags };
}

export class FakeBiliup {
  /** 假「B站」:BV → 稿件。 */
  readonly archives = new Map<string, FakeArchive>();
  /** 全部 run 调用记录(含被故障吞掉的)。 */
  readonly calls: FakeCall[] = [];
  private faults: Array<Fault & { left: number }> = [];
  private seq = 0;
  /** false → `countVideoParts` 返回 null(模拟接口风控/网络不可用)。 */
  countAvailable = true;

  constructor(private readonly real: RealBiliup) {}

  inject(f: Fault): this {
    this.faults.push({ ...f, left: f.times ?? 1 });
    return this;
  }
  clearFaults(): void { this.faults = []; }

  /** 取下一条匹配的故障并消耗一次。 */
  private takeFault(op: "upload" | "append", files: string[]): Fault | null {
    const f = this.faults.find((x) => x.left > 0 && x.op === op && (!x.match || x.match(files)));
    if (!f) return null;
    f.left--;
    return f;
  }

  /** 假 biliup 进程:被真实包装当作 `run` 调用。 */
  readonly run = async (argv: string[]): Promise<string> => {
    const { op, files: rawFiles, flags } = parseFlags(argv);
    const files = rawFiles.map((f) => basename(f));
    const line = flags.get("--line");
    const fault = this.takeFault(op, files);
    const apply = (): FakeArchive => {
      if (op === "upload") {
        const bv = `BV1${String(++this.seq).padStart(9, "0")}`;
        const a: FakeArchive = {
          bv,
          title: flags.get("--title") ?? "",
          parts: [...files],
          watermarkOff: /"state"\s*:\s*0/.test(flags.get("--extra-fields") ?? ""),
          onlySelf: flags.get("--is-only-self") === "1",
        };
        this.archives.set(bv, a);
        return a;
      }
      const bv = flags.get("--vid") ?? "";
      const a = this.archives.get(bv);
      if (!a) throw new Error(`biliup 失败 (rc=1): 稿件不存在 ${bv}`);
      a.parts.push(...files);
      return a;
    };
    const record = (outcome: FakeCall["outcome"], bv?: string): void => {
      this.calls.push({ op, files, bv: bv ?? flags.get("--vid"), line, outcome });
    };
    if (fault) {
      if (fault.mode === "gateway-timeout" || fault.mode === "timeout") {
        record("rejected");
        const why = fault.mode === "gateway-timeout" ? "Gateway Time-out" : "operation timed out";
        throw new Error(`biliup 失败 (rc=1): ${why} uploader.rs:123 start=0 end=1048576`);
      }
      if (fault.mode === "ambiguous") {
        const a = apply();
        record("lost", a.bv);
        throw new Error("biliup 失败 (rc=1): Gateway Time-out uploader.rs:456 start=0 end=1048576");
      }
      // killed
      if (fault.applied) { const a = apply(); record("lost", a.bv); } else record("rejected");
      throw new Error("biliup 失败 (rc=null): 进程被 SIGKILL 终止");
    }
    const a = apply();
    record("ok", a.bv);
    return `投稿成功 ${a.bv}\n`;
  };

  /** 与真实 `countVideoParts` 同签名(第二参 cookies 忽略)。 */
  readonly countVideoParts = async (bv: string, _cookies?: string): Promise<number | null> => {
    if (!this.countAvailable) return null;
    const a = this.archives.get(bv);
    return a ? a.parts.length : null;
  };

  /** 与真实 `uploadPlain` 同签名(`{ plain }` → 由调用方包成 `(plain) => ...` 注入)。 */
  readonly uploadPlain = (plain: UploadOpts): Promise<string> => this.real.uploadPlain({ plain, run: this.run });

  /** 与真实 `appendGroup` 同形(带 countParts 幂等核对,与 cli 装配一致)。 */
  readonly appendGroup = (o: {
    bv: string; files: string[]; cookies: string; public?: boolean;
    /** 调用方(如 RollingUploader)自带的分 P 数查询优先;缺省走假「B站」。 */
    countParts?: () => Promise<number | null>;
  }): Promise<void> =>
    this.real.appendGroup({ ...o, run: this.run, countParts: o.countParts ?? ((): Promise<number | null> => this.countVideoParts(o.bv)) });

  // ── 断言用视图 ──
  /** 建稿次数(= upload 且已提交的稿件数)。 */
  get draftCount(): number { return this.archives.size; }
  get onlyArchive(): FakeArchive {
    const all = [...this.archives.values()];
    if (all.length !== 1) throw new Error(`期望恰好 1 份稿件,实际 ${all.length}`);
    return all[0]!;
  }
}
