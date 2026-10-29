/**
 * Part duration for the zero-disk streaming path (plans/039).
 *
 * An explicit `--stream-upload-sec` wins; otherwise the task's `--segment` (the configured
 * recording window length) defines part size, matching the design "part size follows the
 * configured segment length". 0 / missing / invalid = byte cap only.
 */
export function streamPartMaxMs(streamUploadSec?: string, segment?: string): number | undefined {
  const raw = streamUploadSec !== undefined ? Number(streamUploadSec) : Number(segment ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined;
}
