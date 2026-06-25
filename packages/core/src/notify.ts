// 通知契约(接口+事件类型)。具体实现(Discord/Null + makeNotifier 工厂)在 app 层,
// 这样 manager(RecordingSession)只依赖 core 的接口,不反向依赖 app(否则循环依赖)。
export type NotifyEvent =
  | { kind: "recordStart"; anchor: string; room: string; quality: string }
  // reason：本场录制结束的原因（手动停止 / 窗口结束收播 / 主播下播 / …）。缺省=未标注。
  | { kind: "recordEnd"; anchor: string; room: string; outDir: string; reason?: string }
  // 断流抖动后**重连成功**的告警（warning，非终止）：downSec=中断时长秒。真下播走 recordEnd(reason)。
  | { kind: "recordReconnect"; anchor: string; room: string; downSec: number }
  | { kind: "mergeDone"; file: string }
  | { kind: "burnDone"; style: string; file: string }
  | { kind: "uploadDone"; bv: string; url: string }
  | { kind: "error"; stage: string; message: string };

export interface Notifier { notify(e: NotifyEvent): Promise<void>; }
