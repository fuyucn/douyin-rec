/**
 * app/web/static-html.ts — resolves + serves the built React SPA from web/dist/.
 *
 * The web console is a separate Vite app (ts/web/) that builds to ts/web/dist/
 * with an index.html + hashed assets under /assets/. The node CLI serves those
 * files directly: index.html for "/" and client routes (SPA fallback), and the
 * hashed asset files for their exact paths.
 *
 * Override / discovery order for the dist root (FONTS_DIR-style):
 *   1. process.env.DOUYIN_REC_STATIC  — explicit dir holding index.html
 *   2. <this dir>/../../../web/dist    — tsx: src/app/web → ts/web/dist
 *   3. <bundle dir>/../web/dist        — bundle: ts/dist → ts/web/dist
 *   4. <bundle dir>/../../web/dist     — extra fallback
 *
 * If nothing is found (e.g. running tests before `pnpm build` in web/), a
 * minimal embedded DOCTYPE page is returned so `task serve` never 500s and the
 * REST API stays usable.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Candidate dist roots, in priority order. */
function distRoots(): string[] {
  const list: string[] = [];
  if (process.env.DOUYIN_REC_STATIC) list.push(resolve(process.env.DOUYIN_REC_STATIC));
  // tsx: here === <repo>/ts/src/app/web → ../../../web/dist
  list.push(resolve(here, "..", "..", "..", "web", "dist"));
  // bundle: here === <repo>/dist → ../packages/web/dist
  list.push(resolve(here, "..", "packages", "web", "dist"));
  list.push(resolve(here, "..", "web", "dist"));
  list.push(resolve(here, "..", "..", "web", "dist"));
  return list;
}

/** The first dist root that actually contains an index.html, or null. */
function findDistRoot(): string | null {
  for (const root of distRoots()) {
    if (existsSync(resolve(root, "index.html"))) return root;
  }
  return null;
}

const FALLBACK_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>抖音录制控制台</title></head><body>
<h1>抖音录制控制台</h1>
<p>React SPA 构建产物未找到。请先在 <code>ts/web/</code> 运行 <code>pnpm build</code>
（生成 <code>ts/web/dist/</code>），或设置 <code>DOUYIN_REC_STATIC</code> 指向 dist 目录。
REST API 仍可用，例如 <code>GET /api/tasks</code>。</p>
</body></html>`;

/** Read the SPA index.html, or a minimal embedded fallback. */
export function loadIndexHtml(): string {
  const root = findDistRoot();
  if (root) {
    try {
      return readFileSync(resolve(root, "index.html"), "utf-8");
    } catch {
      /* fall through */
    }
  }
  return FALLBACK_HTML;
}

/** A resolved static asset: its bytes + content-type. */
export interface StaticAsset {
  body: Buffer;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Resolve a request pathname (e.g. "/assets/index-abc.js") to a file under the
 * dist root. Returns null when there is no dist build, the path escapes the
 * root, or the file does not exist. Path traversal ("..") is rejected.
 */
export function loadStaticAsset(pathname: string): StaticAsset | null {
  const root = findDistRoot();
  if (!root) return null;
  // Strip the leading slash, decode, and normalise. Reject traversal.
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
  if (!rel) return null;
  const target = normalize(resolve(root, rel));
  // Must stay within root (defence-in-depth against "..").
  if (target !== root && !target.startsWith(root + sep)) return null;
  if (!existsSync(target)) return null;
  try {
    if (!statSync(target).isFile()) return null;
    return { body: readFileSync(target), contentType: contentTypeFor(target) };
  } catch {
    return null;
  }
}
