/**
 * app/anchor.ts — 抓取主播名 / 短链解析(不启动录制),委托给平台抽象。
 *
 * 历史上直接 import @drec/douyin-live;A1 后改为按平台派发(平台的 fetchAnchorName /
 * resolveShortUrl)。本模块只用 @drec/core 注册表 → vitest 里可被引用(不连带加载 douyin-live
 * 的 sm-crypto;重型逻辑在各平台 <平台>-core 里,只在 bundle/node dist 真跑)。
 *
 * ⚠️ 主播名解析必须【匿名】:owner 是公开信息,但抖音 getInfo 内部走 webcast/room/web/enter
 * 鉴权,带会话 cookie 会触发异地登录踢手机主号(见 docs/douyin-kick-investigation.md)。这一约束
 * 由平台实现(douyinPlatform.fetchAnchorName 不传 cookie)保证,故此处忽略 cookies 入参。
 */
import { createLogger, matchPlatform, defaultPlatform, platformForRoom } from "@drec/core";

const log = createLogger("anchor_resolver");

/** 短链 → 房间 id(按 URL 命中平台;无命中用默认平台)。失败/无短链能力返回 null。 */
export async function resolveShortUrl(url: string): Promise<string | null> {
  try {
    const platform = matchPlatform(url) ?? defaultPlatform();
    return (await platform.resolveShortUrl?.(url)) ?? null;
  } catch (e) {
    log.error(`短链解析失败 ${url}:`, (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * 解析房间的主播名。失败/拿不到返回 null(调用方回落到房间号显示)。
 * @param room    房间号或完整 URL
 * @param _cookies 忽略(主播名必须匿名解析,见文件头)。
 */
export async function fetchAnchorName(room: string, _cookies?: string | null): Promise<string | null> {
  try {
    return await platformForRoom(room).fetchAnchorName(room);
  } catch (e) {
    log.error(`解析主播名失败 room=${room}:`, (e as Error)?.message ?? e);
    return null;
  }
}
