/**
 * wbi.ts — bilibili WBI 签名(纯函数,可单测)。
 *
 * bilibili 多数 web 接口要求 WBI 签名:从 `nav` 接口拿到 `wbi_img.{img_url, sub_url}`,
 * 取两者 basename(去扩展名)拼成 `orig = img_key + sub_key`,经固定的 64 项乱序表 MIX
 * 重排后取前 32 字符得到 `mixinKey`。对请求参数(含 wts 时间戳)按 key 排序、过滤特殊字符、
 * URL 编码后拼成 query,`w_rid = md5(query + mixinKey)`。
 *
 * getDanmuInfo(弹幕 token + WS host)即需 WBI 签名 → 此处实现签名 + nav 拉 key。
 * 只用 node:crypto(md5),无外部依赖,danmaku WS 实现与之共用本模块。
 */
import { createHash } from "node:crypto";

/** WBI mixinKey 乱序表(bilibili web 固定常量)。 */
const MIX_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** URL 的 basename 去扩展名(取 `wbi_img.img_url` / `sub_url` 里的 key)。 */
function keyFromUrl(url: string): string {
  const base = url.split("/").pop() ?? url;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(0, dot) : base;
}

/** img_key + sub_key → mixinKey(乱序重排取前 32 字符)。 */
export function getMixinKey(imgKey: string, subKey: string): string {
  const orig = imgKey + subKey;
  let out = "";
  for (const i of MIX_TABLE) out += orig[i] ?? "";
  return out.slice(0, 32);
}

/** 从 nav 响应的 wbi_img.{img_url, sub_url} 提取 (imgKey, subKey)。 */
export function keysFromWbiImg(imgUrl: string, subUrl: string): { imgKey: string; subKey: string } {
  return { imgKey: keyFromUrl(imgUrl), subKey: keyFromUrl(subUrl) };
}

/**
 * 对参数做 WBI 签名,返回最终 query 字符串(含 `w_rid` + `wts`)。
 * @param params 业务参数(不含 wts);函数内补 wts。
 * @param mixinKey getMixinKey 的产物。
 * @param wts 可注入(测试用);默认当前 unix 秒。
 */
export function encWbi(
  params: Record<string, string | number>,
  mixinKey: string,
  wts: number = Math.floor(Date.now() / 1000),
): string {
  const withWts: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(withWts)
    .sort()
    .map((k) => {
      // 过滤值里的特殊字符 !'()* (bilibili 官方 demo 同款),再 URL 编码。
      const v = String(withWts[k]).replace(/[!'()*]/g, "");
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join("&");
  const wRid = createHash("md5").update(query + mixinKey).digest("hex");
  return `${query}&w_rid=${wRid}`;
}
