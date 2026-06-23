/**
 * proto.d.ts — vendored pbjs 静态模块(proto.js)的最小环境类型声明。
 *
 * proto.js 是上游 `dy.proto` 经 `pbjs --target static-module` 生成的产物(我们作 vendored 保留,
 * 不手改、不重写)。这里只声明 client.ts 实际用到的面:`douyin.<Message>.{decode,encode,create}`。
 * 各消息体字段不在此细化 —— 由 client.ts 在 `.toJSON()` 处按需 cast 成 DyChat/DyGift/DyMember。
 */
interface ProtoCodec {
  /** 解码 protobuf 字节 → 消息对象(字段动态,故 any;调用方按消息类型 cast)。 */
  decode(data: Uint8Array): any; // eslint-disable-line @typescript-eslint/no-explicit-any
  encode(message: Record<string, unknown>): { finish(): Uint8Array };
  create(properties: Record<string, unknown>): Record<string, unknown>;
}

/** pbjs 生成的 `export const douyin`(命名导出,非 default)。键 = 消息名(PushFrame/Response/ChatMessage…)。 */
export const douyin: Record<string, ProtoCodec>;
