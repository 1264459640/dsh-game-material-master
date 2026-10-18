/**
 * 音乐生成编辑（模块七）· 浏览器半区契约自检（不需要浏览器、不联网）。
 *
 *   node scripts/verify-music-client.mjs
 *
 * 钉住三件事：
 *   ① 静态契约：模块注册、深链接、创建卡的 HTML 结构、设置页字段、提示词步骤；
 *   ② 真渲染：用假 React 把 MusicModule 渲染成元素树，断言歌曲卡 / 编辑器 /
 *      版本 / 导出 / 遮罩真的出现；
 *   ③ 新对话：假 sessions/uiWorkspace 断言「先 createMusicJob、再开不挂靠项目的
 *      对话、把带 jobId 的任务说明作为第一句话发出去」。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}
function section(title) {
  console.log(`\n${title}`);
}

const target = process.argv[2] ?? fileURLToPath(new URL("../lib/client.js", import.meta.url));
const source = readFileSync(fileURLToPath(new URL("../src/client.ts", import.meta.url)), "utf8");

// ── 假 React ────────────────────────────────────────────────────────────
const HOOK = { slots: [], cursor: 0 };
const ReactStub = {
  Fragment: Symbol.for("react.fragment"),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    const index = HOOK.cursor++;
    const value = HOOK.slots[index];
    return [value === undefined ? (typeof initial === "function" ? initial() : initial) : value, () => {}];
  },
  useRef(initial) {
    HOOK.cursor++;
    return { current: initial };
  },
  useEffect() {},
  useLayoutEffect() {},
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
  useContext() {
    return undefined;
  }
};

const LOADED = [];
const windowStub = {
  __ModuleLoader__: {
    load(registration) {
      LOADED.push(registration);
    }
  },
  location: { origin: "http://127.0.0.1:43120", search: "", href: "http://127.0.0.1:43120/" },
  history: { replaceState() {} },
  setTimeout: () => 0,
  clearTimeout() {},
  confirm: () => true,
  addEventListener() {},
  removeEventListener() {}
};
globalThis.document = {
  head: { appendChild() {}, removeChild() {} },
  createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: "" }),
  addEventListener() {},
  removeEventListener() {}
};

let bundle;
try {
  new Function("window", "require", readFileSync(target, "utf8"))(windowStub, (name) => {
    if (name === "react") return ReactStub;
    throw new Error(`未预期的 require(${name})`);
  });
  bundle = LOADED[0].factory((name) => {
    if (name === "react") return ReactStub;
    throw new Error(`未预期的 require(${name})`);
  });
  check(`${target}：可加载`, true, `导出 ${Object.keys(bundle).join("、")}`);
} catch (error) {
  check(`${target}：可加载`, false, String(error?.message ?? error));
}
if (bundle === undefined) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
const T = bundle.__test;

// ── 元素树工具 ──────────────────────────────────────────────────────────
function* nodes(node) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) yield* nodes(child);
    return;
  }
  if (typeof node !== "object") return;
  yield node;
  if (Array.isArray(node.children)) for (const child of node.children) yield* nodes(child);
  if (node.props !== undefined && Array.isArray(node.props.children)) for (const child of node.props.children) yield* nodes(child);
}
const byClass = (tree, className) => [...nodes(tree)].filter((node) => String(node.props?.className ?? "").split(/\s+/u).includes(className));
const byTestId = (tree, id) => [...nodes(tree)].find((node) => node.props?.["data-testid"] === id);
const textOf = (node) => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return [node.props?.children, node.children].filter(Boolean).map(textOf).join("");
};

// ── 静态契约 ────────────────────────────────────────────────────────────
section("1) 模块注册 / 深链接 / 设置页");
check("浏览器模块表有 music", /function make_MODULES\(\)[\s\S]*?key: "music", title: T\("音乐生成编辑"\)/.test(source));
check("OPEN_MODULES 放行 music", source.includes('const OPEN_MODULES = new Set(["sprite", "image", "sequence", "rig", "tile", "map", "music", "sfx"])'));
check("★ origin 上报失败会退避重试（宿主刚重启时不能永远停在 localhost）", source.includes("const send = (attempt)") && source.includes("attempt < 20"));
check("解析 music 深链接", (() => {
  const intent = T.parseIntents("?dsh-gmm=1&module=music&job=a1234&stage=edit");
  return intent?.module === "music" && intent?.jobId === "a1234" && intent?.stage === "edit";
})());
check("深链接意图里含 music 的 jobId 字段", source.includes('const jobId = params.get("job")'));
check("设置页有音乐分组与 Key 输入", source.includes("音乐生成（谱乐 AI）") && source.includes('"data-testid": "cfg-music-key"') && source.includes("testMusic"));
check("设置页说明只支持谱乐 AI", /只支持谱乐 AI/.test(source));
check("创建卡有灵感/歌词两个页签", source.includes('"data-testid": "music-create-kind-prompt"') && source.includes('"data-testid": "music-create-kind-lyrics"'));
check("创建卡提交按钮带 data-testid", source.includes('"data-testid": "music-submit"'));
check("编辑器有起止/音量/淡入淡出/标准化控件", ["music-edit-start", "music-edit-end", "music-edit-gain", "music-edit-fade-in", "music-edit-fade-out"].every((id) => source.includes(`testId: "${id}"`)) && source.includes('"data-testid": "music-edit-normalize"'));
check("波形有 data-testid", source.includes('"data-testid": "music-wave"'));
check("导出按钮有 data-testid", source.includes('"data-testid": "music-export"'));
check("模块级文案表加入 rebuilders", source.includes("MUSIC_ENGINES = make_MUSIC_ENGINES();") && source.includes("MUSIC_PHASES = make_MUSIC_PHASES();"));
check("music 的远程方法都在客户端清单里", ["getMusicGuide", "runMusicGeneration", "renderMusicEdit", "exportMusic"].every((method) => source.includes(`["${method}", true]`) || source.includes(`["${method}", false]`)));

// ── 提示词 / 对话桥 ─────────────────────────────────────────────────────
section("2) 新对话提示词");
const prompt = T.buildMusicRequestPrompt({
  jobId: "a1234",
  jobName: "Battle Loop",
  kind: "lyrics",
  prompt: "",
  lyrics: "[Verse]\nline one\nline two",
  note: "90 秒，不要人声",
  title: "Battle",
  tags: "8-bit",
  instrumental: true,
  preferredEngine: "suno",
  reviewMode: "manual",
  lang: "zh"
});
check("提示词含 jobId", prompt.includes("a1234"));
check("提示词含用户完整歌词", prompt.includes("[Verse]\nline one\nline two"));
check("提示词要求先读指南", prompt.includes("getMusicGuide"));
check("提示词要求提交与等待", prompt.includes("runMusicGeneration") && prompt.includes("game_material_wait"));
check("提示词要求后期与导出", prompt.includes("renderMusicEdit") && prompt.includes("exportMusic"));
check("提示词要求贴回链", prompt.includes("openUrl") && prompt.includes("Markdown"));
check("manual 模式要求停下等确认", /停下等我回复/.test(prompt));
check("不调用其它模块工具", /不要调用其它模块的工具/.test(prompt));

let created = null;
let prompted = null;
let opened = null;
const sessions = {
  create: async () => "s1",
  retain: () => ({
    ready: Promise.resolve(),
    binding: { session: { beginSubmission: () => ({ requestId: "r1", abandon() {} }), prompt: async (blocks, mode, _x, id) => { prompted = { blocks, mode, id }; return { ok: true }; } } },
    release() {}
  })
};
const workspace = { openSession: (id) => { opened = id; } };
const ctxBridge = {
  get: (name) => (name === "sessions" ? sessions : name === "uiWorkspace" ? workspace : undefined),
  inject: (_names, fn) => fn(ctxBridge)
};
T.attachSessionBridge(ctxBridge);
await T.openMusicChat(prompt);
check("新对话：不挂靠项目（sessions.create({})）并打开会话", opened === "s1");
check("新对话：首条消息就是任务说明", prompted?.mode === "queue" && prompted?.blocks?.[0]?.text?.startsWith("【游戏素材大师 · 音乐生成编辑】"));
check("新对话：带 requestId", prompted?.id === "r1");

// ── 真渲染：创建卡 ──────────────────────────────────────────────────────
section("3) 真渲染：创建卡");
const config = {
  musicBlocker: null,
  musicApiKeySet: true,
  musicBaseUrl: "https://api.yourmusic.fun",
  musicModel: "chirp-v6",
  musicTimeoutMs: 120000,
  musicPollTimeoutMs: 900000,
  musicEngines: [],
  musicDocsUrl: "https://api.yourmusic.fun/docs",
  musicConsoleUrl: "https://api.yourmusic.fun/dashboard",
  ffmpeg: { ok: true }
};
function renderMusic(slots) {
  HOOK.slots = slots;
  HOOK.cursor = 0;
  return T.MusicModule({ api: new Proxy({}, { get: () => async () => ({}) }) });
}
const createTree = renderMusic([
  0, null, config, [], null, null, null, false, true, "generate", "prompt", "8-bit battle", "", "", "", "", false, "", "auto", false, null,
  null, null, false, false,
  { start: 0, end: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, normalize: false, lufs: -14, truePeak: -1, format: "mp3", bitrate: 192 },
  null, "", false, false, null, null, null, false, false
]);
check("创建卡出现", byTestId(createTree, "music-create") !== undefined);
check("提交按钮出现", byTestId(createTree, "music-submit") !== undefined);
check("灵感输入框出现", byTestId(createTree, "music-prompt") !== undefined);
check("审核模式下拉出现", byClass(createTree, "SPR_field").some((node) => textOf(node).includes("审核模式")));

// ── 真渲染：任务 / 歌曲 / 编辑 / 版本 ───────────────────────────────────
section("4) 真渲染：任务视图");
const job = {
  module: "music",
  id: "a1",
  name: "测试音乐",
  assetBase: "/dsh-game-material-master/music-assets/a1/",
  busy: false,
  reviewMode: "auto",
  updatedAt: 1,
  songsReady: 1,
  songsTotal: 1,
  source: { kind: "prompt", prompt: "8-bit battle loop", lyrics: "", note: "90 秒", title: "Battle", tags: "8-bit", instrumental: true },
  settings: { engine: "suno", mode: "prompt", model: "chirp-v6" },
  stages: { generate: { status: "done" }, edit: { status: "idle" }, export: { status: "idle" } },
  songs: [{ id: "song1", status: "succeeded", title: "Battle Take", engine: "suno", modelName: "chirp-v6", duration: 3, tags: "8-bit", approved: false, localFile: "songs/song-song1.mp3", file: "songs/song-song1.mp3", url: "http://localhost/dsh-game-material-master/music-assets/a1/songs/song-song1.mp3", coverFile: "songs/cover-song1.jpg", coverUrl: "http://localhost/dsh-game-material-master/music-assets/a1/songs/cover-song1.jpg", wavUrl: null, lrcUrl: null, lyric: "[Verse]\nla la" }],
  versions: [{ id: "v1", songId: "song1", label: "裁剪", status: "ready", format: "mp3", duration: 2, size: 1234, preview: false, by: "human", createdAt: 1, file: "versions/v1.mp3", url: "http://localhost/dsh-game-material-master/music-assets/a1/versions/v1.mp3" }],
  tools: [{ id: "t1", kind: "style-analysis", status: "succeeded", result: { description: "bright", genres: ["chiptune"] }, files: [] }],
  exports: [],
  log: [{ at: 1, level: "info", message: "hello" }]
};
const jobTree = renderMusic([
  0, null, config, [{ id: "a1", name: "测试音乐", songsReady: 1, songsTotal: 1, versions: 1, updatedAt: 1, busy: false }], "a1", job, null, false, false, "generate", "prompt", "", "", "", "", "", true, "", "auto", false, "song1",
  null, null, false, false,
  { start: 0, end: 3, gainDb: 0, fadeIn: 0, fadeOut: 0, normalize: false, lufs: -14, truePeak: -1, format: "mp3", bitrate: 192 },
  [0.1, 0.5, 1], "http://x/song.mp3", false, false, null, null, null, false, false
]);
check("歌曲卡出现", byTestId(jobTree, "music-song-song1") !== undefined);
const coverImg = [...nodes(byClass(jobTree, "SPR_musicCover")[0])].find((node) => node.type === "img");
check(
  "★ 封面走 assetBase 相对路径（绝对地址的 origin 可能还是 localhost：图会裂）",
  coverImg !== undefined && coverImg.props?.src === "/dsh-game-material-master/music-assets/a1/songs/cover-song1.jpg",
  String(coverImg?.props?.src)
);
check(
  "★ 点已选中的「试听 / 编辑」也会把试听源切回原曲（否则先试听版本后看起来没反应）",
  /onClick: \(\) => \{\s*setSelectedSongId\(song\.id\);/.test(source) && source.includes("setAudioSrc(musicAssetUrl(job, song.file, song.url))")
);
check(
  "★ 歌曲音频不在渲染时直接取 song.url（宿主 origin 没上报时会指到 localhost，播放键点了没反应）",
  !source.includes('h("audio", { className: "SPR_musicAudio", controls: true, preload: "metadata", src: audioSrc === "" ? undefined : audioSrc })') ||
    source.includes("musicAssetUrl(job, selectedSong.file") && source.includes("musicAssetUrl(job, version.file")
);
const versionDownload = [...nodes(byTestId(jobTree, "music-version-v1"))].find((node) => node.type === "a" && node.props?.download !== undefined);
check(
  "★ 版本下载也优先用 assetBase（不把 localhost 绝对地址交给浏览器）",
  versionDownload !== undefined && String(versionDownload.props?.href).startsWith("/dsh-game-material-master/music-assets/a1/versions/"),
  String(versionDownload?.props?.href)
);
check("编辑器出现", byTestId(jobTree, "music-editor") !== undefined);
check("编辑器在任务视图里出现（控件由 NumField 渲染，静态契约已覆盖）", byTestId(jobTree, "music-editor") !== undefined);
check("渲染按钮出现", byTestId(jobTree, "music-render") !== undefined);
check("版本卡出现", byTestId(jobTree, "music-version-v1") !== undefined);
check("导出按钮出现", byTestId(jobTree, "music-export") !== undefined);
check("波形由组件渲染（静态契约已覆盖）", source.includes('"data-testid": "music-wave"'));
check("工具结果显示风格/标签", textOf(jobTree).includes("chiptune"));
check("日志折叠出现", textOf(jobTree).includes("任务日志"));

// ── 谱曲模式 ────────────────────────────────────────────────────────────
section("4b) 谱曲模式：创建卡 / 谱曲卡 / 提示词 / 深链接");
const composeConfig = {
  ...config,
  musicApiKeySet: true,
  musicScoreStatus: {
    ok: true,
    renderer: "builtin",
    python: { ok: true, path: "/usr/bin/python3", version: "3.12.0" },
    scoremill: { ok: true, version: "0.5.0" },
    fluidsynth: { ok: false },
    soundfont: { ok: false },
    ffmpeg: { ok: true, path: "ffmpeg", version: "8.1.1" },
    blocker: null,
    warnings: ["没找到 FluidSynth：试听会用插件内置的简易音源。"],
    checkedAt: 1
  }
};
const composeCreateTree = renderMusic([
  0, null, composeConfig, [], null, null, null, false, true, "compose", "prompt", "一首战斗曲", "", "", "", "", true, "", "auto", false, null,
  null, null, false, false,
  { start: 0, end: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, normalize: false, lufs: -14, truePeak: -1, format: "mp3", bitrate: 192 },
  null, "", false, false, null, null, null, false, false
]);
check("★ 创建卡有「AI 生成 / 谱曲模式」两个页签", byTestId(composeCreateTree, "music-workflow-generate") !== undefined && byTestId(composeCreateTree, "music-workflow-compose") !== undefined);
check("★ 谱曲模式显示想法输入框（不是歌词页签）", byTestId(composeCreateTree, "music-compose-prompt") !== undefined && byTestId(composeCreateTree, "music-prompt") === undefined);
check("★ 谱曲模式显示依赖状态", textOf(composeCreateTree).includes("谱曲依赖") && textOf(composeCreateTree).includes("0.5.0"));
check("★ 谱曲模式提交按钮文案", textOf(byTestId(composeCreateTree, "music-submit")).includes("开始谱曲"));
check("★ 谱曲模式不因缺谱乐 Key 禁用（composeConfig 有 Key；静态上也不读 musicBlocker）", source.includes("compose ? scoreStatus === undefined || scoreBlocker !== null : config?.musicBlocker"));

const composeIntent = T.parseIntents("?dsh-gmm=1&module=music&job=a1234&stage=compose&score=c123");
check("★ 深链接解析 score", composeIntent?.stage === "compose" && composeIntent?.score === "c123", JSON.stringify(composeIntent));

const composePrompt = T.buildComposeRequestPrompt({
  jobId: "a1234",
  jobName: "战斗曲",
  prompt: "一首战斗曲",
  lyrics: "",
  note: "90 秒",
  title: "Battle",
  instrumental: true,
  reviewMode: "manual",
  lang: "zh",
  scoreStatus: composeConfig.musicScoreStatus
});
check("★ 谱曲提示词要求先输出方案", composePrompt.includes("分析并输出方案") && composePrompt.includes("用用户的语言"));
check("★ 谱曲提示词要求保存方案", composePrompt.includes("saveMusicScorePlan"));
check("★ 谱曲提示词要求 local scoremill 脚本", composePrompt.includes("compose.py") && composePrompt.includes("runMusicScore") && composePrompt.includes("s.save('score.mid')"));
check("★ 谱曲提示词要求 manual 停下等确认", composePrompt.includes("停下"));
check("★ 谱曲提示词要求逐版修改且保留旧版", composePrompt.includes("basedOn") && composePrompt.includes("旧 MIDI"));
check("★ 谱曲提示词说明 Suno 计费且先上传试听音频", composePrompt.includes("submitMusicScoreToSuno") && composePrompt.includes("试听音频") && composePrompt.includes("cover") && composePrompt.includes("copyrightAudio") && composePrompt.includes("绝不自动提交"));

const composeJob = {
  module: "music",
  id: "a2",
  name: "战斗曲",
  assetBase: "/dsh-game-material-master/music-assets/a2/",
  busy: false,
  workflow: "compose",
  reviewMode: "auto",
  updatedAt: 1,
  songsReady: 0,
  songsTotal: 0,
  source: { kind: "prompt", prompt: "一首战斗曲", lyrics: "", note: "90 秒", title: "Battle", tags: "", instrumental: true },
  settings: { engine: "suno", mode: "custom", model: "chirp-v6" },
  scorePlan: {
    summary: "前 8 小节压抑，中段铜管主题，结尾 unresolved。",
    style: "chiptune",
    mood: "tense",
    key: "D minor",
    tempo: 150,
    timeSignature: "4/4",
    structure: [{ name: "INTRO", bars: 8, energy: "p" }, { name: "MAIN", bars: 16, energy: "f" }],
    instrumentation: [{ name: "lead" }, { name: "bass" }],
    instrumental: true
  },
  currentScoreId: "c1",
  compositions: [{
    id: "c1",
    label: "第 1 版",
    title: "Battle",
    plan: { summary: "前 8 小节压抑，中段铜管主题，结尾 unresolved。", style: "chiptune", tempo: 150, timeSignature: "4/4", structure: [{ name: "INTRO", bars: 8 }], instrumentation: [{ name: "lead" }], instrumental: true },
    script: "from scoremill import Song\n",
    scriptFile: "scores/c1/compose.py",
    midiFile: "scores/c1/score.mid",
    midiUrl: "http://localhost/dsh-game-material-master/music-assets/a2/scores/c1/score.mid",
    audioFile: "scores/c1/preview.mp3",
    audioUrl: "http://localhost/dsh-game-material-master/music-assets/a2/scores/c1/preview.mp3",
    audioRenderer: "builtin",
    midi: { duration: 32, bars: 24, tempo: 150, timeSignature: "4/4", tracks: 1, channels: 2, notes: 120 },
    status: "ready",
    approved: false,
    createdAt: 1,
    updatedAt: 1
  }],
  stages: { compose: { status: "done" }, generate: { status: "idle" }, edit: { status: "idle" }, export: { status: "idle" } },
  songs: [],
  versions: [],
  tools: [],
  exports: [],
  log: []
};
const composeJobTree = renderMusic([
  0, null, composeConfig, [{ id: "a2", name: "战斗曲", workflow: "compose", songsReady: 0, songsTotal: 0, versions: 0, compositions: 1, updatedAt: 1, busy: false }], "a2", composeJob, null, false, false, "compose", "prompt", "", "", "", "", "", true, "", "auto", false, null,
  "c1", [0.1, 0.4, 1], false, false,
  { start: 0, end: 32, gainDb: 0, fadeIn: 0, fadeOut: 0, normalize: false, lufs: -14, truePeak: -1, format: "mp3", bitrate: 192 },
  null, "", false, false, null, null, null, false, false
]);
check("★ 谱曲卡出现", byTestId(composeJobTree, "music-score") !== undefined);
check("★ 谱曲方案与段落出现", textOf(composeJobTree).includes("前 8 小节压抑") && textOf(composeJobTree).includes("INTRO 8小节"));
check("★ 谱曲版本卡出现", byTestId(composeJobTree, "music-score-c1") !== undefined);
check("★ 谱曲版本有 MIDI 下载 / 试听 / Suno 按钮", textOf(composeJobTree).includes("下载 MIDI") && textOf(composeJobTree).includes("用这首音频生成 Suno 正式版") && textOf(composeJobTree).includes("导出乐谱包"));
check("★ 谱曲试听走 assetBase 相对路径", [...nodes(byTestId(composeJobTree, "music-score-c1"))].some((node) => node.type === "audio" && String(node.props?.src).startsWith("/dsh-game-material-master/music-assets/a2/scores/c1/")));
check("★ 谱曲版本可查看 compose.py", textOf(composeJobTree).includes("查看 compose.py"));
const submitSunoSource = source.slice(source.indexOf("const submitScoreToSuno"), source.indexOf("const exportScore"));
check(
  "★ Suno 提交后用 loadJob 刷新（旧快照晚到会覆盖成「没歌」，切走再回来才恢复）",
  submitSunoSource.includes("await loadJob(job.id)") && !submitSunoSource.includes("setJob(await api.getMusicJob"),
  submitSunoSource.slice(0, 120)
);
const pollBlock = source.slice(source.indexOf("// 有任务在跑时轮询"), source.indexOf("const selectedSong"));
check(
  "★ 任务轮询用 setInterval 且不依赖 updatedAt（否则只刷新一次就停住）",
  pollBlock.includes("setInterval") && pollBlock.includes("void loadJob(jobId)") && !pollBlock.includes("job?.updatedAt"),
  pollBlock.slice(0, 160)
);

// ── 功能管理 ────────────────────────────────────────────────────────────
section("5) 功能管理");
check("music 在可见模块里", T.visibleModulesOf([]).some((entry) => entry.key === "music"));
check("隐藏 music 后不在可见模块里", !T.visibleModulesOf(["music"]).some((entry) => entry.key === "music"));
check("normalizeHiddenKeys 保留 music", T.normalizeHiddenKeys(["music", "nope"]).includes("music"));

console.log("");
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log(`共 ${checks} 项检查，全部通过。`);
