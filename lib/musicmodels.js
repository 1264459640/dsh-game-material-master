/**
 * 音乐生成编辑（模块七）的引擎 / 模式 / 模型与参数枚举。
 *
 * 这里刻意**不 import config / musicapi**：配置层要用默认模型，API 层要用端点映射，
 * 两边都依赖这张表，表本身只描述「谱乐 AI 开放了什么」。
 *
 * 数据来源：`https://api.yourmusic.fun/v1/openapi.json`（2026-10 抓取）。
 * 模型清单不是动态接口，平台新增模型时改这里即可。
 */
export const MUSIC_ENGINES = ["suno", "mureka", "minimax", "aceStep"];
export const MUSIC_MODES = [
    "prompt",
    "custom",
    "instrumental",
    "cover",
    "extend",
    "mashup",
    "sample",
    "concat"
];
/**
 * 四个引擎的模型与可用模式。
 *
 * ⚠️ Suno 的 `prompt` 上限只有 500 字符，`custom` 的 tags 1000 / lyrics 5000 ——
 * 这两条差别决定了 agent 该走哪条路：短灵感用 prompt，结构化风格 + 歌词用 custom。
 */
export const MUSIC_ENGINE_PRESETS = [
    {
        id: "suno",
        label: "Suno",
        hint: "v6 系列：可只给灵感，也可给完整歌词与风格标签；每次提交返回 2 首",
        defaultModel: "chirp-v6",
        models: [
            { id: "chirp-v6", label: "chirp-v6（默认 · 完成度最好）" },
            { id: "chirp-v6-wild", label: "chirp-v6-wild（探索 · 更有个性、更不可控）" },
            { id: "chirp-v6-mini", label: "chirp-v6-mini（更快更省 · 草稿）" }
        ],
        modes: [
            { id: "prompt", label: "灵感提示词", hint: "一句自然语言灵感；平台会自动补歌词与标题（prompt ≤500 字符）" },
            { id: "custom", label: "自定义歌词", hint: "标题 + 歌词 + 风格标签；控制力最强（lyrics ≤5000 / tags ≤1000）" },
            { id: "cover", label: "翻唱 Cover", hint: "基于已有歌曲 id 重新演绎，可附歌词/标签/人声性别" },
            { id: "extend", label: "续写 Extend", hint: "从已有歌曲的某个时间点继续写，再用 concat 拼成整首" },
            { id: "mashup", label: "混搭 Mashup", hint: "2–5 个源片段的影响叠加" },
            { id: "sample", label: "采样 Sample", hint: "截取源歌曲的一段作为音频样本再生成" },
            { id: "concat", label: "拼接 Concat", hint: "把最后一首续写歌曲拼回完整歌曲" }
        ]
    },
    {
        id: "mureka",
        label: "Mureka",
        hint: "另一个音乐模型家族；纯音乐可直接用 instrumental 端点，每次可出 1–3 首",
        defaultModel: "mureka-9.5",
        models: [
            { id: "mureka-9.5", label: "mureka-9.5（默认）" },
            { id: "mureka-9", label: "mureka-9" },
            { id: "mureka-8", label: "mureka-8" },
            { id: "mureka-7.6", label: "mureka-7.6" },
            { id: "mureka-o2", label: "mureka-o2" },
            { id: "auto", label: "auto（平台自选）" }
        ],
        modes: [
            { id: "prompt", label: "灵感提示词", hint: "给一句灵感，平台先写歌词再生成" },
            { id: "custom", label: "自定义歌词", hint: "标题 + 歌词 + 风格标签（lyrics ≤3000）" },
            { id: "instrumental", label: "纯音乐", hint: "标题 + 提示词，不出人声" }
        ]
    },
    {
        id: "minimax",
        label: "MiniMax",
        hint: "音乐 3.0：需要提示词与歌词（纯音乐可只给提示词），可指定采样率/码率",
        defaultModel: "music-3.0",
        models: [
            { id: "music-3.0", label: "music-3.0（默认）" },
            { id: "music-2.6", label: "music-2.6" }
        ],
        modes: [
            { id: "custom", label: "自定义生成", hint: "提示词（≤2000）+ 歌词 / 纯音乐；可选人声性别、采样率、码率" }
        ]
    },
    {
        id: "aceStep",
        label: "ACE-Step",
        hint: "可明确指定 BPM / 调式 / 拍号与演唱语言；适合游戏循环与纯音乐",
        defaultModel: "v15-turbo",
        models: [{ id: "v15-turbo", label: "v15-turbo（唯一可用模型）" }],
        modes: [
            { id: "prompt", label: "灵感提示词", hint: "标题 + 描述 + 可选演唱语言" },
            { id: "custom", label: "自定义歌词", hint: "标题 + 风格标签 + 歌词；可指定 BPM / 调式 / 拍号" }
        ]
    }
];
export const MUSIC_DEFAULT_ENGINE = "suno";
export const MUSIC_DEFAULT_MODEL = "chirp-v6";
export function isMusicEngine(value) {
    return typeof value === "string" && MUSIC_ENGINES.includes(value);
}
export function isMusicMode(value) {
    return typeof value === "string" && MUSIC_MODES.includes(value);
}
export function enginePresetOf(engine) {
    return MUSIC_ENGINE_PRESETS.find((entry) => entry.id === engine) ?? MUSIC_ENGINE_PRESETS[0];
}
export function defaultModelOf(engine) {
    return enginePresetOf(engine).defaultModel;
}
export function modelsOf(engine) {
    return enginePresetOf(engine).models;
}
export function modeAllowed(engine, mode) {
    return enginePresetOf(engine).modes.some((entry) => entry.id === mode);
}
/** 可用演唱语言（ACE-Step 的 vocal_language 枚举）。 */
export const MUSIC_VOCAL_LANGUAGES = [
    "zh",
    "en",
    "ja",
    "ko",
    "es",
    "fr",
    "de",
    "it",
    "pt",
    "ru",
    "ar",
    "hi",
    "th",
    "vi",
    "id",
    "bn"
];
/** ACE-Step 的调式枚举（与文档逐字一致）。 */
export const MUSIC_KEY_SCALES = [
    "C major",
    "G major",
    "D major",
    "A major",
    "E major",
    "B major",
    "F# major",
    "Db major",
    "Ab major",
    "Eb major",
    "Bb major",
    "F major",
    "A minor",
    "E minor",
    "B minor",
    "F# minor",
    "C# minor",
    "G# minor",
    "D# minor",
    "Bb minor",
    "F minor",
    "C minor",
    "G minor",
    "D minor"
];
export const MUSIC_TIME_SIGNATURES = ["4/4", "3/4", "2/4", "6/8", "5/4", "7/8"];
/** 标准分轨的轨道数。 */
export const MUSIC_STEM_COUNTS = [2, 4, 6];
/** 标准分轨可选的输出格式。 */
export const MUSIC_STEM_FORMATS = ["mp3", "wav", "flac", "ogg"];
/** 高级分轨可选的输出格式（midi 乐器忽略它）。 */
export const MUSIC_PRO_STEM_FORMATS = ["mp3", "wav"];
/** 音频转码的目标格式。 */
export const MUSIC_CONVERT_FORMATS = ["mp3", "wav", "m4a"];
/** 本地编辑可导出的格式。 */
export const MUSIC_EDIT_FORMATS = ["mp3", "wav", "m4a"];
/** MiniMax 的采样率 / 码率枚举（文档正文提到 48k/96k，但 enum 只到 44100 / 256000）。 */
export const MUSIC_SAMPLE_RATES = [16000, 24000, 32000, 44100];
export const MUSIC_BITRATES = [32000, 64000, 128000, 256000];
/** 本地编辑可选码率（kbps）。 */
export const MUSIC_EDIT_BITRATES = [128, 192, 256, 320];
/**
 * 各引擎的文本长度上限。超限时**明确报错**而不是静默截断 —— 截断会把
 * 用户写好的最后一段歌词悄悄丢掉，生成结果看着正常、内容却少了一截。
 */
export const MUSIC_LIMITS = {
    sunoPrompt: 500,
    sunoLyrics: 5000,
    sunoTags: 1000,
    murekaLyrics: 3000,
    murekaPrompt: 1024,
    murekaTags: 1024,
    minimaxPrompt: 2000,
    minimaxLyrics: 3000,
    title: 80
};
/** 生成工具（分轨 / MIDI / 乐谱 / 风格分析 / 转码）。 */
export const MUSIC_TOOL_KINDS = [
    "stems",
    "pro-stems",
    "midi",
    "sheet-music",
    "style-analysis",
    "convert"
];
export function isMusicToolKind(value) {
    return typeof value === "string" && MUSIC_TOOL_KINDS.includes(value);
}
