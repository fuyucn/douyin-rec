/** Shared rule for the only supported live-upload spool setting. */
export const STREAM_UPLOAD_SPOOL_REQUIRED = true as const;

/** User-facing reason for rejecting a no-spool configuration. */
export const STREAM_UPLOAD_NO_SPOOL_ERROR =
  "直播直传必须保留本地回退文件（streamUploadSpool=true）：关闭后上传失败会永久丢失该分 P，已禁止配置。";

/** Returns true when a payload explicitly asks for the unsupported no-spool mode. */
export function forbidsStreamUploadSpool(value: unknown): value is false {
  return value === false;
}
