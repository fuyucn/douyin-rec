// 多会话弹幕 XML 合并 → 一份 biliLive XML,对齐「无间隙拼接后的视频」时间轴。
//
// 参考 origin/main(Python) src/merge/merger.py merge_xml_files,但**偏移用累计视频时长
// (ffprobe),不是墙钟**——断流多会话拼成无间隙一片时,墙钟偏移会含间隙而漂移。
//
// 调整规则(第 i 个会话,累计视频偏移 offsetSec = sum 前序会话时长;base = 首会话 video_start_time):
//   - <d p="rel,...">      : p[0](相对秒)+= offsetSec
//   - <gift|member ts="T"> : T(epoch ms)→ base + (T - 本会话 video_start_time) + offsetSec*1000
//   - metadata/RecorderXmlStyle 取首会话(video_start_time 即 base,首会话元素原样不动)
//
// biliLive xml 每元素独占一行 → 行级正则改时间,保真(保留 uid/price 等全部属性)。

export interface MergeXmlSession {
  /** 该会话 .xml 的文件内容。 */
  xml: string;
  /** 该会话视频总时长(秒,ffprobe 其全部分段之和)。 */
  durationSec: number;
}

/** 从 xml 内容取 metadata.video_start_time(epoch ms);无则 0。 */
function videoStartMs(xml: string): number {
  const m = xml.match(/<video_start_time>\s*(\d+)\s*<\/video_start_time>/);
  return m ? Number(m[1]) : 0;
}

/** 取 head:内容里第一条弹幕元素(<d|<gift|<member)之前的全部(头 + metadata + RecorderXmlStyle + <i>)。 */
function splitHead(xml: string): { head: string; body: string } {
  const m = xml.match(/\n<(?:d |gift |member |d>|gift>|member>)/);
  if (!m || m.index == null) return { head: xml, body: "" };
  return { head: xml.slice(0, m.index), body: xml.slice(m.index + 1) };
}

/** 一行弹幕元素 → 按偏移调整时间后的行(非弹幕行原样返回)。 */
function adjustLine(line: string, offsetSec: number, baseMs: number, segStartMs: number): string {
  if (line.startsWith("<d ") || line.startsWith("<d>")) {
    // p="rel,f2,f3,...":第一字段相对秒 += offsetSec。
    return line.replace(/(<d\s+p=")([^",]+)(,)/, (_full, pre: string, rel: string, comma: string) => {
      const t = (Number(rel) || 0) + offsetSec;
      return `${pre}${t.toFixed(3)}${comma}`;
    });
  }
  if (line.startsWith("<gift") || line.startsWith("<member")) {
    return line.replace(/ts="(\d+)"/, (_full, ts: string) => {
      const newTs = baseMs + (Number(ts) - segStartMs) + Math.round(offsetSec * 1000);
      return `ts="${newTs}"`;
    });
  }
  return line;
}

/**
 * 合并多会话弹幕 xml(按入参顺序 = 时间序)→ 一份 biliLive xml 字符串。
 * 首会话 head(含 metadata.video_start_time=base + RecorderXmlStyle)整体保留;
 * 各会话弹幕行按累计视频时长平移后顺序追加;末尾 </i>。
 */
export function mergeXmlContents(sessions: MergeXmlSession[]): string {
  if (sessions.length === 0) return "";
  const baseMs = videoStartMs(sessions[0].xml);
  const { head } = splitHead(sessions[0].xml);

  const lines: string[] = [];
  let offsetSec = 0;
  for (const s of sessions) {
    const segStartMs = videoStartMs(s.xml);
    const { body } = splitHead(s.xml);
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line || line === "</i>") continue;
      if (line.startsWith("<d ") || line.startsWith("<d>") || line.startsWith("<gift") || line.startsWith("<member")) {
        lines.push(adjustLine(line, offsetSec, baseMs, segStartMs));
      }
    }
    offsetSec += s.durationSec;
  }

  const headTrimmed = head.endsWith("\n") ? head : head + "\n";
  return `${headTrimmed}${lines.join("\n")}\n</i>\n`;
}
