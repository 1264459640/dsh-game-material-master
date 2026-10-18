/**
 * 音效生成（模块八）的数据层与作业。
 *
 * ## 落盘
 *
 * ```
 * <DSH_HOME>/game-material-master/sfx-jobs/<f…>/
 * ├── job.json
 * ├── refs/            参考图（1 张）/ 参考音频（≤3 条）
 * ├── takes/           每次生成的音频（一次请求 = 一条，永不覆盖）
 * └── out/             导出
 * ```
 *
 * ## 与音乐模块的区别
 *
 * 火山引擎的 `seed-audio-1.0` 是**同步接口**：一次 POST 直接返回整段音频，
 * 没有 taskId、没有轮询。这里仍然用后台任务表承载，是为了不阻塞网关调用，
 * 也让 `game_material_wait` / 界面的「生成中」状态有统一落点。
 *
 * 所有写 `job.json` 的地方都走 `patchSfxJob()` 的**按任务串行队列**：界面保存
 * 提示词、后台任务收尾、上传参考同时发生时，后写的不会覆盖前一次改动。
 */
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, sfxJobsRoot } from "./config.js";
import { appendJobLog, messageOf, readJson, sweepTempFiles, writeJsonAtomic } from "./jsonio.js";
import { SFX_LIMITS, buildSfxBody, generateSfx, normalizeSfxSettings, sfxBlocker } from "./sfxapi.js";
import { probeAudio } from "./musicaudio.js";
import { sniffBinary } from "./musicapi.js";
import { sniffImage } from "./imagegen.js";
import { zipEntries } from "./zip.js";
import { assetBasePath, originForLinks } from "./links.js";
export const SFX_STAGES = ["generate", "export"];
const JOB_ID_PATTERN = /^f[a-z0-9]{4,40}$/;
/** 音效任务可经资源路由读取的子目录（唯一真源，`index.ts` 直接引用）。 */
export const SERVABLE_SFX_DIRS = new Set(["refs", "takes", "out"]);
export function sfxJobDir(id) {
    return join(sfxJobsRoot(), id);
}
export function sfxJobFile(id) {
    return join(sfxJobDir(id), "job.json");
}
/** 任务内相对路径 → 绝对路径，并挡住目录穿越。 */
export function sfxAssetPath(id, relative) {
    const base = resolve(sfxJobDir(id));
    const target = resolve(base, relative);
    if (target !== base && !target.startsWith(base + sep))
        throw new Error(`非法的任务内路径：${relative}`);
    return target;
}
export function isValidSfxJobId(id) {
    return JOB_ID_PATTERN.test(id);
}
function assertJobId(id) {
    if (!isValidSfxJobId(id))
        throw new Error(`非法音效任务 id：${id}`);
}
function now() {
    return Date.now();
}
function logOf(job) {
    if (!Array.isArray(job.log))
        job.log = [];
    return job.log;
}
export function sfxLog(job, level, message) {
    appendJobLog(logOf(job), level, message);
}
function clampString(value, max = 20000) {
    return typeof value === "string" ? value.slice(0, max) : "";
}
export function safeSfxStem(value) {
    const base = basename(String(value ?? ""))
        .replace(/[^\w.\-()\u4e00-\u9fa5]+/gu, "_")
        .replace(/^[._]+/u, "");
    return base === "" ? "sfx" : base.slice(0, 80);
}
function deriveSfxName(prompt) {
    const flat = prompt.replace(/\s+/gu, " ").trim();
    return flat === "" ? "未命名音效" : flat.slice(0, 24);
}
function defaultStages() {
    return {
        generate: { status: "idle", approved: false },
        export: { status: "idle", approved: false }
    };
}
function normalizeRefImage(raw) {
    const entry = raw !== null && typeof raw === "object" ? raw : undefined;
    if (entry === undefined || typeof entry.file !== "string" || entry.file === "")
        return undefined;
    return {
        file: entry.file,
        name: typeof entry.name === "string" ? entry.name : basename(entry.file),
        bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : 0,
        ext: typeof entry.ext === "string" ? entry.ext : "png"
    };
}
function normalizeRefAudio(raw) {
    const entry = raw !== null && typeof raw === "object" ? raw : undefined;
    if (entry === undefined || typeof entry.file !== "string" || entry.file === "")
        return undefined;
    return {
        file: entry.file,
        name: typeof entry.name === "string" ? entry.name : basename(entry.file),
        bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : 0,
        ext: typeof entry.ext === "string" ? entry.ext : "wav",
        ...(Number.isFinite(Number(entry.duration)) && Number(entry.duration) > 0 ? { duration: Number(entry.duration) } : {})
    };
}
/** 读回来的老数据补齐数组与阶段字段，避免界面拿 undefined 当空。 */
function normalizeJob(raw, id) {
    const config = raw ?? {};
    const settings = (() => {
        try {
            return normalizeSfxSettings(config.settings);
        }
        catch {
            return normalizeSfxSettings({});
        }
    })();
    const stages = config.stages !== null && typeof config.stages === "object" ? config.stages : {};
    return {
        id,
        name: clampString(config.name, 200) || "未命名音效",
        createdAt: Number(config.createdAt) || now(),
        updatedAt: Number(config.updatedAt) || Number(config.createdAt) || now(),
        prompt: clampString(config.prompt, SFX_LIMITS.promptChars),
        settings,
        reviewMode: config.reviewMode === "manual" ? "manual" : config.reviewMode === "auto" ? "auto" : undefined,
        refs: {
            ...(normalizeRefImage(config.refs?.image) === undefined ? {} : { image: normalizeRefImage(config.refs?.image) }),
            audios: Array.isArray(config.refs?.audios)
                ? config.refs.audios.map(normalizeRefAudio).filter((entry) => entry !== undefined)
                : []
        },
        status: ["idle", "running", "ready", "error"].includes(config.status) ? config.status : "idle",
        ...(typeof config.error === "string" && config.error !== "" ? { error: config.error } : {}),
        takes: Array.isArray(config.takes)
            ? config.takes
                .filter((take) => take !== null && typeof take === "object" && typeof take.file === "string" && take.file !== "")
                .map((take) => ({
                id: typeof take.id === "string" ? take.id : randomUUID().slice(0, 8),
                file: take.file,
                bytes: Number.isFinite(Number(take.bytes)) ? Number(take.bytes) : 0,
                format: typeof take.format === "string" ? take.format : "wav",
                ...(Number.isFinite(Number(take.duration)) && Number(take.duration) > 0 ? { duration: Number(take.duration) } : {}),
                ...(Number.isFinite(Number(take.originalDuration)) && Number(take.originalDuration) > 0 ? { originalDuration: Number(take.originalDuration) } : {}),
                prompt: clampString(take.prompt, SFX_LIMITS.promptChars),
                settings: (() => {
                    try {
                        return normalizeSfxSettings(take.settings, settings);
                    }
                    catch {
                        return settings;
                    }
                })(),
                createdAt: Number(take.createdAt) || now(),
                ...(typeof take.logId === "string" && take.logId !== "" ? { logId: take.logId } : {})
            }))
            : [],
        stages: {
            generate: normalizeStage(stages.generate),
            export: normalizeStage(stages.export)
        },
        exports: Array.isArray(config.exports)
            ? config.exports
                .filter((entry) => entry !== null && typeof entry === "object" && typeof entry.file === "string")
                .map((entry) => ({
                id: typeof entry.id === "string" ? entry.id : randomUUID().slice(0, 8),
                takeId: typeof entry.takeId === "string" ? entry.takeId : null,
                file: entry.file,
                bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : 0,
                format: typeof entry.format === "string" ? entry.format : "wav",
                createdAt: Number(entry.createdAt) || now()
            }))
            : [],
        log: Array.isArray(config.log) ? config.log.slice(-200) : []
    };
}
function normalizeStage(raw) {
    const entry = raw !== null && typeof raw === "object" ? raw : {};
    return {
        status: ["idle", "running", "done", "error"].includes(entry.status) ? entry.status : "idle",
        approved: entry.approved === true,
        ...(typeof entry.error === "string" && entry.error !== "" ? { error: entry.error } : {}),
        ...(Number.isFinite(Number(entry.at)) ? { at: Number(entry.at) } : {})
    };
}
export async function createSfxJob(input) {
    const config = await loadConfig();
    if (input.prompt.length > SFX_LIMITS.promptChars) {
        throw new Error(`提示词太长：${input.prompt.length} 字符，上限 ${SFX_LIMITS.promptChars}`);
    }
    const prompt = clampString(input.prompt, SFX_LIMITS.promptChars).trim();
    if (prompt === "")
        throw new Error("提示词不能为空：先写清要什么声音");
    const settings = normalizeSfxSettings(input.settings, {
        format: config.sfxFormat,
        sampleRate: config.sfxSampleRate
    });
    const id = `f${now().toString(36)}${randomUUID().slice(0, 6)}`;
    const createdAt = now();
    const job = {
        id,
        name: clampString(input.name, 200).trim() || deriveSfxName(prompt),
        createdAt,
        updatedAt: createdAt,
        prompt,
        settings,
        ...(input.reviewMode === "manual" ? { reviewMode: "manual" } : input.reviewMode === "auto" ? { reviewMode: "auto" } : {}),
        refs: { audios: [] },
        status: "idle",
        takes: [],
        stages: defaultStages(),
        exports: [],
        log: []
    };
    await mkdir(join(sfxJobDir(id), "refs"), { recursive: true });
    await mkdir(join(sfxJobDir(id), "takes"), { recursive: true });
    await mkdir(join(sfxJobDir(id), "out"), { recursive: true });
    sfxLog(job, "info", `新建音效任务：${job.name}`);
    await writeJsonAtomic(sfxJobFile(id), job);
    return job;
}
export async function readSfxJob(id) {
    assertJobId(id);
    const raw = await readJson(sfxJobFile(id));
    if (raw === undefined)
        return undefined;
    return normalizeJob(raw, id);
}
/** 保存提示词 / 名称 / 参数 / 审核模式。生成中的任务也允许改，下一次生成才生效。 */
export async function saveSfxJob(id, input) {
    assertJobId(id);
    const job = await patchSfxJob(id, (current) => {
        if (typeof input.name === "string") {
            const name = input.name.trim().slice(0, 200);
            if (name !== "")
                current.name = name;
        }
        if (typeof input.prompt === "string") {
            if (input.prompt.length > SFX_LIMITS.promptChars) {
                throw new Error(`提示词太长：${input.prompt.length} 字符，上限 ${SFX_LIMITS.promptChars}`);
            }
            current.prompt = input.prompt.trim();
        }
        if (input.settings !== undefined) {
            current.settings = normalizeSfxSettings(input.settings, current.settings);
        }
        if (input.reviewMode === "auto" || input.reviewMode === "manual") {
            current.reviewMode = input.reviewMode;
        }
        sfxLog(current, "info", "任务参数已更新");
        return current;
    });
    return sfxSnapshot(job, originForLinks());
}
export async function writeSfxJob(job) {
    assertJobId(job.id);
    await sweepTempFiles(sfxJobDir(job.id)).catch(() => undefined);
    await writeJsonAtomic(sfxJobFile(job.id), job);
}
const jobQueues = new Map();
/**
 * 按任务串行写。后台任务收尾与用户保存同时发生时，只靠「读-改-写」会丢改动。
 */
export function patchSfxJob(id, mutator) {
    assertJobId(id);
    const previous = jobQueues.get(id) ?? Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(async () => {
        const job = await readSfxJob(id);
        if (job === undefined)
            throw new Error(`音效任务不存在：${id}`);
        const result = await mutator(job);
        job.updatedAt = now();
        await writeSfxJob(job);
        return result;
    });
    jobQueues.set(id, next);
    void next.finally(() => {
        if (jobQueues.get(id) === next)
            jobQueues.delete(id);
    }).catch(() => undefined);
    return next;
}
export async function listSfxJobs() {
    let entries = [];
    try {
        entries = (await readdir(sfxJobsRoot(), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && isValidSfxJobId(entry.name))
            .map((entry) => entry.name);
    }
    catch {
        return [];
    }
    const jobs = [];
    for (const id of entries) {
        const job = await readSfxJob(id).catch(() => undefined);
        if (job !== undefined)
            jobs.push(summarizeSfxJob(job));
    }
    return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function summarizeSfxJob(job) {
    const latest = job.takes[job.takes.length - 1];
    return {
        id: job.id,
        name: job.name,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        status: job.status,
        busy: sfxBusy(job.id, job),
        takes: job.takes.length,
        latestDuration: latest?.duration ?? null,
        format: latest?.format ?? null,
        reviewMode: job.reviewMode ?? null
    };
}
export async function deleteSfxJob(id) {
    assertJobId(id);
    const job = await readSfxJob(id);
    if (job === undefined)
        return;
    if (sfxBusy(id, job))
        throw new Error("任务正在生成，先取消或等它结束再删除。");
    await rm(sfxJobDir(id), { recursive: true, force: true });
}
// ── 后台任务表 ──────────────────────────────────────────────────────────
const running = new Map();
const controllers = new Map();
let disposed = false;
/** DSH 重载插件时模块级 disposed 会留着，apply 时靠它复位。 */
export function activateSfx() {
    disposed = false;
    running.clear();
    for (const controller of controllers.values())
        controller.abort();
    controllers.clear();
}
export function disposeSfx() {
    disposed = true;
    for (const controller of controllers.values())
        controller.abort();
    controllers.clear();
    running.clear();
}
export function sfxBusy(id, job) {
    if ((running.get(id)?.size ?? 0) > 0)
        return true;
    return job?.status === "running";
}
function trackSfxTask(id, key, run) {
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
        void patchSfxJob(id, (job) => sfxLog(job, "error", `${key} 失败：${messageOf(error)}`)).catch(() => undefined);
    })
        .finally(() => {
        set.delete(key);
        controllers.delete(`${id}:${key}`);
        if (set.size === 0 && running.get(id) === set)
            running.delete(id);
    });
    return true;
}
function controllerOf(id) {
    return controllers.get(`${id}:generation`);
}
export async function cancelSfxGeneration(id) {
    assertJobId(id);
    const controller = controllerOf(id);
    if (controller === undefined)
        return false;
    controller.abort();
    return true;
}
// ── 参考素材 ────────────────────────────────────────────────────────────
const IMAGE_REF_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);
function safeRefName(name, fallback) {
    const value = typeof name === "string" ? name.trim() : "";
    if (value === "")
        return fallback;
    return value.replace(/[^\w.\-()\u4e00-\u9fa5]+/gu, "_").slice(0, 120);
}
export async function uploadSfxRef(id, kind, name, data) {
    assertJobId(id);
    const job = await readSfxJob(id);
    if (job === undefined)
        throw new Error(`音效任务不存在：${id}`);
    const raw = typeof data === "string" ? data.replace(/^data:[^,]*,/u, "") : "";
    if (raw.trim() === "")
        throw new Error("上传内容为空");
    let bytes;
    try {
        bytes = Buffer.from(raw, "base64");
    }
    catch {
        throw new Error("上传内容不是合法 base64");
    }
    if (bytes.length === 0)
        throw new Error("上传内容为空");
    if (bytes.length > SFX_LIMITS.refBytes) {
        throw new Error(`参考文件太大：${(bytes.length / 1024 / 1024).toFixed(1)}MB（上限 10MB）`);
    }
    await mkdir(join(sfxJobDir(id), "refs"), { recursive: true });
    if (kind === "image") {
        if (job.refs.audios.length > 0)
            throw new Error("参考图与参考音频不能同时使用：先删掉参考音频，再上传参考图。");
        const sniffed = sniffImage(raw);
        if (sniffed === undefined || !IMAGE_REF_EXTS.has(sniffed.ext)) {
            throw new Error("无法识别的参考图格式（支持 PNG / JPEG / WebP）");
        }
        const ext = sniffed.ext === "jpeg" ? "jpg" : sniffed.ext;
        const relative = `refs/image-${randomUUID().slice(0, 8)}.${ext}`;
        await writeFile(sfxAssetPath(id, relative), bytes);
        const previous = job.refs.image;
        await patchSfxJob(id, (current) => {
            current.refs.image = {
                file: relative,
                name: safeRefName(name, `参考图.${ext}`),
                bytes: bytes.length,
                ext
            };
            sfxLog(current, "info", `上传参考图：${current.refs.image.name}`);
        });
        if (previous !== undefined)
            await rm(sfxAssetPath(id, previous.file), { force: true }).catch(() => undefined);
        const latest = await readSfxJob(id);
        return sfxSnapshot(latest ?? job, originForLinks());
    }
    if (job.refs.image !== undefined)
        throw new Error("参考图与参考音频不能同时使用：先删掉参考图，再上传参考音频。");
    if (job.refs.audios.length >= SFX_LIMITS.audioRefs) {
        throw new Error(`参考音频最多 ${SFX_LIMITS.audioRefs} 条：先删掉一条再上传。`);
    }
    const sniffed = sniffBinary(bytes.subarray(0, 24));
    const allowed = new Set(["wav", "mp3", "ogg"]);
    if (sniffed === undefined || !allowed.has(sniffed.ext)) {
        throw new Error("无法识别的参考音频格式（支持 WAV / MP3 / OGG(Opus)）");
    }
    let duration;
    const probeRelative = `refs/.probe-${randomUUID().slice(0, 8)}.${sniffed.ext}`;
    try {
        const probePath = sfxAssetPath(id, probeRelative);
        await writeFile(probePath, bytes);
        const probe = await probeAudio(probePath);
        duration = probe.duration;
        if (duration > SFX_LIMITS.refSeconds + 0.5) {
            throw new Error(`参考音频太长：${duration.toFixed(1)} 秒（上限 ${SFX_LIMITS.refSeconds} 秒）`);
        }
    }
    catch (error) {
        // 缺 ffprobe 时 probeAudio 会抛 MediaError；这不是用户文件的问题，交给平台校验。
        if (error instanceof Error && /参考音频太长/u.test(error.message))
            throw error;
    }
    finally {
        await rm(sfxAssetPath(id, probeRelative), { force: true }).catch(() => undefined);
    }
    const relative = `refs/audio-${job.refs.audios.length + 1}-${randomUUID().slice(0, 8)}.${sniffed.ext}`;
    await writeFile(sfxAssetPath(id, relative), bytes);
    await patchSfxJob(id, (current) => {
        current.refs.audios.push({
            file: relative,
            name: safeRefName(name, `参考音频 ${current.refs.audios.length + 1}.${sniffed.ext}`),
            bytes: bytes.length,
            ext: sniffed.ext,
            ...(duration === undefined ? {} : { duration })
        });
        sfxLog(current, "info", `上传参考音频：${current.refs.audios[current.refs.audios.length - 1].name}`);
    });
    const latest = await readSfxJob(id);
    return sfxSnapshot(latest ?? job, originForLinks());
}
export async function removeSfxRef(id, kind, file) {
    assertJobId(id);
    const job = await readSfxJob(id);
    if (job === undefined)
        throw new Error(`音效任务不存在：${id}`);
    const removed = [];
    await patchSfxJob(id, (current) => {
        if (kind === "image") {
            if (current.refs.image !== undefined) {
                removed.push(current.refs.image.file);
                current.refs.image = undefined;
                sfxLog(current, "info", "删除参考图");
            }
            return;
        }
        const target = typeof file === "string" && file !== "" ? file : undefined;
        const keep = [];
        for (const entry of current.refs.audios) {
            if (target === undefined || entry.file === target)
                removed.push(entry.file);
            else
                keep.push(entry);
        }
        current.refs.audios = keep;
        if (removed.length > 0)
            sfxLog(current, "info", `删除 ${removed.length} 条参考音频`);
    });
    for (const relative of removed)
        await rm(sfxAssetPath(id, relative), { force: true }).catch(() => undefined);
    const latest = await readSfxJob(id);
    return sfxSnapshot(latest ?? job, originForLinks());
}
async function readRefs(id, job) {
    const image = job.refs.image === undefined ? undefined : await readFile(sfxAssetPath(id, job.refs.image.file)).catch(() => undefined);
    if (job.refs.image !== undefined && image === undefined) {
        throw new Error(`参考图文件已丢失：${job.refs.image.file}；请删掉后重新上传。`);
    }
    const audios = [];
    for (const entry of job.refs.audios) {
        const bytes = await readFile(sfxAssetPath(id, entry.file)).catch(() => undefined);
        if (bytes === undefined)
            throw new Error(`参考音频文件已丢失：${entry.file}；请删掉后重新上传。`);
        audios.push(bytes);
    }
    return { ...(image === undefined ? {} : { image }), audios };
}
export async function startSfxGeneration(id) {
    assertJobId(id);
    const job = await readSfxJob(id);
    if (job === undefined)
        throw new Error(`音效任务不存在：${id}`);
    if (sfxBusy(id, job))
        return { started: false, reason: "这个任务正在生成，等它结束再提交（重复提交会重复计费）。" };
    const config = await loadConfig();
    const blocker = sfxBlocker(config);
    if (blocker !== undefined)
        throw new Error(blocker);
    if (job.prompt.trim() === "")
        throw new Error("提示词为空：先写清要什么声音");
    const refs = await readRefs(id, job);
    // 先在主线程校验一遍（不消耗网络），避免「任务已置 running 才因为参数不合法失败」。
    buildSfxBody({ prompt: job.prompt, settings: job.settings, refs }, config.sfxModel);
    const startedAt = now();
    await patchSfxJob(id, (current) => {
        current.status = "running";
        current.error = undefined;
        current.stages.generate = { status: "running", approved: false, at: startedAt };
        sfxLog(current, "info", `提交生成：${job.settings.format} / ${job.settings.sampleRate}Hz`);
    });
    const ok = trackSfxTask(id, "generation", () => runSfxGeneration(id, refs));
    if (!ok) {
        await patchSfxJob(id, (current) => {
            current.status = "error";
            current.error = "后台任务没有启动（插件正在重载？）";
            current.stages.generate = { status: "error", approved: false, error: current.error, at: now() };
            sfxLog(current, "error", current.error);
        });
        return { started: false, reason: "后台任务没有启动，请重启插件后再试。" };
    }
    return { started: true };
}
async function runSfxGeneration(id, refs) {
    const config = await loadConfig();
    const controller = controllerOf(id);
    const job = await readSfxJob(id);
    if (job === undefined)
        return;
    try {
        const result = await generateSfx({
            baseUrl: config.sfxBaseUrl,
            apiKey: config.sfxApiKey,
            model: config.sfxModel,
            timeoutMs: config.sfxTimeoutMs
        }, {
            prompt: job.prompt,
            settings: job.settings,
            refs
        }, controller?.signal);
        const takeId = `k${now().toString(36)}${randomUUID().slice(0, 6)}`;
        const relative = `takes/${takeId}.${result.ext}`;
        const target = sfxAssetPath(id, relative);
        const tmp = `${target}.${randomUUID().slice(0, 6)}.part`;
        await mkdir(join(sfxJobDir(id), "takes"), { recursive: true });
        await writeFile(tmp, result.bytes);
        await rename(tmp, target);
        let duration = result.duration;
        if (duration === undefined) {
            try {
                duration = (await probeAudio(target)).duration;
            }
            catch {
                duration = undefined;
            }
        }
        await patchSfxJob(id, (current) => {
            current.status = "ready";
            current.error = undefined;
            current.takes.push({
                id: takeId,
                file: relative,
                bytes: result.bytes.length,
                format: result.ext,
                ...(duration === undefined ? {} : { duration }),
                ...(result.originalDuration === undefined ? {} : { originalDuration: result.originalDuration }),
                prompt: job.prompt,
                settings: job.settings,
                createdAt: now(),
                ...(result.logId === undefined ? {} : { logId: result.logId })
            });
            current.stages.generate = { status: "done", approved: false, at: now() };
            sfxLog(current, "info", `生成完成：${relative}（${result.bytes.length} 字节${duration === undefined ? "" : `，${duration.toFixed(2)} 秒`}）${(result.attempts ?? 1) > 1 ? ` · 网络握手重试后成功（第 ${result.attempts} 次）` : ""}`);
        });
    }
    catch (error) {
        const message = messageOf(error);
        await patchSfxJob(id, (current) => {
            current.status = "error";
            current.error = message;
            current.stages.generate = { status: "error", approved: false, error: message, at: now() };
            sfxLog(current, "error", message);
        }).catch(() => undefined);
    }
}
// ── 验收 / 导出 ─────────────────────────────────────────────────────────
export async function setSfxApproved(id, stage, approved) {
    assertJobId(id);
    if (stage !== undefined && !SFX_STAGES.includes(stage))
        throw new Error(`未知阶段：${stage}（可选：${SFX_STAGES.join(" / ")}）`);
    const job = await patchSfxJob(id, (current) => {
        const stages = stage === undefined ? [...SFX_STAGES] : [stage];
        for (const key of stages)
            current.stages[key].approved = approved;
        sfxLog(current, "info", `${approved ? "通过" : "取消通过"}：${stage ?? "全部阶段"}`);
        return current;
    });
    return sfxSnapshot(job, originForLinks());
}
function sfxAssetBase(id) {
    return assetBasePath(`/dsh-game-material-master/sfx-assets/${id}/`);
}
function absUrl(origin, assetBase, relative) {
    if (typeof relative !== "string" || relative === "")
        return undefined;
    return `${origin}${assetBase}${relative.split("/").map(encodeURIComponent).join("/")}`;
}
export async function exportSfx(id, input = {}) {
    assertJobId(id);
    const job = await readSfxJob(id);
    if (job === undefined)
        throw new Error(`音效任务不存在：${id}`);
    if (job.takes.length === 0)
        throw new Error("还没有可导出的音频：先生成一条。");
    const outDir = join(sfxJobDir(id), "out");
    await mkdir(outDir, { recursive: true });
    const origin = originForLinks();
    const assetBase = sfxAssetBase(id);
    const stem = safeSfxStem(job.name);
    if (input.zip === true) {
        const entries = [];
        for (const take of job.takes) {
            entries.push({ path: basename(take.file), data: await readFile(sfxAssetPath(id, take.file)) });
        }
        const zip = zipEntries(entries);
        const zipName = `${stem}-${Date.now().toString(36)}.zip`;
        await writeFile(join(outDir, zipName), zip);
        const relative = `out/${zipName}`;
        const exportId = `e${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
        await patchSfxJob(id, (current) => {
            current.exports.push({
                id: exportId,
                takeId: null,
                file: relative,
                bytes: zip.length,
                format: "zip",
                createdAt: now()
            });
            current.stages.export = { status: "done", approved: false, at: now() };
            sfxLog(current, "info", `导出打包：${relative}（${job.takes.length} 条）`);
        });
        const url = absUrl(origin, assetBase, relative) ?? null;
        return {
            ok: true,
            zip: true,
            file: relative,
            path: join(outDir, zipName),
            url,
            downloadUrl: url === null ? null : `${url}?download=1`,
            bytes: zip.length,
            count: job.takes.length
        };
    }
    const take = input.takeId === undefined || input.takeId === ""
        ? job.takes[job.takes.length - 1]
        : job.takes.find((entry) => entry.id === input.takeId);
    if (take === undefined)
        throw new Error(`找不到这一条生成：${input.takeId}`);
    const source = sfxAssetPath(id, take.file);
    const fileName = `${stem}-${take.id}.${take.format}`;
    const target = join(outDir, fileName);
    await copyFile(source, target);
    const info = await stat(target);
    const relative = `out/${fileName}`;
    const exportId = `e${now().toString(36)}${randomUUID().slice(0, 6)}`;
    await patchSfxJob(id, (current) => {
        current.exports.push({
            id: exportId,
            takeId: take.id,
            file: relative,
            bytes: info.size,
            format: take.format,
            createdAt: now()
        });
        current.stages.export = { status: "done", approved: false, at: now() };
        sfxLog(current, "info", `导出：${relative}`);
    });
    const url = absUrl(origin, assetBase, relative) ?? null;
    return {
        ok: true,
        file: relative,
        path: target,
        url,
        downloadUrl: url === null ? null : `${url}?download=1`,
        bytes: info.size,
        format: take.format,
        takeId: take.id
    };
}
// ── 视图 ────────────────────────────────────────────────────────────────
export async function sfxSnapshot(job, origin = originForLinks()) {
    const config = await loadConfig();
    const assetBase = sfxAssetBase(job.id);
    return {
        module: "sfx",
        id: job.id,
        name: job.name,
        dir: sfxJobDir(job.id),
        assetBase,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        reviewMode: job.reviewMode ?? null,
        busy: sfxBusy(job.id, job),
        blocker: sfxBlocker(config) ?? null,
        prompt: job.prompt,
        settings: job.settings,
        status: job.status,
        ...(job.error === undefined ? {} : { error: job.error }),
        refs: {
            image: job.refs.image === undefined
                ? null
                : { ...job.refs.image, url: absUrl(origin, assetBase, job.refs.image.file) ?? null },
            audios: job.refs.audios.map((entry) => ({
                ...entry,
                url: absUrl(origin, assetBase, entry.file) ?? null
            }))
        },
        takes: job.takes.map((take) => ({
            ...take,
            url: absUrl(origin, assetBase, take.file) ?? null
        })),
        stages: job.stages,
        exports: job.exports.map((entry) => ({
            ...entry,
            url: absUrl(origin, assetBase, entry.file) ?? null,
            downloadUrl: absUrl(origin, assetBase, entry.file) === undefined ? null : `${absUrl(origin, assetBase, entry.file)}?download=1`
        })),
        log: job.log.slice(-40)
    };
}
/** 进程重启后：没有远端 taskId 可续查，残留的 running 一律标失败。 */
export async function resumeSfxJobs() {
    const jobs = await listSfxJobs().catch(() => []);
    for (const summary of jobs) {
        if (summary.status !== "running")
            continue;
        await patchSfxJob(summary.id, (job) => {
            job.status = "error";
            job.error = "宿主重启导致生成中断；远端可能已经完成并计费，请重新生成或先到控制台核对。";
            job.stages.generate = { status: "error", approved: false, error: job.error, at: now() };
            sfxLog(job, "warn", job.error);
        }).catch(() => undefined);
    }
}
export async function sweepSfxJob(id) {
    await sweepTempFiles(sfxJobDir(id)).catch(() => undefined);
}
export function sfxJobExists(id) {
    return existsSync(sfxJobFile(id));
}
/** 工具/界面都用的「下一步」提示。 */
export function sfxNextActions(snapshot) {
    const actions = [];
    if (typeof snapshot.blocker === "string" && snapshot.blocker !== "")
        actions.push(snapshot.blocker);
    const takes = Array.isArray(snapshot.takes) ? snapshot.takes : [];
    if (snapshot.busy === true) {
        actions.push("正在生成：用 game_material_wait({module:'sfx', id}) 等它结束；不要重复提交。");
    }
    else if (takes.length === 0) {
        actions.push("还没有生成：runSfxGeneration({jobId})（★真实计费，每次一条），然后 game_material_wait。");
    }
    else {
        actions.push("试听 takes 里的 URL；满意就 exportSfx({jobId, takeId})，不满意改提示词再 runSfxGeneration（会再计费一次）。");
    }
    if (typeof snapshot.error === "string" && snapshot.error !== "") {
        actions.push(`上次失败：${snapshot.error}；重试会再计费，先向用户确认。`);
    }
    if (snapshot.reviewMode === "manual")
        actions.push("审核模式是 manual：生成后贴 openUrl 并停下等用户说「通过」。");
    if (actions.length === 0)
        actions.push("任务已就绪：可以继续生成或导出。");
    return actions;
}
