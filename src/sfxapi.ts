/**
 * 火山引擎「音频生成大模型 seed-audio-1.0」HTTP 客户端。
 *
 * 文档：https://docs.volcengine.com/docs/DoubaoVoice/audio-generation-http
 *
 * ## 这个接口的四个硬事实（写错都不会报类型错，只会在真机上坏）
 *
 * 1. **模型名是短名 `seed-audio-1.0`**，不是方舟的 `doubao-seed-audio-1-0`。
 *    语音的 `openspeech` 端点不能把方舟 id 转过来，填错会直接 4xx。
 * 2. **认证只有 `X-Api-Key`**（语音控制台的 API Key），不是方舟的 `ARK_API_KEY`；
 *    `X-Api-Request-Id` 只是链路追踪。`/tts/create` **不发** `X-Api-Resource-Id`
 *    （模型在 body 的 `model` 里）。
 * 3. **同步接口**：一次 POST 返回整段音频（`audio` base64；也可能只给一个 2 小时
 *    有效的 `url`）。没有任务 id、没有轮询。
 * 4. **响应必须按文件头校验**：`Content-Type` 不可信，CDN 可能返回一段错误页或
 *    未完成的临时对象；只信它会把随机字节落成 `.mp3`。
 *
 * 这一层只负责「参数 → HTTP → 结构化结果」；任务目录、后台任务表、导出都在
 * `sfxgen.ts` 里。两者都不碰界面。
 */

import { randomUUID } from "node:crypto";
import { sniffBinary } from "./musicapi.js";

/** 当前唯一支持的生成式音频模型。 */
export const SFX_DEFAULT_MODEL = "seed-audio-1.0";
/** 国内站默认端点；BytePlus / 反代可以改。 */
export const SFX_DEFAULT_BASE_URL = "https://openspeech.bytedance.com";
export const SFX_DEFAULT_FORMAT = "wav";
export const SFX_DEFAULT_SAMPLE_RATE = 24000;

export type SfxFormat = "mp3" | "wav" | "ogg_opus";
export const SFX_FORMATS: readonly SfxFormat[] = ["mp3", "wav", "ogg_opus"];

/**
 * 官方支持的采样率。全部暴露给界面：游戏音效常用 44100 / 48000，
 * 语音便签用 16000 / 24000 就够。
 */
export const SFX_SAMPLE_RATES: readonly number[] = [8000, 16000, 24000, 32000, 44100, 48000];

export const SFX_LIMITS = {
  /** text_prompt 上限（官方文档）。 */
  promptChars: 2048,
  /** 单次输出上限（秒）。没有 duration 参数，时长只能写进提示词。 */
  maxSeconds: 120,
  /** 参考音频最多 3 条。 */
  audioRefs: 3,
  /** 单条参考（图 / 音频）上限 10MB。 */
  refBytes: 10 * 1024 * 1024,
  /** 单条参考音频时长上限（秒）。 */
  refSeconds: 30,
  /** 响应 / 下载音频的硬上限，防止异常响应把内存吃满。 */
  responseBytes: 120 * 1024 * 1024
} as const;

export interface SfxSettings {
  format: SfxFormat;
  sampleRate: number;
  /** -50~100；100 = 2x。 */
  speechRate: number;
  /** -50~100；100 = 2x 音量。 */
  loudnessRate: number;
  /** -12~12。 */
  pitchRate: number;
  /** 显式 AIGC 节奏水印；默认关。 */
  watermark: boolean;
}

export interface SfxRefsInput {
  /** 参考图（最多 1 张）。 */
  image?: Buffer;
  /** 参考音频（最多 3 条，按上传顺序对应 @音频1…@音频3）。 */
  audios?: Buffer[];
}

export interface SfxRequest {
  prompt: string;
  settings: SfxSettings;
  refs?: SfxRefsInput;
}

export interface SfxApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface SfxResult {
  bytes: Buffer;
  /** 按内容嗅探出的真实扩展名（不是请求里的 format）。 */
  ext: string;
  mime: string;
  /** 后处理后的时长；可能因为变速与 original_duration 不同。 */
  duration?: number;
  /** 计费时长。 */
  originalDuration?: number;
  /** 远端临时 URL（2 小时）；没有返回就是 undefined。 */
  remoteUrl?: string;
  /** 服务端日志 id（排障时给用户）。 */
  logId?: string;
  /** 实际尝试的 HTTP 次数；只在网络握手失败并自动重试时 > 1。 */
  attempts?: number;
}

export class SfxApiError extends Error {
  readonly status?: number;
  readonly code?: string | number;
  readonly logId?: string;
  constructor(message: string, options: { status?: number; code?: string | number; logId?: string } = {}) {
    super(message);
    this.name = "SfxApiError";
    this.status = options.status;
    this.code = options.code;
    this.logId = options.logId;
  }
}

export function isSfxFormat(value: unknown): value is SfxFormat {
  return typeof value === "string" && (SFX_FORMATS as readonly string[]).includes(value);
}

export function isSfxSampleRate(value: unknown): boolean {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && SFX_SAMPLE_RATES.includes(n);
}

/** 配置层用：非法值静默回到默认（配置文件可能被手改过）。 */
export function sfxFormatOrDefault(value: unknown): SfxFormat {
  return isSfxFormat(value) ? value : (SFX_DEFAULT_FORMAT as SfxFormat);
}

export function sfxSampleRateOrDefault(value: unknown): number {
  return isSfxSampleRate(value) ? Number(value) : SFX_DEFAULT_SAMPLE_RATE;
}

/**
 * 统一 Base URL：去尾斜杠；用户把完整端点整段粘进来时也认。
 *
 * 不做「本机地址放行」之类的安全判断：这里是**提交端点**，用户填本地 mock / 反代
 * 是明确意图；下载远端 `url` 时另外校验。
 */
export function normalizeSfxBaseUrl(value: unknown): string {
  let raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return SFX_DEFAULT_BASE_URL;
  raw = raw.replace(/\/+$/u, "");
  raw = raw.replace(/\/api\/v3\/tts\/create$/iu, "");
  raw = raw.replace(/\/api\/v3$/iu, "");
  raw = raw.replace(/\/+$/u, "");
  return raw === "" ? SFX_DEFAULT_BASE_URL : raw;
}

export function sfxEndpoint(baseUrl: string): string {
  return `${normalizeSfxBaseUrl(baseUrl)}/api/v3/tts/create`;
}

/**
 * 配置是否足以提交生成。
 *
 * 同时接受完整 Config（`sfxApiKey`）与脱敏视图（`sfxApiKeySet`），界面、工具
 * intake、网关读同一份判断，避免「界面说没配好、模型说配好了」。
 */
export function sfxBlocker(config: { sfxApiKey?: string; sfxApiKeySet?: boolean } | undefined): string | undefined {
  const hasKey = config?.sfxApiKeySet === true || (typeof config?.sfxApiKey === "string" && config.sfxApiKey.trim() !== "");
  if (!hasKey) {
    return "还没配置火山引擎语音 API Key：设置 → 游戏素材大师 → 音效生成（火山引擎 Seed-Audio）。注意它是语音控制台的 API Key，不是火山方舟的 ARK_API_KEY。";
  }
  return undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberIn(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new SfxApiError(`${field} 必须是数字`);
  if (n < min || n > max) throw new SfxApiError(`${field} 超出范围：${n}（允许 ${min}–${max}）`);
  return Math.round(n);
}

/**
 * 任务参数归一化。`fallback` 是配置里的默认值。
 *
 * **越界直接报错，不静默夹**：用户以为「调了音调」，结果被悄悄夹到 12，
 * 生成出来的东西和预期不一样，比报错更难查。
 */
export function normalizeSfxSettings(raw: unknown, fallback: Partial<SfxSettings> = {}): SfxSettings {
  const input = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const format = input.format === undefined || input.format === "" ? sfxFormatOrDefault(fallback.format) : input.format;
  if (!isSfxFormat(format)) {
    throw new SfxApiError(`输出格式不合法：${String(format)}（允许：${SFX_FORMATS.join(" / ")}）`);
  }
  const sampleRate =
    input.sampleRate === undefined || input.sampleRate === ""
      ? sfxSampleRateOrDefault(fallback.sampleRate)
      : Number(input.sampleRate);
  if (!isSfxSampleRate(sampleRate)) {
    throw new SfxApiError(`采样率不合法：${String(input.sampleRate)}（允许：${SFX_SAMPLE_RATES.join(" / ")}）`);
  }
  return {
    format,
    sampleRate,
    speechRate: numberIn(input.speechRate, fallback.speechRate ?? 0, -50, 100, "语速 speech_rate"),
    loudnessRate: numberIn(input.loudnessRate, fallback.loudnessRate ?? 0, -50, 100, "音量 loudness_rate"),
    pitchRate: numberIn(input.pitchRate, fallback.pitchRate ?? 0, -12, 12, "音调 pitch_rate"),
    watermark: input.watermark === undefined ? fallback.watermark === true : input.watermark === true
  };
}

function b64(buffer: Buffer): string {
  return buffer.toString("base64");
}

/** 把一次请求变成真实 body；所有校验都在这里，错误信息点名到字段。 */
export function buildSfxBody(request: SfxRequest, model = SFX_DEFAULT_MODEL): Record<string, unknown> {
  const prompt = text(request.prompt);
  if (prompt === "") throw new SfxApiError("提示词不能为空：先写清要什么声音");
  if (prompt.length > SFX_LIMITS.promptChars) {
    throw new SfxApiError(`提示词太长：${prompt.length} 字符，上限 ${SFX_LIMITS.promptChars}。请精简后再提交（不会自动截断）。`);
  }
  const modelName = text(model) || SFX_DEFAULT_MODEL;
  const settings = normalizeSfxSettings(request.settings);
  const image = request.refs?.image;
  const audios = request.refs?.audios ?? [];
  if (image !== undefined && audios.length > 0) {
    throw new SfxApiError("参考图与参考音频不能同时使用：先删掉其中一种，再提交。");
  }
  if (image !== undefined && image.length > SFX_LIMITS.refBytes) {
    throw new SfxApiError(`参考图太大：${(image.length / 1024 / 1024).toFixed(1)}MB（上限 10MB）`);
  }
  if (audios.length > SFX_LIMITS.audioRefs) {
    throw new SfxApiError(`参考音频最多 ${SFX_LIMITS.audioRefs} 条，当前 ${audios.length} 条`);
  }
  for (const [index, audio] of audios.entries()) {
    if (audio.length > SFX_LIMITS.refBytes) {
      throw new SfxApiError(`第 ${index + 1} 条参考音频太大：${(audio.length / 1024 / 1024).toFixed(1)}MB（上限 10MB）`);
    }
  }
  const body: Record<string, unknown> = {
    model: modelName,
    text_prompt: prompt,
    audio_config: {
      format: settings.format,
      sample_rate: settings.sampleRate,
      speech_rate: settings.speechRate,
      loudness_rate: settings.loudnessRate,
      pitch_rate: settings.pitchRate
    }
  };
  if (image !== undefined) body.references = [{ image_data: b64(image) }];
  else if (audios.length > 0) body.references = audios.map((audio) => ({ audio_data: b64(audio) }));
  if (settings.watermark) body.watermark = { aigc_watermark: true };
  return body;
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(Math.max(10000, timeoutMs));
  return { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]), timeout };
}

function errorHint(status: number | undefined, bodyText: string, code: string | number | undefined): string {
  if (/resource\s+not\s+granted|10074|not\s+granted/iu.test(bodyText) || String(code ?? "") === "10074") {
    return "模型未开通：到火山引擎语音控制台开通「音频生成大模型 seed-audio-1.0」；API Key 不用换。";
  }
  if (status === 401 || status === 403) {
    return "鉴权失败：确认填的是语音控制台的 API Key（X-Api-Key），不是火山方舟的 ARK_API_KEY。";
  }
  if (status === 429) return "请求太频繁（429）：等一会儿再试；不要连续重复提交，每次都会计费。";
  if (status === 404) return "端点不存在：确认 Base URL 是语音服务的根地址（国内默认 https://openspeech.bytedance.com）。";
  return "";
}

async function readError(response: Response, logId: string | undefined): Promise<SfxApiError> {
  const textBody = await response.text().catch(() => "");
  let payload: any;
  try {
    payload = JSON.parse(textBody);
  } catch {
    payload = undefined;
  }
  const body = payload?.body ?? payload;
  const message = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : textBody.slice(0, 400);
  const code = body?.code ?? body?.error_code ?? undefined;
  const hint = errorHint(response.status, `${textBody} ${message}`, code);
  const parts = [`火山引擎音频生成失败（HTTP ${response.status}）`];
  if (message.trim() !== "") parts.push(message.trim());
  if (code !== undefined) parts.push(`code=${String(code)}`);
  if (logId !== undefined && logId !== "") parts.push(`logId=${logId}`);
  if (hint !== "") parts.push(hint);
  return new SfxApiError(parts.join("；"), { status: response.status, code, logId });
}

async function downloadAudio(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ bytes: Buffer; remoteUrl: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SfxApiError(`返回的音频 URL 不合法：${url.slice(0, 200)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SfxApiError(`只接受 http(s) 音频 URL：${parsed.protocol}`);
  }
  const { signal: composed } = combinedSignal(timeoutMs, signal);
  let response: Response;
  try {
    response = await fetch(parsed.toString(), { signal: composed });
  } catch (error) {
    if (composed.aborted) throw new SfxApiError("下载音频超时或被取消");
    throw new SfxApiError(`下载音频失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new SfxApiError(`下载音频失败（HTTP ${response.status}）`, { status: response.status });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > SFX_LIMITS.responseBytes) {
    throw new SfxApiError(`音频太大：${(length / 1024 / 1024).toFixed(1)}MB（上限 120MB）`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > SFX_LIMITS.responseBytes) {
    throw new SfxApiError(`音频太大：${(bytes.length / 1024 / 1024).toFixed(1)}MB（上限 120MB）`);
  }
  return { bytes, remoteUrl: parsed.toString() };
}

function decodeBase64Audio(value: string): Buffer {
  const raw = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  try {
    return Buffer.from(raw, "base64");
  } catch {
    throw new SfxApiError("返回的 audio 不是合法 base64");
  }
}

/**
 * 只对**还没完成 TLS 握手**的网络错误自动重试。
 *
 * 这类错误说明请求根本没发出去（例如 Clash / TUN 节点抖动时的
 * `Client network socket disconnected before secure TLS connection was established`），
 * 重试不会重复计费。已经在握手后断开的连接不重试——那有可能远端已经收到并计费。
 */
export function isRetryableHandshakeError(error: unknown): boolean {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  const text = [
    error instanceof Error ? error.message : "",
    cause?.message,
    (cause as { code?: string } | undefined)?.code
  ].filter(Boolean).join(" ");
  return /before secure TLS connection was established|socket disconnected before secure TLS|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|connect ETIMEDOUT/iu.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 调一次生成。`signal` 用于取消；超时由 `config.timeoutMs` 控制。
 *
 * 成功时一定返回**能按文件头识别的音频字节**；解码失败 / 不是音频容器都会抛错，
 * 不把坏字节交给调用方落盘。
 */
export async function generateSfx(
  config: SfxApiConfig,
  request: SfxRequest,
  signal?: AbortSignal
): Promise<SfxResult> {
  const apiKey = config.apiKey.trim();
  if (apiKey === "") throw new SfxApiError(sfxBlocker({ sfxApiKey: "" }) ?? "尚未配置语音 API Key");
  const endpoint = sfxEndpoint(config.baseUrl);
  const body = buildSfxBody(request, config.model);
  const { signal: composed, timeout } = combinedSignal(config.timeoutMs, signal);

  let response: Response | undefined;
  let attempts = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    attempts += 1;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
          "X-Api-Request-Id": randomUUID()
        },
        body: JSON.stringify(body),
        signal: composed
      });
      break;
    } catch (error) {
      lastError = error;
      if (timeout.aborted) {
        throw new SfxApiError(`生成超时（${Math.round(config.timeoutMs / 1000)} 秒）：音频生成较慢，可以调大超时后再试；失败重试会再计费，先问用户。`);
      }
      if (composed.aborted) throw new SfxApiError("生成已取消（远端可能仍会完成并计费）");
      if (!isRetryableHandshakeError(error) || attempt === 2) {
        const cause = error instanceof Error && error.cause instanceof Error ? `（${error.cause.message}）` : "";
        const retried = attempts > 1 ? `（网络握手失败，已尝试 ${attempts} 次）` : "";
        throw new SfxApiError(`请求火山引擎失败${retried}：${error instanceof Error ? error.message : String(error)}${cause}`);
      }
      await sleep(350 * (attempt + 1));
    }
  }
  if (response === undefined) {
    const cause = lastError instanceof Error && lastError.cause instanceof Error ? `（${lastError.cause.message}）` : "";
    throw new SfxApiError(`请求火山引擎失败（已尝试 ${attempts} 次）：${lastError instanceof Error ? lastError.message : String(lastError)}${cause}`);
  }

  const logId = response.headers.get("x-tt-logid") ?? undefined;
  if (!response.ok) throw await readError(response, logId);

  const textBody = await response.text();
  let payload: any;
  try {
    payload = textBody === "" ? {} : JSON.parse(textBody);
  } catch {
    throw new SfxApiError(`火山引擎返回了无法解析的 JSON（X-Tt-Logid=${logId ?? "无"}）：${textBody.slice(0, 300)}`, { logId });
  }
  const data = payload?.body !== null && typeof payload?.body === "object" ? payload.body : payload;
  if (typeof data?.code === "number" && data.code !== 0 && !data?.audio && !data?.url) {
    throw new SfxApiError(
      `火山引擎音频生成失败：${typeof data.message === "string" ? data.message : "未知错误"}（code=${data.code}${logId === undefined ? "" : `，logId=${logId}`}）${errorHint(undefined, String(data.message ?? ""), data.code) === "" ? "" : `；${errorHint(undefined, String(data.message ?? ""), data.code)}`}`,
      { code: data.code, logId }
    );
  }

  let bytes: Buffer | undefined;
  let remoteUrl: string | undefined;
  if (typeof data?.audio === "string" && data.audio.trim() !== "") {
    bytes = decodeBase64Audio(data.audio.trim());
  } else if (typeof data?.url === "string" && data.url.trim() !== "") {
    const downloaded = await downloadAudio(data.url.trim(), config.timeoutMs, signal);
    bytes = downloaded.bytes;
    remoteUrl = downloaded.remoteUrl;
  } else {
    throw new SfxApiError(
      `火山引擎没有返回音频（code=${String(data?.code ?? "无")}，message=${String(data?.message ?? "空")}${logId === undefined ? "" : `，logId=${logId}`}）`,
      { code: data?.code, logId }
    );
  }
  if (bytes.length === 0) throw new SfxApiError("火山引擎返回了空音频", { logId });
  if (bytes.length > SFX_LIMITS.responseBytes) {
    throw new SfxApiError(`返回的音频太大：${(bytes.length / 1024 / 1024).toFixed(1)}MB（上限 120MB）`, { logId });
  }
  const sniffed = sniffBinary(bytes);
  const audioExts = new Set(["mp3", "m4a", "wav", "flac", "ogg", "aac"]);
  if (sniffed === undefined || !audioExts.has(sniffed.ext)) {
    throw new SfxApiError(
      `返回的内容不是可识别的音频容器（Content-Type=${response.headers.get("content-type") ?? "unknown"}）。已丢弃，未落盘；可稍后重试。`,
      { logId }
    );
  }
  const duration = Number(data?.duration);
  const originalDuration = Number(data?.original_duration);
  return {
    bytes,
    ext: sniffed.ext,
    mime: sniffed.mime,
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    originalDuration: Number.isFinite(originalDuration) && originalDuration > 0 ? originalDuration : undefined,
    remoteUrl,
    logId,
    attempts
  };
}

/**
 * 设置页「测试连接」：真实生成一条极短音效。
 *
 * 没有免费的探活端点；读历史 / 读模型列表都不能证明「这个 Key 能生成」。
 * 所以这里真的调一次，只返回统计、不落盘。按钮文案必须写明会产生少量费用。
 */
export async function testSfxConnection(config: SfxApiConfig): Promise<Record<string, unknown>> {
  const result = await generateSfx(config, {
    prompt: "短促清脆的 UI 按钮点击声，约 0.5 秒",
    settings: {
      format: "mp3",
      sampleRate: 16000,
      speechRate: 0,
      loudnessRate: 0,
      pitchRate: 0,
      watermark: false
    }
  });
  return {
    ok: true,
    model: config.model || SFX_DEFAULT_MODEL,
    endpoint: sfxEndpoint(config.baseUrl),
    bytes: result.bytes.length,
    duration: result.duration ?? null,
    originalDuration: result.originalDuration ?? null,
    format: result.ext,
    attempts: result.attempts ?? 1,
    message: `连接正常：返回 ${result.bytes.length} 字节音频${result.duration === undefined ? "" : `，${result.duration.toFixed(2)} 秒`}`
  };
}
