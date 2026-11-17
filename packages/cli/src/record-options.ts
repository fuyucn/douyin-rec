/** Options shared by recording mode orchestration and command registration. */
export interface RecordCliOpts {
  room: string;
  name?: string;
  quality?: string;
  engine?: string;
  recorder?: string;
  danmu?: string;
  cookies?: string;
  cookiesFile?: string;
  out?: string;
  segment?: string;
  danmuXmlMode?: string;
  reconnect?: string;
  /** parseRollingUploadFlag: strict; absent/blank = off; unknown values fail with exit 2. */
  rollingUpload?: string;
  /** parseStreamUploadFlag: strict; absent/blank = off; unknown values fail with exit 2. */
  streamUpload?: string;
  streamUploadSize?: string;
  streamUploadSec?: string;
  streamUploadStallSec?: string;
  streamUploadRecoverSec?: string;
  streamUploadRatioAlert?: string;
  streamUploadTid?: string;
  streamUploadTag?: string;
  streamUploadPrivate?: string;
  streamUploadSpool?: string;
  /** Managed workers trust only the metadata delivered by the master. */
  zeroDiskManaged?: string;
  outputFormat?: string;
  taskId?: string;
  config?: string;
}
