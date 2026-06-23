// 通知契约(接口+事件类型)。具体实现(Discord/Null + makeNotifier 工厂)在 app 层,
// 这样 manager(RecordingSession)只依赖 core 的接口,不反向依赖 app(否则循环依赖)。
export type NotifyEvent =
  | { kind: "recordStart"; anchor: string; room: string; quality: string }
  | { kind: "recordEnd"; anchor: string; room: string; outDir: string }
  | { kind: "mergeDone"; file: string }
  | { kind: "burnDone"; style: string; file: string }
  | { kind: "uploadDone"; bv: string; url: string }
  | { kind: "error"; stage: string; message: string };

export interface Notifier { notify(e: NotifyEvent): Promise<void>; }
