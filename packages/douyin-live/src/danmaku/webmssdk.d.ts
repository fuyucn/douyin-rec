/**
 * webmssdk.d.ts — vendored a_bogus 签名 sdk(webmssdk.js)的环境类型声明。
 *
 * webmssdk.js 是抖音网页端签名算法的逆向产物(浏览器 sdk,无可读源码),作 vendored 保留。
 * 弹幕 WS 取流签名唯一靠它;算法上游会变,变了 client.ts 的 getSignature 会拿到废签名。
 */
export function get_sign(md5: string): string;
