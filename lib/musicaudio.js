/**
 * 音乐编辑的本地音频层（模块七）。
 *
 * 只做四件事：探测音频、按参数渲染、算波形峰值、给出可读错误。
 * 所有 ffmpeg / ffprobe 调用都走 `media.ts` 的统一入口 —— 那边会处理
 * FFMPEG_PATH、Windows 注册表与常见安装位置，绕过它就是「自检全绿、真机找不到 ffmpeg」。
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { runFfmpeg, runFfprobe, MediaError } from "./media.js";
import { MUSIC_EDIT_BITRATES, MUSIC_EDIT_FORMATS } from "./musicmodels.js";
function clamp(value, fallback, min, max) {
    const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
function round2(value) {
    return Math.round(value * 100) / 100;
}
/** 探测音频。duration 优先取 format.duration，缺失时退回第一条音频流的 duration。 */
export async function probeAudio(file) {
    const { stdout } = await runFfprobe(["-v", "error", "-show_format", "-show_streams", "-of", "json", file], 60000);
    let payload;
    try {
        payload = JSON.parse(stdout.toString("utf8"));
    }
    catch {
        throw new MediaError(`无法解析 ffprobe 输出：${file}`);
    }
    const streams = Array.isArray(payload?.streams) ? payload.streams : [];
    const audio = streams.find((stream) => stream?.codec_type === "audio");
    if (audio === undefined)
        throw new MediaError(`这个文件里没有音频流：${file}`);
    const formatDuration = Number.parseFloat(String(payload?.format?.duration ?? ""));
    const streamDuration = Number.parseFloat(String(audio?.duration ?? ""));
    const duration = Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : streamDuration;
    if (!Number.isFinite(duration) || duration <= 0)
        throw new MediaError(`无法读取音频时长：${file}`);
    let size = Number.parseInt(String(payload?.format?.size ?? ""), 10);
    if (!Number.isFinite(size) || size <= 0) {
        try {
            size = (await stat(file)).size;
        }
        catch {
            size = 0;
        }
    }
    return {
        duration,
        size,
        codec: typeof audio?.codec_name === "string" ? audio.codec_name : undefined,
        sampleRate: Number.isFinite(Number(audio?.sample_rate)) ? Number(audio.sample_rate) : undefined,
        channels: Number.isFinite(Number(audio?.channels)) ? Number(audio.channels) : undefined,
        bitRate: Number.isFinite(Number(payload?.format?.bit_rate)) ? Number(payload.format.bit_rate) : undefined
    };
}
/**
 * 规范化编辑参数。
 *
 * 规则：
 * - start/end 相对源文件；end 缺省 = 全长；夹到 [0,duration]，end<=start 报错。
 * - 淡入 + 淡出超过段长时**按比例一起缩**（只缩一个会让另一个仍越界）。
 * - normalize 默认关；lufs 默认 -14、truePeak 默认 -1（dBTP）。
 */
export function normalizeEditOps(raw, duration) {
    if (!Number.isFinite(duration) || duration <= 0)
        throw new MediaError("源音频时长无效");
    const start = clamp(raw.start, 0, 0, Math.max(0, duration - 0.05));
    const endRaw = raw.end === undefined || raw.end === null || String(raw.end) === "" ? duration : Number(raw.end);
    if (!Number.isFinite(endRaw))
        throw new MediaError("裁剪终点必须是数字");
    const end = clamp(endRaw, duration, 0, duration);
    if (end <= start)
        throw new MediaError(`裁剪终点必须大于起点（${round2(start)}s → ${round2(end)}s）`);
    const segment = end - start;
    let fadeIn = clamp(raw.fadeIn, 0, 0, 30);
    let fadeOut = clamp(raw.fadeOut, 0, 0, 30);
    if (fadeIn + fadeOut > segment) {
        const scale = segment / (fadeIn + fadeOut);
        fadeIn = Math.floor(fadeIn * scale * 100) / 100;
        fadeOut = Math.floor(fadeOut * scale * 100) / 100;
    }
    fadeIn = Math.min(fadeIn, segment);
    fadeOut = Math.min(fadeOut, segment);
    const format = MUSIC_EDIT_FORMATS.includes(String(raw.format))
        ? String(raw.format)
        : "mp3";
    const bitrateRaw = Math.round(clamp(raw.bitrate, 192, 32, 512));
    const bitrate = MUSIC_EDIT_BITRATES.includes(bitrateRaw) ? bitrateRaw : 192;
    const channels = raw.channels === 1 || raw.channels === 2 ? raw.channels : undefined;
    const sampleRateRaw = raw.sampleRate === undefined ? undefined : Math.round(clamp(raw.sampleRate, 44100, 8000, 96000));
    const sampleRate = sampleRateRaw === undefined ? undefined : [22050, 44100, 48000, 96000].includes(sampleRateRaw) ? sampleRateRaw : 44100;
    return {
        start: round2(start),
        end: round2(end),
        gainDb: round2(clamp(raw.gainDb, 0, -24, 24)),
        fadeIn: round2(fadeIn),
        fadeOut: round2(fadeOut),
        normalize: raw.normalize === true,
        lufs: round2(clamp(raw.lufs, -14, -40, -5)),
        truePeak: round2(clamp(raw.truePeak, -1, -9, 0)),
        format,
        bitrate,
        channels,
        sampleRate
    };
}
function formatFilter(ops) {
    const chain = [];
    if (ops.start > 0 || ops.end < Number.MAX_SAFE_INTEGER) {
        chain.push(`atrim=start=${ops.start.toFixed(3)}:end=${ops.end.toFixed(3)}`);
        chain.push("asetpts=PTS-STARTPTS");
    }
    if (ops.gainDb !== 0)
        chain.push(`volume=${ops.gainDb.toFixed(2)}dB`);
    if (ops.fadeIn > 0)
        chain.push(`afade=t=in:st=0:d=${ops.fadeIn.toFixed(3)}`);
    if (ops.fadeOut > 0) {
        const segment = ops.end - ops.start;
        const at = Math.max(0, segment - ops.fadeOut);
        chain.push(`afade=t=out:st=${at.toFixed(3)}:d=${ops.fadeOut.toFixed(3)}`);
    }
    if (ops.normalize)
        chain.push(`loudnorm=I=${ops.lufs.toFixed(1)}:TP=${ops.truePeak.toFixed(1)}:LRA=11`);
    return chain.join(",");
}
function encoderArgs(ops) {
    const args = [];
    if (ops.format === "mp3")
        args.push("-c:a", "libmp3lame", "-b:a", `${ops.bitrate}k`);
    else if (ops.format === "wav")
        args.push("-c:a", "pcm_s16le");
    else
        args.push("-c:a", "aac", "-b:a", `${ops.bitrate}k`, "-movflags", "+faststart");
    if (ops.sampleRate !== undefined)
        args.push("-ar", String(ops.sampleRate));
    if (ops.channels !== undefined)
        args.push("-ac", String(ops.channels));
    return args;
}
/** 编辑结果的目标路径（调用方给目录与主名，扩展名由 format 决定）。 */
export function editTargetPath(dir, stem, format) {
    return `${dir}/${stem}.${format}`;
}
/**
 * 渲染一次编辑。
 *
 * `force` 语义由上层（musicgen）处理；这里只负责「源 → 目标」。
 * 没开 normalize 时不会碰 loudnorm；开了但 ffmpeg 失败，会**去掉 normalize 重试一次**，
 * 并在 warnings 里说明——不让一条响度滤镜把整次编辑废掉。
 */
export async function renderAudioEdit(input) {
    const probe = await probeAudio(input.source);
    const ops = normalizeEditOps(input.ops, probe.duration);
    const warnings = [];
    await mkdir(dirname(input.dest), { recursive: true });
    const sourceExt = extname(input.source).toLowerCase().replace(/^\./u, "");
    const noOp = ops.start <= 0 &&
        Math.abs(ops.end - probe.duration) < 0.01 &&
        ops.gainDb === 0 &&
        ops.fadeIn === 0 &&
        ops.fadeOut === 0 &&
        !ops.normalize &&
        ops.channels === undefined &&
        ops.sampleRate === undefined;
    if (noOp && sourceExt === ops.format) {
        await copyFile(input.source, input.dest);
        const size = (await stat(input.dest)).size;
        return { file: input.dest, duration: ops.end - ops.start, size, format: ops.format, ops, warnings };
    }
    const baseArgs = [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", input.source,
        "-map", "0:a:0",
        "-vn", "-sn", "-dn",
        "-map_metadata", "-1"
    ];
    const filter = formatFilter(ops);
    const runOnce = async (withNormalize) => {
        const effective = withNormalize ? ops : { ...ops, normalize: false };
        const chain = formatFilter(effective);
        const args = [...baseArgs];
        if (chain !== "")
            args.push("-af", chain);
        args.push(...encoderArgs(ops), input.dest);
        await runFfmpeg(args, input.timeoutMs ?? 600000);
    };
    try {
        await runOnce(ops.normalize);
    }
    catch (error) {
        if (!ops.normalize) {
            throw error instanceof MediaError
                ? error
                : new MediaError(`音频渲染失败：${error instanceof Error ? error.message : String(error)}`);
        }
        warnings.push(`响度标准化失败，已改为不做标准化重试一次：${error instanceof Error ? error.message : String(error)}`);
        await runOnce(false);
    }
    let rendered;
    try {
        rendered = await probeAudio(input.dest);
    }
    catch (error) {
        throw new MediaError(`渲染完成但读不出输出音频：${error instanceof Error ? error.message : String(error)}`);
    }
    const size = (await stat(input.dest)).size;
    return {
        file: input.dest,
        duration: rendered.duration > 0 ? rendered.duration : ops.end - ops.start,
        size,
        format: ops.format,
        ops,
        warnings
    };
}
/** 波形峰值：解码成 4kHz 单声道 s16，再按桶取绝对值最大。 */
export async function audioPeaks(file, buckets = 800) {
    const count = Math.round(clamp(buckets, 800, 64, 2000));
    const probe = await probeAudio(file);
    const { stdout } = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-ac", "1", "-ar", "4000", "-f", "s16le", "-"], 180000);
    const samples = Math.floor(stdout.length / 2);
    if (samples <= 0)
        throw new MediaError(`无法解码波形：${file}`);
    const peaks = new Array(count).fill(0);
    for (let i = 0; i < samples; i++) {
        const value = Math.abs(stdout.readInt16LE(i * 2)) / 32768;
        const bucket = Math.min(count - 1, Math.floor((i / samples) * count));
        if (value > peaks[bucket])
            peaks[bucket] = value;
    }
    // 归一化到 0..1（有些音频峰值只到 0.3，不归一化会看起来像一条平线）。
    const max = Math.max(...peaks);
    const normalized = max > 0 ? peaks.map((value) => Math.round((value / max) * 1000) / 1000) : peaks;
    return { peaks: normalized, buckets: count, duration: probe.duration };
}
/** 把秒数格式化成 m:ss.xx（界面与日志共用）。 */
export function formatSeconds(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const rest = value - minutes * 60;
    const whole = Math.floor(rest);
    const hundredths = Math.round((rest - whole) * 100);
    return `${minutes}:${String(whole).padStart(2, "0")}.${String(Math.min(99, hundredths)).padStart(2, "0")}`;
}
