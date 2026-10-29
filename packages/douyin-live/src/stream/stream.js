import { getRoomInfo, selectRandomAPI } from "./douyin_api.js";
import { globalLoadBalancer } from "./loadBalancer/loadBalancer.js";
export async function getInfo(channelId, opts) {
    let info;
    // 如果使用 balance 模式，使用负载均衡器
    if (opts?.api === "balance") {
        info = await globalLoadBalancer.callWithLoadBalance(channelId, {
            auth: opts.auth,
            uid: opts.uid,
        });
    }
    else {
        info = await getRoomInfo(channelId, opts ?? {});
    }
    const startTime = new Date();
    return {
        living: info.living,
        isLiveRadio: info.isLiveRadio,
        owner: info.owner,
        title: info.title,
        roomId: info.roomId,
        avatar: info.avatar,
        cover: info.cover,
        liveId: info.liveId,
        uid: info.uid,
        api: info.api,
        liveStartTime: startTime,
        recordStartTime: startTime,
        area: info.area ?? "",
    };
}
export async function getStream(opts) {
    let api = opts.api ?? "web";
    if (api === "userHTML" || api === "webHTML") {
        // ⚠️ 不要移除 webHTML(和 userHTML)的这条改写 —— 它们取不到流,改回 web 是**故意的**。
        //   证据 1(上游官方):@bililive-tools/douyin-recorder CHANGELOG 1.17.1
        //     「修复:`webHTML` 接口不再参与获取流」;上游 stream.ts 同款改写。
        //   证据 2(实测 2026-10-07,家宽 + VPS 一致):webHTML 的 getRoomInfo **恒 streams:0**
        //     (只给 living + id_str,不给流),走它必然抛「未找到对应的流」。
        // 若「顺手」删掉这段,用户一旦在设置里选 webHTML / 或 balance 随机选中它 → 取流失败。
        // 注意:弹幕 liveId 解析**不经过这里**(走 getInfo),那里 webHTML 是可用且最准的,别一起改。
        api = "web";
    }
    else if (api === "random") {
        api = selectRandomAPI(["userHTML", "webHTML"]);
    }
    // 直播电台(音频直播):web 端点对这类直播间常取不到流,上游 1.17.2 改为**优先 mobile**
    // (注释:「某些直播间 userHTML 不会有数据,mobile 可能更合适」)。除非用户显式指定 userHTML。
    if (opts.isLiveRadio) {
        api = "mobile";
        if (opts.api === "userHTML") api = "userHTML";
    }
    // balance:自动挑选 api type(按 priority + 加权随机),失败端点自动禁用/自愈。
    // 之前只支持 getInfo 走 balance,getStream 传 "balance" 会**静默落到 web** —— 取流拿不到均衡。
    // 这里补上:走均衡器拿到完整 roomInfo(含 sources),再走下面的选流逻辑。
    const roomOpts = {
        doubleScreen: opts.doubleScreen ?? true,
        auth: opts.auth,
        api: api,
        uid: opts.uid,
    };
    const info = api === "balance"
        // ⚠️ 取流的 exclude **必须含 webHTML** —— 见上面改写处的证据(恒 streams:0)。
        //   userHTML 同理(只返回用户页状态,无 sources/streams)。候选只剩 web / mobile(实测都有流)。
        //   别为了「多一个候选更稳」把 webHTML 加回来:它 100% 失败,只会白耗一次请求。
        // validate **必须保留**:某些端点**不抛错但返回不可用结果**(如被风控 → living:false 且无流),
        //   没它均衡器会当成功返回,调用方随后才炸「未找到对应的流」(VPS2 实测踩过)。
        ? await globalLoadBalancer.callWithLoadBalance(opts.channelId, {
            ...roomOpts,
            exclude: ["webHTML", "userHTML"],
            // ⚠️ **「没开播」不算端点失败** —— 只在「播着却拿不到流」时(validate 不过)才记 failure。
            //   否则房间未开播会把好端点误禁用(实测 VPS1:web/mobile 都被"失败"3 次锁 3 分钟),
            //   等真开播时全在禁用期 → 又取不到流,恶性循环。
            //   判定:living=false → 正常情况(不是端点坏了);living=true 却无 sources/streams → 端点坏了。
            validate: (r) => !!r && (!r.living
                || (Array.isArray(r.sources) && r.sources.length > 0
                    && Array.isArray(r.sources[0]?.streams) && r.sources[0].streams.length > 0)),
        })
        : await getRoomInfo(opts.channelId, roomOpts);
    if (!info.living) {
        throw new Error("It must be called getStream when living");
    }
    // 抖音为自动cdn，所以指定选择第一个
    const sources = info.sources[0];
    // preferAlternativeStream:把备用格式提到前面(音频流场景);上游同款 helper。
    const formatPriorities = getFormatPriorities(opts.formatPriorities || ["flv", "hls"], opts.preferAlternativeStream);
    // 查找指定质量的流
    let targetStream = sources.streams.find((s) => s.quality === opts.quality);
    let qualityName = targetStream?.name ?? "未知";
    if (!targetStream && opts.strictQuality) {
        throw new Error("Can not get expect quality because of strictQuality");
    }
    // 如果找不到指定质量的流，按照流顺序选择第一个可用的流
    if (!targetStream) {
        targetStream = sources.streams.find((stream) => stream.flv || stream.hls);
        if (targetStream) {
            qualityName = targetStream.name;
        }
    }
    if (!targetStream) {
        throw new Error("未找到对应的流");
    }
    // 根据格式优先级选择 URL
    let url;
    for (const format of formatPriorities) {
        url = targetStream[format];
        if (url)
            break;
    }
    if (!url) {
        throw new Error("未找到对应的流");
    }
    let onlyAudio = false;
    try {
        const urlObj = new URL(url);
        if (urlObj.searchParams.get("only_audio") == "1") {
            onlyAudio = true;
        }
    }
    catch (error) {
        console.warn("[stream_processor] 解析流 URL 失败", error);
    }
    return {
        ...info,
        currentStream: {
            name: qualityName,
            source: "自动",
            url: url,
            onlyAudio,
        },
    };
}

/**
 * 格式优先级:preferAlternativeStream=true 且给了 ≥2 个格式时,把第二个格式提到最前
 * (用于「主格式取不到流时先试备用格式」的场景,上游 1.17.x 同款)。
 */
function getFormatPriorities(formatPriorities, preferAlternativeStream = false) {
    if (!preferAlternativeStream || formatPriorities.length < 2) {
        return [...formatPriorities];
    }
    return [formatPriorities[1], formatPriorities[0]];
}
