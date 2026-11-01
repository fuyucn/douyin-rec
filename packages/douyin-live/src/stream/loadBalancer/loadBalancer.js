import { getRoomInfo } from "../douyin_api.js";

// ⚠️ 我们的扩展(issue #425):把登录串从错误消息里脱敏。
//   douyin_api 的 assert 曾把整串登录串拼进消息,上游 loadBalancer 会把它原样 console.warn
//   并最终 throw。这里统一出口:整段 `cookies: ...` 到行尾/字符串末尾全部替换。
export function redactSecrets(msg) {
    if (typeof msg !== "string") return msg;
    return msg.replace(/cookies:[^\n]*/g, "cookies:[已隐去]");
}
/**
 * API 负载均衡器类
 * 实现多个 API 接口的负载均衡调用，具备失败重试和禁用机制
 */
export class APILoadBalancer {
    endpoints = [];
    config;
    constructor(config) {
        this.config = {
            maxFailures: 3, // 连续失败3次后禁用
            blockDuration: 3 * 60 * 1000, // 禁用3分钟
            retryMultiplier: 1.5, // 重试时间倍增
            healthCheckInterval: 30 * 1000, // 30秒健康检查
            ...config,
        };
        // 初始化可用的 API 端点
        this.initializeEndpoints();
    }
    /**
     * 初始化 API 端点配置
     */
    initializeEndpoints() {
        const defaultEndpoints = [
            { name: "web", priority: 2, weight: 1 },
            { name: "webHTML", priority: 1, weight: 1 },
            { name: "mobile", priority: 6, weight: 1 },
            { name: "userHTML", priority: 4, weight: 1 },
        ];
        this.endpoints = defaultEndpoints.map((endpoint) => ({
            endpoint,
            failureCount: 0,
            lastFailureTime: 0,
            isBlocked: false,
            nextRetryTime: 0,
        }));
    }
    /**
     * 获取下一个可用的 API 端点
     * 使用加权轮询算法，优先选择权重高且未被禁用的端点
     *
     * ⚠️ 本地扩展(上游无此参数):`exclude` 排除本场景不适用的端点(如取流排除 webHTML/userHTML)。
     * 重新 vendor 上游时务必保留,否则取流可能选中恒无流的端点。
     *
     * 注:`priority` 只影响**排序顺序**,不影响选中概率 —— 实际选择是按 `weight` 的加权随机,
     * 排序后遍历顺序对随机结果无影响。当前四端点 weight 全 1 → 等概率。要改概率请调 `weight`。
     */
    getNextEndpoint(exclude) {
        const now = Date.now();
        // 清理过期的禁用状态
        this.endpoints.forEach((status) => {
            if (status.isBlocked && now >= status.nextRetryTime) {
                status.isBlocked = false;
                status.failureCount = Math.max(0, status.failureCount - 1); // 部分恢复
            }
        });
        // 获取可用的端点(exclude:本场景不适用的端点,如取流时排除只能做状态检测的 userHTML)
        const skip = exclude && exclude.length > 0 ? new Set(exclude) : null;
        const availableEndpoints = this.endpoints.filter(
            (status) => !status.isBlocked && !(skip && skip.has(status.endpoint.name)),
        );
        if (availableEndpoints.length === 0) {
            return null; // 所有端点都被禁用
        }
        // 按优先级和权重排序
        availableEndpoints.sort((a, b) => {
            if (a.endpoint.priority !== b.endpoint.priority) {
                return a.endpoint.priority - b.endpoint.priority; // 优先级越小越好
            }
            return b.endpoint.weight - a.endpoint.weight; // 权重越大越好
        });
        // 使用加权随机选择
        const totalWeight = availableEndpoints.reduce((sum, status) => sum + status.endpoint.weight, 0);
        const random = Math.random() * totalWeight;
        let currentWeight = 0;
        for (const status of availableEndpoints) {
            currentWeight += status.endpoint.weight;
            if (random <= currentWeight) {
                return status;
            }
        }
        // 如果加权选择失败，返回第一个可用的
        return availableEndpoints[0];
    }
    /**
     * 记录 API 调用失败
     */
    recordFailure(apiType, error) {
        const status = this.endpoints.find((s) => s.endpoint.name === apiType);
        if (!status)
            return;
        status.failureCount++;
        status.lastFailureTime = Date.now();
        // 如果失败次数超过阈值，禁用该端点
        if (status.failureCount >= this.config.maxFailures) {
            status.isBlocked = true;
            const blockDuration = this.config.blockDuration *
                Math.pow(this.config.retryMultiplier, status.failureCount - this.config.maxFailures);
            status.nextRetryTime = Date.now() + blockDuration;
            // ⚠️ 我们的扩展(上游把时间戳用逗号运算符丢掉、并把原始 error.message 拼进日志;error.message 可能含登录串,见 issue #425)。
            console.warn(`[stream_processor] API ${apiType} has been blocked due to ${status.failureCount} failures. Next retry at: ${new Date(status.nextRetryTime).toISOString()} err=${redactSecrets(error.message)}`);
        }
    }
    /**
     * 记录 API 调用成功
     */
    recordSuccess(apiType) {
        const status = this.endpoints.find((s) => s.endpoint.name === apiType);
        if (!status)
            return;
        // 成功调用后，减少失败计数
        if (status.failureCount > 0) {
            status.failureCount = Math.max(0, status.failureCount - 1);
        }
        // 如果之前被禁用，现在可以恢复
        if (status.isBlocked && status.failureCount === 0) {
            status.isBlocked = false;
            status.nextRetryTime = 0;
        }
    }
    /**
     * 使用负载均衡策略调用 getRoomInfo
     */
    async callWithLoadBalance(webRoomId, opts = {}) {
        // ⚠️ 这是对上游 vendored 副本的**本地扩展**,重新 vendor 上游时务必保留(见 SOURCE.md「我们的扩展」)。
        //   exclude  —— 本场景不适用的端点(取流时排除 webHTML/userHTML:它们恒无流,见 stream.js)。
        //   validate —— 结果可用性校验(可选)。上游缺这个:某些端点**不抛错但返回不可用结果**
        //               (如被风控 → living:false 且无 sources),上游会当成功返回、停止重试,
        //               调用方随后才炸「未找到对应的流」(VPS2 实测踩过)。传了 validate 后:
        //               返回 falsy 即按失败处理(记 failure + 换下一个端点)。
        const { exclude, validate, ...roomOpts } = opts;
        const skip = exclude && exclude.length > 0 ? new Set(exclude) : null;
        const maxAttempts = this.endpoints.filter((s) => !(skip && skip.has(s.endpoint.name))).length;
        let lastError = null;
        // ⚠️ 本地扩展(上游 bug):单次调用内不重复试同一个端点。上游无此去重 → getNextEndpoint
        // 可能反复随机选中同一个刚失败的端点,「试遍所有端点」退化成「重试同一个」(最多 N 次都白跑)。
        // 已试过的并入 exclude。重新 vendor 时务必保留。
        const tried = [];
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const endpointStatus = this.getNextEndpoint([...(exclude ?? []), ...tried]);
            if (!endpointStatus) {
                throw new Error("所有 API 端点都不可用，请稍后重试");
            }
            const apiType = endpointStatus.endpoint.name;
            tried.push(apiType);
            try {
                const result = await getRoomInfo(webRoomId, {
                    ...roomOpts,
                    api: apiType,
                });
                // 结果不可用(如取流时该端点无流)→ 记失败并换下一个端点,而不是当成功返回。
                if (typeof validate === "function" && !validate(result)) {
                    throw new Error(`端点 ${apiType} 返回不可用结果(validate 未通过)`);
                }
                // 调用成功，记录成功状态
                this.recordSuccess(apiType);
                return result;
            }
            catch (error) {
                lastError = error;
                this.recordFailure(apiType, lastError);
                // ⚠️ 我们的扩展:错误消息可能带整串登录串(douyin_api assert 模板,issue #425),出日志前隐去。
                console.warn(`[stream_processor] API ${apiType} failed (attempt ${attempt + 1}/${maxAttempts}):`, redactSecrets(lastError.message));
                // 如果这是最后一次尝试，或者没有更多可用端点，则抛出错误
                if (attempt === maxAttempts - 1) {
                    // 最终错误同样脱敏后再抛出(调用方日志会原样打印 message,issue #425)。
                    lastError = new Error(redactSecrets(lastError?.message));
                    break;
                }
            }
        }
        throw new Error(`所有 API 调用都失败了。最后一个错误: ${lastError?.message || "未知错误"}`);
    }
    /**
     * 获取当前端点状态（用于调试和监控）
     */
    getEndpointStatus() {
        return this.endpoints.map((status) => ({ ...status }));
    }
    /**
     * 手动重置某个端点的状态
     */
    resetEndpoint(apiType) {
        const status = this.endpoints.find((s) => s.endpoint.name === apiType);
        if (status) {
            status.failureCount = 0;
            status.lastFailureTime = 0;
            status.isBlocked = false;
            status.nextRetryTime = 0;
        }
    }
    /**
     * 重置所有端点状态
     */
    resetAllEndpoints() {
        this.endpoints.forEach((status) => {
            status.failureCount = 0;
            status.lastFailureTime = 0;
            status.isBlocked = false;
            status.nextRetryTime = 0;
        });
    }
    /**
     * 更新端点配置
     */
    updateEndpointConfig(apiType, updates) {
        const status = this.endpoints.find((s) => s.endpoint.name === apiType);
        if (status) {
            Object.assign(status.endpoint, updates);
        }
    }
    /**
     * 获取负载均衡器配置
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * 更新负载均衡器配置
     */
    updateConfig(updates) {
        Object.assign(this.config, updates);
    }
}
// 创建全局单例实例
export const globalLoadBalancer = new APILoadBalancer();
