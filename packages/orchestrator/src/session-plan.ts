import { readdirSync } from "node:fs";

/** 该场 stage 合成产物的确定性路径(merge 后 / 续跑反推)。 */
export interface StageProducts {
  dateName: string;
  /** merge 命令 --base 用的完整会话 base(含时间戳),如 `主播名_2026-08-10_23-08-10`。 */
  sessionBase: string;
  /** 断流重连多会话时全部会话 base(按时间序);单会话 = [sessionBase]。 */
  sessionBases: string[];
  plain: string;
  danmuMp4: string;
  livechatMp4: string;
  plainXml: string;
  xmlArg: string;
}

/** `主播名_2026-08-10_23-08-10(-PART01).ts` → `主播名_2026-08-10_23-08-10`。 */
export function sessionBaseOfFile(name: string): string | undefined {
  const m = /^(.+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:-PART\d+)?\.(?:ts|flv|xml|mp4)$/i.exec(name);
  return m?.[1];
}

/** 从文件名集合提取全部会话 base，排序并去重(同一场多分段只算一次)。 */
export function sessionBasesOfFiles(files: string[]): string[] {
  return [...new Set(files.map(sessionBaseOfFile).filter((s): s is string => Boolean(s)))].sort();
}

function joinPath(dir: string, name: string): string {
  // 与 pipeline 原实现一致:直接用 path 分隔符拼(避免在此 import node:path 也能跑浏览器构建无关)。
  return `${dir}/${name}`;
}

/** 从 stageSub 目录按确定命名反推产物路径;连一个源文件都找不到 → null。 */
export function deriveStageProducts(stageSub: string): StageProducts | null {
  let files: string[];
  try { files = readdirSync(stageSub); } catch { return null; }
  const danmu = files.find((f) => f.endsWith("_danmu.mp4"));
  const livechat = files.find((f) => f.endsWith("_livechat.mp4"));
  const plainF = files.find((f) => f.endsWith(".mp4") && !f.endsWith("_danmu.mp4") && !f.endsWith("_livechat.mp4"));
  let dateName: string | undefined;
  let sessionBase = "";
  let sessionBases: string[] = [];
  if (danmu) dateName = danmu.slice(0, -"_danmu.mp4".length);
  else if (livechat) dateName = livechat.slice(0, -"_livechat.mp4".length);
  else if (plainF) dateName = plainF.slice(0, -".mp4".length);
  if (!dateName) {
    // merge 还没产出时(失败重跑):从拉来的源段反推 dateName + 完整 sessionBase。
    sessionBases = sessionBasesOfFiles(files);
    sessionBase = sessionBases[0] ?? "";
    if (!sessionBase) return null;
    dateName = sessionBase.replace(/_\d{2}-\d{2}-\d{2}$/, "");
  } else {
    sessionBases = sessionBasesOfFiles(files);
    sessionBase = sessionBases[0] ?? dateName;
  }
  const xmlFile = files.find((f) => f.endsWith(".xml"));
  return {
    dateName,
    sessionBase,
    sessionBases,
    plain: joinPath(stageSub, dateName + ".mp4"),
    danmuMp4: joinPath(stageSub, dateName + "_danmu.mp4"),
    livechatMp4: joinPath(stageSub, dateName + "_livechat.mp4"),
    plainXml: joinPath(stageSub, dateName + ".xml"),
    xmlArg: xmlFile ? joinPath(stageSub, xmlFile) : "",
  };
}
