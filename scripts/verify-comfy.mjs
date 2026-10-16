#!/usr/bin/env node
/**
 * 本地 ComfyUI 后端契约自检 —— 只连本机回环地址上的 mock 服务，不联网、不花钱，也不需要真的装 ComfyUI。
 *
 * 检查的是「用户自己那份工作流能不能被正确注入 / 提交 / 追踪」这件事本身：
 *   1. 地址归一化与「节点ID.输入名」的解析；
 *   2. 工作流解析：API 格式直通、ComfyUI 界面格式（官方示例工作流那种）自动转换、拒绝缺 class_type 的节点；
 *   3. 注入点探测：内置模板 / 只写 required 的工作流 / 需要按 /object_info 补 optional IMAGE 的工作流；
 *   4. 注入：字面量写入、连线跳过、首帧插入 LoadImage、first_frame_reference 开关、纯函数不改原对象；
 *   5. HTTP 层：/system_stats、/queue、/object_info、/upload/image、/prompt、/history 的每个分支，
 *      以及「哪个输出文件算视频」的打分（只有 png 时必须判失败，不能把预览图当视频下载）。
 *
 * 用法：node scripts/verify-comfy.mjs
 */
import { createServer } from "node:http";
import {
  ComfyError,
  DEFAULT_COMFY_WORKFLOW_TEXT,
  applyComfyInputs,
  comfyViewUrl,
  decodeDataUri,
  detectComfyBindings,
  fetchComfyObjectInfo,
  formatBinding,
  normalizeComfyBaseUrl,
  normalizeComfyCookies,
  parseBinding,
  parseComfyWorkflow,
  prepareComfyWorkflow,
  queryComfyVideo,
  submitComfyVideo,
  testComfy,
  uploadComfyImage
} from "../lib/comfy.js";

let passed = 0;
const failures = [];
function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log("  ✓ " + label + (detail ? " — " + detail : ""));
  } else {
    failures.push(label + (detail ? " — " + detail : ""));
    console.log("  ✗ " + label + (detail ? " — " + detail : ""));
  }
}
function section(title) {
  console.log("");
  console.log(title);
}

/* ---------------------------------------------------------------- mock ComfyUI */

/** 真实 /object_info 的形状：input 包了一层（required / optional），输出在 output。 */
const OBJECT_INFO = {
  FreeVideoGenerate: {
    input: {
      required: { text: ["STRING", { default: "" }], width: ["INT", { default: 512 }], height: ["INT", {}], seconds: ["FLOAT", {}], seed: ["INT", {}] },
      optional: { first: ["IMAGE", {}], last: ["IMAGE", {}], first_frame_reference: ["BOOLEAN", {}] }
    },
    output: ["VIDEO", "STRING"],
    name: "FreeVideoGenerate"
  },
  FreeVideoMedia: {
    input: { required: { assets: ["STRING", { default: "[]" }] }, optional: { first: ["IMAGE", {}], reference: ["IMAGE", {}] } },
    output: ["FREEVIDEO_MEDIA"],
    name: "FreeVideoMedia"
  },
  LoadImage: { input: { required: { image: [["a.png"], {}] } }, output: ["IMAGE", "MASK"], name: "LoadImage" },
  /** 第三方实现可能省掉 input 这层，两个写法都得读得到。 */
  FlatNode: { required: { image: ["IMAGE", {}] }, optional: { first: ["IMAGE", {}] } }
};

const state = {
  running: [],
  pending: [],
  history: {},
  uploads: [],
  submits: [],
  cookies: []
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  // 每个请求都把 Cookie 头记下来：藏鉴权反代后面时，漏掉任何一个请求都会 401。
  state.cookies.push({ path, cookie: req.headers.cookie ?? "" });
  const send = (payload, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "GET" && path === "/system_stats") {
    return send({ system: { comfyui_version: "0.40.0" }, devices: [{ name: "Mock GPU (8GB)" }] });
  }
  if (req.method === "GET" && path === "/queue") {
    return send({ queue_running: state.running, queue_pending: state.pending });
  }
  if (req.method === "GET" && path.startsWith("/history/")) {
    const id = decodeURIComponent(path.slice("/history/".length));
    if (id === "bad") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("ComfyUI 内部错误");
      return;
    }
    const entry = state.history[id];
    return send(entry === undefined ? {} : { [id]: entry });
  }
  if (req.method === "GET" && path.startsWith("/object_info/")) {
    const classType = decodeURIComponent(path.slice("/object_info/".length));
    return send(OBJECT_INFO[classType] === undefined ? {} : { [classType]: OBJECT_INFO[classType] });
  }
  if (req.method === "POST" && path === "/upload/image") {
    const body = (await readBody(req)).toString("binary");
    state.uploads.push(body);
    const match = /filename="([^"]*)"/.exec(body);
    return send({ name: match === null ? "" : match[1], subfolder: "", type: "input" });
  }
  if (req.method === "POST" && path === "/prompt") {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    state.submits.push(body);
    const node = body && body.prompt ? body.prompt["1"] : undefined;
    const text = node && node.inputs ? node.inputs.text : undefined;
    if (text === "FAIL") {
      return send({ error: { type: "prompt_outputs_failed_validation" }, node_errors: { "1": { errors: [{ type: "value_not_in_list", message: "bad" }] } } });
    }
    if (text === "ERR") return send({ error: { type: "prompt_outputs_failed_validation" } });
    return send({ prompt_id: "mock-pid", node_errors: {} });
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = "http://127.0.0.1:" + server.address().port;
const client = { baseUrl: BASE, timeoutMs: 8000 };

/* ---------------------------------------------------------------- 夹具 */

const builtIn = parseComfyWorkflow(DEFAULT_COMFY_WORKFLOW_TEXT);
/** 用户手上常见的形状：只有 required 输入、没有 LoadImage。 */
const freeVideo = {
  "1": { class_type: "FreeVideoGenerate", inputs: { text: "一只猫", width: 512, height: 512, seconds: 4, seed: 11, first_frame_reference: false, media: ["2", 0] } },
  "2": { class_type: "FreeVideoMedia", inputs: { assets: "[]" } }
};
/** 两个 LoadImage：首帧用第一个，尾帧用第二个，谁都不能顶掉谁。 */
const twoLoadImage = {
  "1": { class_type: "FreeVideoGenerate", inputs: { text: "x" } },
  "2": { class_type: "LoadImage", inputs: { image: "a.png" } },
  "3": { class_type: "LoadImage", inputs: { image: "b.png" } }
};

function resetQueue() {
  state.running = [];
  state.pending = [];
  state.history = {};
}

/* ---------------------------------------------------------------- 1. 地址与绑定文本 */

section("1. 地址归一化与「节点ID.输入名」");
check("空地址回落到 127.0.0.1:8188", normalizeComfyBaseUrl("") === "http://127.0.0.1:8188", normalizeComfyBaseUrl(""));
check("去掉结尾斜杠", normalizeComfyBaseUrl("http://127.0.0.1:8188/") === "http://127.0.0.1:8188");
check("去掉全部结尾斜杠并 trim", normalizeComfyBaseUrl("  http://host:9000///  ") === "http://host:9000", normalizeComfyBaseUrl("  http://host:9000///  "));
check("undefined 也回落到默认", normalizeComfyBaseUrl(undefined) === "http://127.0.0.1:8188");
const b1 = parseBinding("1.text");
check("解析 1.text", b1 !== undefined && b1.node === "1" && b1.input === "text", formatBinding(b1));
const b2 = parseBinding(" 12.first_frame ");
check("解析带空格的 12.first_frame", b2 !== undefined && b2.node === "12" && b2.input === "first_frame", formatBinding(b2));
const b3 = parseBinding("node.with.dots.image");
check("节点 id 里带点：按最后一个点切", b3 !== undefined && b3.node === "node.with.dots" && b3.input === "image", formatBinding(b3));
check("空串解析成 undefined", parseBinding("") === undefined);
check("undefined 解析成 undefined", parseBinding(undefined) === undefined);
check("没有点的写法解析成 undefined", parseBinding("abc") === undefined);
check("结尾是点的写法解析成 undefined", parseBinding("1.") === undefined);
check("undefined 绑定格式化成空串", formatBinding(undefined) === "");

/* ---------------------------------------------------------------- 2. 工作流解析 */

section("2. 工作流解析");
check("内置模板能解析", builtIn.ok === true && builtIn.nodes === 3, builtIn.ok === true ? builtIn.nodes + " 个节点" : builtIn.error);
const emptyParse = parseComfyWorkflow("   ");
check("空工作流报错", emptyParse.ok === false && emptyParse.error.includes("空的"), emptyParse.ok === false ? emptyParse.error : "");
const badJson = parseComfyWorkflow("{ not json");
check("非法 JSON 报错", badJson.ok === false && badJson.error.includes("不是合法 JSON"), badJson.ok === false ? badJson.error.slice(0, 40) : "");
// 界面格式（ComfyUI 直接导出的 json）——官方示例 FreeVideo-All-in-One.json 就是这个形状，
// 它把首帧接在 FreeVideoGenerate.first，这里照抄一份缩过的夹具。
const UI_FORMAT_FIXTURE = {
  id: "fixture",
  revision: 0,
  last_node_id: 2,
  last_link_id: 1,
  nodes: [
    {
      id: 1,
      type: "FreeVideoGenerate",
      mode: 0,
      title: "FreeVideo · Generate & Preview",
      inputs: [
        { name: "text", type: "STRING", widget: { name: "text" } },
        { name: "width", type: "INT", widget: { name: "width" } },
        { name: "height", type: "INT", widget: { name: "height" } },
        { name: "seconds", type: "FLOAT", widget: { name: "seconds" } },
        { name: "seed", type: "INT", widget: { name: "seed" } },
        { name: "first", type: "IMAGE", link: null },
        { name: "media", type: "FREEVIDEO_MEDIA", link: 1 }
      ],
      widgets_values: ["一只猫在散步", 1344, 768, 10, 2026090903, "randomize"]
    },
    {
      id: 2,
      type: "FreeVideoMedia",
      mode: 0,
      inputs: [
        { name: "assets", type: "STRING", widget: { name: "assets" } },
        { name: "first", type: "IMAGE", link: null }
      ],
      widgets_values: ["[]"]
    }
  ],
  links: [[1, 2, 0, 1, 6, "FREEVIDEO_MEDIA"]],
  groups: []
};
const uiParsed = parseComfyWorkflow(JSON.stringify(UI_FORMAT_FIXTURE));
check("界面格式：自动转成 API 格式", uiParsed.ok === true && uiParsed.converted === true && uiParsed.nodes === 2, uiParsed.ok === true ? "nodes=" + uiParsed.nodes : uiParsed.error);
check("界面格式：控件值按 widgets_values 顺序取", uiParsed.ok === true && uiParsed.workflow["1"].inputs.text === "一只猫在散步" && uiParsed.workflow["1"].inputs.width === 1344 && uiParsed.workflow["1"].inputs.seconds === 10);
check("界面格式：seed 后面的 randomize 是控件不是输入", uiParsed.ok === true && uiParsed.workflow["1"].inputs.seed === 2026090903 && !Object.values(uiParsed.workflow["1"].inputs).includes("randomize"));
check("界面格式：连线写成 [来源节点, 槽位]", uiParsed.ok === true && Array.isArray(uiParsed.workflow["1"].inputs.media) && uiParsed.workflow["1"].inputs.media[0] === "2" && uiParsed.workflow["1"].inputs.media[1] === 0);
check("界面格式：没连的 first 不进 inputs（留给探测按节点定义补）", uiParsed.ok === true && uiParsed.workflow["1"].inputs.first === undefined);
check("界面格式：节点标题进 _meta", uiParsed.ok === true && uiParsed.workflow["1"]._meta.title === "FreeVideo · Generate & Preview");
check("界面格式：便签与静音 / 旁路节点被丢掉", (() => {
  const p = parseComfyWorkflow(JSON.stringify({ nodes: [{ id: 1, type: "Note", widgets_values: ["x"] }, { id: 2, type: "KSampler", mode: 4, inputs: [], widgets_values: [] }, { id: 3, type: "KSampler", mode: 0, inputs: [], widgets_values: [] }], links: [] }));
  return p.ok === true && p.nodes === 1 && p.workflow["3"] !== undefined;
})());
check("界面格式：只剩便签时转换失败", (() => {
  const p = parseComfyWorkflow(JSON.stringify({ nodes: [{ id: 1, type: "Note" }], links: [] }));
  return p.ok === false && p.error.includes("转换失败");
})());
check("界面格式：老版导出丢控件值时报个数", (() => {
  const p = parseComfyWorkflow(JSON.stringify({ nodes: [{ id: 1, type: "CheckpointLoaderSimple", inputs: [], widgets_values: ["sd.safetensors"] }], links: [] }));
  return p.ok === true && p.droppedWidgets === 1;
})());
check("界面格式：新版 links 对象也认", (() => {
  const p = parseComfyWorkflow(JSON.stringify({ nodes: [{ id: 1, type: "A", inputs: [{ name: "x", link: 3 }], widgets_values: [] }, { id: 2, type: "B", inputs: [{ name: "y", widget: { name: "y" } }], widgets_values: [42] }], links: [{ id: 3, origin_id: 2, origin_slot: 1, target_id: 1, target_slot: 0, type: "X" }] }));
  return p.ok === true && Array.isArray(p.workflow["1"].inputs.x) && p.workflow["1"].inputs.x[0] === "2" && p.workflow["1"].inputs.x[1] === 1 && p.workflow["2"].inputs.y === 42;
})());
check("界面格式：转换后按节点定义补出 1.first / 1.last", (() => {
  if (uiParsed.ok !== true) return false;
  const d = detectComfyBindings(uiParsed.workflow, {}, OBJECT_INFO);
  return formatBinding(d.bindings.first) === "1.first" && formatBinding(d.bindings.last) === "1.last" && formatBinding(d.bindings.prompt) === "1.text";
})());
const uiSingleLoadImage = parseComfyWorkflow(JSON.stringify({ last_node_id: 3, nodes: [{ id: 1, type: "LoadImage" }], links: [] }));
check("界面格式：只有一个 LoadImage 也能转", uiSingleLoadImage.ok === true && uiSingleLoadImage.converted === true && uiSingleLoadImage.nodes === 1, uiSingleLoadImage.ok === true ? "" : uiSingleLoadImage.error);
const arrayTop = parseComfyWorkflow("[]");
check("顶层是数组时报错", arrayTop.ok === false, arrayTop.ok === false ? arrayTop.error : "");
const noNodes = parseComfyWorkflow("{}");
check("没有节点时报错", noNodes.ok === false, noNodes.ok === false ? noNodes.error : "");
const noClass = parseComfyWorkflow(JSON.stringify({ "1": { inputs: { text: "x" } } }));
check("节点缺 class_type 时报错", noClass.ok === false && noClass.error.includes("class_type"), noClass.ok === false ? noClass.error : "");
const blankClass = parseComfyWorkflow(JSON.stringify({ "1": { class_type: "  ", inputs: {} } }));
check("class_type 是空白也算缺少", blankClass.ok === false);

/* ---------------------------------------------------------------- 3. 注入点探测 */

section("3. 注入点探测");
const builtInDetect = detectComfyBindings(builtIn.workflow);
check("内置模板：提示词 = 1.text", formatBinding(builtInDetect.bindings.prompt) === "1.text", formatBinding(builtInDetect.bindings.prompt));
check("内置模板：尺寸/时长/种子都在 1 上", formatBinding(builtInDetect.bindings.width) === "1.width" && formatBinding(builtInDetect.bindings.height) === "1.height" && formatBinding(builtInDetect.bindings.seconds) === "1.seconds" && formatBinding(builtInDetect.bindings.seed) === "1.seed");
check("内置模板：首帧走自带 LoadImage 的 image", formatBinding(builtInDetect.bindings.first) === "3.image", formatBinding(builtInDetect.bindings.first));
check("内置模板：记下了 LoadImage 的 id", builtInDetect.bindings.loadImage === "3");
check("内置模板：有且只有一条「已有 LoadImage」提示", builtInDetect.notes.length === 1 && builtInDetect.notes[0].includes("已有 LoadImage 节点"), builtInDetect.notes.join(" | "));
check("内置模板：尾帧不抢首帧那个 LoadImage", builtInDetect.bindings.last === undefined);

const bareDetect = detectComfyBindings(freeVideo);
check("没有 LoadImage 也没节点定义：首帧探测不到", bareDetect.bindings.first === undefined);
check("没有 LoadImage 也没节点定义：给出会报错的提示", bareDetect.notes.some((n) => n.includes("没有找到首帧图的注入点")), bareDetect.notes.join(" | "));
const declaredDetect = detectComfyBindings(freeVideo, {}, OBJECT_INFO);
check("按 /object_info 补出首帧 = 1.first", formatBinding(declaredDetect.bindings.first) === "1.first", formatBinding(declaredDetect.bindings.first));
check("按 /object_info 补出尾帧 = 1.last", formatBinding(declaredDetect.bindings.last) === "1.last", formatBinding(declaredDetect.bindings.last));
check("补出来的首帧有「提交时会插入 LoadImage」的提示", declaredDetect.notes.some((n) => n.includes("接得下 IMAGE")), declaredDetect.notes.join(" | "));
check("补出来的尾帧也有提示", declaredDetect.notes.some((n) => n.includes("尾帧图会接到 1.last")), declaredDetect.notes.join(" | "));
const declaredMedia = detectComfyBindings({ "1": freeVideo["1"], "2": freeVideo["2"] }, {}, OBJECT_INFO);
check("不挑名字对不上的 IMAGE 输入（reference）", formatBinding(declaredMedia.bindings.first) !== "2.reference", formatBinding(declaredMedia.bindings.first));

const twoDetect = detectComfyBindings(twoLoadImage);
check("两个 LoadImage：首帧用第一个", formatBinding(twoDetect.bindings.first) === "2.image", formatBinding(twoDetect.bindings.first));
check("两个 LoadImage：尾帧用第二个（不顶掉首帧）", formatBinding(twoDetect.bindings.last) === "3.image", formatBinding(twoDetect.bindings.last));

const multiPrompt = detectComfyBindings({ "1": { class_type: "A", inputs: { text: "a" } }, "2": { class_type: "B", inputs: { prompt: "b" } } });
check("多个提示词候选：取 id 小的那个", formatBinding(multiPrompt.bindings.prompt) === "1.text", formatBinding(multiPrompt.bindings.prompt));
check("多个提示词候选：提示里点名了候选", multiPrompt.notes.some((n) => n.includes("2 个候选")), multiPrompt.notes.join(" | "));

const overrideOk = detectComfyBindings(freeVideo, { prompt: "1.text", first: "1.first" }, OBJECT_INFO);
check("显式覆盖优先", formatBinding(overrideOk.bindings.prompt) === "1.text" && formatBinding(overrideOk.bindings.first) === "1.first");
const overrideMissingNode = detectComfyBindings(freeVideo, { prompt: "9.text" });
check("覆盖指向不存在的节点：忽略并回退", formatBinding(overrideMissingNode.bindings.prompt) === "1.text" && overrideMissingNode.notes.some((n) => n.includes("节点 9 不存在")), overrideMissingNode.notes.join(" | "));
const overrideMissingInput = detectComfyBindings(freeVideo, { prompt: "1.nope" });
check("覆盖指向不存在的输入：忽略并回退", formatBinding(overrideMissingInput.bindings.prompt) === "1.text" && overrideMissingInput.notes.some((n) => n.includes("不存在，已忽略")), overrideMissingInput.notes.join(" | "));
const overrideGarbage = detectComfyBindings(freeVideo, { prompt: "nonsense" });
check("覆盖写法不对：忽略并回退", formatBinding(overrideGarbage.bindings.prompt) === "1.text" && overrideGarbage.notes.some((n) => n.includes("不是 节点ID.输入名")), overrideGarbage.notes.join(" | "));

/* ---------------------------------------------------------------- 4. 注入 */

section("4. 注入");
const applied = applyComfyInputs(builtIn.workflow, builtInDetect.bindings, { prompt: "测试提示词", width: 768, height: 512, seconds: 3.333, seed: 7.9 });
check("提示词写进 1.text", applied.workflow["1"].inputs.text === "测试提示词");
check("宽度 / 高度写进去", applied.workflow["1"].inputs.width === 768 && applied.workflow["1"].inputs.height === 512);
check("秒数保留两位", applied.workflow["1"].inputs.seconds === 3.33, String(applied.workflow["1"].inputs.seconds));
check("种子取整", applied.workflow["1"].inputs.seed === 7, String(applied.workflow["1"].inputs.seed));
check("纯函数：原工作流没被改", builtIn.workflow["1"].inputs.text !== "测试提示词" && builtIn.workflow["1"].inputs.width === 512, builtIn.workflow["1"].inputs.text);
const zeroInput = applyComfyInputs(builtIn.workflow, builtInDetect.bindings, { width: 0, height: 0, seconds: 0 });
check("0 表示「用工作流里的值」，不覆盖", zeroInput.workflow["1"].inputs.width === 512 && zeroInput.workflow["1"].inputs.seconds === 4);
const negativeSeed = applyComfyInputs(builtIn.workflow, builtInDetect.bindings, { seed: -5 });
check("负种子夹到 0", negativeSeed.workflow["1"].inputs.seed === 0, String(negativeSeed.workflow["1"].inputs.seed));

const wired = { "1": { class_type: "X", inputs: { text: ["2", 0] } }, "2": { class_type: "Y", inputs: {} } };
const wiredDetect = detectComfyBindings(wired, { prompt: "1.text" });
const wiredApplied = applyComfyInputs(wired, wiredDetect.bindings, { prompt: "P" });
check("目标是连线时跳过注入并记提示", Array.isArray(wiredApplied.workflow["1"].inputs.text) && wiredApplied.notes.some((n) => n.includes("现在是连线")), wiredApplied.notes.join(" | "));
let noPromptThrew = false;
try { applyComfyInputs(wired, {}, { prompt: "P" }); } catch (error) { noPromptThrew = error instanceof ComfyError && error.message.includes("找不到可以写入提示词的文本输入"); }
check("没有提示词注入点时直接报错", noPromptThrew);

const replaceImage = applyComfyInputs(builtIn.workflow, builtInDetect.bindings, { firstImageName: "gmm_a.png" });
check("首帧替换自带 LoadImage 的文件名", replaceImage.workflow["3"].inputs.image === "gmm_a.png", replaceImage.workflow["3"].inputs.image);
check("替换时不会多插节点", Object.keys(replaceImage.workflow).length === 3);
check("替换时给出提示", replaceImage.notes.some((n) => n.includes("已把首帧图替换为 gmm_a.png")), replaceImage.notes.join(" | "));

const insertImage = applyComfyInputs(freeVideo, declaredDetect.bindings, { firstImageName: "gmm_b.png" });
check("没有 LoadImage 时插入新节点", insertImage.workflow["3"] !== undefined && insertImage.workflow["3"].class_type === "LoadImage", JSON.stringify(insertImage.workflow["3"]));
check("插入节点的 image 是新上传的文件", insertImage.workflow["3"].inputs.image === "gmm_b.png");
check("插入节点只写 image 一个输入（不塞节点没定义的键）", Object.keys(insertImage.workflow["3"].inputs).length === 1, Object.keys(insertImage.workflow["3"].inputs).join(","));
check("原来那个 IMAGE 输入被接到新节点上", Array.isArray(insertImage.workflow["1"].inputs.first) && insertImage.workflow["1"].inputs.first[0] === "3" && insertImage.workflow["1"].inputs.first[1] === 0, JSON.stringify(insertImage.workflow["1"].inputs.first));
check("插入了 LoadImage 的提示", insertImage.notes.some((n) => n.includes("已插入 LoadImage 节点 3")), insertImage.notes.join(" | "));
check("首帧参考开关被打开", insertImage.workflow["1"].inputs.first_frame_reference === true);
check("打开开关也有提示", insertImage.notes.some((n) => n.includes("first_frame_reference 置为 true")), insertImage.notes.join(" | "));
check("原工作流没被改动（first_frame_reference 仍是 false）", freeVideo["1"].inputs.first_frame_reference === false);

const twoApplied = applyComfyInputs(twoLoadImage, twoDetect.bindings, { firstImageName: "f.png", lastImageName: "l.png" });
check("首尾帧都注入：各写各的 LoadImage", twoApplied.workflow["2"].inputs.image === "f.png" && twoApplied.workflow["3"].inputs.image === "l.png", twoApplied.workflow["2"].inputs.image + " / " + twoApplied.workflow["3"].inputs.image);

let noFirstThrew = false;
try { applyComfyInputs(freeVideo, bareDetect.bindings, { firstImageName: "x.png" }); } catch (error) { noFirstThrew = error instanceof ComfyError && error.message.includes("没有可以接收首帧图的位置"); }
check("有首帧图却无处可放：报错并说清怎么办", noFirstThrew);
const noLast = applyComfyInputs(freeVideo, bareDetect.bindings, { lastImageName: "x.png" });
check("没有尾帧输入：只记提示不报错", noLast.notes.some((n) => n.includes("尾帧图已忽略")), noLast.notes.join(" | "));

const prepared = prepareComfyWorkflow({ workflow: freeVideo, info: OBJECT_INFO, prompt: "P", firstImageName: "gmm_c.png" });
check("组合入口：探测 + 注入的提示都在", prepared.notes.some((n) => n.includes("接得下 IMAGE")) && prepared.notes.some((n) => n.includes("已插入 LoadImage 节点")), prepared.notes.join(" | "));
check("组合入口：工作流确实被改过", prepared.workflow["1"].inputs.text === "P" && prepared.workflow["1"].inputs.first[0] === "3");

/* ---------------------------------------------------------------- 5. HTTP 层 */

section("5. HTTP 层（mock ComfyUI）");
const status = await testComfy({ baseUrl: BASE + "/", timeoutMs: 8000 });
check("连通性：读到版本号", status.version === "0.40.0", status.version);
check("连通性：读到显卡", status.device === "Mock GPU (8GB)", status.device);
state.running = [[0, "r", {}, {}, []]];
state.pending = [[0, "p1", {}, {}, []], [0, "p2", {}, {}, []]];
const status2 = await testComfy(client);
check("连通性：队列长度（执行中 1 / 等待 2）", status2.queueRunning === 1 && status2.queuePending === 2, status2.queueRunning + " / " + status2.queuePending);
let connectThrew = false;
try { await testComfy({ baseUrl: "http://127.0.0.1:1", timeoutMs: 3000 }); } catch (error) { connectThrew = error instanceof ComfyError && error.message.includes("无法连接本地 ComfyUI"); }
check("ComfyUI 没启动：报「无法连接本地 ComfyUI」", connectThrew);

const info = await fetchComfyObjectInfo(client, ["FreeVideoGenerate", "FreeVideoMedia", "FlatNode", "NoSuchNode", "FreeVideoGenerate"]);
check("object_info：拿到已知类型（重复的类型只查一次）", Object.keys(info).length === 3, Object.keys(info).join(","));
check("object_info：IMAGE 输入读的是 optional.first", Array.isArray(info.FreeVideoGenerate.input.optional.first) && info.FreeVideoGenerate.input.optional.first[0] === "IMAGE");
check("object_info：也兼容省掉 input 那层的平铺写法", Array.isArray(info.FlatNode.required.image));
// 注意 inputs 里不能写一个叫 image 的空串：那会先被「工作流里已存在的 first 类输入」命中（也是对的），
// 就走不到「按节点定义补 optional IMAGE」这一级了。
const flatDetect = detectComfyBindings({ "1": { class_type: "FlatNode", inputs: {} } }, {}, info);
check("object_info：平铺写法同样能补出 optional IMAGE", formatBinding(flatDetect.bindings.first) === "1.first", formatBinding(flatDetect.bindings.first));
check("object_info：查不到的类型静默跳过", info.NoSuchNode === undefined);
const infoDown = await fetchComfyObjectInfo({ baseUrl: "http://127.0.0.1:1", timeoutMs: 3000 }, ["FreeVideoGenerate"]);
check("object_info：连不上时返回空表而不抛错", Object.keys(infoDown).length === 0);

const pngData = "data:image/png;base64," + Buffer.from("hello png").toString("base64");
const uploaded = await uploadComfyImage(client, pngData);
check("上传：文件名带 gmm_ 前缀与 png 后缀", uploaded.startsWith("gmm_") && uploaded.endsWith(".png"), uploaded);
check("上传：真的走的是 multipart", state.uploads.length === 1 && state.uploads[0].includes("name=\"image\""), String(state.uploads.length));
check("上传：multipart 里的文件名与返回值一致", state.uploads[0].includes(uploaded), uploaded);
const jpegName = await uploadComfyImage(client, "data:image/jpeg;base64," + Buffer.from("hello jpg").toString("base64"));
check("上传：jpeg 落到 .jpg", jpegName.endsWith(".jpg"), jpegName);
const bareName = await uploadComfyImage(client, Buffer.from("raw").toString("base64"));
check("上传：裸 base64 当 png 处理", bareName.endsWith(".png"), bareName);
let dataUriThrew = "";
try { decodeDataUri(""); } catch (error) { dataUriThrew = error.message; }
check("空图片数据报错", dataUriThrew.includes("是空的"), dataUriThrew);
let httpThrew = "";
try { decodeDataUri("https://example.com/a.png"); } catch (error) { httpThrew = error.message; }
check("http 地址明确拒绝", httpThrew.includes("不接受 http(s)"), httpThrew);

const submitted = await submitComfyVideo({ ...client, workflow: applied.workflow });
check("提交：拿到 prompt_id", submitted === "mock-pid", submitted);
check("提交：body 里带 client_id", typeof state.submits[state.submits.length - 1].client_id === "string" && state.submits[state.submits.length - 1].client_id.startsWith("gmm-"));
check("提交：body 里带工作流本体", state.submits[state.submits.length - 1].prompt["1"].inputs.text === "测试提示词");
let nodeErrorThrew = "";
try { await submitComfyVideo({ ...client, workflow: { "1": { class_type: "FreeVideoGenerate", inputs: { text: "FAIL" } } } }); } catch (error) { nodeErrorThrew = error.message; }
check("提交：node_errors 非空时报错", nodeErrorThrew.includes("拒绝了这个工作流"), nodeErrorThrew.slice(0, 60));
let submitErrorThrew = "";
try { await submitComfyVideo({ ...client, workflow: { "1": { class_type: "FreeVideoGenerate", inputs: { text: "ERR" } } } }); } catch (error) { submitErrorThrew = error.message; }
check("提交：只有 error 字段时报错", submitErrorThrew.includes("提交失败"), submitErrorThrew.slice(0, 60));

resetQueue();
const pendingNew = await queryComfyVideo({ ...client, promptId: "pid-new" });
check("查询：history 与队列里都没有 = 等接收", pendingNew.status === "pending" && pendingNew.remoteStatus.includes("等待 ComfyUI 接收"), pendingNew.status + " / " + pendingNew.remoteStatus);
state.pending = [[0, "other", {}, {}, []], [0, "pid-queued", {}, {}, []]];
const queued = await queryComfyVideo({ ...client, promptId: "pid-queued" });
check("查询：在 queue_pending 里 = 排队中，并说清前面还有几个", queued.status === "pending" && queued.remoteStatus.includes("前面还有 1 个任务"), queued.status + " / " + queued.remoteStatus);
state.running = [[0, "pid-running", {}, {}, []]];
state.pending = [];
const running = await queryComfyVideo({ ...client, promptId: "pid-running" });
check("查询：在 queue_running 里 = 执行中", running.status === "running", running.status + " / " + running.remoteStatus);
state.history["pid-running-hist"] = { status: { status_str: "running", completed: false }, outputs: {} };
const runningHist = await queryComfyVideo({ ...client, promptId: "pid-running-hist" });
check("查询：history 里有但没完成 = 执行中", runningHist.status === "running", runningHist.status);
state.history["pid-ok"] = { status: { status_str: "success", completed: true }, outputs: { "9": { videos: [{ filename: "out.mp4", subfolder: "video", type: "output" }], images: [{ filename: "thumb.png", subfolder: "", type: "output" }] } } };
const ok = await queryComfyVideo({ ...client, promptId: "pid-ok" });
check("查询：完成后选出 mp4 而不是 png 预览图", ok.status === "succeeded" && ok.file.filename === "out.mp4", ok.status + " / " + String(ok.file && ok.file.filename));
check("查询：视频地址走 /view 并带 subfolder", ok.videoUrl.includes("/view?") && ok.videoUrl.includes("filename=out.mp4") && ok.videoUrl.includes("subfolder=video") && ok.videoUrl.includes("type=output"), ok.videoUrl);
state.history["pid-kind"] = { status: { completed: true }, outputs: { "9": { anything: [{ filename: "result.bin", metadata: { kind: "video" } }] } } };
const byKind = await queryComfyVideo({ ...client, promptId: "pid-kind" });
check("查询：靠 metadata.kind = video 也能认出视频", byKind.status === "succeeded" && byKind.file.filename === "result.bin", byKind.status + " / " + byKind.remoteStatus);
state.history["pid-img"] = { status: { completed: true }, outputs: { "9": { images: [{ filename: "only.png", subfolder: "", type: "output" }] } } };
const onlyImage = await queryComfyVideo({ ...client, promptId: "pid-img" });
check("查询：只有图片时判失败（不能把预览图当视频）", onlyImage.status === "failed" && onlyImage.remoteStatus === "empty", onlyImage.status + " / " + onlyImage.remoteStatus);
state.history["pid-err"] = { status: { status_str: "error", messages: [["execution_error", { node_type: "FreeVideoGenerate", exception_type: "RuntimeError", exception_message: "CUDA out of memory" }]] } };
const failed = await queryComfyVideo({ ...client, promptId: "pid-err" });
check("查询：执行失败时把节点与异常带出来", failed.status === "failed" && failed.error.includes("CUDA out of memory") && failed.error.includes("FreeVideoGenerate"), failed.error);
let historyThrew = null;
try { await queryComfyVideo({ ...client, promptId: "bad" }); } catch (error) { historyThrew = error; }
check("查询：HTTP 500 时抛 ComfyError 并带状态码", historyThrew instanceof ComfyError && historyThrew.status === 500, historyThrew === null ? "" : String(historyThrew.status));

const viewUrl = comfyViewUrl("http://127.0.0.1:8188/", { filename: "角色 1.mp4", subfolder: "clip", type: "output" });
check("view 地址：中文与空格都被编码", viewUrl.startsWith("http://127.0.0.1:8188/view?") && viewUrl.includes("%E8%A7%92%E8%89%B2") && !viewUrl.includes(" "), viewUrl);
check("view 地址：type 缺省成 output", comfyViewUrl(BASE, { filename: "a.mp4" }).includes("type=output"));
check("view 地址：subfolder 为空时不写", !comfyViewUrl(BASE, { filename: "a.mp4", subfolder: "" }).includes("subfolder="));

/* ---------------------------------------------------------------- 6. Cookie（鉴权反代） */

section("6. Cookie 请求头（藏在鉴权反代后面的 ComfyUI）");
check("归一化：空串 / 纯空白 = 不带这个头", normalizeComfyCookies(undefined) === "" && normalizeComfyCookies("   ") === "");
check("归一化：剥掉 Cookie: 前缀", normalizeComfyCookies("Cookie: a=1; b=2") === "a=1; b=2", normalizeComfyCookies("Cookie: a=1; b=2"));
check("归一化：去掉尾部分号", normalizeComfyCookies("a=1;") === "a=1", normalizeComfyCookies("a=1;"));
check("归一化：多行折成一行", normalizeComfyCookies("a=1;\nb=2") === "a=1; b=2", normalizeComfyCookies("a=1;\nb=2"));
check("归一化：续行（不以「名字:」开头）跟着 Cookie 走", normalizeComfyCookies("Cookie: a=1\nb=2") === "a=1; b=2", normalizeComfyCookies("Cookie: a=1\nb=2"));
check(
  "归一化：整块「Copy request headers」只取 Cookie 那一行",
  normalizeComfyCookies("accept: */*\nCookie: token=abc; session=xyz\nreferer: http://x/") === "token=abc; session=xyz",
  normalizeComfyCookies("accept: */*\nCookie: token=abc; session=xyz\nreferer: http://x/")
);

const cookies = "token=abc; session=xyz";
state.cookies.length = 0;
await testComfy({ ...client, cookies });
check("带 cookies：/system_stats 收到该头", state.cookies.some((item) => item.path === "/system_stats" && item.cookie === cookies));
check("带 cookies：/queue 收到该头", state.cookies.some((item) => item.path === "/queue" && item.cookie === cookies));

state.cookies.length = 0;
await testComfy(client);
check("没配 cookies：一个请求都不带这个头", state.cookies.length > 0 && state.cookies.every((item) => item.cookie === ""), String(state.cookies.length));

state.cookies.length = 0;
await uploadComfyImage({ ...client, cookies }, "iVBORw0KGgo=");
check("带 cookies：/upload/image 收到该头", state.cookies.some((item) => item.path === "/upload/image" && item.cookie === cookies));

state.cookies.length = 0;
await submitComfyVideo({ ...client, cookies, workflow: builtIn.workflow });
check("带 cookies：提交 /prompt 收到该头", state.cookies.some((item) => item.path === "/prompt" && item.cookie === cookies));

state.cookies.length = 0;
await queryComfyVideo({ ...client, cookies, promptId: "pid-none" });
check("带 cookies：查询也收到该头", state.cookies.every((item) => item.cookie === cookies), JSON.stringify(state.cookies.map((item) => item.path)));

server.close();

console.log("");
if (failures.length === 0) {
  console.log("共 " + passed + " 项检查，全部通过。");
  console.log("本地 ComfyUI 后端契约全部通过。");
  process.exit(0);
} else {
  console.log("共 " + passed + " 项检查，失败 " + failures.length + " 项：");
  for (const item of failures) console.log("  - " + item);
  process.exit(1);
}
