import { URL, URLSearchParams } from "url";
import axios from "axios";
import { isEmpty } from "lodash-es";
import { assert, get__ac_signature } from "./utils.js";
import { ABogus } from "./sign.js";
const requester = axios.create({
    timeout: 10e3,
    // axios 会自动读取环境变量中的 http_proxy 和 https_proxy 并应用，这会让请求发往代理的 host。
    // 所以这里需要主动禁用代理功能。
    proxy: false,
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    },
});
/**
 * 从抖音短链接解析得到直播间ID
 * @param shortURL 短链接，如 https://v.douyin.com/DpfoBLAXoHM/
 * @returns webRoomId 直播间ID
 */
export async function resolveShortURL(shortURL) {
    // 获取跳转后的页面内容
    const response = await requester.get(shortURL);
    const redirectedURL = response.request.res.responseUrl;
    if (redirectedURL.includes("/user/")) {
        const secUid = new URL(redirectedURL).searchParams.get("sec_uid");
        if (!secUid) {
            throw new Error("无法从短链接解析出直播间ID");
        }
        return parseUser(`https://www.douyin.com/user/${secUid}`);
    }
    // 尝试从页面内容中提取webRid
    const webRidMatch = response.data.match(/"webRid\\":\\"(\d+)\\"/);
    if (webRidMatch) {
        return webRidMatch[1];
    }
    throw new Error("无法从短链接解析出直播间ID");
}
const qualityList = [
    {
        key: "origin",
        desc: "原画",
    },
    {
        key: "uhd",
        desc: "蓝光",
    },
    {
        key: "hd",
        desc: "超清",
    },
    {
        key: "sd",
        desc: "高清",
    },
    {
        key: "ld",
        desc: "标清",
    },
    {
        key: "ao",
        desc: "音频流",
    },
    {
        key: "real_origin",
        desc: "真原画",
    },
];
let cookieCache;
export const getCookie = async () => {
    const now = new Date().getTime();
    // 缓存6小时
    if (cookieCache?.startTimestamp && now - cookieCache.startTimestamp < 6 * 60 * 60 * 1000) {
        return cookieCache.cookies;
    }
    const res = await requester.get("https://live.douyin.com/");
    if (!res.headers["set-cookie"]) {
        throw new Error("No cookie in response");
    }
    const cookies = (res.headers["set-cookie"] ?? [])
        .map((cookie) => {
        return cookie.split(";")[0];
    })
        .join("; ");
    if (!cookies.includes("ttwid")) {
        // 如果不含ttwid，且已经存在含ttwid的cookie，将缓存时间直接增加1小时，复用之前的参数
        if (cookieCache?.cookies) {
            cookieCache.startTimestamp += 60 * 60 * 1000; // 增加1小时
            return cookieCache.cookies;
        }
    }
    cookieCache = {
        startTimestamp: now,
        cookies,
    };
    return cookies;
};
function generateNonce() {
    // 21味随机字母数字组合
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let nonce = "";
    for (let i = 0; i < 21; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
/**
 * 随机选择一个可用的 API 接口
 * @returns 随机选择的 API 类型
 */
export function selectRandomAPI(exclude) {
    const availableAPIs = ["web", "webHTML", "mobile", "userHTML"];
    if (exclude && exclude.length > 0) {
        for (const api of exclude) {
            const index = availableAPIs.indexOf(api);
            if (index !== -1) {
                availableAPIs.splice(index, 1);
            }
        }
    }
    const randomIndex = Math.floor(Math.random() * availableAPIs.length);
    return availableAPIs[randomIndex];
}
/**
 * 通过解析用户html页面来获取房间数据
 * @param secUserId
 * @param opts
 */
async function getRoomInfoByUserWeb(secUserId, opts = {}) {
    const url = `https://www.douyin.com/user/${secUserId}`;
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0";
    let nonce = "068ea1c0100bb2c06590f";
    try {
        nonce = await getNonce(url);
    }
    catch (error) {
        console.warn("[stream_processor] 获取nonce失败，使用默认值", error);
    }
    let cookies = undefined;
    if (opts.auth) {
        cookies = opts.auth;
    }
    else {
        const timestamp = Math.floor(Date.now() / 1000);
        const signed = get__ac_signature(timestamp, url, nonce, ua);
        cookies = `__ac_nonce=${nonce}; __ac_signature=${signed}; __ac_referer=__ac_blank`;
    }
    const res = await requester.get(url, {
        headers: {
            "User-Agent": ua,
            cookie: cookies,
        },
    });
    if (res.data.includes("验证码")) {
        throw new Error("需要验证码，请在浏览器中打开链接获取" + url);
    }
    if (!res.data.includes("抖音号")) {
        throw new Error("userHTML页面没有正常加载" + String(res.data));
    }
    if (!res.data.includes("直播中")) {
        return {
            living: false,
            isLiveRadio: false,
            nickname: "",
            sec_uid: "",
            avatar: "",
            api: "userHTML",
            room: null,
        };
    }
    const userRegex = /(\{\\"user\\":.*?)\]\\n"\]\)/;
    // fs.writeFileSync("douyin.html", res.data);
    const userMatch = res.data.match(userRegex);
    if (!userMatch) {
        throw new Error("No match found in HTML");
    }
    let userJsonStr = userMatch[1];
    userJsonStr = userJsonStr
        .replace(/\\"/g, '"')
        .replace(/\\"/g, '"')
        .replace(/"\$\w+"/g, "null");
    // const roomRegex = /(\{\\"common\\":.*?)"\]\)/;
    // const roomMatch = res.data.match(roomRegex);
    // if (!roomMatch) {
    //   throw new Error("No room match found in HTML");
    // }
    // let roomJsonStr = roomMatch[1];
    // roomJsonStr = roomJsonStr
    //   .replace(/\\"/g, '"')
    //   .replace(/\\"/g, '"')
    //   .replace(/"\$\w+"/g, "null");
    try {
        // console.log(userJsonStr);
        const userData = JSON.parse(userJsonStr);
        // 从用户页 roomData 重建取流所需结构(上游 1.17.x 补):用户页只给 flv_pull_url 的 map,
        // 需按画质 key 反查出各档 flv,拼成与 web 端点同形的 live_core_sdk_data.pull_data.stream_data,
        // 否则 stream_url 为 null → userHTML 路径取不到流(见 SOURCE.md「上游修复对照」)。
        const roomData = userData?.user?.user?.roomData;
        const streamUrl = roomData?.stream_url;
        let liveCoreSdkData = null;
        if (streamUrl) {
            liveCoreSdkData = { live_core_sdk_data: streamUrl.live_core_sdk_data };
            if (liveCoreSdkData?.live_core_sdk_data?.pull_data) {
                const flvPullUrl = streamUrl.flv_pull_url;
                const streamData = {};
                // or4 = 原画(用户页的 key 与 web 端点不同名)→ 归一为 origin。
                for (const quality of [{ key: "or4", desc: "原画" }, ...qualityList]) {
                    const flvUrls = Object.values(flvPullUrl ?? {});
                    if (flvUrls.some((u) => u.includes(`${quality.key}`))) {
                        const u = flvUrls.find((x) => x.includes(`${quality.key}`));
                        const convertedQuality = quality.key === "or4" ? "origin" : quality.key;
                        streamData[convertedQuality] = { main: { flv: u, hls: "" } };
                    }
                }
                liveCoreSdkData.live_core_sdk_data.pull_data.stream_data = streamData;
            }
            else {
                liveCoreSdkData = null;
            }
        }
        return {
            living: userData?.user?.user?.roomData?.status === 2,
            isLiveRadio: roomData?.live_type_audio ?? false,
            nickname: userData?.user?.user?.nickname ?? "",
            sec_uid: userData?.user?.user?.secUid ?? "",
            avatar: userData?.user?.user?.avatar ?? "",
            // 本函数 = userHTML 端点(由 getRoomInfo 的 `api === "userHTML"` 分支调用)。
            // 之前误标 "webHTML" 会让 getRoomInfo 里按 data.api 走的返回分支错判 —— 已修(与上游一致)。
            api: "userHTML",
            room: {
                title: "",
                cover: "",
                id_str: userData?.user?.user?.roomIdStr,
                stream_url: liveCoreSdkData,
            },
        };
    }
    catch (e) {
        console.error("[stream_processor] Failed to parse JSON:", e);
        throw e;
    }
}
/**
 * 通过解析直播html页面来获取房间数据
 * @param webRoomId
 * @param opts
 */
async function getRoomInfoByHtml(webRoomId, opts = {}) {
    const url = `https://live.douyin.com/${webRoomId}`;
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0";
    const nonce = generateNonce();
    let cookies = undefined;
    if (opts.auth) {
        cookies = opts.auth;
    }
    else {
        const timestamp = Math.floor(Date.now() / 1000);
        const signed = get__ac_signature(timestamp, url, nonce, ua);
        cookies = `__ac_nonce=${nonce}; __ac_signature=${signed}; __ac_referer=__ac_blank`;
    }
    const res = await requester.get(url, {
        headers: {
            "User-Agent": ua,
            cookie: cookies,
        },
    });
    const regex = /(\{\\"state\\":.*?)\]\\n"\]\)/;
    const match = res.data.match(regex);
    if (!match) {
        throw new Error("No match found in HTML");
    }
    let jsonStr = match[1];
    jsonStr = jsonStr.replace(/\\"/g, '"');
    jsonStr = jsonStr.replace(/\\"/g, '"');
    try {
        const data = JSON.parse(jsonStr);
        const roomInfo = data.state.roomStore.roomInfo;
        const streamData = data.state.streamStore.streamData;
        // 直播电台(音频直播):enter_mode === 1。这类直播间 room.status 不一定是 2,靠 enter_mode 补判,
        // 否则会被当成「未开播」→ 漏录(上游 1.17.1/1.17.2 修复,见 SOURCE.md)。
        const isLiveRadio = roomInfo.enter_mode == 1;
        return {
            living: roomInfo?.room?.status === 2 || isLiveRadio,
            isLiveRadio,
            nickname: roomInfo?.anchor?.nickname ?? "",
            sec_uid: roomInfo?.anchor?.sec_uid ?? "",
            avatar: roomInfo?.anchor?.avatar_thumb?.url_list?.[0] ?? "",
            api: "webHTML",
            room: {
                title: roomInfo?.room?.title ?? "",
                cover: roomInfo?.room?.cover?.url_list?.[0] ?? "",
                id_str: roomInfo?.room?.id_str ?? "",
                stream_url: {
                    pull_datas: roomInfo?.room?.stream_url?.pull_datas,
                    live_core_sdk_data: {
                        pull_data: {
                            options: { qualities: streamData.H264_streamData?.options?.qualities ?? [] },
                            stream_data: streamData.H264_streamData?.stream ?? {},
                        },
                    },
                },
            },
        };
    }
    catch (e) {
        console.error("[stream_processor] Failed to parse JSON:", e);
        throw e;
    }
}
async function getRoomInfoByWeb(webRoomId, opts = {}) {
    let cookies = undefined;
    if (opts.auth) {
        cookies = opts.auth;
    }
    else {
        // 抖音的 'webcast/room/web/enter' api 会需要 ttwid 的 cookie，这个 cookie 是由这个请求的响应头设置的，
        // 所以在这里请求一次自动设置。
        cookies = await getCookie();
    }
    const params = {
        aid: 6383,
        live_id: 1,
        device_platform: "web",
        language: "zh-CN",
        enter_from: "web_live",
        cookie_enabled: "true",
        screen_width: 1920,
        screen_height: 1080,
        browser_language: "zh-CN",
        browser_platform: "MacIntel",
        browser_name: "Chrome",
        browser_version: "108.0.0.0",
        web_rid: webRoomId,
        "Room-Enter-User-Login-Ab": 0,
        is_need_double_stream: "false",
    };
    const abogus = new ABogus();
    const [query, _, ua] = abogus.generateAbogus(new URLSearchParams(params).toString(), "");
    const res = await requester.get(`https://live.douyin.com/webcast/room/web/enter/?${query}`, {
        headers: {
            cookie: cookies,
            "User-Agent": ua,
        },
    });
    if (res.data.status_code === 30003) {
        // 直播已结束
        return {
            living: false,
            isLiveRadio: false,
            nickname: "",
            sec_uid: "",
            avatar: "",
            api: "web",
            room: {
                title: "",
                cover: "",
                id_str: "",
                stream_url: null,
            },
        };
    }
    // ⚠️ 我们的扩展(上游模板把整串登录串拼进错误消息,经 loadBalancer console.warn 进 docker logs,见 issue #425):
    //    只打「有/无(长度)」。升级 vendor 时务必保留本改动。
    assert(
        res.data.status_code === 0,
        `Unexpected resp, code ${res.data.status_code}, msg ${JSON.stringify(res.data.data)}, id ${webRoomId}, 登录串: ${cookies ? `有(${cookies.length})` : "无"}`,
    );
    const data = res.data.data;
    const room = data?.data?.[0];
    return {
        // room_status:0=普通直播,1=直播电台(音频直播)。只判 0 会把电台误判成未开播 → 漏录
        // (上游 1.17.1/1.17.2 修复,见 SOURCE.md「上游修复对照」)。
        living: data?.room_status === 0 || data?.room_status === 1,
        isLiveRadio: data?.room_status === 1,
        nickname: data?.user?.nickname ?? "",
        avatar: data?.user?.avatar_thumb?.url_list?.[0] ?? "",
        sec_uid: data?.user?.sec_uid ?? "",
        api: "web",
        room: {
            title: room?.title ?? "",
            cover: room?.cover?.url_list?.[0] ?? "",
            id_str: room?.id_str ?? "",
            stream_url: room?.stream_url,
        },
    };
}
async function getRoomInfoByMobile(secUserId, opts = {}) {
    if (!secUserId) {
        // ⚠️ 我们的扩展(issue #425):opts 里可能含 auth(登录串),不能整对象打印。
        console.error("[stream_processor] Mobile API 缺少 secUserId", { hasAuth: !!opts?.auth, keys: Object.keys(opts ?? {}) });
        throw new Error("Mobile API need secUserId, please set uid field");
    }
    if (typeof secUserId === "number") {
        throw new Error("Mobile API need secUserId string, please set uid field");
    }
    const params = {
        app_id: 1128,
        live_id: 1,
        verifyFp: "",
        room_id: opts.roomId ?? 2,
        type_id: 0,
        sec_user_id: secUserId,
    };
    const res = await requester.get(`https://webcast.amemv.com/webcast/room/reflow/info/`, {
        params,
        headers: {
        // cookie: opts.auth,
        },
    });
    // @ts-ignore
    const room = res?.data?.data?.room;
    return {
        living: room?.status === 2,
        isLiveRadio: room?.live_type_audio ?? false,
        nickname: room?.owner?.nickname,
        sec_uid: room?.owner?.sec_uid,
        avatar: room?.owner?.avatar_thumb?.url_list?.[0],
        api: "mobile",
        room: {
            title: room?.title,
            cover: room?.cover?.url_list?.[0],
            id_str: room?.id_str,
            stream_url: room?.stream_url,
        },
        webRid: room?.owner?.web_rid,
    };
}
/** 用「上一次/当前 room.id_str + sec_uid」离线反查稳定 web_rid。 */
export async function resolveWebRid(roomId, secUserId, opts = {}) {
    const data = await getRoomInfoByMobile(secUserId, { ...opts, roomId });
    return String(data.webRid ?? "").trim() || null;
}
export async function getRoomInfo(webRoomId, opts = {}) {
    let data;
    let api = opts.api ?? "web";
    // 如果选择了 random，则随机选择一个可用的接口
    if (api === "random") {
        api = selectRandomAPI();
    }
    if (api === "mobile" || api === "userHTML") {
        // mobile 接口需要 sec_uid 参数，老数据可能没有，实现兼容
        if (!opts.uid || typeof opts.uid !== "string") {
            api = "web";
        }
    }
    if (api === "webHTML") {
        data = await getRoomInfoByHtml(webRoomId, opts);
    }
    else if (api === "mobile") {
        data = await getRoomInfoByMobile(opts.uid, opts);
    }
    else if (api === "userHTML") {
        data = await getRoomInfoByUserWeb(opts.uid, opts);
    }
    else {
        data = await getRoomInfoByWeb(webRoomId, opts);
    }
    // console.log(JSON.stringify(data, null, 2));
    const room = data.room;
    if (api === "userHTML") {
        return {
            living: data.living,
            isLiveRadio: data.isLiveRadio,
            roomId: webRoomId,
            owner: data.nickname,
            title: room?.title ?? data.nickname,
            streams: [],
            sources: [],
            avatar: data.avatar,
            cover: room?.cover ?? "",
            liveId: room?.id_str ?? "",
            uid: data.sec_uid,
            api: data.api,
        };
    }
    assert(room, `No room data, id ${webRoomId}`);
    if (room?.stream_url == null) {
        return {
            living: false,
            isLiveRadio: data.isLiveRadio,
            roomId: webRoomId,
            owner: data.nickname,
            title: room?.title ?? data.nickname,
            streams: [],
            sources: [],
            avatar: data.avatar,
            cover: room.cover,
            liveId: room.id_str,
            uid: data.sec_uid,
            api: data.api,
        };
    }
    let qualities = [];
    let stream_data = "";
    if (opts.doubleScreen && !isEmpty(room.stream_url.pull_datas)) {
        const pull_data = Object.values(room.stream_url.pull_datas)[0] ?? {
            options: {
                qualities: [],
            },
            stream_data: "",
        };
        // @ts-ignore
        qualities = pull_data.options.qualities;
        // @ts-ignore
        stream_data = pull_data.stream_data;
    }
    if (!stream_data) {
        qualities = room.stream_url.live_core_sdk_data.pull_data.options.qualities;
        stream_data = room.stream_url.live_core_sdk_data.pull_data.stream_data;
    }
    const streamData = typeof stream_data === "string" ? JSON.parse(stream_data).data : stream_data;
    const streams = qualities.map((info) => ({
        desc: info.name,
        key: info.sdk_key,
        bitRate: info.v_bit_rate,
    }));
    // 转换流数据结构
    const streamList = Object.entries(streamData)
        .map(([quality, info]) => {
        const stream = info?.main;
        const name = qualityList.find((item) => item.key === quality)?.desc;
        return {
            quality: quality,
            name: name ?? "未知",
            flv: stream?.flv,
            hls: stream?.hls,
        };
    })
        .filter((stream) => stream.flv || stream.hls);
    const aoStream = streamList.find((stream) => stream.quality === "ao");
    if (!!aoStream) {
        // 真原画流是在ao流中拿到的
        streamList.push({
            quality: "real_origin",
            name: "真原画",
            flv: (aoStream?.flv ?? "").replace("&only_audio=1", ""),
            hls: (aoStream?.hls ?? "").replace("&only_audio=1", ""),
        });
    }
    streamList.sort((a, b) => {
        const aIndex = qualityList.findIndex((item) => item.key === a.quality);
        const bIndex = qualityList.findIndex((item) => item.key === b.quality);
        // 如果找不到对应的质量等级，将其排在最后
        if (aIndex === -1)
            return 1;
        if (bIndex === -1)
            return -1;
        return aIndex - bIndex;
    });
    // 看起来抖音是自动切换 cdn 的，所以这里固定返回一个默认的 source。
    const sources = [
        {
            name: "自动",
            streamMap: streamData,
            streams: streamList,
        },
    ];
    // console.log(JSON.stringify(sources, null, 2), qualities);
    return {
        living: data.living,
        isLiveRadio: data.isLiveRadio,
        roomId: webRoomId,
        owner: data.nickname,
        title: room.title,
        streams,
        sources,
        avatar: data.avatar,
        cover: room.cover,
        liveId: room.id_str,
        uid: data.sec_uid,
        api: data.api,
    };
}
let nonceCache;
/**
 * 获取nonce
 */
async function getNonce(url) {
    const now = new Date().getTime();
    // 缓存6小时
    if (nonceCache?.startTimestamp && now - nonceCache.startTimestamp < 6 * 60 * 60 * 1000) {
        return nonceCache.nonce;
    }
    const res = await requester.get(url);
    if (!res.headers["set-cookie"]) {
        throw new Error("No cookie in response");
    }
    const cookies = {};
    (res.headers["set-cookie"] ?? []).forEach((cookie) => {
        const [key, _] = cookie.split(";");
        const [keyPart, valuePart] = key.split("=");
        if (!keyPart || !valuePart)
            return;
        cookies[keyPart.trim()] = valuePart.trim();
    });
    const nonce = cookies["__ac_nonce"];
    if (nonce) {
        nonceCache = {
            startTimestamp: now,
            nonce: nonce,
        };
    }
    return nonce;
}
/**
 * 解析抖音号
 * @param url
 */
export async function parseUser(url) {
    const timestamp = Math.floor(Date.now() / 1000);
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0";
    const nonce = (await getNonce(url)) ?? generateNonce();
    const signed = get__ac_signature(timestamp, url, nonce, ua);
    const res = await requester.get(url, {
        headers: {
            "User-Agent": ua,
            cookie: `__ac_nonce=${nonce}; __ac_signature=${signed}`,
        },
    });
    const text = res.data;
    const regex = /\\"uniqueId\\":\\"(.*?)\\"/;
    const match = text.match(regex);
    if (match && match[1]) {
        return match[1];
    }
    return null;
}
