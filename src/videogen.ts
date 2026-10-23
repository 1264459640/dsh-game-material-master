/**
 * 视频生成后端分派。
 *
 * 同一个「图 + 提示词 → 一段视频」的调用被两条链路用到：八方向 / 转圈（pipeline）
 * 与序列帧（seqgen）。后端有两个：
 *
 *   - `minimax` 云端 MiniMax（默认），提交 / 查询 / 下载三件事都走 minimax.ts；
 *   - `comfy`   本机 ComfyUI（设置页打开 `comfyVideo` 后生效），走 comfy.ts。
 *
 * 差别只有三件事：**怎么提交、怎么查状态、从哪儿下载**。把这三件事收在这里，
 * 两条链路调用同一组函数，就不会出现「有一条链路忘了分派」的半成品。
 *
 * 任务 id 两个后端都是字符串（MiniMax 是 `task_id`，ComfyUI 是 `prompt_id`），
 * 所以调用方照旧把它存进节点的 `taskId`，另外把 `backend` 一起写进节点——
 * 判断后端必须**按节点上记的那个值**，不能按当前配置：用户完全可能在任务跑的
 * 中间改设置，那时按配置去查就会拿 MiniMax 的接口去查一个 ComfyUI 的 prompt_id。
 */

import type { Config } from "./config.js";
import {
  fetchComfyObjectInfo,
  normalizeComfyCookies,
  parseComfyWorkflow,
  prepareComfyWorkflow,
  queryComfyVideo,
  submitComfyVideo,
  uploadComfyImage,
  type ComfyInjectionInput
} from "./comfy.js";
import { cleanCustomVideoBaseUrl, queryCustomVideo, submitCustomVideo } from "./customvideo.js";
import { downloadVideo, queryVideo, retrieveFile, submitVideo } from "./minimax.js";
import type { VideoBackend } from "./store.js";

export type VideoPhase = "pending" | "running" | "succeeded" | "failed";

export interface VideoSubmitRequest {
  prompt: string;
  /** 首帧图（data URI）。ComfyUI 后端必须有，MiniMax 视模式而定。 */
  firstFrameImage?: string;
  /** 尾帧图（data URI），只有首尾帧模式用得上。 */
  lastFrameImage?: string;
  /** 多模态参考模式的参考图（data URI）。 */
  referenceImages?: string[];
  /** 多模态参考模式的参考视频（data URI）。 */
  referenceVideos?: string[];
  /** 秒数（MiniMax 走自己的档位归一化；ComfyUI 用它覆盖秒数输入）。 */
  duration: number;
  resolution: string;
  promptOptimizer: boolean;
  /** 覆盖全局视频模型（序列帧任务跟随全局设置，这里只留个口子）。 */
  model?: string;
}

export interface VideoSubmitResult {
  taskId: string;
  backend: VideoBackend;
  /** 本机注入过程中的说明（日志 / 设置页预览用）。 */
  notes: string[];
}

export interface VideoQueryResult {
  status: VideoPhase;
  remoteStatus: string;
  /** 成功时的视频地址（ComfyUI 是 `/view?...` 的本机地址）。 */
  url?: string;
  error?: string;
}

/** 当前配置用哪个后端。 */
export function videoBackendOf(config: Config): VideoBackend {
  if (config.videoProvider === "custom") return "custom";
  if (config.videoProvider === "comfy" || config.comfyVideo === true) return "comfy";
  return "minimax";
}

/** 当前生效的视频模型名。 */
export function videoModelOf(config: Config): string {
  const backend = videoBackendOf(config);
  if (backend === "custom") return config.customVideoModel;
  if (backend === "comfy") return "ComfyUI";
  return config.minimaxModel;
}

/**
 * 提交前的前置检查。
 *
 * 只检查「当前后端」需要的东西：走 ComfyUI 时不该因为没填 MiniMax Key 就拦住
 * 用户——反过来也一样，Key 填了但工作流指向一个没启动的 ComfyUI，那是提交时的事，
 * 由请求本身报错（测试按钮负责提前发现）。
 */
export function assertVideoBackendReady(config: Config): void {
  const backend = videoBackendOf(config);
  if (backend === "comfy") return;
  if (backend === "custom") {
    if (config.customVideoApiKey.trim() === "") throw new Error("尚未配置自定义视频 API Key（设置 → 游戏素材大师）");
    return;
  }
  if (config.minimaxApiKey.trim() === "") throw new Error("尚未配置 MiniMax API Key");
}

/** 提交一个视频任务。返回的 taskId 与 backend 必须一起存进节点。 */
export async function submitVideoTask(config: Config, request: VideoSubmitRequest): Promise<VideoSubmitResult> {
  const backend = videoBackendOf(config);
  if (backend === "comfy") return submitViaComfy(config, request);
  if (backend === "custom") return submitViaCustom(config, request);

  const taskId = await submitVideo({
    baseUrl: config.minimaxBaseUrl,
    apiKey: config.minimaxApiKey,
    model: request.model ?? config.minimaxModel,
    timeoutMs: config.minimaxTimeoutMs,
    prompt: request.prompt,
    firstFrameImage: request.firstFrameImage,
    lastFrameImage: request.lastFrameImage,
    referenceImages: request.referenceImages,
    referenceVideos: request.referenceVideos,
    duration: request.duration,
    resolution: request.resolution,
    promptOptimizer: request.promptOptimizer
  });
  return { taskId, backend: "minimax", notes: [] };
}

/**
 * 本机 ComfyUI 提交：上传首帧图 → 注入提示词与参数 → `POST /prompt`。
 *
 * 注入点是「看工作流里有什么」自动探测的，用户在设置页可以手动覆盖；
 * 探测结果（notes）一路带回去记进项目日志，出问题时能看见它到底改了哪几个输入。
 */
async function submitViaComfy(config: Config, request: VideoSubmitRequest): Promise<VideoSubmitResult> {
  if ((request.referenceImages?.length ?? 0) > 0 || (request.referenceVideos?.length ?? 0) > 0) {
    throw new Error("本地 ComfyUI 后端不支持「多模态参考模式」：请改用首尾帧模式，或关掉设置里的 ComfyUI 后端");
  }
  if (request.firstFrameImage === undefined) {
    throw new Error("本地 ComfyUI 后端需要一张首帧图：请先上传 / 生成首帧，再提交");
  }
  const parsed = parseComfyWorkflow(config.comfyWorkflow);
  if (parsed.ok === false) throw new Error(`ComfyUI 工作流无法解析：${parsed.error}`);

  const client = { baseUrl: config.comfyBaseUrl, timeoutMs: config.comfyTimeoutMs, cookies: config.comfyCookies };
  const firstImageName = await uploadComfyImage(client, request.firstFrameImage);
  const lastImageName =
    request.lastFrameImage === undefined ? undefined : await uploadComfyImage(client, request.lastFrameImage);

  // 0 一律当「没填」：尺寸 / 时长用工作流里的原值，种子每次随机（固定种子要显式填）。
  // 读一次节点定义：工作流里**没连**的 optional IMAGE 输入（例如 FreeVideoMedia.first）
  // 在 JSON 里看不见，只有节点定义能告诉我们「这个节点接得下 IMAGE、键名叫 first」。
  // 查不到（ComfyUI 半途挂了之类）就按「没有额外信息」继续——上面的上传已经验证过连通性。
  const info = await fetchComfyObjectInfo(
    client,
    Object.keys(parsed.workflow).map((id) => parsed.workflow[id]?.class_type ?? "")
  ).catch(() => undefined);

  const injection: ComfyInjectionInput = {
    prompt: request.prompt,
    firstImageName,
    lastImageName,
    width: config.comfyWidth > 0 ? config.comfyWidth : undefined,
    height: config.comfyHeight > 0 ? config.comfyHeight : undefined,
    seconds: config.comfySeconds > 0 ? config.comfySeconds : undefined,
    seed: config.comfySeed > 0 ? config.comfySeed : randomSeed()
  };
  const prepared = prepareComfyWorkflow({
    workflow: parsed.workflow,
    overrides: { prompt: config.comfyPromptTarget, first: config.comfyFirstFrameTarget },
    info,
    ...injection
  });

  // 尾帧图上传了却没人接收，说明注入点是错的：静默丢掉会让用户以为「用了尾帧」。
  if (lastImageName !== undefined && prepared.bindings.last === undefined) {
    throw new Error("工作流里没有可以接收尾帧图的位置：请去掉尾帧，或用「尾帧输入」指定节点与输入名");
  }

  const taskId = await submitComfyVideo({ ...client, workflow: prepared.workflow });
  return { taskId, backend: "comfy", notes: prepared.notes };
}

/** 自定义 API（New API / OpenAI Video）提交。 */
async function submitViaCustom(config: Config, request: VideoSubmitRequest): Promise<VideoSubmitResult> {
  const model =
    request.model && request.model.trim() !== "" && request.model !== config.minimaxModel
      ? request.model.trim()
      : config.customVideoModel;
  const taskId = await submitCustomVideo({
    baseUrl: config.customVideoBaseUrl,
    apiKey: config.customVideoApiKey,
    model,
    prompt: request.prompt,
    firstFrameImage: request.firstFrameImage,
    duration: request.duration,
    resolution: request.resolution,
    timeoutMs: config.customVideoTimeoutMs
  });
  return { taskId, backend: "custom", notes: [] };
}

/** ComfyUI 的 seed 是整数；0 被当作「用工作流里的原值」，所以随机种子从 1 起。 */
function randomSeed(): number {
  return 1 + Math.floor(Math.random() * (2 ** 31 - 1));
}

/**
 * 查询一个视频任务。
 *
 * `backend` 必须来自**节点上记的那个值**（见文件头注释），不是当前配置。
 */
export async function queryVideoTask(
  config: Config,
  backend: VideoBackend,
  taskId: string,
  options?: { model?: string }
): Promise<VideoQueryResult> {
  if (backend === "comfy") {
    const query = await queryComfyVideo({
      baseUrl: config.comfyBaseUrl,
      timeoutMs: config.comfyTimeoutMs,
      cookies: config.comfyCookies,
      promptId: taskId
    });
    return { status: query.status, remoteStatus: query.remoteStatus, url: query.videoUrl, error: query.error };
  }

  if (backend === "custom") {
    return queryCustomVideo({
      baseUrl: config.customVideoBaseUrl,
      apiKey: config.customVideoApiKey,
      taskId,
      timeoutMs: config.customVideoTimeoutMs
    });
  }

  const request = {
    baseUrl: config.minimaxBaseUrl,
    apiKey: config.minimaxApiKey,
    model: options?.model ?? config.minimaxModel,
    timeoutMs: config.minimaxTimeoutMs
  };
  const query = await queryVideo({ ...request, taskId });
  if (query.status !== "succeeded") {
    return { status: query.status, remoteStatus: query.remoteStatus, error: query.error };
  }
  // v2（H3）在查询结果里直接给地址；v1 还要拿 file_id 再换一次。
  const url =
    query.videoUrl ??
    (query.fileId !== undefined ? await retrieveFile({ ...request, fileId: query.fileId }) : undefined);
  if (url === undefined) throw new Error("任务已成功，但响应里既没有视频地址也没有 file_id");
  return { status: "succeeded", remoteStatus: query.remoteStatus, url };
}

/** 下载成品视频。ComfyUI 的地址是本机 `/view`，超时用 comfyTimeoutMs。 */
export async function downloadVideoTask(config: Config, backend: VideoBackend, url: string) {
  if (backend === "custom") {
    const isProxyUrl = Boolean(config.customVideoBaseUrl && url.startsWith(cleanCustomVideoBaseUrl(config.customVideoBaseUrl)));
    const headers: Record<string, string> = {};
    if (isProxyUrl && config.customVideoApiKey.trim()) {
      headers["Authorization"] = `Bearer ${config.customVideoApiKey.trim()}`;
    }
    return downloadVideo(url, config.customVideoTimeoutMs, Object.keys(headers).length > 0 ? headers : undefined);
  }
  // 反向代理鉴权时 `/view` 同样要带 Cookie，否则视频下不下来（只影响 comfy 后端）。
  const cookies = backend === "comfy" ? normalizeComfyCookies(config.comfyCookies) : "";
  return downloadVideo(url, backend === "comfy" ? config.comfyTimeoutMs : config.minimaxTimeoutMs, cookies === "" ? undefined : { Cookie: cookies });
}

/** 失败原因：各后端的 query 都会给 error，兜底文案按后端区分。 */
export function videoFailureReason(backend: VideoBackend, error: string | undefined): string {
  if (error !== undefined && error.trim() !== "") return error;
  if (backend === "custom") return "自定义视频 API 报告该任务失败";
  return backend === "comfy" ? "ComfyUI 报告该任务失败" : "MiniMax 报告该任务失败";
}
