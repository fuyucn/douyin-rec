// app-facing biliup module: the process helpers live in @drec/processors (plan 038 T05).
import { rootBiliupCookies } from "../paths.js";
import { readBiliupCookieHeader as readHeader } from "@drec/processors";

export type { UploadLine, UploadOpts, UploadSubmit, BiliupHooks } from "@drec/processors";
export {
  biliupCookieHeader, DEFAULT_UPLOAD_LINES, uploadSubmit, uploadLineCandidates,
  buildUploadArgs, parseBV, checkBiliup, isAllFilesUploadedLine, runBiliup,
  upload, buildAppendArgs, uploadPlain, countVideoParts, appendGroup,
  uploadThenAppend, uploadThenAppendGroups,
} from "@drec/processors";

/** biliup cookies.json:BILIUP_COOKIE > <DOUYIN_REC_ROOT ?? DEFAULT_ROOT>/config/biliup/cookies.json。 */
export const DEFAULT_COOKIES = process.env.BILIUP_COOKIE ?? rootBiliupCookies();

/** Read biliup's Bilibili login cookies as a request Cookie header (default path for app callers). */
export function readBiliupCookieHeader(cookiesPath = DEFAULT_COOKIES): string | null {
  return readHeader(cookiesPath);
}
