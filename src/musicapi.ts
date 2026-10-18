/**
 * 谱乐 AI（YourMusic）Open API 客户端。
 *
 * 文档：https://api.yourmusic.fun/docs
 * OpenAPI：https://api.yourmusic.fun/v1/openapi.json
 *
 * 这一层只负责「把参数变成正确的 HTTP 请求 / 把响应变成结构化结果」，
 * 不碰任务目录、不碰轮询循环 —— 那些在 `musicgen.ts` 里。
 *
 * 两个刻意的约束：
 * 1. **所有文本长度都显式校验**：超限时明确报错，绝不静默截断。截断会把用户写好的
 *    最后一段歌词悄悄丢掉，生成结果看着正常、内容却少了一截。
 * 2. **下载只接受 http(s)**：工具类接口要公开音频 URL，如果 agent 传一个
 *    `http://127.0.0.1:…` 进来，那是一次 SSRF。`assertDownloadUrl` 会挡住
 *    本机 / 私网地址；只有「用户把 Base URL 配成了一个本机地址」时才放行本机，
 *    因为那说明用户自己在跑 mock / 反代。
 */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MUSIC_BITRATES,
  MUSIC_CONVERT_FORMATS,
  MUSIC_ENGINE_PRESETS,
  MUSIC_KEY_SCALES,
  MUSIC_LIMITS,
  MUSIC_MODES,
  MUSIC_PRO_STEM_FORMATS,
  MUSIC_SAMPLE_RATES,
  MUSIC_STEM_COUNTS,
  MUSIC_STEM_FORMATS,
  MUSIC_TIME_SIGNATURES,
  MUSIC_VOCAL_LANGUAGES,
  MUSIC_ENGINES,
  defaultModelOf,
  enginePresetOf,
  isMusicEngine,
  isMusicMode,
  type MusicEngine,
  type MusicMode
} from "./musicmodels.js";

export interface MusicApiConfig {
  baseUrl: string;
  apiKey: string;
  /** 单次 HTTP 请求超时（毫秒）。 */
  timeoutMs: number;
}

export class MusicApiError extends Error {
  readonly status?: number;
  readonly type?: string;
  readonly code?: string;
  readonly param?: string;
  readonly requestId?: string;
  constructor(
    message: string,
    options: { status?: number; type?: string; code?: string; param?: string; requestId?: string } = {}
  ) {
    super(message);
    this.name = "MusicApiError";
    this.status = options.status;
    this.type = options.type;
    this.code = options.code;
    this.param = options.param;
    this.requestId = options.requestId;
  }
}

/** 统一 Base URL：去尾斜杠，并剥掉用户误填的 `/v1`（端点里已经带 /v1）。 */
export function normalizeMusicBaseUrl(value: unknown): string {
  let raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return "https://api.yourmusic.fun";
  raw = raw.replace(/\/+$/u, "");
  if (/\/v1$/iu.test(raw)) raw = raw.slice(0, -3).replace(/\/+$/u, "");
  return raw === "" ? "https://api.yourmusic.fun" : raw;
}

/**
 * 配置是否足以提交生成。
 *
 * 同时接受完整 Config（`musicApiKey`）与脱敏视图（`musicApiKeySet`）：
 * 界面、工具 intake、网关都读同一份判断，避免「界面说没配好、模型说配好了」。
 */
export function musicBlocker(config: { musicApiKey?: string; musicApiKeySet?: boolean } | undefined): string | undefined {
  const hasKey = config?.musicApiKeySet === true || (typeof config?.musicApiKey === "string" && config.musicApiKey.trim() !== "");
  if (!hasKey) {
    return "还没配置谱乐 AI API Key：设置 → 游戏素材大师 → 音乐生成（谱乐 AI），配好点「测试连接」。";
  }
  return undefined;
}

function apiBase(config: MusicApiConfig): string {
  return normalizeMusicBaseUrl(config.baseUrl);
}

function authHeaders(config: MusicApiConfig): Record<string, string> {
  if (config.apiKey.trim() === "") {
    throw new MusicApiError("尚未配置谱乐 AI API Key（设置 → 游戏素材大师 → 音乐生成）");
  }
  return {
    Authorization: `Bearer ${config.apiKey.trim()}`,
    Accept: "application/json"
  };
}

interface ApiErrorBody {
  type?: string;
  code?: string;
  message?: string;
  param?: string;
  request_id?: string;
}

async function readError(response: Response): Promise<MusicApiError> {
  const text = await response.text().catch(() => "");
  let body: ApiErrorBody | undefined;
  try {
    const parsed = JSON.parse(text) as any;
    body = parsed?.error ?? parsed;
  } catch {
    body = undefined;
  }
  const message =
    typeof body?.message === "string" && body.message.trim() !== ""
      ? body.message
      : text.trim().slice(0, 500) || `HTTP ${response.status} ${response.statusText}`;
  const hint = statusHint(response.status);
  return new MusicApiError(`${hint}${message}`, {
    status: response.status,
    type: typeof body?.type === "string" ? body.type : undefined,
    code: typeof body?.code === "string" ? body.code : undefined,
    param: typeof body?.param === "string" ? body.param : undefined,
    requestId: typeof body?.request_id === "string" ? body.request_id : undefined
  });
}

function statusHint(status: number): string {
  if (status === 401) return "谱乐 AI API Key 无效或已过期：";
  if (status === 402) return "谱乐 AI 积分不足：";
  if (status === 429) return "谱乐 AI 请求过于频繁，请稍后再试：";
  if (status === 404) return "谱乐 AI 找不到该资源（可能尚未完成或不属于当前账号）：";
  if (status >= 500) return "谱乐 AI 服务端错误：";
  return `谱乐 AI 请求失败（HTTP ${status}）：`;
}

async function requestJson(
  config: MusicApiConfig,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string | number | undefined> } = {},
  options: { allow404?: boolean } = {}
): Promise<any> {
  const base = apiBase(config);
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${base}/`);
  if (init.query !== undefined) {
    for (const [key, value] of Object.entries(init.query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const timeout = AbortSignal.timeout(Math.max(10000, config.timeoutMs || 120000));
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: init.method ?? "GET",
      headers: {
        ...authHeaders(config),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: timeout
    });
  } catch (error) {
    if (timeout.aborted) throw new MusicApiError(`谱乐 AI 请求超时（${Math.round((config.timeoutMs || 120000) / 1000)} 秒）`);
    throw new MusicApiError(`无法连接谱乐 AI：${error instanceof Error ? error.message : String(error)}`);
  }
  if (options.allow404 === true && response.status === 404) {
    return { __notFound: true };
  }
  if (!response.ok) throw await readError(response);
  const text = await response.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MusicApiError(`谱乐 AI 返回了无法解析的 JSON：${text.slice(0, 300)}`, { status: response.status });
  }
}

// ── 生成请求 ────────────────────────────────────────────────────────────

export interface GenerationRequestInput {
  engine: MusicEngine | string;
  mode: MusicMode | string;
  model?: string;
  title?: string;
  prompt?: string;
  lyrics?: string;
  tags?: string;
  instrumental?: boolean;
  n?: number;
  vocalGender?: string;
  negativeTags?: string;
  styleWeight?: number;
  weirdness?: number;
  duration?: number;
  isMaxMode?: boolean;
  augCreativity?: number;
  vocalLanguage?: string;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  useFormat?: boolean;
  sampleRate?: number;
  bitrate?: number;
  sourceSongIds?: string[];
  sourceSongId?: string;
  coverClipId?: string;
  audioWeight?: number;
  continueClipId?: string;
  continueAt?: number;
  startTime?: number;
  endTime?: number;
  clipId?: string;
}

export interface GenerationRequest {
  endpoint: string;
  body: Record<string, unknown>;
  engine: MusicEngine;
  mode: MusicMode;
  /** 日志里用的一句话摘要（不含 Key）。 */
  summary: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function limitText(value: unknown, max: number, field: string, required = false): string {
  const out = text(value);
  if (required && out === "") throw new MusicApiError(`缺少必填参数：${field}`);
  if (out.length > max) throw new MusicApiError(`${field} 太长：${out.length} 字符，上限 ${max}。请精简后再提交。`);
  return out;
}

function numIn(value: unknown, min: number, max: number, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new MusicApiError(`${field} 必须是数字`);
  if (n < min || n > max) throw new MusicApiError(`${field} 超出范围：${n}（允许 ${min}–${max}）`);
  return n;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const out = String(value);
  if (!(allowed as readonly string[]).includes(out)) {
    throw new MusicApiError(`${field} 取值不合法：${out}（允许：${allowed.join(" / ")}）`);
  }
  return out as T;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function put(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") body[key] = value;
}

function titleOf(input: GenerationRequestInput): string {
  return limitText(input.title, MUSIC_LIMITS.title, "标题", true);
}

function sunoCommon(input: GenerationRequestInput, model: string, body: Record<string, unknown>): void {
  put(body, "negative_tags", limitText(input.negativeTags, MUSIC_LIMITS.sunoTags, "negative_tags"));
  put(body, "vocal_gender", oneOf(input.vocalGender, ["male", "female"] as const, "vocal_gender"));
  put(body, "style_weight", numIn(input.styleWeight, 0, 1, "style_weight"));
  put(body, "weirdness_constraint", numIn(input.weirdness, 0, 1, "weirdness_constraint"));
  put(body, "duration", numIn(input.duration, 10, 360, "duration"));
  put(body, "is_max_mode", bool(input.isMaxMode));
  put(body, "aug_creativity", numIn(input.augCreativity, 0, 4, "aug_creativity"));
  put(body, "model", model);
}

/**
 * 把一次「引擎 + 模式 + 参数」变成真实端点与请求体。
 *
 * 参数校验放在这里，而不是让平台返回 400：平台的中文错误经常只说「参数错误」，
 * agent 很难据此自我修正。这里会点名是哪个字段、允许什么范围。
 */
export function buildGenerationRequest(input: GenerationRequestInput): GenerationRequest {
  if (!isMusicEngine(input.engine)) throw new MusicApiError(`未知音乐引擎：${String(input.engine)}`);
  if (!isMusicMode(input.mode)) throw new MusicApiError(`未知生成模式：${String(input.mode)}`);
  const engine = input.engine;
  const mode = input.mode;
  const preset = enginePresetOf(engine);
  if (!preset.modes.some((entry) => entry.id === mode)) {
    throw new MusicApiError(`${preset.label} 不支持「${mode}」模式（可用：${preset.modes.map((entry) => entry.id).join(" / ")}）`);
  }
  const model = text(input.model) || preset.defaultModel;
  if (!preset.models.some((entry) => entry.id === model)) {
    throw new MusicApiError(`${preset.label} 没有模型「${model}」（可用：${preset.models.map((entry) => entry.id).join(" / ")}）`);
  }
  const body: Record<string, unknown> = {};

  if (engine === "suno") {
    if (mode === "prompt") {
      put(body, "prompt", limitText(input.prompt, MUSIC_LIMITS.sunoPrompt, "prompt", true));
      put(body, "model", model);
      put(body, "instrumental", bool(input.instrumental));
      return { endpoint: "/v1/suno/generate/prompt", body, engine, mode, summary: `Suno prompt · ${model}` };
    }
    if (mode === "concat") {
      const clipId = text(input.clipId);
      if (clipId === "") throw new MusicApiError("concat 需要 clipId（最后一首续写歌曲的 id）");
      body.clip_id = clipId;
      return { endpoint: "/v1/suno/generate/concat", body, engine, mode, summary: `Suno concat · ${clipId}` };
    }
    body.title = titleOf(input);
    if (mode === "custom") {
      put(body, "lyrics", limitText(input.lyrics, MUSIC_LIMITS.sunoLyrics, "lyrics"));
      put(body, "tags", limitText(input.tags, MUSIC_LIMITS.sunoTags, "tags", true));
      put(body, "instrumental", bool(input.instrumental));
      sunoCommon(input, model, body);
      return { endpoint: "/v1/suno/generate/custom", body, engine, mode, summary: `Suno custom · ${model} · ${body.title}` };
    }
    put(body, "tags", limitText(input.tags, MUSIC_LIMITS.sunoTags, "tags"));
    put(body, "lyrics", limitText(input.lyrics, MUSIC_LIMITS.sunoLyrics, "lyrics"));
    sunoCommon(input, model, body);
    if (mode === "cover") {
      const id = text(input.coverClipId);
      if (id === "") throw new MusicApiError("cover 需要 coverClipId（要翻唱的歌曲 id）");
      body.cover_clip_id = id;
      put(body, "audio_weight", numIn(input.audioWeight, 0, 1, "audio_weight"));
      return { endpoint: "/v1/suno/generate/cover", body, engine, mode, summary: `Suno cover · ${id}` };
    }
    if (mode === "extend") {
      const id = text(input.continueClipId);
      if (id === "") throw new MusicApiError("extend 需要 continueClipId（要续写的歌曲 id）");
      body.continue_clip_id = id;
      put(body, "continue_at", numIn(input.continueAt, 0, 3600, "continue_at"));
      return { endpoint: "/v1/suno/generate/extend", body, engine, mode, summary: `Suno extend · ${id}` };
    }
    if (mode === "mashup") {
      const ids = Array.isArray(input.sourceSongIds) ? input.sourceSongIds.map((id) => text(id)).filter(Boolean) : [];
      if (ids.length < 2 || ids.length > 5) throw new MusicApiError("mashup 需要 2–5 个 sourceSongIds");
      body.source_clip_ids = ids;
      return { endpoint: "/v1/suno/generate/mashup", body, engine, mode, summary: `Suno mashup · ${ids.join(" + ")}` };
    }
    if (mode === "sample") {
      const id = text(input.coverClipId) || text(input.sourceSongIds?.[0]) || text(input.sourceSongId);
      if (id === "") throw new MusicApiError("sample 需要 sourceSongId（或 coverClipId）");
      const start = numIn(input.startTime, 0, 3600, "start_time");
      const end = numIn(input.endTime, 0, 3600, "end_time");
      if (start === undefined || end === undefined || end <= start) {
        throw new MusicApiError("sample 需要 start_time < end_time（秒）");
      }
      body.source_clip_id = id;
      body.start_time = start;
      body.end_time = end;
      return { endpoint: "/v1/suno/generate/sample", body, engine, mode, summary: `Suno sample · ${id} ${start}–${end}s` };
    }
  }

  if (engine === "mureka") {
    const n = input.n === undefined ? undefined : Math.round(numIn(input.n, 1, 3, "n") as number);
    put(body, "model", model);
    put(body, "n", n);
    if (mode === "prompt") {
      put(body, "prompt", limitText(input.prompt, MUSIC_LIMITS.murekaPrompt, "prompt", true));
      return { endpoint: "/v1/mureka/generate/prompt", body, engine, mode, summary: `Mureka prompt · ${model}` };
    }
    if (mode === "custom") {
      body.title = limitText(input.title, MUSIC_LIMITS.title, "标题", true);
      put(body, "lyrics", limitText(input.lyrics, MUSIC_LIMITS.murekaLyrics, "lyrics", true));
      put(body, "tags", limitText(input.tags, MUSIC_LIMITS.murekaTags, "tags"));
      return { endpoint: "/v1/mureka/generate/custom", body, engine, mode, summary: `Mureka custom · ${model}` };
    }
    if (mode === "instrumental") {
      body.title = limitText(input.title, MUSIC_LIMITS.title, "标题", true);
      put(body, "prompt", limitText(input.prompt, MUSIC_LIMITS.murekaPrompt, "prompt", true));
      return { endpoint: "/v1/mureka/generate/instrumental", body, engine, mode, summary: `Mureka instrumental · ${model}` };
    }
  }

  if (engine === "minimax") {
    const instrumental = bool(input.instrumental) === true;
    put(body, "prompt", limitText(input.prompt, MUSIC_LIMITS.minimaxPrompt, "prompt", true));
    if (!instrumental) {
      const lyrics = limitText(input.lyrics, MUSIC_LIMITS.minimaxLyrics, "lyrics");
      if (lyrics.length < 10) throw new MusicApiError("MiniMax 人声歌曲的 lyrics 至少 10 个字符（纯音乐请把 instrumental 设为 true）");
      put(body, "lyrics", lyrics);
    }
    put(body, "title", limitText(input.title, MUSIC_LIMITS.title, "标题"));
    put(body, "instrumental", instrumental);
    put(body, "sample_rate", oneOf(input.sampleRate === undefined ? undefined : String(input.sampleRate), MUSIC_SAMPLE_RATES.map(String) as any, "sample_rate"));
    put(body, "bitrate", oneOf(input.bitrate === undefined ? undefined : String(input.bitrate), MUSIC_BITRATES.map(String) as any, "bitrate"));
    if (body.sample_rate !== undefined) body.sample_rate = Number(body.sample_rate);
    if (body.bitrate !== undefined) body.bitrate = Number(body.bitrate);
    put(body, "vocal_gender", text(input.vocalGender));
    put(body, "model", model);
    return { endpoint: "/v1/minimax/generate/custom", body, engine, mode, summary: `MiniMax custom · ${model}` };
  }

  // ACE-Step
  body.title = limitText(input.title, MUSIC_LIMITS.title, "标题", true);
  put(body, "model", model);
  put(body, "instrumental", bool(input.instrumental));
  put(body, "vocal_language", oneOf(input.vocalLanguage, MUSIC_VOCAL_LANGUAGES, "vocal_language"));
  if (mode === "prompt") {
    put(body, "prompt", limitText(input.prompt, 4000, "prompt", true));
    return { endpoint: "/v1/ace-step/generate/prompt", body, engine, mode, summary: `ACE-Step prompt · ${model}` };
  }
  put(body, "tags", limitText(input.tags, 2000, "tags", true));
  put(body, "lyrics", limitText(input.lyrics, 5000, "lyrics"));
  put(body, "bpm", numIn(input.bpm, 30, 300, "bpm"));
  put(body, "key_scale", oneOf(input.keyScale, MUSIC_KEY_SCALES, "key_scale"));
  put(body, "time_signature", oneOf(input.timeSignature, MUSIC_TIME_SIGNATURES, "time_signature"));
  put(body, "use_format", bool(input.useFormat));
  return { endpoint: "/v1/ace-step/generate/custom", body, engine, mode, summary: `ACE-Step custom · ${model}` };
}

// ── 提交 / 查询 / WAV / LRC / 历史 ──────────────────────────────────────

export interface MusicSongPayload {
  id: string;
  status: string;
  title?: string;
  audio_url?: string;
  audio_wav_url?: string;
  image_url?: string;
  duration?: number;
  lyric?: string;
  tags?: string;
  model_name?: string;
  created_at?: string;
  instrumental?: boolean;
}

export interface SubmitResult {
  taskId?: string;
  songs: MusicSongPayload[];
  raw: any;
}

export async function submitGeneration(config: MusicApiConfig, request: GenerationRequest): Promise<SubmitResult> {
  const payload = await requestJson(config, request.endpoint, { method: "POST", body: request.body });
  const songs: MusicSongPayload[] = Array.isArray(payload?.songs)
    ? payload.songs
        .filter((song: any) => typeof song?.id === "string" && song.id !== "")
        .map((song: any) => ({ ...song, id: String(song.id), status: typeof song.status === "string" ? song.status : "pending" }))
    : [];
  if (songs.length === 0) {
    throw new MusicApiError(`谱乐 AI 没有返回歌曲 id：${JSON.stringify(payload).slice(0, 400)}`);
  }
  return {
    taskId: typeof payload?.task_id === "string" ? payload.task_id : undefined,
    songs,
    raw: payload
  };
}

/**
 * 上传一段本地音频，供 Suno 的音频条件生成（cover / sample）使用。
 *
 * 文档：`POST /v1/suno/audio/upload`（multipart），上限 300MB；标准上传免费。
 * 如果 Suno 判定音频有版权，需要带 `copyright_audio_flag=1` 走**付费**版权通道；
 * 那条路是异步任务，要轮询 `GET /v1/suno/audio/upload/{taskId}`，成功后
 * `songs[0].id` 才是可用的 cover 参考 id。
 */
export interface SunoAudioUploadInput {
  filePath: string;
  fileName?: string;
  /** true = 走付费版权通道（`copyright_audio_flag=1`）。 */
  copyright?: boolean;
  /** 版权通道等待上限（毫秒），默认 5 分钟。 */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface SunoAudioUploadResult {
  songId: string;
  status: string;
  /** 是否走的是付费版权通道。 */
  copyright: boolean;
  taskId?: string;
  raw: unknown;
}

/** 上传文件的 MIME：只接受音乐模块实际会产出的格式。 */
function audioMimeOf(file: string): string {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  if (ext === "wav") return "audio/wav";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "aac") return "audio/aac";
  if (ext === "flac") return "audio/flac";
  if (ext === "ogg") return "audio/ogg";
  return "audio/mpeg";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function uploadSunoAudio(config: MusicApiConfig, input: SunoAudioUploadInput): Promise<SunoAudioUploadResult> {
  let info;
  try {
    info = await stat(input.filePath);
  } catch (error) {
    throw new MusicApiError(`找不到要上传的音频：${input.filePath}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!info.isFile() || info.size <= 0) throw new MusicApiError("要上传的音频文件是空的");
  if (info.size > 300 * 1024 * 1024) throw new MusicApiError(`音频超过 300MB 上限（${(info.size / 1024 / 1024).toFixed(1)} MB）`);
  const buffer = await readFile(input.filePath);
  const fileName = input.fileName?.trim() || basename(input.filePath);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: audioMimeOf(fileName) }), fileName);
  if (input.copyright === true) form.append("copyright_audio_flag", "1");
  const url = new URL("/v1/suno/audio/upload", `${apiBase(config)}/`);
  const timeout = AbortSignal.timeout(Math.max(30000, config.timeoutMs || 120000));
  let response: Response;
  try {
    // 不要手动设 Content-Type：fetch 会带 multipart 的 boundary。
    response = await fetch(url.toString(), {
      method: "POST",
      headers: authHeaders(config),
      body: form,
      signal: timeout
    });
  } catch (error) {
    if (timeout.aborted) throw new MusicApiError(`上传参考音频超时（${Math.round((config.timeoutMs || 120000) / 1000)} 秒）`);
    throw new MusicApiError(`无法上传参考音频：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw await readError(response);
  const text = await response.text();
  let payload: any = {};
  if (text.trim() !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new MusicApiError(`谱乐 AI 上传接口返回了无法解析的 JSON：${text.slice(0, 300)}`, { status: response.status });
    }
  }
  const taskId = typeof payload?.task_id === "string" ? payload.task_id : undefined;
  if (taskId !== undefined) {
    // 版权通道：异步任务，等 songs[0].id。
    const deadline = Date.now() + Math.max(30000, input.pollTimeoutMs ?? 300000);
    const interval = Math.max(500, input.pollIntervalMs ?? 3000);
    for (;;) {
      if (Date.now() >= deadline) {
        throw new MusicApiError(`版权音频上传等待超时（task ${taskId}）；可以稍后用 listMusicHistory 或控制台查看。`);
      }
      await sleep(interval);
      let status: any;
      try {
        status = await requestJson(config, `/v1/suno/audio/upload/${encodeURIComponent(taskId)}`);
      } catch (error) {
        // 版权任务刚建好时可能短暂 404；按「还没完成」继续等。
        if (error instanceof MusicApiError && error.status === 404) continue;
        throw error;
      }
      if (status?.status === "failed") {
        const message = typeof status?.error_message === "string" && status.error_message !== "" ? status.error_message : "版权音频上传失败";
        throw new MusicApiError(message);
      }
      const songs = Array.isArray(status?.songs) ? status.songs : [];
      const songId = typeof songs[0]?.id === "string" ? songs[0].id : "";
      if (songId !== "") {
        return { songId, status: "succeeded", copyright: true, taskId, raw: status };
      }
    }
  }
  const songId = typeof payload?.id === "string" ? payload.id : "";
  if (songId === "") {
    throw new MusicApiError(`上传音频没有返回可用 id：${JSON.stringify(payload).slice(0, 400)}`);
  }
  return {
    songId,
    status: typeof payload?.status === "string" ? payload.status : "succeeded",
    copyright: input.copyright === true,
    raw: payload
  };
}

export async function querySongs(config: MusicApiConfig, ids: string[]): Promise<MusicSongPayload[]> {
  const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (clean.length === 0) return [];
  try {
    const payload = await requestJson(config, "/v1/music/generations/query", {
      query: { songid: clean.join(",") }
    });
    if (!Array.isArray(payload)) return [];
    return payload
      .filter((song: any) => typeof song?.id === "string" && song.id !== "")
      .map((song: any) => ({ ...song, id: String(song.id), status: typeof song.status === "string" ? song.status : "pending" }));
  } catch (error) {
    // 404 = 歌曲还没完成（文档明确说 404 可能是 not yet completed）。交给轮询继续等。
    if (error instanceof MusicApiError && error.status === 404) return [];
    throw error;
  }
}

export interface MusicHistory {
  data: MusicSongPayload[];
  total: number;
  page: number;
  size: number;
  totalPages: number;
}

export async function musicHistory(
  config: MusicApiConfig,
  options: { page?: number; size?: number; filters?: string[] } = {}
): Promise<MusicHistory> {
  const page = Math.max(1, Math.round(options.page ?? 1));
  const size = Math.min(100, Math.max(1, Math.round(options.size ?? 20)));
  const filters = (options.filters ?? []).filter((entry) => ["uploads", "covers", "extensions"].includes(entry));
  const payload = await requestJson(config, "/v1/music/generations/history", {
    query: { page, size, ...(filters.length === 0 ? {} : { filters: filters.join(",") }) }
  });
  return {
    data: Array.isArray(payload?.data) ? payload.data : [],
    total: Number(payload?.total ?? 0),
    page: Number(payload?.page ?? page),
    size: Number(payload?.size ?? size),
    totalPages: Number(payload?.total_pages ?? 0)
  };
}

export async function requestWav(config: MusicApiConfig, songId: string): Promise<{ id: string; url: string }> {
  const payload = await requestJson(config, "/v1/music/generations/wav", { method: "POST", body: { songid: songId } });
  const url = typeof payload?.audio_wav_url === "string" ? payload.audio_wav_url : "";
  if (url === "") throw new MusicApiError(`谱乐 AI 没有返回 WAV 地址：${JSON.stringify(payload).slice(0, 300)}`);
  return { id: typeof payload?.id === "string" ? payload.id : songId, url };
}

export interface LrcResult {
  id: string;
  success: boolean;
  lrcAlignment?: unknown;
  error?: string;
}

export async function generateLrc(config: MusicApiConfig, ids: string[]): Promise<LrcResult[]> {
  const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 10);
  if (clean.length === 0) throw new MusicApiError("getMusicLrc 需要至少一个歌曲 id");
  const payload = await requestJson(config, "/v1/suno/lrc/generate", { method: "POST", body: { clip_ids: clean } });
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.map((item: any) => ({
    id: typeof item?.id === "string" ? item.id : "",
    success: item?.success === true,
    lrcAlignment: item?.lrc_alignment,
    error: typeof item?.error === "string" ? item.error : undefined
  }));
}

// ── 工具（分轨 / MIDI / 乐谱 / 风格分析 / 转码）─────────────────────────

export interface ToolTask {
  taskId: string;
  status: "pending" | "processing" | "succeeded" | "failed";
  type: string;
  raw: any;
}

export async function submitStemSplit(
  config: MusicApiConfig,
  input: { audioUrl: string; filename?: string; stemCount: number; outputFormat: string }
): Promise<ToolTask> {
  assertDownloadUrl(input.audioUrl, config.baseUrl);
  if (!(MUSIC_STEM_COUNTS as readonly number[]).includes(input.stemCount)) {
    throw new MusicApiError(`stemCount 只能是 ${MUSIC_STEM_COUNTS.join(" / ")}`);
  }
  const outputFormat = oneOf(input.outputFormat, MUSIC_STEM_FORMATS, "output_format");
  const payload = await requestJson(config, "/v1/tools/stems/split", {
    method: "POST",
    body: {
      audio_url: input.audioUrl,
      filename: input.filename,
      stem_count: input.stemCount,
      output_format: outputFormat
    }
  });
  return toolTaskOf(payload, "stem_split");
}

export interface StemInstrumentCategory {
  category_code: string;
  name: string;
  sort: number;
  instruments: Array<{
    code: string;
    name: string;
    credits?: number;
    output_track_count?: number;
    output_tracks?: string[];
    task_type?: string;
    icon_url?: string;
    track_labels?: Record<string, string>;
  }>;
}

export async function stemInstruments(config: MusicApiConfig): Promise<{ categories: StemInstrumentCategory[]; fetchedAt: number }> {
  const payload = await requestJson(config, "/v1/tools/stems/instruments");
  const categories = Array.isArray(payload?.categories) ? payload.categories : [];
  return { categories, fetchedAt: Date.now() };
}

export async function submitProStemSplit(
  config: MusicApiConfig,
  input: { audioUrl: string; itemCode: string; filename?: string; outputFormat?: string }
): Promise<ToolTask> {
  assertDownloadUrl(input.audioUrl, config.baseUrl);
  const itemCode = text(input.itemCode);
  if (itemCode === "") throw new MusicApiError("高级分轨需要 itemCode（见 listMusicStemInstruments）");
  const outputFormat = oneOf(input.outputFormat, MUSIC_PRO_STEM_FORMATS, "output_format");
  const payload = await requestJson(config, "/v1/tools/stems/professional/split", {
    method: "POST",
    body: {
      audio_url: input.audioUrl,
      item_code: itemCode,
      filename: input.filename,
      output_format: outputFormat
    }
  });
  return toolTaskOf(payload, "professional_stem_split");
}

export async function toolTask(config: MusicApiConfig, taskId: string): Promise<ToolTask> {
  const id = text(taskId);
  if (id === "") throw new MusicApiError("taskId 不能为空");
  // 分轨与转码共用同一个查询端点（文档里的 GET /v1/tools/stems/{task_id} 与
  // GET /v1/tools/audio/convert/{task_id} 是两个路径，先按 stem 查，404 再查转码）。
  try {
    const payload = await requestJson(config, `/v1/tools/stems/${encodeURIComponent(id)}`, {}, { allow404: true });
    if (!payload?.__notFound) return toolTaskOf(payload, "stem_split");
  } catch (error) {
    if (!(error instanceof MusicApiError) || error.status !== 404) throw error;
  }
  const payload = await requestJson(config, `/v1/tools/audio/convert/${encodeURIComponent(id)}`);
  return toolTaskOf(payload, "audio_convert");
}

function toolTaskOf(payload: any, fallbackType: string): ToolTask {
  const status = payload?.status;
  const normalized: ToolTask["status"] =
    status === "succeeded" || status === "failed" || status === "processing" || status === "pending"
      ? status
      : "pending";
  return {
    taskId: typeof payload?.task_id === "string" ? payload.task_id : "",
    status: normalized,
    type: typeof payload?.type === "string" ? payload.type : fallbackType,
    raw: payload
  };
}

export async function submitMidi(config: MusicApiConfig, input: { audioUrl: string; audioName?: string }): Promise<{ midiUrl: string; raw: any }> {
  assertDownloadUrl(input.audioUrl, config.baseUrl);
  const payload = await requestJson(config, "/v1/tools/midi/convert", {
    method: "POST",
    body: { audio_url: input.audioUrl, audio_name: input.audioName }
  });
  const midiUrl = typeof payload?.result?.midi_url === "string" ? payload.result.midi_url : "";
  if (midiUrl === "") throw new MusicApiError(`转 MIDI 没有返回文件地址：${JSON.stringify(payload).slice(0, 300)}`);
  return { midiUrl, raw: payload };
}

export async function submitSheetMusic(config: MusicApiConfig, midiUrl: string): Promise<{ pdfUrl?: string; xmlUrl?: string; raw: any }> {
  assertDownloadUrl(midiUrl, config.baseUrl);
  const payload = await requestJson(config, "/v1/tools/sheet-music/convert", { method: "POST", body: { midi_url: midiUrl } });
  return {
    pdfUrl: typeof payload?.result?.files?.pdf_url === "string" ? payload.result.files.pdf_url : undefined,
    xmlUrl: typeof payload?.result?.files?.xml_url === "string" ? payload.result.files.xml_url : undefined,
    raw: payload
  };
}

export async function submitStyleAnalysis(
  config: MusicApiConfig,
  input: { audioUrl: string; audioName?: string }
): Promise<{ instruments: string[]; genres: string[]; tags: string[]; description: string; raw: any }> {
  assertDownloadUrl(input.audioUrl, config.baseUrl);
  const payload = await requestJson(config, "/v1/tools/style-analysis", {
    method: "POST",
    body: { audio_url: input.audioUrl, audio_name: input.audioName }
  });
  const result = payload?.result ?? {};
  return {
    instruments: Array.isArray(result.instruments) ? result.instruments.map(String) : [],
    genres: Array.isArray(result.genres) ? result.genres.map(String) : [],
    tags: Array.isArray(result.tags) ? result.tags.map(String) : [],
    description: typeof result.description === "string" ? result.description : "",
    raw: payload
  };
}

export async function submitAudioConvert(
  config: MusicApiConfig,
  input: { sourceUrl: string; targetFormat: string }
): Promise<ToolTask> {
  assertDownloadUrl(input.sourceUrl, config.baseUrl);
  const targetFormat = oneOf(input.targetFormat, MUSIC_CONVERT_FORMATS, "target_format");
  const payload = await requestJson(config, "/v1/tools/audio/convert", {
    method: "POST",
    body: { source_url: input.sourceUrl, target_format: targetFormat }
  });
  return toolTaskOf(payload, "audio_convert");
}

// ── 下载 ────────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function hostIsLocal(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (LOCAL_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  if (/^127\./u.test(host)) return true;
  if (/^10\./u.test(host)) return true;
  if (/^192\.168\./u.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./u.test(host)) return true;
  if (/^169\.254\./u.test(host)) return true;
  if (/^\[?f[cd][0-9a-f]{2}:/iu.test(host)) return true;
  if (host.endsWith(".local")) return true;
  return false;
}

/**
 * 允许下载/交给第三方工具的 URL 校验。
 *
 * 公网 Base URL 时拒绝本机/私网 —— 否则 agent 传入 `http://127.0.0.1:…` 就是一次
 * SSRF。用户把 Base URL 配成本机（mock / 反代 / 本地服务）时放行本机，因为那是
 * 用户自己的明确选择，自检也需要它。
 */
export function assertDownloadUrl(raw: unknown, baseUrl: string): URL {
  const value = text(raw);
  if (value === "") throw new MusicApiError("音频 URL 不能为空");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MusicApiError(`不是合法的 URL：${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MusicApiError(`只接受 http(s) URL：${value}`);
  }
  let baseHost = "";
  try {
    baseHost = new URL(normalizeMusicBaseUrl(baseUrl)).hostname;
  } catch {
    baseHost = "";
  }
  const localBase = baseHost !== "" && hostIsLocal(baseHost);
  if (!localBase && hostIsLocal(parsed.hostname)) {
    throw new MusicApiError(`出于安全原因，不下载本机 / 私网地址：${value}`);
  }
  return parsed;
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/midi": "mid",
  "audio/x-midi": "mid",
  "application/pdf": "pdf",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/zip": "zip",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

/** 按文件头认音频/文档，避免扩展名造假。返回 undefined 时再退回 Content-Type / 调用方给的后缀。 */
export function sniffBinary(head: Buffer): { ext: string; mime: string } | undefined {
  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE") {
    return { ext: "wav", mime: "audio/wav" };
  }
  if (head.length >= 4 && head.toString("ascii", 0, 4) === "fLaC") return { ext: "flac", mime: "audio/flac" };
  if (head.length >= 4 && head.toString("ascii", 0, 4) === "OggS") return { ext: "ogg", mime: "audio/ogg" };
  if (head.length >= 4 && head.toString("ascii", 0, 4) === "MThd") return { ext: "mid", mime: "audio/midi" };
  if (head.length >= 4 && head.toString("ascii", 0, 4) === "%PDF") return { ext: "pdf", mime: "application/pdf" };
  if (head.length >= 2 && head.toString("ascii", 0, 2) === "PK") return { ext: "zip", mime: "application/zip" };
  if (head.length >= 3 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return { ext: "mp3", mime: "audio/mpeg" };
  if (head.length >= 3 && head.toString("ascii", 0, 3) === "ID3") return { ext: "mp3", mime: "audio/mpeg" };
  if (head.length >= 12 && head.toString("ascii", 4, 8) === "ftyp") {
    const brand = head.toString("ascii", 8, 12).toLowerCase();
    if (brand.includes("m4a") || brand.includes("mp4")) return { ext: "m4a", mime: "audio/mp4" };
    return { ext: "m4a", mime: "audio/mp4" };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return { ext: "png", mime: "image/png" };
  return undefined;
}

export interface DownloadResult {
  file: string;
  bytes: number;
  ext: string;
  mime: string;
}

export interface DownloadOptions {
  /** 文件主名（不含扩展名）；扩展名按内容/URL 决定。 */
  stem: string;
  /** 内容识别不出来时的后缀。 */
  fallbackExt?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * true = 只接受能按文件头识别的音频容器。
   *
   * ⚠️ Suno 的音频 URL 偶尔会先返回一段未完成 / 加密的临时对象，
   * Content-Type 仍可能是 `audio/mpeg`；只信 Content-Type 会把随机字节当成
   * `.mp3` 落盘，界面就会出现「有歌名但第一首放不了」。音频下载一律开这个。
   */
  requireAudio?: boolean;
}

/**
 * 下载到一个目录并返回落盘路径。先写 `.part` 再 rename，失败不留半截文件。
 * 用流式读取 + 计数，避免把几百 MB 的音频整个读进内存。
 */
export async function downloadToFile(
  rawUrl: string,
  destDir: string,
  config: MusicApiConfig,
  options: DownloadOptions
): Promise<DownloadResult> {
  const url = assertDownloadUrl(rawUrl, config.baseUrl);
  const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
  const timeout = AbortSignal.timeout(Math.max(30000, options.timeoutMs ?? 180000));
  let response: Response;
  try {
    response = await fetch(url.toString(), { signal: timeout });
  } catch (error) {
    if (timeout.aborted) throw new MusicApiError(`下载音频超时：${url.hostname}`);
    throw new MusicApiError(`下载音频失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new MusicApiError(`下载音频失败（HTTP ${response.status}）：${url.hostname}`, { status: response.status });
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new MusicApiError(`文件太大：${(contentLength / 1024 / 1024).toFixed(1)}MB（上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`);
  }
  await mkdir(destDir, { recursive: true });
  const tmp = join(destDir, `${options.stem}.${Date.now().toString(36)}-${randomUUID().slice(0, 6)}.part`);
  const stream = createWriteStream(tmp);
  let bytes = 0;
  let head = Buffer.alloc(0);
  let sniffed: { ext: string; mime: string } | undefined;
  try {
    const body = response.body;
    if (body === null) throw new MusicApiError("下载响应没有 body");
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = Buffer.from(value);
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
      if (sniffed === undefined && head.length >= 4) sniffed = sniffBinary(head);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MusicApiError(`文件太大：超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限`);
      }
      if (!stream.write(chunk)) {
        await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.end(() => resolve());
    });
  } catch (error) {
    stream.destroy();
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error instanceof MusicApiError ? error : new MusicApiError(`下载写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (options.requireAudio === true) {
    const audioExts = new Set(["mp3", "m4a", "wav", "flac", "ogg", "aac"]);
    if (sniffed === undefined || !audioExts.has(sniffed.ext)) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new MusicApiError(
        `下载到的内容不是音频（Content-Type: ${contentType || "unknown"}，文件头无法识别）；已丢弃，稍后可重试`
      );
    }
  }
  const byMime = EXT_BY_MIME[contentType];
  const byUrl = extFromUrl(url);
  const ext = sniffed?.ext ?? byMime ?? byUrl ?? options.fallbackExt ?? "bin";
  const mime = sniffed?.mime ?? contentType ?? "application/octet-stream";
  const file = join(destDir, `${safeStem(options.stem)}.${ext}`);
  await rm(file, { force: true }).catch(() => undefined);
  await rename(tmp, file);
  return { file, bytes, ext, mime };
}

function extFromUrl(url: URL): string | undefined {
  const match = /\.([a-z0-9]{2,5})$/iu.exec(url.pathname);
  return match?.[1]?.toLowerCase();
}

/** 文件名主名：去掉路径分隔符与控制字符，限制长度。 */
export function safeStem(value: string): string {
  const base = basename(String(value ?? "")).replace(/[^\w.\-()\u4e00-\u9fa5]+/gu, "_").replace(/^[._]+/u, "");
  return base === "" ? "music" : base.slice(0, 80);
}

// ── 测试连接 ────────────────────────────────────────────────────────────

export interface MusicTestResult {
  ok: boolean;
  warning?: string;
  total?: number;
  message: string;
}

/**
 * 测试连接：读一页历史，不生成、不扣生成积分。
 *
 * 402 视为「Key 有效但积分不足」——这时连接本身是通的，不该报成 Key 错误。
 */
export async function testMusicConnection(config: MusicApiConfig): Promise<MusicTestResult> {
  try {
    const history = await musicHistory(config, { page: 1, size: 1 });
    return {
      ok: true,
      total: history.total,
      message: `连接正常（历史记录 ${history.total} 首）`
    };
  } catch (error) {
    if (error instanceof MusicApiError && error.status === 402) {
      return { ok: true, warning: error.message, message: "Key 有效，但当前积分不足；仍可读取历史，生成会被拒绝。" };
    }
    throw error;
  }
}

/** 供界面/工具展示的引擎摘要（不包含 Key）。 */
export function musicEngineSummary(): Array<Record<string, unknown>> {
  return MUSIC_ENGINE_PRESETS.map((engine) => ({
    id: engine.id,
    label: engine.label,
    hint: engine.hint,
    defaultModel: engine.defaultModel,
    models: engine.models.map((model) => ({ ...model })),
    modes: engine.modes.map((mode) => ({ ...mode }))
  }));
}

/** 校验引擎/模式的辅助（界面传错时给出明确错误）。 */
export function assertEngineMode(engine: unknown, mode: unknown): { engine: MusicEngine; mode: MusicMode } {
  if (!isMusicEngine(engine)) throw new MusicApiError(`未知音乐引擎：${String(engine)}（可用：${MUSIC_ENGINES.join(" / ")}）`);
  if (!isMusicMode(mode)) throw new MusicApiError(`未知生成模式：${String(mode)}（可用：${MUSIC_MODES.join(" / ")}）`);
  if (!enginePresetOf(engine).modes.some((entry) => entry.id === mode)) {
    throw new MusicApiError(`${enginePresetOf(engine).label} 不支持「${mode}」模式`);
  }
  return { engine, mode };
}

/** 默认模型（给建任务时兜底）。 */
export function fallbackModel(engine: unknown): string {
  return isMusicEngine(engine) ? defaultModelOf(engine) : defaultModelOf("suno");
}
