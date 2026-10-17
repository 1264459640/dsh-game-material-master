/**
 * 音乐生成编辑（模块七）的数据层与作业。
 *
 * ## 落盘
 *
 * ```
 * <DSH_HOME>/game-material-master/music-jobs/<a…>/
 * ├── job.json
 * ├── songs/<songId>.mp3|.m4a|.wav   下载的原曲
 * ├── songs/<songId>-cover.jpg|.png
 * ├── songs/<songId>-lrc.json
 * ├── versions/<v…>.<ext>
 * ├── peaks/<hash>.json
 * ├── tools/<toolTaskId>/…
 * └── out/<安全名>.<ext> / <任务名>.zip
 * ```
 *
 * ## 状态机
 *
 * `runMusicGeneration` 先落一条 `submitting` 的 generation 并启动后台任务：
 * 提交 → `polling`（每 5 秒查一次）→ 下载 → `succeeded` / `partial` / `failed`
 * / `timeout`。进程重启后 `resumeMusicJobs()` 会把 `polling` 的任务接上。
 *
 * 所有写 job.json 的地方都走 `patchMusicJob()` 的**按任务串行队列**：轮询器与用户
 * 改名/保存同时发生时，后写的不会把前一次改动覆盖掉。
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig, musicJobsRoot } from "./config.js";
import { appendJobLog, messageOf, readJson, sweepTempFiles, writeJsonAtomic } from "./jsonio.js";
import { MUSIC_EDIT_FORMATS, MUSIC_ENGINES, MUSIC_TOOL_KINDS, defaultModelOf, enginePresetOf, isMusicEngine, isMusicMode, isMusicToolKind } from "./musicmodels.js";
import { MusicApiError, buildGenerationRequest, downloadToFile, generateLrc, musicBlocker, musicHistory, querySongs, requestWav, safeStem, stemInstruments, submitAudioConvert, submitGeneration, submitMidi, submitProStemSplit, submitSheetMusic, submitStemSplit, submitStyleAnalysis, toolTask } from "./musicapi.js";
import { audioPeaks, normalizeEditOps, probeAudio, renderAudioEdit } from "./musicaudio.js";
import { zipEntries } from "./zip.js";
import { assetBasePath, buildOpenLink, originForLinks } from "./links.js";
export const MUSIC_STAGES = ["generate", "edit", "export"];
const JOB_ID_PATTERN = /^a[a-z0-9]{4,40}$/;
/** 音乐任务可经资源路由读取的子目录（唯一真源，`index.ts` 直接引用）。 */
export const SERVABLE_MUSIC_DIRS = new Set(["songs", "versions", "peaks", "tools", "out"]);
export function musicJobDir(id) {
    return join(musicJobsRoot(), id);
}
export function musicJobFile(id) {
    return join(musicJobDir(id), "job.json");
}
/** 任务内相对路径 → 绝对路径，并挡住目录穿越。 */
export function musicAssetPath(id, relative) {
    const base = resolve(musicJobDir(id));
    const target = resolve(base, relative);
    if (target !== base && !target.startsWith(base + sep))
        throw new Error(`非法的任务内路径：${relative}`);
    return target;
}
export function isValidMusicJobId(id) {
    return JOB_ID_PATTERN.test(id);
}
function assertJobId(id) {
    if (!isValidMusicJobId(id))
        throw new Error(`非法音乐任务 id：${id}`);
}
function logOf(job) {
    if (!Array.isArray(job.log))
        job.log = [];
    return job.log;
}
export function musicLog(job, level, message) {
    appendJobLog(logOf(job), level, message);
}
function now() {
    return Date.now();
}
function clampString(value, max = 20000) {
    return typeof value === "string" ? value.slice(0, max) : "";
}
/** 用户输入的归一化：原文保留，扩写结果单独存。 */
export function normalizeMusicSource(input) {
    const raw = (input ?? {});
    const kind = raw.kind === "lyrics" ? "lyrics" : "prompt";
    const prompt = clampString(raw.prompt);
    const lyrics = clampString(raw.lyrics);
    return {
        kind,
        prompt,
        lyrics,
        note: clampString(raw.note, 4000),
        title: clampString(raw.title, 200),
        tags: clampString(raw.tags, 4000),
        instrumental: raw.instrumental === true,
        preferredEngine: isMusicEngine(raw.preferredEngine) ? raw.preferredEngine : undefined,
        adaptedPrompt: typeof raw.adaptedPrompt === "string" ? clampString(raw.adaptedPrompt) : undefined,
        adaptedLyrics: typeof raw.adaptedLyrics === "string" ? clampString(raw.adaptedLyrics) : undefined,
        adaptedTags: typeof raw.adaptedTags === "string" ? clampString(raw.adaptedTags) : undefined,
        adaptedNote: typeof raw.adaptedNote === "string" ? clampString(raw.adaptedNote, 4000) : undefined
    };
}
/** 任务设置归一化：引擎/模式/模型给默认值，其余可选字段只保留合法值。 */
export function normalizeMusicSettings(input, source) {
    const raw = (input ?? {});
    const engine = isMusicEngine(raw.engine)
        ? raw.engine
        : source?.preferredEngine ?? "suno";
    const preset = enginePresetOf(engine);
    const mode = isMusicMode(raw.mode) && preset.modes.some((entry) => entry.id === raw.mode)
        ? raw.mode
        : preset.modes[0].id;
    const requestedModel = typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model.trim() : defaultModelOf(engine);
    // 切引擎时旧模型可能不属于新引擎：别把非法值留在设置里，回落到该引擎默认模型。
    const model = preset.models.some((entry) => entry.id === requestedModel) ? requestedModel : defaultModelOf(engine);
    const out = { engine, mode, model };
    const putNum = (key, value, min, max) => {
        const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
        if (Number.isFinite(n))
            out[key] = Math.min(max, Math.max(min, n));
    };
    if (raw.n !== undefined)
        putNum("n", raw.n, 1, 3);
    if (typeof raw.vocalGender === "string")
        out.vocalGender = raw.vocalGender;
    if (typeof raw.negativeTags === "string")
        out.negativeTags = clampString(raw.negativeTags, 2000);
    putNum("styleWeight", raw.styleWeight, 0, 1);
    putNum("weirdness", raw.weirdness, 0, 1);
    putNum("duration", raw.duration, 10, 360);
    putNum("augCreativity", raw.augCreativity, 0, 4);
    putNum("bpm", raw.bpm, 30, 300);
    putNum("sampleRate", raw.sampleRate, 8000, 192000);
    putNum("bitrate", raw.bitrate, 8000, 512000);
    if (typeof raw.isMaxMode === "boolean")
        out.isMaxMode = raw.isMaxMode;
    if (typeof raw.vocalLanguage === "string")
        out.vocalLanguage = raw.vocalLanguage;
    if (typeof raw.keyScale === "string")
        out.keyScale = raw.keyScale;
    if (typeof raw.timeSignature === "string")
        out.timeSignature = raw.timeSignature;
    return out;
}
function summarizeSource(source) {
    const text = source.kind === "lyrics" ? source.lyrics : source.prompt;
    const flat = text.replace(/\s+/gu, " ").trim();
    return flat === "" ? "未命名音乐" : flat.slice(0, 80);
}
function deriveMusicName(source) {
    const text = source.kind === "lyrics" ? source.lyrics : source.prompt;
    const flat = text.replace(/\s+/gu, " ").trim();
    if (flat === "")
        return "音乐任务";
    return flat.slice(0, 20);
}
export async function createMusicJob(input = {}) {
    const source = normalizeMusicSource(input.source);
    const name = (typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : deriveMusicName(source)).slice(0, 80);
    const id = `a${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
    const timestamp = now();
    const job = {
        id,
        name,
        createdAt: timestamp,
        updatedAt: timestamp,
        source,
        settings: normalizeMusicSettings(input.settings, source),
        reviewMode: input.reviewMode === "manual" ? "manual" : input.reviewMode === "auto" ? "auto" : undefined,
        stages: {
            generate: { status: "idle" },
            edit: { status: "idle" },
            export: { status: "idle" }
        },
        generations: [],
        songs: [],
        versions: [],
        tools: [],
        exports: [],
        log: []
    };
    for (const sub of ["songs", "versions", "peaks", "tools", "out"]) {
        await mkdir(join(musicJobDir(id), sub), { recursive: true });
    }
    musicLog(job, "info", `新建音乐任务：${name}（${source.kind === "lyrics" ? "完整歌词" : "灵感提示词"}）`);
    await writeJsonAtomic(musicJobFile(id), job);
    return job;
}
export async function readMusicJob(id) {
    if (!isValidMusicJobId(id))
        return undefined;
    const job = await readJson(musicJobFile(id));
    if (job === undefined || job === null || typeof job !== "object")
        return undefined;
    job.songs = Array.isArray(job.songs) ? job.songs : [];
    job.generations = Array.isArray(job.generations) ? job.generations : [];
    job.versions = Array.isArray(job.versions) ? job.versions : [];
    job.tools = Array.isArray(job.tools) ? job.tools : [];
    job.exports = Array.isArray(job.exports) ? job.exports : [];
    job.log = Array.isArray(job.log) ? job.log : [];
    job.stages = job.stages ?? { generate: { status: "idle" }, edit: { status: "idle" }, export: { status: "idle" } };
    return job;
}
export async function writeMusicJob(job) {
    assertJobId(job.id);
    await writeJsonAtomic(musicJobFile(job.id), job);
}
const jobQueues = new Map();
/**
 * 按任务串行地读-改-写。所有写入口都必须走它。
 *
 * 不串行的话，轮询器刚读到旧 job、用户同时改名，两边各写一次，后写的会把
 * 前一次的改动覆盖掉——表现是「改了名字过一会儿又变回去」。
 */
export function patchMusicJob(id, mutator) {
    assertJobId(id);
    const previous = jobQueues.get(id) ?? Promise.resolve();
    const result = previous
        .catch(() => undefined)
        .then(async () => {
        const job = await readMusicJob(id);
        if (job === undefined)
            throw new Error(`音乐任务不存在：${id}`);
        const value = await mutator(job);
        job.updatedAt = now();
        await writeJsonAtomic(musicJobFile(id), job);
        return value;
    });
    jobQueues.set(id, result.then(() => undefined, () => undefined));
    return result;
}
export async function listMusicJobs() {
    const root = musicJobsRoot();
    let names;
    try {
        names = await readdir(root);
    }
    catch {
        return [];
    }
    const jobs = [];
    for (const name of names) {
        if (!isValidMusicJobId(name))
            continue;
        const job = await readMusicJob(name);
        if (job === undefined)
            continue;
        jobs.push(summarizeMusicJob(job));
    }
    jobs.sort((a, b) => b.updatedAt - a.updatedAt);
    return jobs;
}
export function summarizeMusicJob(job) {
    const ready = job.songs.filter((song) => song.status === "succeeded");
    return {
        id: job.id,
        name: job.name,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        songsReady: ready.length,
        songsTotal: job.songs.length,
        versions: job.versions.filter((version) => version.status === "ready").length,
        engines: [...new Set(job.songs.map((song) => song.engine))],
        busy: musicBusy(job.id, job),
        reviewMode: job.reviewMode,
        coverFile: ready.find((song) => typeof song.coverFile === "string")?.coverFile
    };
}
export async function deleteMusicJob(id) {
    assertJobId(id);
    for (const [key, controller] of [...controllers.entries()]) {
        if (key.startsWith(`${id}:`)) {
            controller.abort();
            controllers.delete(key);
        }
    }
    cancelMusicGeneration(id);
    await rm(musicJobDir(id), { recursive: true, force: true });
    jobQueues.delete(id);
}
export function musicBusy(id, job) {
    if ((running.get(id)?.size ?? 0) > 0)
        return true;
    if (job === undefined)
        return false;
    if (job.generations.some((generation) => generation.status === "submitting" || generation.status === "polling"))
        return true;
    // ⚠️ 不要把「歌曲还是 pending」单独算忙：等待超时后 generation 已标成 timeout，
    // 但平台仍可能在跑；这时 busy 必须是 false，界面才能刷新/补查，而不是永远转圈。
    if (job.tools.some((tool) => tool.status === "submitting" || tool.status === "polling"))
        return true;
    if (job.versions.some((version) => version.status === "rendering"))
        return true;
    return false;
}
// ── 后台任务表 ──────────────────────────────────────────────────────────
const running = new Map();
const controllers = new Map();
let disposed = false;
/** DSH 重载插件时模块级 disposed 会留着，apply 时靠它复位。 */
export function activateMusic() {
    disposed = false;
    running.clear();
    for (const controller of controllers.values())
        controller.abort();
    controllers.clear();
}
export function disposeMusic() {
    disposed = true;
    for (const controller of controllers.values())
        controller.abort();
    controllers.clear();
    running.clear();
}
function trackMusicTask(id, key, run) {
    if (disposed)
        return false;
    const set = running.get(id) ?? new Set();
    if (set.has(key))
        return false;
    running.set(id, set);
    set.add(key);
    const controller = new AbortController();
    controllers.set(`${id}:${key}`, controller);
    void run()
        .catch((error) => {
        musicLogSafe(id, "error", `${key} 失败：${messageOf(error)}`);
    })
        .finally(() => {
        set.delete(key);
        controllers.delete(`${id}:${key}`);
        if (set.size === 0 && running.get(id) === set)
            running.delete(id);
    });
    return true;
}
function musicLogSafe(id, level, message) {
    void patchMusicJob(id, (job) => musicLog(job, level, message)).catch(() => undefined);
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new Error("已取消"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener?.("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("已取消"));
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });
    });
}
function apiConfigOf(config) {
    return {
        baseUrl: config.musicBaseUrl,
        apiKey: config.musicApiKey,
        timeoutMs: config.musicTimeoutMs
    };
}
async function requireApi() {
    const config = await loadConfig();
    const blocker = musicBlocker(config);
    if (blocker !== undefined)
        throw new MusicApiError(blocker);
    return apiConfigOf(config);
}
// ── 任务视图 ────────────────────────────────────────────────────────────
export function musicAssetBase(id) {
    return assetBasePath(`/dsh-game-material-master/music-assets/${id}/`);
}
function absUrl(origin, assetBase, relative) {
    if (typeof relative !== "string" || relative === "")
        return undefined;
    return `${origin}${assetBase}${relative.split("/").map(encodeURIComponent).join("/")}`;
}
export async function musicSnapshot(job, origin = originForLinks()) {
    const config = await loadConfig();
    const assetBase = musicAssetBase(job.id);
    const songs = job.songs.map((song) => ({
        ...song,
        file: song.localFile ?? null,
        url: absUrl(origin, assetBase, song.localFile) ?? song.audioUrl ?? null,
        remoteUrl: song.audioUrl ?? null,
        coverUrl: absUrl(origin, assetBase, song.coverFile) ?? song.imageUrl ?? null,
        wavUrl: absUrl(origin, assetBase, song.wavFile) ?? null,
        lrcUrl: absUrl(origin, assetBase, song.lrcFile) ?? null
    }));
    const versions = job.versions.map((version) => ({
        ...version,
        url: absUrl(origin, assetBase, version.file) ?? null
    }));
    const tools = job.tools.map((tool) => ({
        ...tool,
        files: (tool.files ?? []).map((file) => ({ ...file, url: absUrl(origin, assetBase, file.file) ?? null }))
    }));
    const exports = job.exports.map((entry) => ({
        ...entry,
        url: absUrl(origin, assetBase, entry.file) ?? null,
        downloadUrl: absUrl(origin, assetBase, entry.file) === undefined ? null : `${absUrl(origin, assetBase, entry.file)}?download=1`
    }));
    return {
        module: "music",
        id: job.id,
        name: job.name,
        dir: musicJobDir(job.id),
        assetBase,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        reviewMode: job.reviewMode ?? null,
        busy: musicBusy(job.id, job),
        blocker: musicBlocker(config) ?? null,
        source: job.source,
        settings: job.settings,
        stages: job.stages,
        generations: job.generations.map((generation) => ({
            ...generation,
            // 请求体里可能有歌词，保留；但永远不会有 Key（Key 只在请求头里）。
            request: generation.request
        })),
        songs,
        versions,
        tools,
        exports,
        songsReady: songs.filter((song) => song.status === "succeeded").length,
        songsTotal: songs.length,
        log: job.log.slice(-30)
    };
}
function pickParam(params, ...keys) {
    for (const key of keys) {
        if (params[key] !== undefined && params[key] !== null && params[key] !== "")
            return params[key];
    }
    return undefined;
}
/**
 * 把任务里的原文 / 设置与本次覆盖参数合并成 API 请求。
 *
 * 兼容 camelCase 与 snake_case：agent 可能照着 API 文档写 `cover_clip_id`，
 * 也可能照着工具描述写 `coverClipId`；两种都收，只认一套内部字段。
 */
function mergeGenerationInput(job, input) {
    const params = input.params ?? {};
    const engine = isMusicEngine(input.engine) ? input.engine : job.settings.engine;
    const preset = enginePresetOf(engine);
    const mode = isMusicMode(input.mode) && preset.modes.some((entry) => entry.id === input.mode)
        ? input.mode
        : job.settings.mode;
    const source = job.source;
    const settings = job.settings;
    const explicitModel = typeof input.model === "string" && input.model.trim() !== "" ? input.model.trim() : "";
    const jobModel = job.settings.model || "";
    const model = explicitModel !== ""
        ? explicitModel
        : engine !== job.settings.engine && !enginePresetOf(engine).models.some((entry) => entry.id === jobModel)
            ? defaultModelOf(engine)
            : jobModel || defaultModelOf(engine);
    const requestInput = {
        engine,
        mode,
        model,
        title: pickParam(params, "title") ?? (source.title || job.name),
        prompt: pickParam(params, "prompt") ?? (source.adaptedPrompt || source.prompt),
        lyrics: pickParam(params, "lyrics") ?? (source.adaptedLyrics || source.lyrics),
        tags: pickParam(params, "tags") ?? (source.adaptedTags || source.tags),
        instrumental: typeof pickParam(params, "instrumental") === "boolean" ? pickParam(params, "instrumental") : source.instrumental,
        n: pickParam(params, "n") ?? settings.n,
        vocalGender: pickParam(params, "vocalGender", "vocal_gender") ?? settings.vocalGender,
        negativeTags: pickParam(params, "negativeTags", "negative_tags") ?? settings.negativeTags,
        styleWeight: pickParam(params, "styleWeight", "style_weight") ?? settings.styleWeight,
        weirdness: pickParam(params, "weirdness", "weirdness_constraint") ?? settings.weirdness,
        duration: pickParam(params, "duration") ?? settings.duration,
        isMaxMode: pickParam(params, "isMaxMode", "is_max_mode") ?? settings.isMaxMode,
        augCreativity: pickParam(params, "augCreativity", "aug_creativity") ?? settings.augCreativity,
        vocalLanguage: pickParam(params, "vocalLanguage", "vocal_language") ?? settings.vocalLanguage,
        bpm: pickParam(params, "bpm") ?? settings.bpm,
        keyScale: pickParam(params, "keyScale", "key_scale") ?? settings.keyScale,
        timeSignature: pickParam(params, "timeSignature", "time_signature") ?? settings.timeSignature,
        sampleRate: pickParam(params, "sampleRate", "sample_rate") ?? settings.sampleRate,
        bitrate: pickParam(params, "bitrate") ?? settings.bitrate,
        coverClipId: pickParam(params, "coverClipId", "cover_clip_id"),
        sourceSongId: pickParam(params, "sourceSongId", "source_clip_id"),
        audioWeight: pickParam(params, "audioWeight", "audio_weight"),
        continueClipId: pickParam(params, "continueClipId", "continue_clip_id"),
        continueAt: pickParam(params, "continueAt", "continue_at"),
        startTime: pickParam(params, "startTime", "start_time"),
        endTime: pickParam(params, "endTime", "end_time"),
        clipId: pickParam(params, "clipId", "clip_id"),
        sourceSongIds: (() => {
            const raw = pickParam(params, "sourceSongIds", "source_clip_ids");
            if (Array.isArray(raw))
                return raw.map(String);
            if (typeof raw === "string" && raw.trim() !== "")
                return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
            return undefined;
        })()
    };
    return { requestInput, engine, mode };
}
/**
 * 提交一次生成。★计费。
 *
 * 两道闸：同任务已有任务在跑拒绝；已有歌曲时再提交必须 `regenerate:true`。
 * 两条都是为了「不为确认状态白花一次积分」。
 */
export async function startMusicGeneration(id, input = {}) {
    assertJobId(id);
    const job = await readMusicJob(id);
    if (job === undefined)
        throw new Error(`音乐任务不存在：${id}`);
    if (musicBusy(id, job))
        return { started: false, reason: "这个任务已有生成/编辑任务在跑，等它结束再提交（重复提交会重复计费）。" };
    if (job.songs.some((song) => song.status === "succeeded") && input.regenerate !== true) {
        return {
            started: false,
            reason: "这个任务已经有歌曲了。再生成一批会再计费；确认要重做请传 regenerate:true。"
        };
    }
    const { requestInput, engine, mode } = mergeGenerationInput(job, input);
    const request = buildGenerationRequest(requestInput);
    const generationId = `g${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
    const startedAt = now();
    await patchMusicJob(id, (current) => {
        current.settings = { ...current.settings, engine, mode, model: requestInput.model ?? current.settings.model };
        current.generations.push({
            id: generationId,
            engine,
            mode,
            model: requestInput.model ?? defaultModelOf(engine),
            endpoint: request.endpoint,
            summary: request.summary,
            request: request.body,
            status: "submitting",
            songIds: [],
            startedAt,
            updatedAt: startedAt
        });
        current.stages.generate = { status: "running", at: startedAt };
        musicLog(current, "info", `提交生成：${request.summary}`);
    });
    const ok = trackMusicTask(id, "generation", () => runGeneration(id, generationId, request));
    if (!ok) {
        await patchMusicJob(id, (current) => {
            const generation = current.generations.find((entry) => entry.id === generationId);
            if (generation !== undefined) {
                generation.status = "failed";
                generation.error = "后台任务没有启动（插件正在重载？）";
                generation.updatedAt = now();
            }
            current.stages.generate = { status: "error", error: "后台任务没有启动", at: now() };
        });
        return { started: false, reason: "后台任务没有启动，请重启插件后再试。" };
    }
    return { started: true, generationId };
}
async function runGeneration(id, generationId, request) {
    const config = await loadConfig();
    const api = apiConfigOf(config);
    const controller = controllers.get(`${id}:generation`);
    const deadline = now() + Math.max(60000, config.musicPollTimeoutMs || 900000);
    let submitted;
    try {
        submitted = await submitGeneration(api, request);
    }
    catch (error) {
        await patchMusicJob(id, (job) => {
            const generation = job.generations.find((entry) => entry.id === generationId);
            if (generation !== undefined) {
                generation.status = "failed";
                generation.error = messageOf(error);
                generation.updatedAt = now();
            }
            job.stages.generate = { status: "error", error: messageOf(error), at: now() };
            musicLog(job, "error", `提交失败：${messageOf(error)}`);
        });
        return;
    }
    await patchMusicJob(id, (job) => {
        const generation = job.generations.find((entry) => entry.id === generationId);
        if (generation === undefined)
            return;
        generation.status = "polling";
        generation.taskId = submitted.taskId;
        generation.songIds = submitted.songs.map((song) => song.id);
        generation.updatedAt = now();
        for (const payload of submitted.songs) {
            const existing = job.songs.find((song) => song.id === payload.id);
            if (existing === undefined) {
                job.songs.push(songFromPayload(payload, generation.engine, generationId));
            }
        }
        musicLog(job, "info", `已提交：${submitted.songs.length} 首（task ${submitted.taskId ?? "—"}）`);
    });
    const songIds = submitted.songs.map((song) => song.id);
    let lastError;
    for (;;) {
        if (controller?.signal.aborted === true) {
            await patchMusicJob(id, (job) => {
                const generation = job.generations.find((entry) => entry.id === generationId);
                if (generation !== undefined) {
                    generation.status = "canceled";
                    generation.updatedAt = now();
                }
                musicLog(job, "warn", "已停止本地轮询；已提交的远端生成仍可能完成并计费。");
            });
            return;
        }
        if (now() >= deadline) {
            await patchMusicJob(id, (job) => {
                const generation = job.generations.find((entry) => entry.id === generationId);
                if (generation !== undefined) {
                    generation.status = "timeout";
                    generation.error = `等待超时（${Math.round((config.musicPollTimeoutMs || 900000) / 1000)} 秒）；可以 refreshMusicJob 继续查询。`;
                    generation.updatedAt = now();
                }
                job.stages.generate = { status: "error", error: generation?.error ?? "等待超时", at: now() };
                musicLog(job, "warn", `等待超时：${generationId}（可 refreshMusicJob 继续）`);
            });
            return;
        }
        let payloads = [];
        try {
            payloads = await querySongs(api, songIds);
        }
        catch (error) {
            if (error instanceof MusicApiError && error.status === 429) {
                await sleep(15000, controller?.signal);
                continue;
            }
            lastError = messageOf(error);
            // 查询失败不立刻判死：可能是网络抖动，继续重试到 deadline。
            musicLogSafe(id, "warn", `查询失败，稍后重试：${lastError}`);
            await sleep(8000, controller?.signal);
            continue;
        }
        if (payloads.length > 0) {
            await patchMusicJob(id, (job) => {
                const generation = job.generations.find((entry) => entry.id === generationId);
                for (const payload of payloads) {
                    const song = job.songs.find((entry) => entry.id === payload.id);
                    if (song === undefined) {
                        job.songs.push(songFromPayload(payload, generation?.engine ?? "suno", generationId));
                    }
                    else {
                        applySongPayload(song, payload);
                        song.generationId = generationId;
                    }
                }
            });
        }
        const jobNow = await readMusicJob(id);
        const songs = jobNow?.songs.filter((song) => songIds.includes(song.id)) ?? [];
        // 先到先下载：即使另一首还没完成，用户也能先试听已完成的那首。
        for (const song of songs.filter((entry) => entry.status === "succeeded" && entry.localFile === undefined)) {
            await ensureLocalSong(id, song.id).catch((error) => {
                void patchMusicJob(id, (job) => {
                    const entry = job.songs.find((item) => item.id === song.id);
                    if (entry !== undefined)
                        entry.downloadError = messageOf(error);
                });
            });
        }
        const succeeded = songs.filter((song) => song.status === "succeeded");
        const failed = songs.filter((song) => song.status === "failed");
        if (songs.length > 0 && songs.every((song) => song.status === "succeeded" || song.status === "failed")) {
            for (const song of succeeded) {
                if (song.localFile === undefined) {
                    try {
                        await ensureLocalSong(id, song.id);
                    }
                    catch (error) {
                        await patchMusicJob(id, (job) => {
                            const entry = job.songs.find((item) => item.id === song.id);
                            if (entry !== undefined)
                                entry.downloadError = messageOf(error);
                            musicLog(job, "warn", `歌曲 ${song.id} 下载失败：${messageOf(error)}`);
                        });
                    }
                }
            }
            await patchMusicJob(id, (job) => {
                const generation = job.generations.find((entry) => entry.id === generationId);
                if (generation !== undefined) {
                    generation.status = failed.length === 0 ? "succeeded" : succeeded.length === 0 ? "failed" : "partial";
                    generation.error = failed.length > 0 ? `${failed.length} 首失败` : undefined;
                    generation.updatedAt = now();
                }
                job.stages.generate = {
                    status: succeeded.length > 0 ? "done" : "error",
                    error: succeeded.length === 0 ? (generation?.error ?? "生成失败") : undefined,
                    at: now()
                };
                musicLog(job, succeeded.length > 0 ? "info" : "error", `生成结束：${succeeded.length} 首成功${failed.length > 0 ? `，${failed.length} 首失败` : ""}`);
            });
            return;
        }
        await sleep(5000, controller?.signal);
    }
}
function songFromPayload(payload, engine, generationId) {
    const timestamp = now();
    return {
        id: payload.id,
        generationId,
        engine,
        status: normalizeSongStatus(payload.status),
        title: typeof payload.title === "string" ? payload.title : undefined,
        audioUrl: typeof payload.audio_url === "string" ? payload.audio_url : undefined,
        wavUrl: typeof payload.audio_wav_url === "string" ? payload.audio_wav_url : undefined,
        imageUrl: typeof payload.image_url === "string" ? payload.image_url : undefined,
        duration: typeof payload.duration === "number" ? payload.duration : undefined,
        lyric: typeof payload.lyric === "string" ? payload.lyric : undefined,
        tags: typeof payload.tags === "string" ? payload.tags : undefined,
        modelName: typeof payload.model_name === "string" ? payload.model_name : undefined,
        createdAt: timestamp,
        updatedAt: timestamp
    };
}
function normalizeSongStatus(value) {
    return value === "succeeded" || value === "failed" || value === "processing" ? value : "pending";
}
function applySongPayload(song, payload) {
    song.status = normalizeSongStatus(payload.status);
    song.updatedAt = now();
    if (typeof payload.title === "string")
        song.title = payload.title;
    if (typeof payload.audio_url === "string")
        song.audioUrl = payload.audio_url;
    if (typeof payload.audio_wav_url === "string")
        song.wavUrl = payload.audio_wav_url;
    if (typeof payload.image_url === "string")
        song.imageUrl = payload.image_url;
    if (typeof payload.duration === "number")
        song.duration = payload.duration;
    if (typeof payload.lyric === "string")
        song.lyric = payload.lyric;
    if (typeof payload.tags === "string")
        song.tags = payload.tags;
    if (typeof payload.model_name === "string")
        song.modelName = payload.model_name;
    if (payload.status === "failed")
        song.error = "平台返回失败";
    if (payload.status === "succeeded")
        song.error = undefined;
}
// ── 下载 / 补查 / WAV / LRC ─────────────────────────────────────────────
const downloading = new Map();
/** 确保一首歌的音频已落盘；失败时抛错，调用方决定是记 downloadError 还是中断。 */
export async function ensureLocalSong(id, songId) {
    assertJobId(id);
    const key = `${id}:${songId}`;
    const runningDownload = downloading.get(key);
    if (runningDownload !== undefined)
        return runningDownload;
    const promise = (async () => {
        const job = await readMusicJob(id);
        if (job === undefined)
            throw new Error(`音乐任务不存在：${id}`);
        const song = job.songs.find((entry) => entry.id === songId);
        if (song === undefined)
            throw new Error(`歌曲不存在：${songId}`);
        if (song.localFile !== undefined && existsSync(musicAssetPath(id, song.localFile)))
            return song;
        if (typeof song.audioUrl !== "string" || song.audioUrl === "")
            throw new Error("这首歌没有可下载的音频地址");
        const config = await loadConfig();
        const api = apiConfigOf(config);
        const result = await downloadToFile(song.audioUrl, join(musicJobDir(id), "songs"), api, {
            stem: `song-${safeStem(songId)}`,
            fallbackExt: "mp3"
        });
        const relative = `songs/${result.file.split(/[\\/]/u).pop()}`;
        const cover = await downloadCover(id, song, api).catch(() => undefined);
        let duration = song.duration;
        try {
            const probe = await probeAudio(result.file);
            duration = probe.duration;
        }
        catch {
            // 探测失败不影响播放；API 的 duration 先顶着。
        }
        return await patchMusicJob(id, (current) => {
            const entry = current.songs.find((item) => item.id === songId);
            if (entry === undefined)
                throw new Error(`歌曲不存在：${songId}`);
            entry.localFile = relative;
            entry.downloadError = undefined;
            if (cover !== undefined)
                entry.coverFile = cover;
            if (duration !== undefined)
                entry.duration = duration;
            musicLog(current, "info", `已下载歌曲：${entry.title ?? songId}`);
            return entry;
        });
    })();
    downloading.set(key, promise);
    return promise.finally(() => {
        downloading.delete(key);
    });
}
async function downloadCover(id, song, api) {
    if (typeof song.imageUrl !== "string" || song.imageUrl === "")
        return undefined;
    const result = await downloadToFile(song.imageUrl, join(musicJobDir(id), "songs"), api, {
        stem: `cover-${safeStem(song.id)}`,
        fallbackExt: "jpg",
        maxBytes: 50 * 1024 * 1024
    });
    return `songs/${result.file.split(/[\\/]/u).pop()}`;
}
/** 补查未完成歌曲 / 补下载 / 恢复工具轮询。界面「刷新」与工具 `refreshMusicJob` 都走它。 */
export async function refreshMusicJob(id) {
    assertJobId(id);
    const job = await readMusicJob(id);
    if (job === undefined)
        throw new Error(`音乐任务不存在：${id}`);
    const api = await requireApi();
    // 未完成的 generation：先查一次当前状态（不重复提交）。
    const pendingGenerations = job.generations.filter((generation) => generation.status === "polling" || generation.status === "submitting");
    for (const generation of pendingGenerations) {
        if (generation.songIds.length === 0)
            continue;
        try {
            const payloads = await querySongs(api, generation.songIds);
            await patchMusicJob(id, (current) => {
                for (const payload of payloads) {
                    const song = current.songs.find((entry) => entry.id === payload.id);
                    if (song !== undefined)
                        applySongPayload(song, payload);
                }
            });
        }
        catch (error) {
            musicLogSafe(id, "warn", `补查失败：${messageOf(error)}`);
        }
        const latest = await readMusicJob(id);
        const songs = latest?.songs.filter((song) => generation.songIds.includes(song.id)) ?? [];
        if (songs.length > 0 && songs.every((song) => song.status === "succeeded" || song.status === "failed")) {
            for (const song of songs.filter((entry) => entry.status === "succeeded" && entry.localFile === undefined)) {
                await ensureLocalSong(id, song.id).catch(() => undefined);
            }
            await patchMusicJob(id, (current) => {
                const entry = current.generations.find((item) => item.id === generation.id);
                const failed = songs.filter((song) => song.status === "failed").length;
                if (entry !== undefined) {
                    entry.status = failed === 0 ? "succeeded" : failed === songs.length ? "failed" : "partial";
                    entry.updatedAt = now();
                }
                current.stages.generate = { status: failed === songs.length ? "error" : "done", at: now() };
            });
        }
        else {
            // 还没完成：把后台轮询接上（如果本来就有一条在跑，track 会拒绝，不会重复）。
            const generationNow = latest?.generations.find((entry) => entry.id === generation.id);
            if (generationNow !== undefined && (generationNow.status === "polling" || generationNow.status === "submitting")) {
                trackMusicTask(id, "generation", () => resumeGeneration(id, generation.id));
            }
        }
    }
    // 已成功但还没下载的歌曲：补下载。
    const latest = await readMusicJob(id);
    for (const song of latest?.songs.filter((entry) => entry.status === "succeeded" && entry.localFile === undefined) ?? []) {
        await ensureLocalSong(id, song.id).catch((error) => {
            void patchMusicJob(id, (current) => {
                const entry = current.songs.find((item) => item.id === song.id);
                if (entry !== undefined)
                    entry.downloadError = messageOf(error);
            });
        });
    }
    // 工具任务：恢复轮询。
    const pendingTools = latest?.tools.filter((tool) => tool.status === "polling" || tool.status === "submitting") ?? [];
    for (const tool of pendingTools) {
        trackMusicTask(id, `tool:${tool.id}`, () => resumeToolTask(id, tool.id));
    }
    const after = await readMusicJob(id);
    if (after === undefined)
        throw new Error(`音乐任务不存在：${id}`);
    return musicSnapshot(after);
}
export function cancelMusicGeneration(id) {
    const controller = controllers.get(`${id}:generation`);
    if (controller === undefined)
        return false;
    controller.abort();
    return true;
}
/** 插件启动时接上未完成的任务（进程重启后没有内存里的后台任务）。 */
export async function resumeMusicJobs() {
    const jobs = await listMusicJobs();
    for (const summary of jobs) {
        if (!summary.busy)
            continue;
        const job = await readMusicJob(summary.id);
        if (job === undefined)
            continue;
        const pendingGeneration = job.generations.find((generation) => generation.status === "polling" || generation.status === "submitting");
        if (pendingGeneration !== undefined && pendingGeneration.songIds.length > 0) {
            trackMusicTask(job.id, "generation", () => resumeGeneration(job.id, pendingGeneration.id));
        }
        else if (pendingGeneration !== undefined) {
            // 提交请求发出去了但还没拿到歌曲 id 就重启：没有可续查的远端任务，只能标失败。
            await patchMusicJob(job.id, (current) => {
                const entry = current.generations.find((item) => item.id === pendingGeneration.id);
                if (entry !== undefined) {
                    entry.status = "failed";
                    entry.error = "插件重启前没有拿到歌曲 id，无法续查；请重新生成（会再计费）。";
                    entry.updatedAt = now();
                }
                current.stages.generate = { status: "error", error: "插件重启前提交未完成", at: now() };
            });
        }
        for (const tool of job.tools.filter((entry) => entry.status === "polling" || entry.status === "submitting")) {
            trackMusicTask(job.id, `tool:${tool.id}`, () => resumeToolTask(job.id, tool.id));
        }
        // 编辑任务没有持久化的子进程：重启后在跑的那一版只能标失败，让用户重试。
        const rendering = job.versions.filter((version) => version.status === "rendering");
        if (rendering.length > 0) {
            await patchMusicJob(job.id, (current) => {
                for (const version of current.versions.filter((entry) => entry.status === "rendering")) {
                    version.status = "error";
                    version.error = "插件重启，渲染中断；请重新导出这一版。";
                }
                current.stages.edit = { status: "error", error: "插件重启，渲染中断", at: now() };
            });
        }
        for (const song of job.songs.filter((entry) => entry.status === "succeeded" && entry.localFile === undefined)) {
            void ensureLocalSong(job.id, song.id).catch(() => undefined);
        }
    }
}
/** 重启后接上一条已提交的 generation：不再提交，只继续查询/下载。 */
async function resumeGeneration(id, generationId) {
    const job = await readMusicJob(id);
    if (job === undefined)
        return;
    const generation = job.generations.find((entry) => entry.id === generationId);
    if (generation === undefined || generation.songIds.length === 0)
        return;
    const config = await loadConfig();
    const api = apiConfigOf(config);
    const controller = controllers.get(`${id}:generation`);
    const deadline = now() + Math.max(60000, config.musicPollTimeoutMs || 900000);
    for (;;) {
        if (controller?.signal.aborted === true)
            return;
        if (now() >= deadline) {
            await patchMusicJob(id, (current) => {
                const entry = current.generations.find((item) => item.id === generationId);
                if (entry !== undefined) {
                    entry.status = "timeout";
                    entry.updatedAt = now();
                }
                current.stages.generate = { status: "error", error: "等待超时", at: now() };
            });
            return;
        }
        try {
            const payloads = await querySongs(api, generation.songIds);
            if (payloads.length > 0) {
                await patchMusicJob(id, (current) => {
                    for (const payload of payloads) {
                        const song = current.songs.find((entry) => entry.id === payload.id);
                        if (song !== undefined)
                            applySongPayload(song, payload);
                    }
                });
            }
        }
        catch (error) {
            if (error instanceof MusicApiError && error.status === 429) {
                await sleep(15000, controller?.signal);
                continue;
            }
            await sleep(8000, controller?.signal);
            continue;
        }
        const latest = await readMusicJob(id);
        const songs = latest?.songs.filter((song) => generation.songIds.includes(song.id)) ?? [];
        if (songs.length > 0 && songs.every((song) => song.status === "succeeded" || song.status === "failed")) {
            for (const song of songs.filter((entry) => entry.status === "succeeded" && entry.localFile === undefined)) {
                await ensureLocalSong(id, song.id).catch(() => undefined);
            }
            await patchMusicJob(id, (current) => {
                const entry = current.generations.find((item) => item.id === generationId);
                const failed = songs.filter((song) => song.status === "failed").length;
                if (entry !== undefined) {
                    entry.status = failed === 0 ? "succeeded" : failed === songs.length ? "failed" : "partial";
                    entry.updatedAt = now();
                }
                current.stages.generate = { status: failed === songs.length ? "error" : "done", at: now() };
            });
            return;
        }
        await sleep(5000, controller?.signal);
    }
}
export async function getMusicWav(id, songId) {
    assertJobId(id);
    const job = await readMusicJob(id);
    if (job === undefined)
        throw new Error(`音乐任务不存在：${id}`);
    const song = job.songs.find((entry) => entry.id === songId);
    if (song === undefined)
        throw new Error(`歌曲不存在：${songId}`);
    if (song.wavFile !== undefined && existsSync(musicAssetPath(id, song.wavFile))) {
        return { ok: true, reused: true, file: song.wavFile };
    }
    const api = await requireApi();
    const wav = await requestWav(api, songId);
    const result = await downloadToFile(wav.url, join(musicJobDir(id), "songs"), api, {
        stem: `song-${safeStem(songId)}-lossless`,
        fallbackExt: "wav"
    });
    const relative = `songs/${result.file.split(/[\\/]/u).pop()}`;
    await patchMusicJob(id, (current) => {
        const entry = current.songs.find((item) => item.id === songId);
        if (entry !== undefined) {
            entry.wavFile = relative;
            entry.wavUrl = wav.url;
        }
        musicLog(current, "info", `已获取无损 WAV：${song.title ?? songId}`);
    });
    return { ok: true, file: relative, url: wav.url, bytes: result.bytes };
}
export async function getMusicLrc(id, songIds) {
    assertJobId(id);
    const job = await readMusicJob(id);
    if (job === undefined)
        throw new Error(`音乐任务不存在：${id}`);
    const targetIds = (Array.isArray(songIds) && songIds.length > 0 ? songIds : job.songs.filter((song) => song.status === "succeeded").map((song) => song.id))
        .filter((songId) => job.songs.some((song) => song.id === songId));
    if (targetIds.length === 0)
        throw new Error("没有已完成的歌曲可以生成滚动歌词");
    const api = await requireApi();
    const results = await generateLrc(api, targetIds);
    const saved = [];
    for (const result of results) {
        if (!result.success || result.lrcAlignment === undefined)
            continue;
        const relative = `songs/${safeStem(result.id)}-lrc.json`;
        await writeTextAtomic(musicAssetPath(id, relative), `${JSON.stringify({ id: result.id, lrc_alignment: result.lrcAlignment }, null, 2)}\n`);
        saved.push(result.id);
        await patchMusicJob(id, (current) => {
            const entry = current.songs.find((song) => song.id === result.id);
            if (entry !== undefined)
                entry.lrcFile = relative;
            musicLog(current, "info", `滚动歌词已就绪：${entry?.title ?? result.id}`);
        });
    }
    return { ok: true, results, saved };
}
async function writeTextAtomic(file, text) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, text, "utf8");
}
// ── 工具任务 ────────────────────────────────────────────────────────────
export async function listMusicStemInstruments() {
    const api = await requireApi();
    return stemInstruments(api);
}
function pickSong(job, songId) {
    const song = songId === undefined ? job.songs.find((entry) => entry.status === "succeeded") : job.songs.find((entry) => entry.id === songId);
    if (song === undefined)
        throw new Error(songId === undefined ? "任务里还没有已完成的歌曲" : `歌曲不存在：${songId}`);
    return song;
}
function publicAudioOf(song) {
    const url = song.wavUrl || song.audioUrl;
    if (typeof url !== "string" || url === "")
        throw new Error("这首歌没有公开音频 URL（工具类接口只接受公开可访问的 URL）");
    return url;
}
export async function runMusicTool(id, kind, params = {}) {
    assertJobId(id);
    if (!isMusicToolKind(kind))
        throw new Error(`未知音乐工具：${kind}（可用：${MUSIC_TOOL_KINDS.join(" / ")}）`);
    const job = await readMusicJob(id);
    if (job === undefined)
        throw new Error(`音乐任务不存在：${id}`);
    if (job.tools.some((tool) => tool.status === "submitting" || tool.status === "polling")) {
        return { started: false, reason: "已有工具任务在跑，等它结束再提交。" };
    }
    const toolId = `t${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
    const startedAt = now();
    await patchMusicJob(id, (current) => {
        current.tools.push({
            id: toolId,
            kind: kind,
            status: "submitting",
            params: { ...params },
            startedAt,
            updatedAt: startedAt
        });
        musicLog(current, "info", `提交音乐工具：${kind}`);
    });
    const ok = trackMusicTask(id, `tool:${toolId}`, () => runToolTask(id, toolId));
    if (!ok) {
        await patchMusicJob(id, (current) => {
            const tool = current.tools.find((entry) => entry.id === toolId);
            if (tool !== undefined) {
                tool.status = "failed";
                tool.error = "后台任务没有启动";
                tool.updatedAt = now();
            }
        });
        return { started: false, reason: "后台任务没有启动，请重启插件后再试。" };
    }
    return { started: true, toolId };
}
/**
 * 接上重启前已经提交过的工具任务：**只查询和下载，绝不重新提交**。
 *
 * 同步类工具（midi / sheet-music / style-analysis）没有可查的远端任务；如果它们在
 * 重启前没落盘，只能标失败让用户重新运行——重新运行会再计费，必须由用户决定。
 */
async function resumeToolTask(id, toolId) {
    const job = await readMusicJob(id);
    if (job === undefined)
        return;
    const tool = job.tools.find((entry) => entry.id === toolId);
    if (tool === undefined)
        return;
    try {
        if (tool.remoteTaskId === undefined || tool.remoteTaskId === "" || !["stems", "pro-stems", "convert"].includes(tool.kind)) {
            throw new Error("插件重启前这一步没有可续查的远端任务，请重新运行（会再计费）。");
        }
        const api = await requireApi();
        const finished = await pollTool(api, id, toolId, {
            taskId: tool.remoteTaskId,
            status: tool.status === "polling" ? "processing" : "pending",
            type: tool.kind,
            raw: {}
        });
        const params = tool.params ?? {};
        const fallback = tool.kind === "convert"
            ? (typeof params.targetFormat === "string" ? params.targetFormat : "mp3")
            : (typeof params.outputFormat === "string" ? params.outputFormat : "mp3");
        const toolDir = join(musicJobDir(id), "tools", toolId);
        await downloadToolFiles(id, toolId, finished.raw, toolDir, fallback);
    }
    catch (error) {
        await patchMusicJob(id, (current) => {
            const entry = current.tools.find((item) => item.id === toolId);
            if (entry !== undefined) {
                entry.status = "failed";
                entry.error = messageOf(error);
                entry.updatedAt = now();
            }
            musicLog(current, "error", `工具任务未能续跑：${messageOf(error)}`);
        });
    }
}
async function runToolTask(id, toolId) {
    const job = await readMusicJob(id);
    if (job === undefined)
        return;
    const tool = job.tools.find((entry) => entry.id === toolId);
    if (tool === undefined)
        return;
    const api = await requireApi();
    const params = tool.params ?? {};
    // sheet-music 只需要一个公开 MIDI URL，不依赖这首歌；其余分支才需要 song/audioUrl。
    let songCache;
    const songOf = () => {
        if (songCache === undefined)
            songCache = pickSong(job, typeof params.songId === "string" ? params.songId : undefined);
        return songCache;
    };
    const audioUrlOf = () => typeof params.audioUrl === "string" && params.audioUrl !== "" ? params.audioUrl : publicAudioOf(songOf());
    const toolDir = join(musicJobDir(id), "tools", toolId);
    try {
        if (tool.kind === "stems") {
            const stemCount = Number(params.stemCount ?? 4);
            const outputFormat = typeof params.outputFormat === "string" ? params.outputFormat : "mp3";
            const submitted = await submitStemSplit(api, { audioUrl: audioUrlOf(), filename: `${safeStem(songOf().title ?? songOf().id)}.mp3`, stemCount, outputFormat });
            await markToolSubmitted(id, toolId, submitted);
            const finished = await pollTool(api, id, toolId, submitted);
            await downloadToolFiles(id, toolId, finished.raw, toolDir, outputFormat);
            return;
        }
        if (tool.kind === "pro-stems") {
            const itemCode = typeof params.itemCode === "string" ? params.itemCode : "";
            const outputFormat = typeof params.outputFormat === "string" ? params.outputFormat : "mp3";
            const submitted = await submitProStemSplit(api, { audioUrl: audioUrlOf(), itemCode, filename: `${safeStem(songOf().title ?? songOf().id)}.mp3`, outputFormat });
            await markToolSubmitted(id, toolId, submitted);
            const finished = await pollTool(api, id, toolId, submitted);
            await downloadToolFiles(id, toolId, finished.raw, toolDir, outputFormat);
            return;
        }
        if (tool.kind === "midi") {
            const midi = await submitMidi(api, { audioUrl: audioUrlOf(), audioName: `${safeStem(songOf().title ?? songOf().id)}.mp3` });
            const downloaded = await downloadToFile(midi.midiUrl, toolDir, api, { stem: "midi", fallbackExt: "mid" });
            await patchMusicJob(id, (current) => {
                const entry = current.tools.find((item) => item.id === toolId);
                if (entry !== undefined) {
                    entry.status = "succeeded";
                    entry.result = { midiUrl: midi.midiUrl };
                    entry.files = [{ name: "midi.mid", file: `tools/${toolId}/${downloaded.file.split(/[\\/]/u).pop()}`, bytes: downloaded.bytes }];
                    entry.updatedAt = now();
                }
                musicLog(current, "info", "音频转 MIDI 完成");
            });
            return;
        }
        if (tool.kind === "sheet-music") {
            const midiUrl = typeof params.midiUrl === "string" ? params.midiUrl : "";
            if (midiUrl === "")
                throw new Error("乐谱转换需要 midiUrl（可以先用 midi 工具拿到公开 MIDI URL）");
            const sheet = await submitSheetMusic(api, midiUrl);
            const files = [];
            if (sheet.pdfUrl !== undefined) {
                const downloaded = await downloadToFile(sheet.pdfUrl, toolDir, api, { stem: "score", fallbackExt: "pdf", maxBytes: 80 * 1024 * 1024 });
                files.push({ name: "score.pdf", file: `tools/${toolId}/${downloaded.file.split(/[\\/]/u).pop()}`, bytes: downloaded.bytes });
            }
            if (sheet.xmlUrl !== undefined) {
                const downloaded = await downloadToFile(sheet.xmlUrl, toolDir, api, { stem: "score", fallbackExt: "musicxml", maxBytes: 80 * 1024 * 1024 });
                files.push({ name: "score.musicxml", file: `tools/${toolId}/${downloaded.file.split(/[\\/]/u).pop()}`, bytes: downloaded.bytes });
            }
            await patchMusicJob(id, (current) => {
                const entry = current.tools.find((item) => item.id === toolId);
                if (entry !== undefined) {
                    entry.status = "succeeded";
                    entry.result = { pdfUrl: sheet.pdfUrl, xmlUrl: sheet.xmlUrl };
                    entry.files = files;
                    entry.updatedAt = now();
                }
                musicLog(current, "info", "MIDI 转乐谱完成");
            });
            return;
        }
        if (tool.kind === "style-analysis") {
            const analysis = await submitStyleAnalysis(api, { audioUrl: audioUrlOf(), audioName: `${safeStem(songOf().title ?? songOf().id)}.mp3` });
            await patchMusicJob(id, (current) => {
                const entry = current.tools.find((item) => item.id === toolId);
                if (entry !== undefined) {
                    entry.status = "succeeded";
                    entry.result = { instruments: analysis.instruments, genres: analysis.genres, tags: analysis.tags, description: analysis.description };
                    entry.files = [];
                    entry.updatedAt = now();
                }
                musicLog(current, "info", "风格分析完成");
            });
            return;
        }
        // convert
        const targetFormat = typeof params.targetFormat === "string" ? params.targetFormat : "mp3";
        const submitted = await submitAudioConvert(api, { sourceUrl: audioUrlOf(), targetFormat });
        await markToolSubmitted(id, toolId, submitted);
        const finished = await pollTool(api, id, toolId, submitted);
        await downloadToolFiles(id, toolId, finished.raw, toolDir, targetFormat);
    }
    catch (error) {
        await patchMusicJob(id, (current) => {
            const entry = current.tools.find((item) => item.id === toolId);
            if (entry !== undefined) {
                entry.status = "failed";
                entry.error = messageOf(error);
                entry.updatedAt = now();
            }
            musicLog(current, "error", `音乐工具失败（${tool.kind}）：${messageOf(error)}`);
        });
    }
}
async function markToolSubmitted(id, toolId, task) {
    await patchMusicJob(id, (current) => {
        const entry = current.tools.find((item) => item.id === toolId);
        if (entry !== undefined) {
            entry.status = task.status === "succeeded" || task.status === "failed" ? task.status : "polling";
            entry.remoteTaskId = task.taskId;
            entry.updatedAt = now();
        }
    });
}
async function pollTool(api, id, toolId, submitted) {
    let current = submitted;
    const deadline = now() + 15 * 60 * 1000;
    while (current.status !== "succeeded" && current.status !== "failed") {
        if (now() >= deadline)
            throw new Error("工具任务等待超时（15 分钟）");
        await sleep(5000);
        current = await toolTask(api, current.taskId || submitted.taskId);
        await patchMusicJob(id, (job) => {
            const entry = job.tools.find((item) => item.id === toolId);
            if (entry !== undefined) {
                entry.status = current.status === "succeeded" || current.status === "failed" ? current.status : "polling";
                entry.updatedAt = now();
            }
        });
    }
    if (current.status === "failed") {
        throw new Error(`工具任务失败：${JSON.stringify(current.raw).slice(0, 300)}`);
    }
    return current;
}
/** 从工具响应里收集可下载的 URL（stems 的 tracks / 转码的 url / tracks 都收）。 */
function collectToolUrls(raw) {
    const out = [];
    const seen = new Set();
    const push = (name, url, ext) => {
        if (typeof url !== "string" || url === "" || seen.has(url))
            return;
        seen.add(url);
        out.push({ name, url, ext });
    };
    const result = raw?.result ?? raw;
    const tracks = Array.isArray(result?.tracks) ? result.tracks : [];
    for (const [index, track] of tracks.entries()) {
        const type = typeof track?.type === "string" ? track.type : `track-${index + 1}`;
        push(type, track?.url, typeof track?.format === "string" ? track.format : undefined);
    }
    push("audio", result?.url ?? result?.audio_url ?? result?.output_url);
    return out;
}
async function downloadToolFiles(id, toolId, raw, dir, fallbackExt) {
    const urls = collectToolUrls(raw);
    if (urls.length === 0)
        throw new Error(`工具任务完成但没有返回可下载文件：${JSON.stringify(raw).slice(0, 300)}`);
    const api = await requireApi();
    const files = [];
    for (const entry of urls) {
        const downloaded = await downloadToFile(entry.url, dir, api, {
            stem: safeStem(entry.name),
            fallbackExt: entry.ext ?? fallbackExt,
            maxBytes: 200 * 1024 * 1024
        });
        files.push({
            name: `${safeStem(entry.name)}.${downloaded.ext}`,
            file: `tools/${toolId}/${downloaded.file.split(/[\\/]/u).pop()}`,
            bytes: downloaded.bytes
        });
    }
    await patchMusicJob(id, (current) => {
        const entry = current.tools.find((item) => item.id === toolId);
        if (entry !== undefined) {
            entry.status = "succeeded";
            entry.result = raw;
            entry.files = files;
            entry.updatedAt = now();
        }
        musicLog(current, "info", `工具产物已下载：${files.length} 个文件`);
    });
}
// ── 编辑 / 版本 ─────────────────────────────────────────────────────────
function opsHashOf(sourceRelative, ops, sourceSize, sourceMtime) {
    return createHash("sha1")
        .update(`${sourceRelative}|${sourceSize}|${sourceMtime}|${JSON.stringify(ops)}`)
        .digest("hex");
}
/**
 * 渲染一次编辑（后台）。
 *
 * 返回预分配的 versionId：界面据此轮询到「这一版就绪」，而不是靠比较列表长度。
 * 相同源 + 相同 ops 默认复用已有版本（`force:true` 可强制重跑）。
 */
export async function renderMusicEdit(id, input) {
    assertJobId(id);
    const job = await readMusicJob(id);
    if (job === undefined)
        throw new Error(`音乐任务不存在：${id}`);
    const baseVersion = typeof input.versionId === "string" ? job.versions.find((version) => version.id === input.versionId && version.status === "ready") : undefined;
    const song = baseVersion !== undefined
        ? job.songs.find((entry) => entry.id === baseVersion.songId)
        : job.songs.find((entry) => entry.id === (input.songId ?? job.songs.find((entry) => entry.status === "succeeded")?.id));
    if (song === undefined)
        throw new Error("任务里还没有可编辑的歌曲");
    if (baseVersion === undefined && song.localFile === undefined)
        await ensureLocalSong(id, song.id);
    // ensureLocalSong 写的是**磁盘上的 job**，上面的 `job` 还是旧对象；重新读一次再取 localFile。
    const fresh = baseVersion === undefined ? await readMusicJob(id) : job;
    const freshSong = fresh?.songs.find((entry) => entry.id === song.id) ?? song;
    const sourceRelative = baseVersion?.file ?? freshSong.localFile;
    if (sourceRelative === undefined)
        throw new Error("这首歌还没有下载到本地，无法编辑");
    const sourceFile = musicAssetPath(id, sourceRelative);
    const sourceInfo = await stat(sourceFile).catch(() => undefined);
    if (sourceInfo === undefined)
        throw new Error(`源音频不存在：${sourceRelative}`);
    const probe = await probeAudio(sourceFile);
    const ops = normalizeEditOps(input.ops ?? {}, probe.duration);
    const hash = opsHashOf(sourceRelative, ops, sourceInfo.size, sourceInfo.mtimeMs);
    if (input.force !== true) {
        const existing = job.versions.find((version) => version.opsHash === hash && version.status === "ready");
        if (existing !== undefined) {
            // 同一组参数先「试听」再「保存为版本」：直接把试听版转正，没必要再花一次本地渲染。
            if (input.preview !== true && existing.preview === true) {
                await patchMusicJob(id, (current) => {
                    const entry = current.versions.find((version) => version.id === existing.id);
                    if (entry !== undefined) {
                        entry.preview = false;
                        if (typeof input.label === "string" && input.label.trim() !== "")
                            entry.label = input.label.trim().slice(0, 80);
                    }
                    musicLog(current, "info", `试听版转正：${entry?.label ?? existing.label}`);
                });
            }
            return { started: false, versionId: existing.id, reused: true, reason: input.preview !== true && existing.preview === true ? "试听版已转为正式版本" : "相同参数已有版本，直接复用" };
        }
    }
    const versionId = `v${Date.now().toString(36)}${randomUUID().slice(0, 5)}`;
    const relative = `versions/${versionId}.${ops.format}`;
    const label = (typeof input.label === "string" && input.label.trim() !== "" ? input.label.trim() : describeOps(ops)).slice(0, 80);
    const createdAt = now();
    await patchMusicJob(id, (current) => {
        current.versions.push({
            id: versionId,
            songId: song.id,
            label,
            file: relative,
            format: ops.format,
            duration: ops.end - ops.start,
            size: 0,
            ops,
            opsHash: hash,
            preview: input.preview === true,
            status: "rendering",
            by: input.by === "ai" ? "ai" : "human",
            baseVersionId: baseVersion?.id,
            createdAt
        });
        current.stages.edit = { status: "running", at: createdAt };
        musicLog(current, "info", `开始渲染版本：${label}`);
    });
    const ok = trackMusicTask(id, `edit:${versionId}`, async () => {
        try {
            const rendered = await renderAudioEdit({ source: sourceFile, dest: musicAssetPath(id, relative), ops });
            await patchMusicJob(id, (current) => {
                const version = current.versions.find((entry) => entry.id === versionId);
                if (version !== undefined) {
                    version.status = "ready";
                    version.duration = rendered.duration;
                    version.size = rendered.size;
                    version.ops = rendered.ops;
                    version.label = label;
                }
                current.stages.edit = { status: "done", at: now() };
                for (const warning of rendered.warnings)
                    musicLog(current, "warn", warning);
                musicLog(current, "info", `版本已就绪：${label}（${rendered.duration.toFixed(1)} 秒）`);
            });
        }
        catch (error) {
            await patchMusicJob(id, (current) => {
                const version = current.versions.find((entry) => entry.id === versionId);
                if (version !== undefined) {
                    version.status = "error";
                    version.error = messageOf(error);
                }
                current.stages.edit = { status: "error", error: messageOf(error), at: now() };
                musicLog(current, "error", `版本渲染失败：${messageOf(error)}`);
            });
        }
    });
    if (!ok) {
        await patchMusicJob(id, (current) => {
            const version = current.versions.find((entry) => entry.id === versionId);
            if (version !== undefined) {
                version.status = "error";
                version.error = "后台任务没有启动";
            }
            current.stages.edit = { status: "error", error: "后台任务没有启动", at: now() };
        });
        return { started: false, versionId, reason: "后台任务没有启动，请重启插件后再试。" };
    }
    return { started: true, versionId };
}
export function describeOps(ops) {
    const parts = [];
    if (ops.start !== undefined || ops.end !== undefined)
        parts.push("裁剪");
    if (typeof ops.gainDb === "number" && ops.gainDb !== 0)
        parts.push(`${ops.gainDb > 0 ? "+" : ""}${ops.gainDb} dB`);
    if (typeof ops.fadeIn === "number" && ops.fadeIn > 0)
        parts.push(`淡入 ${ops.fadeIn}s`);
    if (typeof ops.fadeOut === "number" && ops.fadeOut > 0)
        parts.push(`淡出 ${ops.fadeOut}s`);
    if (ops.normalize === true)
        parts.push(`标准化 ${ops.lufs ?? -14} LUFS`);
    if (typeof ops.format === "string")
        parts.push(ops.format.toUpperCase());
    return parts.length === 0 ? "原始音频" : parts.join(" · ");
}
export async function saveMusicVersion(id, versionId, label) {
    assertJobId(id);
    const job = await patchMusicJob(id, (current) => {
        const version = current.versions.find((entry) => entry.id === versionId);
        if (version === undefined)
            throw new Error(`版本不存在：${versionId}`);
        version.preview = false;
        if (typeof label === "string" && label.trim() !== "")
            version.label = label.trim().slice(0, 80);
        musicLog(current, "info", `保存版本：${version.label}`);
        return current;
    });
    return musicSnapshot(job);
}
export async function deleteMusicVersion(id, versionId) {
    assertJobId(id);
    let file;
    await patchMusicJob(id, (job) => {
        const index = job.versions.findIndex((entry) => entry.id === versionId);
        if (index < 0)
            throw new Error(`版本不存在：${versionId}`);
        file = job.versions[index].file;
        job.versions.splice(index, 1);
        musicLog(job, "info", `删除版本：${versionId}`);
    });
    if (file !== undefined)
        await rm(musicAssetPath(id, file), { force: true }).catch(() => undefined);
}
// ── 波形 ────────────────────────────────────────────────────────────────
export async function musicPeaks(id, input = {}, origin = originForLinks()) {
    assertJobId(id);
    const job = await readMusicJob(id);
    if (job === undefined)
        throw new Error(`音乐任务不存在：${id}`);
    const version = typeof input.versionId === "string" ? job.versions.find((entry) => entry.id === input.versionId && entry.status === "ready") : undefined;
    const song = version !== undefined ? job.songs.find((entry) => entry.id === version.songId) : pickSong(job, input.songId);
    if (song === undefined)
        throw new Error("找不到对应歌曲");
    if (version === undefined && song.localFile === undefined)
        await ensureLocalSong(id, song.id);
    const relative = version?.file ?? song.localFile;
    if (relative === undefined)
        throw new Error("这首歌还没有下载到本地，无法生成波形");
    const file = musicAssetPath(id, relative);
    const info = await stat(file).catch(() => undefined);
    if (info === undefined)
        throw new Error(`音频文件不存在：${relative}`);
    const buckets = Math.min(2000, Math.max(64, Math.round(Number(input.buckets ?? 800))));
    const hash = createHash("sha1").update(`${relative}|${info.size}|${info.mtimeMs}|${buckets}`).digest("hex");
    const cacheFile = join(musicJobDir(id), "peaks", `${hash}.json`);
    const cached = await readJson(cacheFile);
    if (cached !== undefined && Array.isArray(cached.peaks)) {
        return { ...cached, file: relative, url: absUrl(origin, musicAssetBase(id), relative) ?? null };
    }
    const result = await audioPeaks(file, buckets);
    await writeJsonAtomic(cacheFile, result);
    return {
        peaks: result.peaks,
        buckets: result.buckets,
        duration: result.duration,
        file: relative,
        url: absUrl(origin, musicAssetBase(id), relative) ?? null
    };
}
function extOf(relative) {
    const match = /\.([a-z0-9]{2,5})$/iu.exec(relative);
    return (match?.[1] ?? "mp3").toLowerCase();
}
function normalizeExportFormat(value, fallback) {
    const raw = typeof value === "string" && value !== "" ? value : fallback;
    return MUSIC_EDIT_FORMATS.includes(raw) ? raw : "mp3";
}
async function uniqueExportPath(dir, stem, ext) {
    const safe = safeStem(stem);
    for (let index = 0; index < 1000; index++) {
        const name = index === 0 ? `${safe}.${ext}` : `${safe}-${index + 1}.${ext}`;
        const full = join(dir, name);
        if (!existsSync(full))
            return full;
    }
    throw new Error("导出文件名冲突太多");
}
/**
 * 导出到 `out/`。
 *
 * - 指定 versionId / songId：导出单个文件（必要时转码）；
 * - 不指定：全部已完成的歌 + 已保存版本 + manifest.json，打成一个 zip；
 * - `zip:true` 时即使只有一个目标也打 zip。
 */
export async function exportMusic(id, input = {}, options = {}) {
    assertJobId(id);
    const job = await readMusicJob(id);
    if (job === undefined)
        throw new Error(`音乐任务不存在：${id}`);
    const outDir = join(musicJobDir(id), "out");
    await mkdir(outDir, { recursive: true });
    const targets = [];
    if (typeof input.versionId === "string") {
        const version = job.versions.find((entry) => entry.id === input.versionId && entry.status === "ready");
        if (version === undefined)
            throw new Error(`版本不存在或尚未完成：${input.versionId}`);
        const song = job.songs.find((entry) => entry.id === version.songId);
        targets.push({
            label: `${song?.title ?? job.name} · ${version.label}`,
            sourceRelative: version.file,
            format: normalizeExportFormat(input.format, version.format),
            songId: song?.id,
            versionId: version.id
        });
    }
    else if (typeof input.songId === "string") {
        const song = job.songs.find((entry) => entry.id === input.songId);
        if (song === undefined)
            throw new Error(`歌曲不存在：${input.songId}`);
        if (song.localFile === undefined)
            await ensureLocalSong(id, song.id);
        if (song.localFile === undefined)
            throw new Error("歌曲还没有下载到本地");
        targets.push({
            label: song.title ?? job.name,
            sourceRelative: song.localFile,
            format: normalizeExportFormat(input.format, extOf(song.localFile)),
            songId: song.id
        });
    }
    else {
        for (const song of job.songs.filter((entry) => entry.status === "succeeded")) {
            if (song.localFile === undefined)
                await ensureLocalSong(id, song.id).catch(() => undefined);
            if (song.localFile === undefined)
                continue;
            targets.push({
                label: song.title ?? job.name,
                sourceRelative: song.localFile,
                format: normalizeExportFormat(input.format, extOf(song.localFile)),
                songId: song.id
            });
        }
        for (const version of job.versions.filter((entry) => entry.status === "ready" && entry.preview !== true)) {
            targets.push({
                label: `${job.name} · ${version.label}`,
                sourceRelative: version.file,
                format: normalizeExportFormat(input.format, version.format),
                versionId: version.id
            });
        }
    }
    if (targets.length === 0)
        throw new Error("任务里没有可导出的歌曲或版本");
    const exported = [];
    for (const target of targets) {
        const source = musicAssetPath(id, target.sourceRelative);
        const sourceExt = extOf(target.sourceRelative);
        const desiredName = targets.length === 1 && typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : target.label;
        const dest = await uniqueExportPath(outDir, desiredName, target.format);
        if (sourceExt === target.format) {
            const { copyFile } = await import("node:fs/promises");
            await copyFile(source, dest);
        }
        else {
            await renderAudioEdit({ source, dest, ops: { format: target.format } });
        }
        const info = await stat(dest);
        exported.push({ label: target.label, file: `out/${dest.split(/[\\/]/u).pop()}`, bytes: info.size, format: target.format });
    }
    const origin = options.origin ?? originForLinks();
    const assetBase = musicAssetBase(id);
    if (exported.length === 1 && input.zip !== true) {
        const entry = exported[0];
        const record = {
            id: `e${Date.now().toString(36)}${randomUUID().slice(0, 5)}`,
            file: entry.file,
            format: entry.format,
            bytes: entry.bytes,
            createdAt: now(),
            songId: targets[0].songId,
            versionId: targets[0].versionId
        };
        await patchMusicJob(id, (current) => {
            current.exports.push(record);
            current.stages.export = { status: "done", at: now() };
            musicLog(current, "info", `导出：${entry.file}`);
        });
        return {
            ok: true,
            file: entry.file,
            path: musicAssetPath(id, entry.file),
            url: absUrl(origin, assetBase, entry.file) ?? null,
            downloadUrl: absUrl(origin, assetBase, entry.file) === undefined ? null : `${absUrl(origin, assetBase, entry.file)}?download=1`,
            bytes: entry.bytes,
            format: entry.format
        };
    }
    const manifest = {
        job: { id: job.id, name: job.name, createdAt: job.createdAt },
        platform: "谱乐 AI (YourMusic)",
        exportedAt: new Date().toISOString(),
        files: exported,
        songs: job.songs.filter((song) => song.status === "succeeded").map((song) => ({
            id: song.id,
            title: song.title,
            duration: song.duration,
            tags: song.tags,
            lyric: song.lyric,
            modelName: song.modelName
        })),
        versions: job.versions.filter((version) => version.status === "ready").map((version) => ({
            id: version.id,
            songId: version.songId,
            label: version.label,
            format: version.format,
            duration: version.duration,
            ops: version.ops
        }))
    };
    const entries = [];
    for (const entry of exported) {
        const { readFile } = await import("node:fs/promises");
        entries.push({ path: entry.file.replace(/^out\//u, ""), data: await readFile(musicAssetPath(id, entry.file)) });
    }
    entries.push({ path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") });
    const zip = zipEntries(entries);
    const zipName = `${safeStem(input.name ?? job.name)}.zip`;
    const zipPath = await uniqueExportPath(outDir, `${safeStem(input.name ?? job.name)}`, "zip");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(zipPath, zip);
    const zipRelative = `out/${zipPath.split(/[\\/]/u).pop()}`;
    const record = {
        id: `e${Date.now().toString(36)}${randomUUID().slice(0, 5)}`,
        file: zipRelative,
        format: "zip",
        bytes: zip.length,
        createdAt: now(),
        files: exported.map((entry) => entry.file)
    };
    await patchMusicJob(id, (current) => {
        current.exports.push(record);
        current.stages.export = { status: "done", at: now() };
        musicLog(current, "info", `导出打包：${zipRelative}（${exported.length} 个文件）`);
    });
    return {
        ok: true,
        zip: true,
        file: zipRelative,
        path: zipPath,
        url: absUrl(origin, assetBase, zipRelative) ?? null,
        downloadUrl: absUrl(origin, assetBase, zipRelative) === undefined ? null : `${absUrl(origin, assetBase, zipRelative)}?download=1`,
        bytes: zip.length,
        files: exported,
        name: zipName
    };
}
// ── 杂项 ────────────────────────────────────────────────────────────────
/** 供工具面/界面展示「历史里有哪些歌」（只读，不生成）。 */
export async function listMusicHistory(input = {}) {
    const api = await requireApi();
    const history = await musicHistory(api, input);
    return history;
}
/** 清理任务目录里遗留的 tmp（读任务时顺手做一次，别让它们越积越多）。 */
export async function sweepMusicJob(id) {
    await sweepTempFiles(musicJobDir(id)).catch(() => undefined);
}
/** 给工具面用的「任务是否存在」判断（不读全量 job）。 */
export async function musicJobExists(id) {
    if (!isValidMusicJobId(id))
        return false;
    try {
        await stat(musicJobFile(id));
        return true;
    }
    catch {
        return false;
    }
}
/** 给 `links.ts` / 工具面用的「打开任务」链接。 */
export function musicOpenLink(id, stage) {
    return buildOpenLink({ module: "music", jobId: id, ...(stage === undefined ? {} : { stage }) });
}
/** 任务里的引擎 key（避免界面重复实现）。 */
export const MUSIC_ENGINE_KEYS = [...MUSIC_ENGINES];
