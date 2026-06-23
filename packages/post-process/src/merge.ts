// 会话合成编排:把按时间序选中的多个会话(各自分段 .ts + 会话级 .xml)合成
//   - 一个无损视频(mergeSession concat -c copy)
//   - 一份累计视频时长偏移后的合并弹幕 xml(mergeXmlContents)
import { readFileSync, writeFileSync } from "node:fs";
import { mergeSession } from "./concat.js";
import { ffprobeDuration } from "./ffmpeg.js";
import { mergeXmlContents } from "./merge-xml.js";

/** 一个会话:它的分段 .ts(按段序)+ 可选会话级 .xml(绝对路径)。 */
export interface MergeSessionInput {
  tsFiles: string[];
  xmlPath?: string;
}

/**
 * 合成选中会话 → outMp4(无损拼接)+(有 xml 时)outXml(偏移合并)。
 * 各会话视频时长 = 其分段 ffprobe 时长之和,用作下一会话弹幕的累计偏移。
 */
export async function mergeSessions(
  sessions: MergeSessionInput[],
  outMp4: string,
  outXml?: string,
): Promise<{ mp4: string; xml?: string }> {
  // 1) 视频:全部分段按会话序 + 段序拼成一片(无损)。
  const allTs = sessions.flatMap((s) => s.tsFiles);
  if (allTs.length === 0) throw new Error("mergeSessions: 无分段可合成");
  await mergeSession(allTs, outMp4);

  // 2) 弹幕:每会话 ffprobe 总时长 → 偏移合并 xml(仅当所有选中会话都有 xml)。
  if (outXml && sessions.every((s) => s.xmlPath)) {
    const xmlSessions = [];
    for (const s of sessions) {
      let durationSec = 0;
      for (const ts of s.tsFiles) {
        try {
          durationSec += await ffprobeDuration(ts);
        } catch (e) {
          // 探测失败按 0 计,但**绝不静默** —— 否则该段时长缺失 → 后续会话弹幕整体前移、无声漂移。
          console.warn(`[merge] ⚠️ ffprobe 时长失败,该段偏移按 0 计(后续弹幕可能漂移): ${ts} — ${(e as Error)?.message ?? e}`);
        }
      }
      xmlSessions.push({ xml: readFileSync(s.xmlPath as string, "utf-8"), durationSec });
    }
    const merged = mergeXmlContents(xmlSessions);
    writeFileSync(outXml, merged, "utf-8");
    return { mp4: outMp4, xml: outXml };
  }
  return { mp4: outMp4 };
}
