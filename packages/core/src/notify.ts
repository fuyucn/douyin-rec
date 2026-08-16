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
  // hub 编排开始处理一场直播(新建 job、pipeline 启动)。同一场只发一次。
  | { kind: "hubTaskStart"; streamKey: string; room: string; workers: string[]; mode: "stage" | "upload" }
  | { kind: "error"; stage: string; message: string };

export interface Notifier { notify(e: NotifyEvent): Promise<void>; }

/** 设置面板里每类提醒的开关键(与 web 前端 NOTIF_KEYS 一致)。 */
export type NotifKey = "live" | "recordEnd" | "merge" | "hub" | "error";

/** 每类提醒的 webhook(Discord)推送开关(实际缺省见 DEFAULT_WEBHOOK_TOGGLES,全关)。 */
export type NotifWebhookToggles = Record<NotifKey, boolean>;

/** 事件 kind → 设置开关键(webhook 与 in-app 共用同一套分类)。 */
export function notifKeyOf(e: NotifyEvent): NotifKey {
  switch (e.kind) {
    case "recordStart":
    case "recordReconnect":
      return "live";
    case "recordEnd":
      return "recordEnd";
    case "mergeDone":
    case "burnDone":
    case "uploadDone":
      return "merge";
    case "hubTaskStart":
      return "hub";
    case "error":
      return "error";
  }
}
