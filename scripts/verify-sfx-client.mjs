/**
 * 音效生成（模块八）· 浏览器半区契约自检（不需要浏览器、不联网）。
 *
 *   node scripts/verify-sfx-client.mjs
 *
 * 钉住：
 *   ① 静态契约：模块注册、深链接、设置页字段、远程方法清单、草稿合并；
 *   ② 真渲染：用假 React 把 SfxModule 渲染成元素树，断言新建卡 / 任务卡 /
 *      参考卡 / takes / 生成按钮 / 遮罩真的出现；
 *   ③ 点击「生成」真的调到 runSfxGeneration，而不是只改界面。
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
  setInterval: () => 0,
  clearInterval() {},
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
check("浏览器模块表有 sfx", /function make_MODULES\(\)[\s\S]*?key: "sfx", title: T\("音效生成"\)/.test(source));
check("OPEN_MODULES 放行 sfx", source.includes('new Set(["sprite", "image", "sequence", "rig", "tile", "map", "music", "sfx"])'));
check("深链接能解析 sfx", (() => {
  const intent = T.parseIntents("?dsh-gmm=1&module=sfx&job=f1234&stage=generate");
  return intent?.module === "sfx" && intent?.jobId === "f1234" && intent?.stage === "generate";
})());
check("设置页有音效分组与 Key 输入", source.includes("音效生成（火山引擎 Seed-Audio）") && source.includes('"data-testid": "cfg-sfx-key"') && source.includes("testSfx"));
check("设置页说明 Key 不是方舟 Key", /不是火山方舟的 ARK_API_KEY/.test(source));
check("新建卡 / 生成按钮 / 参考卡都有 data-testid", ["sfx-create", "sfx-create-submit", "sfx-generate", "sfx-refs", "sfx-takes"].every((id) => source.includes(`"data-testid": "${id}"`)));
check("远程方法都在客户端清单里", ["testSfx", "createSfxJob", "getSfxJob", "runSfxGeneration", "uploadSfxRef", "exportSfx"].every((method) => source.includes(`["${method}", true]`) || source.includes(`["${method}", false]`)));
check("模块导出到 __test", typeof T.SfxModule === "function");
check("轮询草稿用 mergeDrafts", /setPromptDraft\(\(current\) => mergeDrafts\(current, loadedDraft\.current\.prompt/.test(source));
check("生成前先保存提示词与参数", /await api\.saveSfxJob\(\{ jobId, prompt: promptDraft, settings: settingsDraft \}\);\s*\n\s*const result = await api\.runSfxGeneration/.test(source));

// ── 真渲染：新建卡 ──────────────────────────────────────────────────────
section("2) 真渲染：新建卡");
const config = {
  sfxBlocker: null,
  sfxApiKeySet: true,
  sfxBaseUrl: "https://openspeech.bytedance.com",
  sfxModel: "seed-audio-1.0",
  sfxFormat: "wav",
  sfxSampleRate: 24000,
  sfxFormats: [
    { id: "wav", label: "WAV（无损，游戏引擎常用）" },
    { id: "mp3", label: "MP3（体积小）" },
    { id: "ogg_opus", label: "Ogg Opus（体积更小）" }
  ],
  sfxSampleRates: [16000, 24000, 44100, 48000],
  sfxLimits: { promptChars: 2048, maxSeconds: 120 }
};
function renderSfx(slots, api) {
  HOOK.slots = slots;
  HOOK.cursor = 0;
  return T.SfxModule({ api: api ?? new Proxy({}, { get: () => async () => ({}) }) });
}
const createTree = renderSfx([
  0, null, config, [], null, null, null, false, true,
  { name: "", prompt: "", format: "wav", sampleRate: 24000 }, "auto", false, "", { format: "wav", sampleRate: 24000, speechRate: 0, loudnessRate: 0, pitchRate: 0, watermark: false }, false, false, null, null, false
]);
check("新建卡出现", byTestId(createTree, "sfx-create") !== undefined);
check("新建提交按钮出现", byTestId(createTree, "sfx-create-submit") !== undefined);
check("新建提示词框出现", byTestId(createTree, "sfx-create-prompt") !== undefined);
check("新建卡有审核模式", textOf(createTree).includes("审核模式"));

// ── 真渲染：任务视图 ────────────────────────────────────────────────────
section("3) 真渲染：任务视图");
const job = {
  module: "sfx",
  id: "f1",
  name: "测试音效",
  assetBase: "/dsh-game-material-master/sfx-assets/f1/",
  busy: false,
  status: "ready",
  reviewMode: "auto",
  blocker: null,
  prompt: "金属撞击，短促，约 1 秒",
  settings: { format: "wav", sampleRate: 24000, speechRate: 0, loudnessRate: 0, pitchRate: 0, watermark: false },
  refs: {
    image: { file: "refs/image.png", name: "角色.png", bytes: 72, ext: "png", url: "http://localhost/dsh-game-material-master/sfx-assets/f1/refs/image.png" },
    audios: [{ file: "refs/a.wav", name: "a.wav", bytes: 144, ext: "wav", duration: 3, url: "http://localhost/dsh-game-material-master/sfx-assets/f1/refs/a.wav" }]
  },
  takes: [{
    id: "k1",
    file: "takes/k1.wav",
    bytes: 144078,
    format: "wav",
    duration: 3,
    originalDuration: 3,
    prompt: "金属撞击，短促，约 1 秒",
    settings: { format: "wav", sampleRate: 24000 },
    createdAt: 1,
    url: "http://localhost/dsh-game-material-master/sfx-assets/f1/takes/k1.wav"
  }],
  stages: { generate: { status: "done", approved: false }, export: { status: "idle", approved: false } },
  exports: [],
  log: [{ at: 1, level: "info", message: "hello" }]
};
function jobSlots(overrides = {}) {
  return [
    0,
    null,
    config,
    [{ id: "f1", name: "测试音效", takes: 1, latestDuration: 3, busy: false }],
    "f1",
    job,
    null,
    false,
    false,
    { name: "", prompt: "", format: "wav", sampleRate: 24000 },
    "auto",
    false,
    job.prompt,
    { format: "wav", sampleRate: 24000, speechRate: 0, loudnessRate: 0, pitchRate: 0, watermark: false },
    false,
    false,
    null,
    null,
    false,
    ...(overrides.extra ?? [])
  ];
}
const jobTree = renderSfx(jobSlots());
check("任务卡出现", byTestId(jobTree, "sfx-job") !== undefined);
check("提示词框出现", byTestId(jobTree, "sfx-prompt") !== undefined);
check("生成按钮出现", byTestId(jobTree, "sfx-generate") !== undefined);
check("参考卡出现", byTestId(jobTree, "sfx-refs") !== undefined);
check("takes 卡出现", byTestId(jobTree, "sfx-takes") !== undefined);
check("audio 播放器出现", [...nodes(jobTree)].some((node) => node.type === "audio" && node.props?.controls === true));
check("参考图缩略图出现", [...nodes(jobTree)].some((node) => node.type === "img"));
check("参考音频列表出现", textOf(jobTree).includes("@音频1"));
check("通过按钮出现", [...nodes(jobTree)].some((node) => textOf(node) === "通过本条音效"));

// 生成中必须出现遮罩。
const busyTree = renderSfx(jobSlots().map((value, index) => (index === 5 ? { ...job, busy: true } : value)));
check("生成中显示遮罩", [...nodes(busyTree)].some((node) => node.type === T.LoadingOverlay && node.props?.show === true));

// ── 点击「生成」真的调到远程方法 ────────────────────────────────────────
section("4) 点击生成");
const calls = [];
const api = new Proxy({}, {
  get: (_target, name) => async (...args) => {
    calls.push([String(name), args]);
    if (name === "getConfig") return config;
    if (name === "listSfxJobs") return { jobs: [] };
    if (name === "saveSfxJob") return job;
    if (name === "runSfxGeneration") return { started: true };
    if (name === "getSfxJob") return job;
    if (name === "setSfxApproved") return job;
    if (name === "uploadSfxRef" || name === "removeSfxRef" || name === "exportSfx") return job;
    return {};
  }
});
const clickTree = renderSfx(jobSlots(), api);
const generateButton = byTestId(clickTree, "sfx-generate");
generateButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check("点击生成先 saveSfxJob", calls.some(([name]) => name === "saveSfxJob"));
check("点击生成调用 runSfxGeneration", calls.some(([name]) => name === "runSfxGeneration"));

// 生成中按钮禁用（Key 缺失 / 提示词为空时）。
const blockedTree = renderSfx(jobSlots().map((value, index) => (index === 2 ? { ...config, sfxBlocker: "还没配置 API Key" } : value)));
check("缺 Key 时生成按钮禁用", byTestId(blockedTree, "sfx-generate")?.props?.disabled === true);

console.log(`\n共 ${checks} 项检查，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.error(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
}
