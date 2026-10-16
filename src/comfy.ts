/**
 * 本地 ComfyUI 后端（生成视频）。
 *
 * 与 Ark / MiniMax 的区别：这里没有「远端 API 契约」，只有一份**用户自己的 API 格式工作流**。
 * 于是插件负责三件事：
 *   1. 把提示词 / 首帧图 / 尺寸 / 时长 / 种子**注入**到工作流的对应输入（自动探测，可手工覆盖成 `节点ID.输入名`）；
 *   2. `POST /prompt` 提交，之后轮询 `/history/<promptId>`（还没进 history 时看 `/queue` 区分排队与执行）；
 *   3. 从 history 的 outputs 里挑出视频文件，拼出 `/view` 地址，交给既有的下载 → 抽帧 → 抠像流水线。
 *
 * 注入点是**探测**出来的，不写死节点 id：换一份工作流（Wan / Hunyuan / Flux…）只要输入名符合常见约定就能直接用。
 */

import { randomUUID } from "node:crypto";

export interface ComfyRequest {
  /** 例如 http://127.0.0.1:8188 */
  baseUrl: string;
  /** 单次 HTTP 超时（毫秒）。生成本身是异步的，这里只约束一次请求。 */
  timeoutMs: number;
  /**
   * 附带的 `Cookie` 请求头原文（如 `token=…; session=…`）；空 = 不带这个头。
   *
   * ComfyUI 自己不做鉴权，但把 8188 藏在**需要登录的反代**后面（Cloudflare Access、
   * Basic Auth、自建网关）时，不带 cookie 连 `/system_stats` 都读不到。
   */
  cookies?: string;
}

export class ComfyError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ComfyError";
    this.status = status;
  }
}

export interface ComfyNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** ComfyUI 的「API 格式」：节点 id → 节点。 */
export type ComfyWorkflow = Record<string, ComfyNode>;

export interface ComfyBinding {
  node: string;
  input: string;
}

export interface ComfyBindings {
  prompt?: ComfyBinding;
  first?: ComfyBinding;
  last?: ComfyBinding;
  width?: ComfyBinding;
  height?: ComfyBinding;
  seconds?: ComfyBinding;
  seed?: ComfyBinding;
  /** 工作流里自带的 LoadImage 节点 id（有的话首帧图直接替换它的文件名）。 */
  loadImage?: string;
}

export interface ComfyBindingOverrides {
  prompt?: string;
  first?: string;
  last?: string;
  width?: string;
  height?: string;
  seconds?: string;
  seed?: string;
}

const PROMPT_KEYS = ["text", "prompt", "positive", "positive_prompt", "caption"];
const FIRST_KEYS = ["first", "first_frame", "first_image", "start_image", "init_image", "image"];
const LAST_KEYS = ["last", "last_frame", "last_image", "end_image"];
const WIDTH_KEYS = ["width"];
const HEIGHT_KEYS = ["height"];
const SECONDS_KEYS = ["seconds", "duration", "video_length", "length"];
const SEED_KEYS = ["seed", "noise_seed", "rand_seed"];

export function normalizeComfyBaseUrl(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return "http://127.0.0.1:8188";
  return trimmed.replace(/\/+$/, "");
}

/**
 * 归一化 `Cookie` 请求头原文。
 *
 * 用户多半直接从浏览器的开发者工具里复制：那里可能带 `Cookie: ` 前缀，整段
 * 「Copy request headers」还夹着 Accept 之类的别的头，长 cookie 也可能折成几行。
 * 这里统一收成一行 `a=1; b=2`：只认 Cookie 那一行（加它的续行）、剥掉前缀、
 * 去掉每段末尾多余的分号。空串（或只有空白）= 不带这个头。
 */
export function normalizeComfyCookies(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return "";
  const lines = trimmed
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // 整块粘贴时只认 Cookie：它那一行，加上后面不以「名字:」开头的续行。
  const start = lines.findIndex((line) => /^cookie\s*:/i.test(line));
  const picked =
    start < 0 ? lines : [lines[start], ...lines.slice(start + 1).filter((line) => !/^[A-Za-z0-9_-]+\s*:/.test(line))];
  return picked
    // 每段先去掉自己的尾分号，再拼起来——不然 `a=1;` + `b=2` 会拼出 `a=1;; b=2`。
    .map((line) => line.replace(/[;\s]+$/, ""))
    .join("; ")
    .replace(/^cookie\s*:/i, " ")
    .replace(/[;\s]+$/, "")
    .trim();
}

export function formatBinding(binding: ComfyBinding | undefined): string {
  return binding === undefined ? "" : binding.node + "." + binding.input;
}

/** 解析 `节点ID.输入名`。节点 id 里可能带点，所以按**最后一个**点切分。 */
export function parseBinding(text: string | undefined): ComfyBinding | undefined {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return undefined;
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return undefined;
  return { node: trimmed.slice(0, dot), input: trimmed.slice(dot + 1) };
}

export type ComfyParseResult =
  | { ok: true; workflow: ComfyWorkflow; nodes: number }
  | { ok: false; error: string };

export function parseComfyWorkflow(text: string): ComfyParseResult {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return { ok: false, error: "工作流是空的" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: "不是合法 JSON：" + reason };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "顶层必须是「节点 id → 节点」的对象" };
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.nodes) && (record.links !== undefined || record.last_node_id !== undefined)) {
    return { ok: false, error: "这是 ComfyUI 界面导出的工作流（含 nodes / links 数组），不是 API 格式。请在 ComfyUI 里用「工作流 → 导出(API)」或 Save (API Format) 重新导出。" };
  }
  const ids = Object.keys(record);
  if (ids.length === 0) return { ok: false, error: "工作流里没有任何节点" };
  for (const id of ids) {
    const node = record[id];
    if (node === null || typeof node !== "object" || Array.isArray(node)) return { ok: false, error: "节点 " + id + " 不是对象" };
    const classType = (node as ComfyNode).class_type;
    if (typeof classType !== "string" || classType.trim() === "") return { ok: false, error: "节点 " + id + " 缺少 class_type" };
  }
  return { ok: true, workflow: record as ComfyWorkflow, nodes: ids.length };
}

/** 只有界面预览与报错信息用：把工作流里的一批候选输入列出来。 */
function nodeOrder(workflow: ComfyWorkflow): string[] {
  return Object.keys(workflow).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const fa = Number.isFinite(na);
    const fb = Number.isFinite(nb);
    if (fa && fb) return na - nb;
    if (fa !== fb) return fa ? -1 : 1;
    return a.localeCompare(b);
  });
}

interface Candidate {
  binding: ComfyBinding;
  title: string;
}

function candidates(workflow: ComfyWorkflow, keys: string[], want: "string" | "number"): Candidate[] {
  const found: Candidate[] = [];
  for (const id of nodeOrder(workflow)) {
    const node = workflow[id];
    const inputs = node?.inputs;
    if (inputs === undefined) continue;
    for (const key of keys) {
      const value = inputs[key];
      if (value === undefined) continue;
      if (want === "string" && typeof value !== "string") continue;
      if (want === "number" && typeof value !== "number") continue;
      const meta = node?._meta;
      const title = meta !== undefined && typeof meta.title === "string" ? meta.title : (node?.class_type ?? "");
      found.push({ binding: { node: id, input: key }, title });
    }
  }
  return found;
}

export interface ComfyDetectResult {
  bindings: ComfyBindings;
  notes: string[];
}

/**
 * `/object_info` 单类型查询返回的定义里，我们关心的那部分。
 *
 * ComfyUI 的写法是 `{ input: { required, optional }, output: [...], name }`——注意 **input 包了一层**；
 * 也兼容「直接平铺 required / optional」的第三方实现，两种都读得到才不至于探测不到 IMAGE 输入。
 */
export interface ComfyObjectInputSpec {
  required?: Record<string, unknown[]>;
  optional?: Record<string, unknown[]>;
}

export interface ComfyNodeSpec extends ComfyObjectInputSpec {
  input?: ComfyObjectInputSpec;
  output?: unknown[];
  display_name?: string;
}

export type ComfyObjectInfo = Record<string, ComfyNodeSpec>;

/**
 * 按节点类型查 ComfyUI 的节点定义。
 *
 * 为什么要查：**工作流里没写的输入，在 JSON 里根本看不见**。FreeVideo 的
 * `FreeVideoMedia.first` 就是这种 optional IMAGE 输入——用户在界面里没连首帧图，
 * 导出的工作流里就没有这个键，只靠「扫工作流里已存在的输入」永远找不到它。
 * 拿到节点定义才知道「这个节点接得下 IMAGE，键名叫 first」，于是能自动补上连线。
 *
 * 查不到（ComfyUI 没启动 / 类型不存在）只跳过不抛错：调用方按「没有额外信息」继续。
 */
export async function fetchComfyObjectInfo(request: ComfyRequest, classTypes: string[]): Promise<ComfyObjectInfo> {
  const out: ComfyObjectInfo = {};
  const unique = Array.from(new Set(classTypes.filter((item) => typeof item === "string" && item.trim() !== "")));
  await Promise.all(
    unique.map(async (classType) => {
      try {
        const response = await comfyFetch(request, "/object_info/" + encodeURIComponent(classType));
        if (response.ok !== true) return;
        const data = (await response.json()) as Record<string, ComfyNodeSpec>;
        const spec = data[classType];
        if (spec !== undefined) out[classType] = spec;
      } catch {
        // 单个类型查不到不影响其它类型，也不影响「没有额外信息」这条兜底。
      }
    })
  );
  return out;
}

/** 这个节点定义里哪些输入吃 IMAGE（optional 在前：required 的 IMAGE 输入通常必须自己连）。 */
function imageInputNames(spec: ComfyNodeSpec | undefined): string[] {
  if (spec === undefined) return [];
  const group = spec.input ?? spec;
  const names: string[] = [];
  for (const part of [group.optional ?? {}, group.required ?? {}]) {
    for (const [key, value] of Object.entries(part)) {
      if (Array.isArray(value) && value[0] === "IMAGE") names.push(key);
    }
  }
  return names;
}

/**
 * 在工作流里找一个**接得下 IMAGE 且名字符合候选**的输入，用于自动补首帧 / 尾帧连线。
 * 名字不在候选里的 IMAGE 输入（reference / mask 之类）一律不猜——接错比不接更坏。
 */
function findImageInput(workflow: ComfyWorkflow, info: ComfyObjectInfo, keys: string[]): ComfyBinding | undefined {
  const wanted = keys.map((key) => key.toLowerCase());
  for (const id of nodeOrder(workflow)) {
    const node = workflow[id];
    if (node === undefined) continue;
    for (const name of imageInputNames(info[node.class_type ?? ""])) {
      if (!wanted.includes(name.toLowerCase())) continue;
      if (Array.isArray(node.inputs?.[name])) continue; // 已被别的连线占用
      return { node: id, input: name };
    }
  }
  return undefined;
}

/**
 * 探测注入点。显式覆盖优先；否则按上面的候选名列表，节点按数字 id 升序取第一个。
 * 覆盖写错（节点或输入不存在）时只记一条 note 并回退到自动探测，不抛错——这样设置页的预览也能用。
 */
export function detectComfyBindings(
  workflow: ComfyWorkflow,
  overrides: ComfyBindingOverrides = {},
  info?: ComfyObjectInfo
): ComfyDetectResult {
  const notes: string[] = [];
  // 一个 LoadImage 只装一张图：首帧用第一个；尾帧只在真有第二个时才走「替换文件名」这条路。
  // 只有一个 LoadImage 还把尾帧也指过去，注入尾帧时会静默顶掉首帧的图 —— 这种错在界面上看不出来。
  const loadImageIds = nodeOrder(workflow).filter((id) => workflow[id]?.class_type === "LoadImage");

  /** 用户显式填的 `节点ID.输入名`：只有真能写进去才采用，否则记一条 note 并回退。 */
  const overrideBinding = (label: string, override: string | undefined): ComfyBinding | undefined => {
    if (override === undefined || override.trim() === "") return undefined;
    const binding = parseBinding(override);
    if (binding === undefined) {
      notes.push(label + "覆盖「" + override + "」不是 节点ID.输入名 的写法，已忽略。");
    } else if (workflow[binding.node] === undefined) {
      notes.push(label + "覆盖指向的节点 " + binding.node + " 不存在，已忽略。");
    } else if (workflow[binding.node].inputs?.[binding.input] === undefined) {
      notes.push(label + "覆盖指向的输入 " + override + " 不存在，已忽略。");
    } else {
      return binding;
    }
    return undefined;
  };

  const autoBinding = (label: string, keys: string[], want: "string" | "number"): ComfyBinding | undefined => {
    const list = candidates(workflow, keys, want);
    if (list.length > 1) {
      notes.push(label + "有 " + list.length + " 个候选（" + list.map((item) => item.binding.node + "." + item.binding.input + (item.title === "" ? "" : " " + item.title)).join("、") + "），当前用第一个。");
    }
    return list[0]?.binding;
  };

  const pick = (label: string, override: string | undefined, keys: string[], want: "string" | "number"): ComfyBinding | undefined =>
    overrideBinding(label, override) ?? autoBinding(label, keys, want);

  /**
   * 图像断点分四级找：显式覆盖 → 工作流自带的 LoadImage（替换它的 image 文件名，连线不动）
   * → 工作流里已经写着的 first 类输入 → **节点定义里的 optional IMAGE 输入**（工作流里没写的那种，补连线）。
   * 前两级命中时不再往下扫，免得对着一个用不上的候选报「有多个候选」。
   */
  const locateImage = (label: string, override: string | undefined, keys: string[], loadImageId?: string): { binding: ComfyBinding | undefined; source: string } => {
    const explicit = overrideBinding(label, override);
    if (explicit !== undefined) return { binding: explicit, source: "override" };
    if (loadImageId !== undefined) return { binding: { node: loadImageId, input: "image" }, source: "loadImage" };
    const existing = autoBinding(label, keys, "string");
    if (existing !== undefined) return { binding: existing, source: "input" };
    if (info !== undefined) {
      const declared = findImageInput(workflow, info, keys);
      if (declared !== undefined) return { binding: declared, source: "declared" };
    }
    return { binding: undefined, source: "none" };
  };

  const first = locateImage("首帧", overrides.first, FIRST_KEYS, loadImageIds[0]);
  // 尾帧拿第二个 LoadImage（没有就交给「已存在的 last 类输入 / 节点定义里的 optional IMAGE」）。
  const last = locateImage("尾帧", overrides.last, LAST_KEYS, loadImageIds[1]);

  const bindings: ComfyBindings = {
    prompt: pick("提示词", overrides.prompt, PROMPT_KEYS, "string"),
    width: pick("宽度", overrides.width, WIDTH_KEYS, "number"),
    height: pick("高度", overrides.height, HEIGHT_KEYS, "number"),
    seconds: pick("时长", overrides.seconds, SECONDS_KEYS, "number"),
    seed: pick("种子", overrides.seed, SEED_KEYS, "number"),
    first: first.binding,
    last: last.binding
  };
  if (loadImageIds.length > 0) bindings.loadImage = loadImageIds[0];
  if (first.source === "loadImage") {
    notes.push("工作流里已有 LoadImage 节点（id=" + (first.binding?.node ?? "") + "），首帧图会直接替换它的 image 文件名。");
  } else if (first.source === "declared") {
    notes.push("工作流里没有连首帧图，但按节点定义 " + formatBinding(first.binding) + " 接得下 IMAGE——提交时会插入一个 LoadImage 节点连过去。");
  } else if (first.source === "none") {
    notes.push("没有找到首帧图的注入点（既没有 LoadImage 节点，也没有 first 之类的 IMAGE 输入）——图生视频会在提交时报错。");
  }
  if (last.source === "declared") {
    notes.push("尾帧图会接到 " + formatBinding(last.binding) + "（工作流里原本没连这个 IMAGE 输入）。");
  }
  return { bindings, notes };
}

export interface ComfyInjectionInput {
  prompt?: string;
  width?: number;
  height?: number;
  seconds?: number;
  seed?: number;
  /** 已上传到 ComfyUI 的首帧文件名（uploadComfyImage 的返回值）。 */
  firstImageName?: string;
  lastImageName?: string;
}

export interface ComfyInjectionResult {
  workflow: ComfyWorkflow;
  bindings: ComfyBindings;
  notes: string[];
}

function cloneWorkflow(workflow: ComfyWorkflow): ComfyWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
}

function nextNodeId(workflow: ComfyWorkflow): string {
  let max = 0;
  for (const id of Object.keys(workflow)) {
    const value = Number(id);
    if (Number.isFinite(value) && value > max) max = Math.floor(value);
  }
  let candidate = String(max + 1);
  while (Object.prototype.hasOwnProperty.call(workflow, candidate)) candidate = String(Number(candidate) + 1);
  return candidate;
}

function injectImage(workflow: ComfyWorkflow, bindings: ComfyBindings, name: string, which: "first" | "last", notes: string[]): void {
  const target = which === "first" ? bindings.first : bindings.last;
  const label = which === "first" ? "首帧" : "尾帧";
  if (target === undefined) {
    if (which === "first") {
      throw new ComfyError(
        "工作流里没有可以接收首帧图的位置：请在工作流里放一个 LoadImage 节点（把它的 IMAGE 输出连给视频节点），" +
          "或在设置页把「首帧图注入点」填成 节点ID.输入名（例如 2.first）。" +
          "如果这个节点确实有 IMAGE 输入却仍报这一条，多半是 ComfyUI 没在配置的地址上跑，读不到它的节点定义。"
      );
    }
    notes.push("工作流里没有尾帧输入，尾帧图已忽略。");
    return;
  }
  const node = workflow[target.node];
  if (node === undefined) throw new ComfyError("首帧目标 " + formatBinding(target) + " 指向的节点不存在。");
  if (node.class_type === "LoadImage" && target.input === "image") {
    node.inputs = { ...(node.inputs ?? {}), image: name };
    notes.push("已把" + label + "图替换为 " + name + "（工作流自带的 LoadImage 节点 " + target.node + "）。");
    return;
  }
  const newId = nextNodeId(workflow);
  workflow[newId] = { class_type: "LoadImage", inputs: { image: name }, _meta: { title: "游戏素材大师 · " + label + "图" } };
  node.inputs = { ...(node.inputs ?? {}) };
  node.inputs[target.input] = [newId, 0];
  notes.push("已插入 LoadImage 节点 " + newId + "，把 " + name + " 接到 " + formatBinding(target) + "。");
}

export function applyComfyInputs(workflow: ComfyWorkflow, bindings: ComfyBindings, input: ComfyInjectionInput): ComfyInjectionResult {
  const next = cloneWorkflow(workflow);
  const notes: string[] = [];

  const writeLiteral = (binding: ComfyBinding | undefined, value: unknown, label: string): boolean => {
    if (binding === undefined) return false;
    const node = next[binding.node];
    if (node === undefined) return false;
    const inputs = node.inputs ?? {};
    if (Array.isArray(inputs[binding.input])) {
      notes.push(label + "目标 " + formatBinding(binding) + " 现在是连线，已跳过注入（要在 ComfyUI 里先断开这条连线）。");
      return false;
    }
    node.inputs = { ...inputs, [binding.input]: value };
    return true;
  };

  if (typeof input.prompt === "string" && input.prompt !== "") {
    if (bindings.prompt === undefined) {
      throw new ComfyError("工作流里找不到可以写入提示词的文本输入：请放一个提示词节点，或在设置页把「提示词目标」填成 节点ID.输入名。");
    }
    writeLiteral(bindings.prompt, input.prompt, "提示词");
  }
  if (typeof input.width === "number" && input.width > 0) writeLiteral(bindings.width, Math.round(input.width), "宽度");
  if (typeof input.height === "number" && input.height > 0) writeLiteral(bindings.height, Math.round(input.height), "高度");
  if (typeof input.seconds === "number" && input.seconds > 0) writeLiteral(bindings.seconds, Math.round(input.seconds * 100) / 100, "时长");
  if (typeof input.seed === "number" && Number.isFinite(input.seed)) writeLiteral(bindings.seed, Math.max(0, Math.floor(input.seed)), "种子");

  if (typeof input.firstImageName === "string" && input.firstImageName !== "") {
    injectImage(next, bindings, input.firstImageName, "first", notes);
    // FreeVideo 这类节点有「首帧参考」开关，注入首帧后必须打开它，否则图不参与。
    for (const id of Object.keys(next)) {
      const node = next[id];
      if (node !== undefined && node.inputs !== undefined && node.inputs.first_frame_reference === false) {
        node.inputs = { ...node.inputs, first_frame_reference: true };
        notes.push("已把 " + id + ".first_frame_reference 置为 true，让注入的首帧真正参与生成。");
      }
    }
  }
  if (typeof input.lastImageName === "string" && input.lastImageName !== "") {
    injectImage(next, bindings, input.lastImageName, "last", notes);
  }
  return { workflow: next, bindings, notes };
}

/**
 * 内置默认工作流：FreeVideo（本机装了这个扩展就能直接跑）。
 *
 * 结构对照 FreeVideo 节点在 `/object_info` 里的定义：
 * - `FreeVideoGenerate.text` 是提示词（required STRING），尺寸 / 时长 / 种子都在这一个节点上；
 * - `FreeVideoGenerate.first_frame_reference` 是「首帧参考」开关，注入首帧后必须为 true；
 * - `FreeVideoGenerate.media` 连 `FreeVideoMedia` 的输出；
 * - `FreeVideoMedia` 的 `assets` 是素材清单（默认 "[]"），首帧图走它的 **optional IMAGE 输入 `first`**。
 *
 * 所以模板自带一个空的 LoadImage（节点 3）并连到 `first`：插件把上传后的文件名写进它的
 * `image`，连线不动——比「提交时现插一个节点」稳，也省得用户自己接一遍。
 */
export const DEFAULT_COMFY_WORKFLOW_TEXT = JSON.stringify(
  {
    "1": {
      inputs: {
        text: "在这里写提示词（插件会用项目里的提示词自动替换这一项）",
        width: 512,
        height: 512,
        seconds: 4,
        seed: 0,
        two_pass: true,
        base_steps: 8,
        refine_steps: 3,
        force_regenerate: false,
        preview: false,
        refine_from: "",
        continue_from: "",
        frames: 0,
        first_frame_reference: true,
        media: ["2", 0]
      },
      class_type: "FreeVideoGenerate",
      _meta: { title: "FreeVideo" }
    },
    "2": {
      inputs: { assets: "[]", first: ["3", 0] },
      class_type: "FreeVideoMedia",
      _meta: { title: "FreeVideo 素材" }
    },
    "3": {
      inputs: { image: "" },
      class_type: "LoadImage",
      _meta: { title: "游戏素材大师 · 首帧图" }
    }
  },
  null,
  2
);

function newClientId(): string {
  try {
    return "gmm-" + randomUUID();
  } catch {
    return "gmm-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }
}

async function comfyFetch(request: ComfyRequest, path: string, init?: RequestInit): Promise<Response> {
  const base = normalizeComfyBaseUrl(request.baseUrl);
  const timeoutMs = Math.max(5000, Math.round(request.timeoutMs));
  const timeout = AbortSignal.timeout(timeoutMs);
  // 鉴权反代后面：所有请求（状态、上传、提交、查询）都带上同一份 Cookie。
  const cookies = normalizeComfyCookies(request.cookies);
  const headers = new Headers(init?.headers ?? undefined);
  if (cookies !== "") headers.set("Cookie", cookies);
  try {
    return await fetch(base + path, { ...(init ?? {}), headers, signal: timeout });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (timeout.aborted === true) throw new ComfyError("本地 ComfyUI 请求超时（" + Math.round(timeoutMs / 1000) + " 秒）：" + path);
    throw new ComfyError("无法连接本地 ComfyUI（" + base + "）：" + reason + "。请确认 ComfyUI 正在运行。");
  }
}

async function comfyJson(request: ComfyRequest, path: string, init?: RequestInit): Promise<any> {
  const response = await comfyFetch(request, path, init);
  const text = await response.text().catch(() => "");
  if (response.ok !== true) {
    throw new ComfyError("ComfyUI " + path + " 返回 HTTP " + response.status + "：" + (text.slice(0, 400) === "" ? response.statusText : text.slice(0, 400)), response.status);
  }
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ComfyError("ComfyUI " + path + " 返回的不是 JSON：" + trimmed.slice(0, 200));
  }
}

export interface ComfyStatus {
  ok: true;
  version: string;
  device?: string;
  queueRunning: number;
  queuePending: number;
}

/** 连通性自检：读 /system_stats 与 /queue。 */
export async function testComfy(request: ComfyRequest): Promise<ComfyStatus> {
  const stats = await comfyJson(request, "/system_stats");
  const version = typeof stats?.system?.comfyui_version === "string" ? stats.system.comfyui_version : "未知";
  const device = Array.isArray(stats?.devices) && typeof stats.devices[0]?.name === "string" ? stats.devices[0].name : undefined;
  const queue = await comfyJson(request, "/queue").catch(() => undefined);
  const running = Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0;
  const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0;
  return { ok: true, version, device, queueRunning: running, queuePending: pending };
}

export async function submitComfyVideo(request: ComfyRequest & { workflow: ComfyWorkflow }): Promise<string> {
  const payload = await comfyJson(request, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: request.workflow, client_id: newClientId() })
  });
  const nodeErrors = payload?.node_errors;
  if (nodeErrors !== undefined && nodeErrors !== null && typeof nodeErrors === "object" && Object.keys(nodeErrors).length > 0) {
    throw new ComfyError("ComfyUI 拒绝了这个工作流：" + JSON.stringify(nodeErrors).slice(0, 500));
  }
  if (payload?.error !== undefined && payload.error !== null) {
    throw new ComfyError("ComfyUI 提交失败：" + JSON.stringify(payload.error).slice(0, 400));
  }
  const promptId = payload?.prompt_id;
  if (typeof promptId !== "string" || promptId === "") {
    throw new ComfyError("ComfyUI 没有返回 prompt_id：" + JSON.stringify(payload).slice(0, 300));
  }
  return promptId;
}

export type ComfyPhase = "pending" | "running" | "succeeded" | "failed";

export interface ComfyFileRef {
  filename: string;
  subfolder: string;
  type: string;
  url: string;
}

export interface ComfyQuery {
  status: ComfyPhase;
  remoteStatus: string;
  file?: ComfyFileRef;
  videoUrl?: string;
  error?: string;
  raw?: unknown;
}

export function comfyViewUrl(baseUrl: string, file: { filename: string; subfolder?: string; type?: string }): string {
  const params = new URLSearchParams();
  params.set("filename", file.filename);
  if (file.subfolder !== undefined && file.subfolder !== "") params.set("subfolder", file.subfolder);
  params.set("type", file.type === undefined || file.type === "" ? "output" : file.type);
  return normalizeComfyBaseUrl(baseUrl) + "/view?" + params.toString();
}

function scoreOutput(item: Record<string, unknown>, filename: string): number {
  const metadata = item.metadata;
  const kind = metadata !== null && typeof metadata === "object" ? (metadata as Record<string, unknown>).kind : undefined;
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const isImage = ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "bmp";
  const isAudio = ext === "flac" || ext === "wav" || ext === "mp3" || ext === "ogg";
  let score = 0;
  if (kind === "video") score += 5;
  else if (typeof kind === "string" && kind !== "") score -= 3;
  if (ext === "mp4" || ext === "webm" || ext === "mkv" || ext === "mov") score += 4;
  else if (ext === "gif") score += 2;
  else if (isImage) score -= 5;
  else if (isAudio) score -= 4;
  else score += 1;
  return score;
}

function pickVideoFile(outputs: unknown, baseUrl: string): ComfyFileRef | undefined {
  if (outputs === null || typeof outputs !== "object") return undefined;
  let best: { score: number; file: ComfyFileRef } | undefined;
  for (const nodeId of Object.keys(outputs as Record<string, unknown>)) {
    const nodeOut = (outputs as Record<string, unknown>)[nodeId];
    if (nodeOut === null || typeof nodeOut !== "object") continue;
    for (const key of Object.keys(nodeOut as Record<string, unknown>)) {
      const list = (nodeOut as Record<string, unknown>)[key];
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (raw === null || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const filename = typeof item.filename === "string" ? item.filename : "";
        if (filename === "") continue;
        const score = scoreOutput(item, filename);
        if (score <= 0) continue;
        if (best === undefined || score > best.score) {
          const subfolder = typeof item.subfolder === "string" ? item.subfolder : "";
          const type = typeof item.type === "string" ? item.type : "output";
          best = { score, file: { filename, subfolder, type, url: comfyViewUrl(baseUrl, { filename, subfolder, type }) } };
        }
      }
    }
  }
  return best?.file;
}

function extractHistoryError(entry: any): string {
  const messages = entry?.status?.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (Array.isArray(message) && message[0] === "execution_error" && message[1] !== null && typeof message[1] === "object") {
        const info = message[1] as Record<string, unknown>;
        const parts = [info.node_type, info.exception_type, info.exception_message].filter((value) => typeof value === "string" && value !== "");
        if (parts.length > 0) return "ComfyUI 执行失败：" + (parts as string[]).join(" / ");
      }
    }
  }
  return "ComfyUI 执行失败（history 里没有更详细的信息）";
}

export async function queryComfyVideo(request: ComfyRequest & { promptId: string }): Promise<ComfyQuery> {
  const history = await comfyJson(request, "/history/" + encodeURIComponent(request.promptId));
  const entry = history === null || typeof history !== "object" ? undefined : (history as Record<string, unknown>)[request.promptId];
  if (entry !== undefined && entry !== null && typeof entry === "object") {
    const record = entry as any;
    const statusStr = typeof record?.status?.status_str === "string" ? record.status.status_str : "";
    if (statusStr === "error") return { status: "failed", remoteStatus: "error", error: extractHistoryError(record), raw: record };
    if (record?.status?.completed === true || statusStr === "success") {
      const file = pickVideoFile(record?.outputs, request.baseUrl);
      if (file === undefined) {
        return { status: "failed", remoteStatus: "empty", error: "ComfyUI 执行完成，但输出里没有视频文件（检查工作流的终点节点是不是视频节点）。", raw: record };
      }
      return { status: "succeeded", remoteStatus: "success", file, videoUrl: file.url, raw: record };
    }
    return { status: "running", remoteStatus: statusStr === "" ? "running" : statusStr, raw: record };
  }
  const queue = await comfyJson(request, "/queue").catch(() => undefined);
  const running = Array.isArray(queue?.queue_running) ? queue.queue_running : [];
  const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending : [];
  const inRunning = running.some((item: unknown) => Array.isArray(item) && item[1] === request.promptId);
  if (inRunning) return { status: "running", remoteStatus: "running" };
  const index = pending.findIndex((item: unknown) => Array.isArray(item) && item[1] === request.promptId);
  if (index >= 0) return { status: "pending", remoteStatus: "排队中（前面还有 " + index + " 个任务）" };
  return { status: "pending", remoteStatus: "等待 ComfyUI 接收" };
}

function extForMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower === "image/jpeg" || lower === "image/jpg") return "jpg";
  if (lower === "image/webp") return "webp";
  if (lower === "image/bmp") return "bmp";
  return "png";
}

/** 把 data URI（或裸 base64）解码成字节。 */
export function decodeDataUri(value: string): { bytes: Buffer; mime: string; ext: string } {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") throw new ComfyError("参考图数据是空的");
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(trimmed);
  if (match !== null) {
    const mime = match[1] !== undefined && match[1] !== "" ? match[1] : "image/png";
    const payload = match[2] === undefined ? decodeURIComponent(match[3]) : Buffer.from(match[3], "base64");
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    if (bytes.length === 0) throw new ComfyError("参考图数据是空的");
    return { bytes, mime, ext: extForMime(mime) };
  }
  if (/^https?:/i.test(trimmed)) {
    throw new ComfyError("本地 ComfyUI 只接收本机图片字节，不接受 http(s) 图片地址。");
  }
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.length === 0) throw new ComfyError("参考图数据是空的");
  return { bytes, mime: "image/png", ext: "png" };
}

/** 上传一张参考图到 ComfyUI 的 input 目录，返回 LoadImage 能用的文件名。 */
export async function uploadComfyImage(request: ComfyRequest, dataUri: string, prefix = "gmm"): Promise<string> {
  const decoded = decodeDataUri(dataUri);
  const name = prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8) + "." + decoded.ext;
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(decoded.bytes)], { type: decoded.mime }), name);
  form.append("overwrite", "true");
  form.append("type", "input");
  const response = await comfyFetch(request, "/upload/image", { method: "POST", body: form });
  const text = await response.text().catch(() => "");
  if (response.ok !== true) {
    throw new ComfyError("上传参考图到 ComfyUI 失败（HTTP " + response.status + "）：" + text.slice(0, 300), response.status);
  }
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ComfyError("上传参考图返回的不是 JSON：" + text.slice(0, 200));
  }
  const fileName = typeof payload?.name === "string" ? payload.name : "";
  if (fileName === "") throw new ComfyError("上传参考图失败：" + text.slice(0, 200));
  const subfolder = typeof payload?.subfolder === "string" ? payload.subfolder : "";
  return subfolder === "" ? fileName : subfolder + "/" + fileName;
}

/** 探测 + 注入一步到位，给调用方（pipeline / seqgen）用的组合入口。 */
export interface ComfyPrepareInput extends ComfyInjectionInput {
  workflow: ComfyWorkflow;
  overrides?: ComfyBindingOverrides;
  /** `/object_info` 的查询结果（可选）：有它才能发现「工作流里没写的 optional IMAGE 输入」。 */
  info?: ComfyObjectInfo;
}

export interface ComfyPrepareResult {
  workflow: ComfyWorkflow;
  bindings: ComfyBindings;
  notes: string[];
}

export function prepareComfyWorkflow(input: ComfyPrepareInput): ComfyPrepareResult {
  const detected = detectComfyBindings(input.workflow, input.overrides ?? {}, input.info);
  const applied = applyComfyInputs(input.workflow, detected.bindings, input);
  return { workflow: applied.workflow, bindings: applied.bindings, notes: [...detected.notes, ...applied.notes] };
}
