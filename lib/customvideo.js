/**
 * 自定义图生视频后端：支持 New API / One API / OpenAI Video (openai_video) 协议。
 *
 * 端点结构：
 * 1. 提交任务：POST {baseUrl}/v1/videos
 * 2. 轮询状态：GET {baseUrl}/v1/videos/{taskId}
 * 3. 结果获取：GET {baseUrl}/v1/videos/{taskId}/content 或返回的直链
 * 4. 模型列表：GET {baseUrl}/v1/models
 */
export class CustomVideoError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "CustomVideoError";
        this.status = status;
    }
}
/** 清理并规范化 Base URL，剥除末尾斜杠和 /v1 或 /v1/videos。 */
export function cleanCustomVideoBaseUrl(baseUrl) {
    let cleaned = (baseUrl ?? "").trim().replace(/\/+$/, "");
    cleaned = cleaned.replace(/\/v1\/videos$/i, "");
    cleaned = cleaned.replace(/\/v1$/i, "");
    return cleaned;
}
/** 提交一个图生视频任务到自定义 API（New API / OpenAI Video 兼容）。 */
export async function submitCustomVideo(input) {
    const root = cleanCustomVideoBaseUrl(input.baseUrl);
    if (!root)
        throw new CustomVideoError("尚未配置自定义视频 Base URL");
    const url = `${root}/v1/videos`;
    const timeout = AbortSignal.timeout(Math.max(10000, input.timeoutMs ?? 120000));
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json"
    };
    if (input.apiKey && input.apiKey.trim()) {
        headers["Authorization"] = `Bearer ${input.apiKey.trim()}`;
    }
    const body = {
        model: input.model.trim() || "kling-v1",
        prompt: input.prompt.trim()
    };
    if (input.firstFrameImage) {
        // 兼容各渠道插件写法：kling/sora/doubao/hailuo 等
        body.image = input.firstFrameImage;
        body.input_reference = input.firstFrameImage;
    }
    if (typeof input.duration === "number" && input.duration > 0) {
        body.seconds = input.duration;
        body.duration = input.duration;
    }
    if (input.resolution) {
        body.size = input.resolution;
    }
    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: timeout
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new CustomVideoError(`提交自定义视频任务失败 (HTTP ${response.status}): ${errorText || response.statusText}`, response.status);
    }
    const json = (await response.json());
    const taskId = json.id ?? json.task_id ?? json.data?.task_id ?? json.taskId;
    if (typeof taskId !== "string" || taskId.trim() === "") {
        throw new CustomVideoError(`自定义视频接口响应中未找到任务 ID: ${JSON.stringify(json)}`);
    }
    return taskId.trim();
}
/** 查询自定义视频任务状态。 */
export async function queryCustomVideo(input) {
    const root = cleanCustomVideoBaseUrl(input.baseUrl);
    const url = `${root}/v1/videos/${encodeURIComponent(input.taskId)}`;
    const timeout = AbortSignal.timeout(Math.max(10000, input.timeoutMs ?? 30000));
    const headers = {
        Accept: "application/json"
    };
    if (input.apiKey && input.apiKey.trim()) {
        headers["Authorization"] = `Bearer ${input.apiKey.trim()}`;
    }
    const response = await fetch(url, {
        method: "GET",
        headers,
        signal: timeout
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new CustomVideoError(`查询视频任务状态失败 (HTTP ${response.status}): ${errorText || response.statusText}`, response.status);
    }
    const json = (await response.json());
    const rawStatus = String(json.status ?? json.data?.status ?? json.task_status ?? "").toLowerCase();
    if (["completed", "succeeded", "success"].includes(rawStatus)) {
        // 查找视频 URL：优先看响应里的直链
        let videoUrl = json.url ??
            json.video_url ??
            json.data?.video_url ??
            (Array.isArray(json.videos) && json.videos[0]?.url) ??
            (Array.isArray(json.data?.task_result?.videos) && json.data.task_result.videos[0]?.url);
        if (!videoUrl) {
            // 若没有直链，则走 New API 内部代理下载端点
            videoUrl = `${root}/v1/videos/${encodeURIComponent(input.taskId)}/content`;
        }
        return {
            status: "succeeded",
            remoteStatus: rawStatus || "completed",
            url: videoUrl
        };
    }
    if (["failed", "failure", "cancelled", "canceled", "error"].includes(rawStatus)) {
        const errorMsg = json.error?.message ??
            json.fail_reason ??
            json.task_status_msg ??
            json.message ??
            "视频生成失败";
        return {
            status: "failed",
            remoteStatus: rawStatus || "failed",
            error: String(errorMsg)
        };
    }
    return {
        status: ["in_progress", "processing", "running"].includes(rawStatus) ? "running" : "pending",
        remoteStatus: rawStatus || "queued"
    };
}
/** 从自定义 API (New API / OpenAI 规范) 获取可用模型列表。 */
export async function fetchCustomVideoModels(baseUrl, apiKey, timeoutMs = 15000) {
    const root = cleanCustomVideoBaseUrl(baseUrl);
    if (!root)
        throw new CustomVideoError("尚未配置自定义视频 Base URL");
    const url = `${root}/v1/models`;
    const headers = {
        Accept: "application/json"
    };
    if (apiKey && apiKey.trim()) {
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
    }
    const timeout = AbortSignal.timeout(Math.max(5000, timeoutMs));
    const res = await fetch(url, { headers, signal: timeout });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CustomVideoError(`获取模型失败 (HTTP ${res.status}): ${text || res.statusText}`, res.status);
    }
    const json = (await res.json());
    if (!Array.isArray(json.data))
        return [];
    const list = json.data.map((m) => m.id).filter(Boolean);
    // 智能排序：优先把包含视频相关关键词的模型置顶
    const videoKeywords = ["video", "kling", "sora", "cog", "luma", "wan", "hailuo", "jimeng", "minimax", "runway", "i2v", "t2v", "v2v"];
    return list.sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        const aIsVideo = videoKeywords.some((k) => aLower.includes(k));
        const bIsVideo = videoKeywords.some((k) => bLower.includes(k));
        if (aIsVideo && !bIsVideo)
            return -1;
        if (!aIsVideo && bIsVideo)
            return 1;
        return a.localeCompare(b);
    });
}
/** 自检连接：通过拉取模型列表来验证 Base URL 和 API Key 的连通性。 */
export async function testCustomVideo(input) {
    if (!input.apiKey || input.apiKey.trim() === "") {
        throw new CustomVideoError("尚未配置自定义视频 API Key");
    }
    const models = await fetchCustomVideoModels(input.baseUrl, input.apiKey, input.timeoutMs);
    return {
        ok: true,
        modelCount: models.length,
        sampleModels: models.slice(0, 10)
    };
}
