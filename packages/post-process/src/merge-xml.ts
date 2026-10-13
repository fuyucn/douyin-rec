// 多会话弹幕 XML 合并 → 一份 biliLive XML,对齐「无间隙拼接后的视频」时间轴;
// 以及反向的**窗口切片**(一份会话 xml → 一个分 P 的 xml,时间轴重定基到 0)。
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

// 窗口切片(`renderXmlWindowToXml`)是 merge 的**逆向**:按窗口取子集 + 时间重定基到 0。
//
// 窗口口径必须与烧录 `renderXmlWindowToAss`(post-process/segment.ts)完全一致,
// 权威实现是 `ass/render.ts` 的 `extractItems`:
//   - <d>    相对时间 = p[0](缺失按 0)
//   - <gift>/<member> 相对时间 = ts/1000 - video_start_time/1000
//   - 命中窗口 [startSec, endSec) 才保留,并把时间重定基 `- startSec`
//   - 空文本 <d> 不收(与 extractItems 一致:它不占条目)
//
// **切出的是一份无损投影**:缺省保留全部三种元素、不做礼物阈值过滤 —— 与 `extractItems`
// 的缺省(`types` 全开、`giftValueFilter` 0)同一口径。烧录/二次渲染自己的过滤(member 不收、
// `giftValueFilter` 0.9)在**消费时**照旧生效,故从派生 xml 烧出的结果与直接从会话 xml 烧**完全一致**
// (merge-xml.test.ts 的差分测试钉住这一点,含分数秒窗口的浮点容差)。
// 反例(踩过):在派生时就把 `>0.9` 与 `member 不收` 烤进文件 —— 既有 CLI 多段烧录
// (`merge --indir`,缺省 `--gift-value 0`)拿到派生 xml 会得到与会话 xml 不同的条目集。

export interface MergeXmlSession {
  /** 该会话 .xml 的文件内容。 */
  xml: string;
  /** 该会话视频总时长(秒,ffprobe 其全部分段之和)。 */
  durationSec: number;
}

/** 窗口切片结果:派生 xml + 窗内条目数(0 = 窗口无弹幕,文件仍结构完整)。 */
export interface XmlWindowRenderResult {
  xml: string;
  count: number;
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

/** 行级取 <d> 的 p[0](相对秒):缺失 p 按 0、非数字按 null=丢弃,与 extractItems 一致。 */
function danmakuRelSec(line: string): number | null {
  const m = /<d(?:\s+p="([^"]*))?/.exec(line);
  if (!m) return null;
  const rel = Number(m[1] == null ? "0" : m[1].split(",")[0]);
  return Number.isFinite(rel) ? rel : null;
}

/** gift/member 行:按窗口判定并重定基 ts(保留其余全部属性);窗外/无 ts → null。 */
function windowShiftTsLine(
  line: string,
  segStartMs: number,
  window: { startSec: number; endSec: number },
): string | null {
  const m = line.match(/ts="(-?\d+)"/);
  if (!m) return null;
  const ts = Number(m[1]);
  const rel = ts / 1000 - segStartMs / 1000;
  if (rel < window.startSec || rel >= window.endSec) return null;
  const newTs = Math.round(ts - window.startSec * 1000);
  return line.replace(/ts="(-?\d+)"/, `ts="${newTs}"`);
}

/**
 * 一份会话 xml + 该分 P 在整场时间轴上的窗口 → 该分 P 的 biliLive xml(时间重定基到 0)。
 *
 * 与烧录 `renderXmlWindowToAss` **同一套窗口口径**(权威实现 = ass/render.ts 的 extractItems):
 *   - 只保留窗内 [startSec, endSec) 条目;<gift>/<member> 相对时间 = ts/1000 - video_start_time/1000
 *   - 时间重定基 `- startSec`;<d> 只改 p[0],gift/member 平移 ts(epoch ms)
 *   - 空文本 <d> 不收;三种元素全留、不过滤礼物(无损投影,见文件头)
 *
 * `video_start_time` 保持源会话不变 —— 消费方按原公式 ts/1000 - video_start_time/1000
 * 即得分 P 内相对秒。输出是叶子产物(不要再对它做第二次窗口切片)。
 *
 * 窗口内无条目 → 返回 count=0 且仍是**结构完整**的 xml(head + `</i>`,不是空串),
 * 这样每个分 P 都能落一份对齐产物、分 P 序号与文件序号不会因跳过而错位。
 */
export function renderXmlWindowToXml(
  xml: string,
  window: { startSec: number; endSec: number },
): XmlWindowRenderResult {
  const segStartMs = videoStartMs(xml);
  // 先剥结尾 </i> 再切 head/body:空弹幕文件(分不到首条元素)时 head 会包含整份 xml,
  // 若直接拼会多出一个 </i>。保留源 head 的 video_start_time 未动,只重定基条目时间。
  const noClose = xml.replace(/<\/i>\s*$/, "");
  const { head, body } = splitHead(noClose);
  const lines: string[] = [];
  let count = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line === "</i>") continue;
    let kept = "";
    if (line.startsWith("<d ") || line.startsWith("<d>")) {
      const rel = danmakuRelSec(line);
      if (rel === null || rel < window.startSec || rel >= window.endSec) continue;
      // 空文本 <d> 不保留(与 extractItems 一致:烧录窗口里它不占条目)。
      if (!line.replace(/<\/?d[^>]*>/g, "").trim()) continue;
      kept = line.replace(/(<d\s+p=")[^",]*/, (_f, pre: string) => `${pre}${(rel - window.startSec).toFixed(3)}`);
    } else if (line.startsWith("<gift")) {
      const shifted = windowShiftTsLine(line, segStartMs, window);
      if (!shifted) continue;
      kept = shifted;
    } else if (line.startsWith("<member")) {
      const shifted = windowShiftTsLine(line, segStartMs, window);
      if (!shifted) continue;
      kept = shifted;
    } else {
      continue;
    }
    lines.push(kept);
    count++;
  }
  const headTrimmed = head.endsWith("\n") ? head : head + "\n";
  return { xml: `${headTrimmed}${lines.length ? `${lines.join("\n")}\n` : ""}</i>\n`, count };
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
