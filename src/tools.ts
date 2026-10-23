/**
 * 游戏素材大师 —— 对话调用面（模型工具）。
 *
 * 目标：**插件里的每个功能都能通过对话调用**，多步流程（八方向图这种）
 * 让 agent 自己推进 / 等待 / 审查，也可以每一步停下来交给人验收。
 *
 * 工具分工：
 *
 * | 工具 | 作用 |
 * |---|---|
 * | `game_material_call` | 万能通道：插件全部远程方法逐个可调，覆盖全部功能 |
 * | `game_material_status` | 读一眼当前进度（项目 / 任务 / 阶段 / 是否有任务在跑） |
 * | `game_material_wait` | 阻塞等待到「没有任务在跑」或超时，回来就是可审查状态 |
 * | `game_material_review` | 出一个**验收包**：每个产物的绝对 URL、状态、通过标记、深链接 |
 * | `game_material_approve` | 打「通过 / 取消通过」（八方向图按阶段+方位，图片按张，序列帧按步骤） |
 *
 * 几个刻意的设计：
 *
 * - **不新增业务逻辑**：工具只是 `GameStudioGateway` 上已有方法的编排层，
 *   避免同一件事有两份实现（界面走远程服务，模型走工具，底层同一份代码）。
 * - **结果里永远带 `openUrl`**：模型把这条链接贴给用户，用户点一下就把
 *   Web GUI 切到插件对应页面验收。见 src/links.ts。
 * - **不重复提交**：生成类调用照旧由宿主半区拦重复提交，工具层不再拦一次
 *   （两层拦截会让报错信息变得莫名其妙）。
 */

import type { GameStudioGateway } from "./index.js";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DIRECTION_KEYS, directionOf } from "./directions.js";
import { listJobs } from "./pipeline.js";
import { listProjects, readProject } from "./store.js";
import { listImageJobs, readImageJob, sniffImage } from "./imagegen.js";
import { listSequenceJobs, readSequenceJob, listSequenceTasks } from "./seqgen.js";
import { listRigJobs, readRigJob, rigSnapshot } from "./riggen.js";
import { listTileProjects, readTileProject, tileSnapshot } from "./tilegen.js";
import { listMapProjects, mapSnapshot, readMapProject } from "./mapgen.js";
import { listMusicJobs, musicSnapshot, readMusicJob } from "./musicgen.js";
import { listSfxJobs, readSfxJob, sfxNextActions, sfxSnapshot } from "./sfxgen.js";
import { TOOL_METHODS } from "./wire.js";
import { MUSIC_STAGES, MAP_STAGES, SFX_STAGES, PANEL_KEY, STUDIO_MODULES, assetBasePath, buildOpenLink, originForLinks, type OpenIntent } from "./links.js";
import { loadConfig } from "./config.js";

/**
 * 八个模块的 key 与界面里的模块 key 完全一致。
 *
 * 真源是 `links.ts` 的 `STUDIO_MODULES`（配置层的 `hiddenModules` 也按它收敛），
 * 这里只是换个短名字。
 */
const MODULES = STUDIO_MODULES;
type ModuleKey = (typeof MODULES)[number];

/** 模块的中文名，与界面页签的 title 逐字一致（报错信息里直接引用）。 */
export const MODULE_LABELS: Record<ModuleKey, string> = {
  sprite: "八方向图生成",
  image: "图片生成",
  sequence: "序列帧生成",
  rig: "骨骼动画生成",
  tile: "45°地图地块生成",
  map: "地图编辑器（导入 tileset）",
  music: "音乐生成编辑",
  sfx: "音效生成"
};

/**
 * 远程方法 → 它属于哪个模块。
 *
 * 这张表是「隐藏了功能，AI 也调不到」的落点：`game_material_call` 每次调用都
 * 按它查一次模块再拦。`scripts/verify-tools.mjs` 有一条契约要求
 * **每个** `TOOL_METHODS` 方法要么在这里、要么在 `SHARED_TOOL_METHODS` 里——
 * 新加方法忘了归类会直接红，不会静默漏过。
 */
export const METHOD_MODULE: Record<string, ModuleKey> = {
  // 模块一 八方向图
  listProjects: "sprite",
  createProject: "sprite",
  getProject: "sprite",
  deleteProject: "sprite",
  renameProject: "sprite",
  uploadSource: "sprite",
  savePrompts: "sprite",
  saveSettings: "sprite",
  setApproved: "sprite",
  revealProject: "sprite",
  /** 本地自选视频（转圈 / 某个方向）与中间图片打包：都归八方向图模块。 */
  uploadVideo: "sprite",
  exportImages: "sprite",
  runImage: "sprite",
  runImages: "sprite",
  setImageMode: "sprite",
  runTurnVideo: "sprite",
  runTurnFrames: "sprite",
  setTurnPick: "sprite",
  setTurnPicks: "sprite",
  resetTurnPicks: "sprite",
  cutTurnFrames: "sprite",
  runVideos: "sprite",
  pollVideos: "sprite",
  clearVideos: "sprite",
  runFrames: "sprite",
  prepareFramePick: "sprite",
  setFramePick: "sprite",
  setFramePicks: "sprite",
  resetFramePicks: "sprite",
  rekey: "sprite",
  compose: "sprite",
  // 模块二 图片生成
  listImageJobs: "image",
  createImageJob: "image",
  getImageJob: "image",
  deleteImageJob: "image",
  saveImageJob: "image",
  uploadImageRef: "image",
  removeImageRef: "image",
  addImageItem: "image",
  removeImageItem: "image",
  runImageJob: "image",
  keyImageJob: "image",
  // 模块三 序列帧生成
  listSequenceJobs: "sequence",
  createSequenceJob: "sequence",
  getSequenceJob: "sequence",
  deleteSequenceJob: "sequence",
  saveSequenceJob: "sequence",
  uploadSequenceRef: "sequence",
  removeSequenceRef: "sequence",
  runSequenceVideo: "sequence",
  pollSequenceVideo: "sequence",
  clearSequenceVideo: "sequence",
  runSequenceFrames: "sequence",
  keySequenceFrames: "sequence",
  composeSequence: "sequence",
  // 模块四 骨骼动画生成
  listRigJobs: "rig",
  createRigJob: "rig",
  getRigJob: "rig",
  deleteRigJob: "rig",
  saveRigJob: "rig",
  uploadRigSource: "rig",
  uploadRigPart: "rig",
  removeRigPart: "rig",
  renameRigPart: "rig",
  setRigPartVisibility: "rig",
  saveRigLayoutItem: "rig",
  saveRigLayoutItems: "rig",
  setRigLayoutHints: "rig",
  setRigSemantics: "rig",
  setRigBoneOffsets: "rig",
  resetRigBoneOffsets: "rig",
  setRigAnimationSettings: "rig",
  resetRigAnimationSettings: "rig",
  getRigAnimation: "rig",
  saveRigAnimation: "rig",
  resetRigAnimation: "rig",
  runRigQa: "rig",
  setRigConstraints: "rig",
  resetRigConstraints: "rig",
  setRigMesh: "rig",
  resetRigMesh: "rig",
  setRigPath: "rig",
  resetRigPath: "rig",
  tintRigParts: "rig",
  uploadRigTexture: "rig",
  setRigTextureVersion: "rig",
  removeRigTextureVersion: "rig",
  runRigRedraw: "rig",
  runRigSheet: "rig",
  runRigSegment: "rig",
  runRigLayout: "rig",
  runRigBones: "rig",
  runRigAtlas: "rig",
  // 模块五 45°地图地块
  listTileProjects: "tile",
  createTileProject: "tile",
  getTileProject: "tile",
  deleteTileProject: "tile",
  saveTileProject: "tile",
  runTileItems: "tile",
  runTileItem: "tile",
  setTileApproved: "tile",
  runTileMap: "tile",
  saveTileMapCells: "tile",
  runTileExport: "tile",
  cancelTileJob: "tile",
  revealTileProject: "tile",
  // 模块六 地图编辑器（单项目 = 单张地图，全本地零计费）
  listMapProjects: "map",
  createMapProject: "map",
  getMapProject: "map",
  saveMapProject: "map",
  deleteMapProject: "map",
  importMapTileset: "map",
  importSampleTileset: "map",
  composeMapAsset: "map",
  recomposeMapTileset: "map",
  saveMapTileset: "map",
  removeMapTileset: "map",
  saveMapDoc: "map",
  applyMapOps: "map",
  mapUndo: "map",
  mapRedo: "map",
  mapPlan: "map",
  runMapGenerate: "map",
  runMapPreview: "map",
  runMapExport: "map",
  cancelMapJob: "map",
  setMapApproved: "map",
  revealMapProject: "map",
  // 模块七 音乐生成编辑
  getMusicGuide: "music",
  getMusicScoreGuide: "music",
  saveMusicScorePlan: "music",
  runMusicScore: "music",
  submitMusicScoreToSuno: "music",
  listMusicJobs: "music",
  createMusicJob: "music",
  getMusicJob: "music",
  saveMusicJob: "music",
  deleteMusicJob: "music",
  setMusicApproved: "music",
  revealMusicJob: "music",
  runMusicGeneration: "music",
  cancelMusicGeneration: "music",
  refreshMusicJob: "music",
  getMusicWav: "music",
  getMusicLrc: "music",
  listMusicHistory: "music",
  listMusicStemInstruments: "music",
  runMusicTool: "music",
  musicPeaks: "music",
  renderMusicEdit: "music",
  saveMusicVersion: "music",
  deleteMusicVersion: "music",
  exportMusic: "music",
  // 模块八 音效生成
  listSfxJobs: "sfx",
  createSfxJob: "sfx",
  getSfxJob: "sfx",
  saveSfxJob: "sfx",
  deleteSfxJob: "sfx",
  uploadSfxRef: "sfx",
  removeSfxRef: "sfx",
  runSfxGeneration: "sfx",
  cancelSfxGeneration: "sfx",
  setSfxApproved: "sfx",
  revealSfxJob: "sfx",
  exportSfx: "sfx"
};

/**
 * 不隶属于任何模块的方法：配置类 + 跨模块的审核模式
 * （`setReviewMode` 的模块在 payload 里，另外判）。
 */
export const SHARED_TOOL_METHODS: ReadonlySet<string> = new Set([
  "getConfig",
  "saveConfig",
  "testArk",
  "testCustomImage",
  "testMinimax",
  "testComfy",
  "testCustomVideo",
  "fetchCustomVideoModels",
  "testMusic",
  "testMusicScore",
  "testSfx",
  "setReviewMode"
]);

/**
 * 当前被隐藏的模块集合。
 *
 * 直接读配置缓存（`loadConfig` 命中内存缓存，不打盘），所以每次工具调用都能
 * 拿到**最新**的勾选：用户在设置里取消隐藏后，下一次调用立刻可用，不需要重启。
 */
async function hiddenModulesNow(): Promise<Set<string>> {
  const config = await loadConfig();
  return new Set(config.hiddenModules);
}

/**
 * 【功能管理】被隐藏的模块对模型一律不可用。
 *
 * 只在界面上藏起来是不够的：模型看不见页签，照样能调 `runTileItems` 真实计费。
 * 所以工具面必须自己再拦一次，并且报错里告诉用户去哪里打开。
 */
async function assertModuleVisible(module: ModuleKey | undefined): Promise<void> {
  if (module === undefined) return;
  const hidden = await hiddenModulesNow();
  if (hidden.has(module)) {
    throw new Error(
      `功能「${MODULE_LABELS[module]}」已被用户在「设置 → 游戏素材大师 → 功能管理」里隐藏，不能调用。` +
        `请让用户先在那里把它打开；不要绕过这一限制。`
    );
  }
}

/** 方法属于哪个模块（共享方法返回 undefined）。 */
export function moduleOfMethod(method: string, payload?: Record<string, any>): ModuleKey | undefined {
  if (method === "setReviewMode") return moduleOf(payload?.module);
  return METHOD_MODULE[method];
}

/** 工具名统一前缀，避免和别家插件撞名。 */
const PREFIX = "game_material_";

/** 远程资源路由前缀，与 index.ts 的 ROUTE_PREFIX 一致。 */
const ROUTE_PREFIX = "/dsh-game-material-master";

/** 输出 schema：工具返回值是不定形的 JSON，这里只约束到「对象」。 */
const OBJECT_SCHEMA = { type: "object", additionalProperties: true } as const;

const textBlocks = (text: string) => [{ type: "text", text }];
const asRecord = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" ? (value as Record<string, any>) : {};
const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

function moduleOf(value: unknown): ModuleKey | undefined {
  return typeof value === "string" && (MODULES as readonly string[]).includes(value) ? (value as ModuleKey) : undefined;
}

/** 任务 id 前缀决定它属于哪个模块（p… / i… / s… / r… / t… / m… / a… / f…）。 */
export function moduleForId(id: string): ModuleKey | undefined {
  if (/^p[a-z0-9]+$/.test(id)) return "sprite";
  if (/^i[a-z0-9]+$/.test(id)) return "image";
  if (/^s[a-z0-9]+$/.test(id)) return "sequence";
  if (/^r[a-z0-9]+$/.test(id)) return "rig";
  if (/^t[a-z0-9]+$/.test(id)) return "tile";
  if (/^m[a-z0-9]+$/.test(id)) return "map";
  if (/^a[a-z0-9]+$/.test(id)) return "music";
  if (/^f[a-z0-9]+$/.test(id)) return "sfx";
  return undefined;
}

/** 产物相对路径 → 浏览器可直接打开的绝对 URL。 */
function assetUrl(assetBase: string, relative: string | undefined): string | undefined {
  if (typeof relative !== "string" || relative === "") return undefined;
  return `${originForLinks()}${assetBase}${relative}`;
}

/**
 * 把工具返回值收拾成「能无损过 JSON」的形状。
 *
 * DSH（typert 0.1.7+）对工具返回值做无损 JSON 校验：对象里带一个 `undefined`
 * 的键、或者 `NaN` / `Infinity` / `-0` 这种 JSON 表达不了的数字，整次工具调用
 * 会**直接失败**，界面上只看到 `tool "…" returned invalid output: value is not
 * lossless JSON`——而产物其实好端端躺在磁盘上。
 *
 * 快照里的 `file` / `url` 这类可选字段是按 `file: node.file` 直接写的，节点还没
 * 生成时它就是 `undefined`（键在、值是 undefined）。所以「项目还没跑完」时
 * `status` / `review` / `wait` / `call getProject` 会全部报这个错，项目空空如也
 * 时反而看不出来——很容易误判成「插件装坏了」。
 *
 * 这里做的恰好是 `JSON.stringify` 本来就会做的事：丢掉 `undefined` 键、把
 * 非有限数字变成 `null`、`-0` 变成 `0`。**模型看到的内容与修复前完全一致**
 * （那三种值本来就会在序列化时消失），只是不再让整次调用失败。
 *
 * 只处理普通对象与数组；`Date` / `Buffer` 等非普通对象原样透传，交给各自的
 * 出口去序列化。原地整理：传进来的都是本函数刚组装出来的快照，不是共享状态。
 */
function jsonSafe<T>(value: T, seen = new Set<unknown>()): T {
  if (typeof value === "number") {
    if (Number.isNaN(value) || !Number.isFinite(value)) return null as unknown as T;
    return (Object.is(value, -0) ? 0 : value) as unknown as T;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = jsonSafe(value[i], seen);
    return value;
  }
  // 只碰普通对象；类实例（Date / Buffer…）保持原样。
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (child === undefined) delete record[key];
    else record[key] = jsonSafe(child, seen);
  }
  return value;
}

// ── 三份「状态快照」 ────────────────────────────────────────────────────
// 每份都返回纯 JSON：给模型看的是**判断所需的最小字段**，不是整个 project.json。

interface DirectionCell {
  direction: string;
  label: string;
  status: string;
  approved: boolean;
  stale: boolean;
  file?: string;
  url?: string;
  error?: string;
}

function cellsOf(
  nodes: Record<string, any>,
  assetBase: string,
  pick: (node: any) => { file?: string; url?: string; extra?: Record<string, unknown> }
): DirectionCell[] {
  return DIRECTION_KEYS.map((key) => {
    const node = nodes?.[key] ?? {};
    const picked = pick(node);
    return {
      direction: key,
      label: directionOf(key)?.label ?? key,
      status: String(node.status ?? "empty"),
      approved: node.approved === true,
      stale: node.stale === true,
      file: picked.file,
      url: picked.url ?? assetUrl(assetBase, picked.file),
      ...(picked.extra ?? {}),
      ...(typeof node.error === "string" && node.error !== "" ? { error: node.error } : {})
    };
  });
}

function spriteSnapshot(project: any) {
  const assetBase = assetBasePath(`${ROUTE_PREFIX}/assets/${project.id}/`);
  // 「还有没有活在跑」= 节点状态 + 宿主的后台任务表。只看节点不行：批量任务是
  // 一个方向一个方向开工的（抽帧并发只有 2），任务刚登记时八个方向可能都还不是
  // running，只看节点会让 game_material_wait 立刻返回 settled=true，
  // 而那时候一个产物都没出来。
  const busy = DIRECTION_KEYS.some(
    (key) =>
      project.images?.[key]?.status === "running" ||
      project.videos?.[key]?.status === "running" ||
      project.frames?.[key]?.status === "running"
  ) || project.sheet?.status === "running" || listJobs(project.id).length > 0;
  const count = (cells: DirectionCell[], status: string) => cells.filter((cell) => cell.status === status).length;
  const approved = (cells: DirectionCell[]) => cells.filter((cell) => cell.approved).length;

  const images = cellsOf(project.images, assetBase, (node) => ({ file: node.file }));
  // 转圈模式下每张方向图都是「第几帧」切出来的：验收包带上这个下标，
  // agent 才说得清「正面那帧截早了」这类问题，也才知道 setTurnPick 该往哪调。
  if (project.imageMode === "turn") {
    const total = project.turn?.frames?.frames?.length ?? 0;
    const duration = Number(project.turn?.frames?.duration ?? 0);
    for (const cell of images as any[]) {
      if (total <= 0) continue;
      const index = Math.min(total - 1, Math.max(0, Number(project.turn?.frames?.picks?.[cell.direction] ?? 0)));
      cell.frameIndex = index;
      cell.frameTotal = total;
      cell.frameSeconds = Number(((index * duration) / total).toFixed(2));
    }
  }
  const videos = cellsOf(project.videos, assetBase, (node) => ({ file: node.file }));
  const frames = cellsOf(project.frames, assetBase, (node) => ({ file: node.strip, extra: { frameCount: node.frames?.length ?? 0 } }));
  const sheetCell: DirectionCell[] = [
    {
      direction: "sheet",
      label: "整图",
      status: String(project.sheet?.status ?? "empty"),
      approved: project.sheet?.approved === true,
      stale: false,
      file: project.sheet?.file,
      url: assetUrl(assetBase, project.sheet?.file),
      // 抠像诊断：背景占比偏低 / 边框采样被大量排除，都是「抠歪了」的信号。
      ...(typeof project.sheet?.backgroundFraction === "number" ? { backgroundFraction: project.sheet.backgroundFraction } : {}),
      ...(typeof project.sheet?.borderSamplesDropped === "number" && project.sheet.borderSamplesDropped > 0
        ? { borderSamplesDropped: project.sheet.borderSamplesDropped, borderSamples: project.sheet.borderSamples }
        : {}),
      ...(typeof project.sheet?.error === "string" && project.sheet.error !== "" ? { error: project.sheet.error } : {})
    }
  ];

  return {
    module: "sprite" as const,
    id: project.id,
    name: project.name,
    sourceFile: project.source?.file ?? null,
    reviewMode: project.reviewMode ?? null,
    busy,
    /**
     * 阶段①的生成方式与它的转圈状态。
     *
     * 转圈模式下「八个方向图」不是八个节点各自生成的，而是同一段视频的八个
     * 截帧位置——验收包里必须把视频、缩略条带和八个位置一起给出来，
     * 否则 agent 看不到「圈转没转对」，只能对着一张张方向图猜。
     */
    imageMode: project.imageMode ?? "turn",
    turn: {
      direction: project.turn?.direction ?? "cw",
      videoStatus: project.turn?.video?.status ?? "empty",
      videoUrl: assetUrl(assetBase, project.turn?.video?.file),
      firstFrame: project.turn?.video?.firstFrame ?? null,
      remoteStatus: project.turn?.video?.remoteStatus ?? null,
      error: project.turn?.video?.error ?? null,
      framesStatus: project.turn?.frames?.status ?? "empty",
      stripUrl: assetUrl(assetBase, project.turn?.frames?.strip),
      frameCount: project.turn?.frames?.frames?.length ?? 0,
      duration: project.turn?.frames?.duration ?? null,
      stale: project.turn?.frames?.stale === true
    },
    /** 八个方向各自截在第几帧（转圈模式专用；逐方向生图时是空的）。 */
    turnPicks: project.imageMode === "turn" ? { ...(project.turn?.frames?.picks ?? {}) } : {},
    stages: [
      { stage: "images", title: "① 八方向绿幕图", ready: count(images, "ready"), running: count(images, "running"), error: count(images, "error"), approved: approved(images), total: 8, cells: images },
      { stage: "videos", title: "② 行走动作视频", ready: count(videos, "ready"), running: count(videos, "running"), error: count(videos, "error"), approved: approved(videos), total: 8, cells: videos },
      { stage: "frames", title: "③ 提取序列帧", ready: count(frames, "ready"), running: count(frames, "running"), error: count(frames, "error"), approved: approved(frames), total: 8, cells: frames },
      { stage: "sheet", title: "④ 抠绿幕合成整图", ready: sheetCell[0].status === "ready" ? 1 : 0, running: sheetCell[0].status === "running" ? 1 : 0, error: sheetCell[0].status === "error" ? 1 : 0, approved: sheetCell[0].approved ? 1 : 0, total: 1, cells: sheetCell }
    ],
    settings: {
      cellWidth: project.settings?.cellWidth,
      cellHeight: project.settings?.cellHeight,
      frameCount: project.settings?.frameCount,
      pixelSize: project.settings?.pixelSize,
      rowOrder: project.settings?.rowOrder
    },
    prompts: {
      video: project.prompts?.video,
      suffix: project.prompts?.suffix ?? "",
      images: project.prompts?.images
    },
    runningTasks: listJobs(project.id),
    logTail: Array.isArray(project.log) ? project.log.slice(-6).map((entry: any) => `${entry.level}: ${entry.message}`) : []
  };
}

function imageSnapshot(job: any) {
  const assetBase = assetBasePath(`${ROUTE_PREFIX}/image-assets/${job.id}/`);
  const items = (job.items ?? []).map((item: any) => ({
    index: item.index,
    status: item.status,
    approved: item.approved === true,
    source: item.source,
    file: item.file,
    url: assetUrl(assetBase, item.file),
    keyedFile: item.keyedFile,
    keyedUrl: assetUrl(assetBase, item.keyedFile),
    backgroundFraction: item.backgroundFraction,
    ...(typeof item.error === "string" && item.error !== "" ? { error: item.error } : {})
  }));
  return {
    module: "image" as const,
    id: job.id,
    name: job.name,
    reviewMode: job.reviewMode ?? null,
    busy: items.some((item: any) => item.status === "running"),
    prompt: job.prompt,
    suffix: job.suffix,
    refs: (job.refs ?? []).map((ref: any) => ref.file),
    settings: job.settings,
    keying: job.keying,
    items,
    review: {
      ready: items.filter((item: any) => item.status === "ready").length,
      approved: items.filter((item: any) => item.approved).length,
      error: items.filter((item: any) => item.status === "error").length
    }
  };
}

function sequenceSnapshot(job: any) {
  const assetBase = assetBasePath(`${ROUTE_PREFIX}/sequence-assets/${job.id}/`);
  const steps = [
    { step: "video", title: "① 生成视频", status: job.video?.status, approved: job.video?.approved === true, url: assetUrl(assetBase, job.video?.file), error: job.video?.error },
    { step: "frames", title: "② 抽帧 + 抠像", status: job.frames?.status, approved: job.frames?.approved === true, files: (job.frames?.files ?? []).map((file: string) => assetUrl(assetBase, file)), keyed: (job.frames?.keyed ?? []).map((file: string) => assetUrl(assetBase, file)), stale: job.frames?.stale === true, error: job.frames?.error },
    { step: "sheet", title: "③ 横向合成条图", status: job.sheet?.status, approved: job.sheet?.approved === true, url: assetUrl(assetBase, job.sheet?.file), error: job.sheet?.error }
  ];
  return {
    module: "sequence" as const,
    id: job.id,
    name: job.name,
    mode: job.mode,
    reviewMode: job.reviewMode ?? null,
    prompt: job.prompt,
    suffix: job.suffix,
    refs: {
      firstFrame: job.refs?.firstFrame?.file ?? null,
      lastFrame: job.refs?.lastFrame?.file ?? null,
      referenceImages: (job.refs?.referenceImages ?? []).length,
      referenceVideos: (job.refs?.referenceVideos ?? []).length
    },
    busy: steps.some((step) => step.status === "running"),
    settings: job.settings,
    keying: job.keying,
    steps,
    runningTasks: listSequenceTasks(job.id)
  };
}

/** 读一个目标（项目 / 图片任务 / 序列帧任务 / 骨骼动画任务）的快照。 */
async function snapshotOf(module: ModuleKey, id: string): Promise<any> {
  if (module === "sprite") {
    const project = await readProject(id);
    if (project === undefined) throw new Error(`找不到八方向图项目：${id}`);
    return spriteSnapshot(project);
  }
  if (module === "image") {
    const job = await readImageJob(id);
    if (job === undefined) throw new Error(`找不到图片任务：${id}`);
    return imageSnapshot(job);
  }
  if (module === "sequence") {
    const job = await readSequenceJob(id);
    if (job === undefined) throw new Error(`找不到序列帧任务：${id}`);
    return sequenceSnapshot(job);
  }
  if (module === "tile") {
    const project = await readTileProject(id);
    if (project === undefined) throw new Error(`找不到地图地块项目：${id}`);
    return tileSnapshot(project, originForLinks());
  }
  if (module === "map") {
    const project = await readMapProject(id);
    if (project === undefined) throw new Error(`找不到地图项目：${id}`);
    return mapSnapshot(project, originForLinks());
  }
  if (module === "music") {
    const job = await readMusicJob(id);
    if (job === undefined) throw new Error(`找不到音乐任务：${id}`);
    return musicSnapshot(job, originForLinks());
  }
  if (module === "sfx") {
    const job = await readSfxJob(id);
    if (job === undefined) throw new Error(`找不到音效任务：${id}`);
    return sfxSnapshot(job, originForLinks());
  }
  const job = await readRigJob(id);
  if (job === undefined) throw new Error(`找不到骨骼动画任务：${id}`);
  // 工具侧要的是**绝对** URL（会直接贴给用户点），所以带上已上报的 origin。
  return rigSnapshot(job, originForLinks());
}

/** 猜一个目标属于哪个模块：显式声明优先，其次按 id 前缀。 */
function resolveTarget(module: unknown, id: string): ModuleKey {
  const declared = moduleOf(module);
  if (declared !== undefined) return declared;
  const guessed = moduleForId(id);
  if (guessed === undefined) throw new Error(`无法判断 "${id}" 属于哪个模块，请显式给 module`);
  return guessed;
}

/** 目标 → 深链接意图。 */
function intentOf(module: ModuleKey, id: string, extra: { stage?: string; direction?: string } = {}): OpenIntent {
  if (module === "sprite") return { module, projectId: id, ...extra };
  return { module, jobId: id, ...extra };
}

/** 结果里统一带上的「打开界面」信息。 */
function openInfo(intent: OpenIntent, hint: string) {
  return { panel: PANEL_KEY, openUrl: buildOpenLink(intent), openHint: hint };
}

/**
 * 音乐方法对应的界面阶段：生成 / 编辑 / 导出。
 *
 * 深链接少一个 stage 也能打开任务，但「从对话里点回来看的是哪一步」会丢失；
 * 这里按方法名自动补，省得每个工具调用都自己传。
 */
function musicStageOf(method: string): "compose" | "generate" | "edit" | "export" | undefined {
  if (method === "exportMusic") return "export";
  if (method === "renderMusicEdit" || method === "saveMusicVersion" || method === "deleteMusicVersion" || method === "musicPeaks") return "edit";
  if (method === "getMusicScoreGuide" || method === "saveMusicScorePlan" || method === "runMusicScore") return "compose";
  if (
    method === "runMusicGeneration" ||
    method === "submitMusicScoreToSuno" ||
    method === "getMusicWav" ||
    method === "getMusicLrc" ||
    method === "refreshMusicJob" ||
    method === "cancelMusicGeneration" ||
    method === "getMusicJob"
  ) {
    return "generate";
  }
  return undefined;
}

/** 音效方法对应的界面阶段：生成 / 导出。 */
function sfxStageOf(method: string): "generate" | "export" | undefined {
  if (method === "exportSfx") return "export";
  if (method === "setSfxApproved" || method === "revealSfxJob" || method === "deleteSfxJob") return undefined;
  return "generate";
}

/**
 * 从一次远程调用的入参（和已经拿到的返回值）里推断该打开哪个界面。
 * 推断不出来（例如 listProjects）就不给链接，免得把用户带到一个空页面上。
 *
 * `value` 只有少数方法用得上：链接里要带的**产物路径**是算出来的，不在入参里。
 */
function intentFromCall(method: string, payload: Record<string, any>, value?: any): OpenIntent | undefined {
  const projectId = asString(payload.projectId);
  const jobId = asString(payload.jobId);
  const stage = typeof payload.stage === "string" ? payload.stage : undefined;
  /**
   * `composeMapAsset` 是「AI 生成素材」那条链路的终点：它整理出来的图**还不是素材**
   * —— 素材属性在「新增素材」那一刻定死，所以要用户自己点一次「确定」。
   * 链接因此带上 `dialog=add&asset=<相对路径>&frames=<帧数>&shape=<形态>`：
   * 点开落在地图编辑器、素材窗口展开、「新增素材」已经打开并**按形态**预填好
   * （少了 `shape` 的话拼块 / 整格会被预选成「普通」，导入出来的块全是碎的，而且不报错）。
   */
  if (method === "composeMapAsset") {
    const file = typeof value?.file === "string" ? value.file : "";
    const frames = typeof value?.frameCount === "number" ? value.frameCount : undefined;
    const shape = typeof value?.shape === "string" ? value.shape : undefined;
    /**
     * 素材图是**每格几倍分辨率**：`composeMapAsset` 会先留到 4 倍（保留细节），
     * 「新增素材」据此知道导入时还要按用户选的清晰度缩到格子上 —— 链接里少这个数，
     * 界面就会把 4 倍图切成 16 倍的碎块（而且不报错）。
     */
    const scale = typeof value?.scale === "number" && value.scale > 1 ? value.scale : undefined;
    /**
     * 整图：占几格也要带上（`shape=stamp` 时「新增素材」按它预填）。
     * 少了它只能退回默认 3×3，图与占格对不上会被拉伸 —— 而且这种拉伸不报错。
     */
    const stamp = value?.stamp;
    const cols = typeof stamp?.cols === "number" ? stamp.cols : undefined;
    const rows = typeof stamp?.rows === "number" ? stamp.rows : undefined;
    /** 整理时已经抠过绿幕 → 回链带 `keyed=1`，界面就不会再抠第二遍。 */
    const keyed = typeof value?.keyed === "number" && value.keyed > 0 ? 1 : undefined;
    if (projectId === "") return { module: "map" };
    return {
      module: "map",
      jobId: projectId,
      stage: "assets",
      ...(file === "" ? {} : { dialog: "add", asset: file }),
      ...(frames === undefined ? {} : { frames }),
      ...(shape === undefined ? {} : { shape }),
      ...(scale === undefined ? {} : { scale }),
      ...(cols === undefined ? {} : { cols }),
      ...(rows === undefined ? {} : { rows }),
      ...(keyed === undefined ? {} : { keyed })
    };
  }
  /**
   * ⚠️ **先按方法名认模块，再看字段名。**
   *
   * 以前是先判 `payload.projectId` 非空就当八方向图 —— 于是模块二/三/四/五/六里
   * 凡是入参叫 `projectId` 的方法（`runTileMap`、`getMapProject`、`saveMapDoc`…）
   * 返回的 openUrl 全都指向 `module=sprite&project=<别人的 id>`，用户点进去落在
   * 八方向图页面上，看着就是「链接是坏的」。字段名靠不住，方法归属才是真源
   * （`METHOD_MODULE`），非 sprite 模块的 id 一律放 `jobId`（宿主 `intentOf` 的约定）。
   */
  const owner = METHOD_MODULE[method];
  if (owner !== undefined && owner !== "sprite") {
    const targetId = projectId !== "" ? projectId : jobId;
    const autoStage = owner === "music"
      ? method === "getMusicJob" && value?.workflow === "compose"
        ? "compose"
        : musicStageOf(method)
      : owner === "sfx"
        ? sfxStageOf(method)
        : undefined;
    const effectiveStage = stage ?? autoStage;
    const scoreId = typeof value?.scoreId === "string" && value.scoreId !== "" ? value.scoreId : undefined;
    return targetId === ""
      ? { module: owner }
      : {
          module: owner,
          jobId: targetId,
          ...(effectiveStage === undefined ? {} : { stage: effectiveStage }),
          ...(owner === "music" && scoreId !== undefined ? { scoreId } : {})
        };
  }
  // 两个导入入口都是「素材」这一步：链接直接展开素材窗口，省得用户自己找。
  if (method === "importMapTileset" && projectId !== "") {
    return { module: "map", jobId: projectId, stage: "assets" };
  }
  if (projectId !== "") {
    const framePick = method === "prepareFramePick" || method === "setFramePick" || method === "setFramePicks" || method === "resetFramePicks";
    return { module: "sprite", projectId, stage: framePick ? "frames" : stage };
  }
  if (jobId !== "") {
    const module = moduleForId(jobId);
    return module === undefined ? undefined : { module, jobId };
  }
  if (method.startsWith("listRigJob") || method.startsWith("createRigJob")) return { module: "rig" };
  if (method.startsWith("listTileProject") || method.startsWith("createTileProject")) return { module: "tile" };
  if (method.startsWith("listMapProject") || method.startsWith("createMapProject")) return { module: "map" };
  if (method.startsWith("listMusicJob") || method.startsWith("createMusicJob")) return { module: "music" };
  if (method.startsWith("listSfxJob") || method.startsWith("createSfxJob")) return { module: "sfx" };
  if (method.startsWith("listImageJob") || method.startsWith("createImageJob")) return { module: "image" };
  if (method.startsWith("listSequenceJob") || method.startsWith("createSequenceJob")) return { module: "sequence" };
  if (method.startsWith("listProject") || method.startsWith("createProject")) return { module: "sprite" };
  return undefined;
}

// ── 工具注册 ────────────────────────────────────────────────────────────

/** `game_material_call` 的描述：把每个远程方法的用途与入参写清楚。 */
const CALL_DESCRIPTION = [
  "调用「游戏素材大师」插件的任意远程方法——插件界面上的每个功能都能在这里调用。",
  "配置：getConfig() / saveConfig(payload: 任意配置字段，如 arkApiKey、arkModel、imageProvider(ark|custom)、customProtocol(openai|comfyui|sdwebui)、customBaseUrl、customModel、customWorkflow、videoProvider(minimax|comfy|custom)、customVideoBaseUrl、customVideoModel、minimaxModel、sfxApiKey、sfxModel、sfxBaseUrl、cellWidth…) / testArk() / testCustomImage() / testMinimax() / testComfy() / testCustomVideo() / fetchCustomVideoModels() / testSfx()",
  "  ★ 生图后端有两种：`ark`（火山方舟 Seedream，默认）与 `custom`（用户自己的服务，协议可选 openai / comfyui / sdwebui）。",
  "    换后端只改 imageProvider 一个字段，八方向图 / 图片生成 / 骨骼动画 / 地图地块全都跟着走；图生视频走 MiniMax，也可以改走本机 / 远端 ComfyUI（comfyVideo 开关）。",
  "  ⚠️ 用户可以在「设置 → 游戏素材大师 → 功能管理」里隐藏某些功能模块。被隐藏的模块**工具面一律拒绝**（界面也看不到），",
  "    调用会直接报错并说明去哪里打开；不要试图绕过。hiddenModules 本身只能由用户在设置界面里改，工具面不允许写。",
  "八方向图：listProjects() / createProject({name}) / getProject({projectId}) / deleteProject({projectId}) / renameProject({projectId,name}) /",
  "  uploadSource({projectId,name,data:base64}) / savePrompts({projectId,images?,video?,turn?,videoPerDirection?,suffix?,resetImagesToDefault?,resetVideoToDefault?,resetTurnToDefault?}) /",
  "  saveSettings({projectId,settings}) / setApproved({projectId,stage:images|videos|frames|sheet,key?,approved}) / revealProject({projectId}) /",
  "  uploadVideo({projectId,key:turn|<方向>,name,data:base64})【★本地自选视频：两处「要生成视频」的地方都能用自己电脑上的视频顶替远程生成——key=turn 是转圈视频（导入后自动抽候选帧并切八张图），key=<方向> 是某一段行走视频（之后到第 3 步抽帧）；产物与远端生成完全同形，`origin:'local'` 标注来路】/",
  "  exportImages({projectId})【把所有中间图片（八方向绿幕图 / 转圈候选帧与条带 / 每段视频的绿幕帧与抠像帧 / 整图）打成一个 zip 落在 out/ 下，返回 file 与 assetBase 供下载】/",
  "  runImage({projectId,key,prompt?}) / runImages({projectId,force?}) / runVideos({projectId,keys?,regenerate?}) / pollVideos({projectId}) /",
  "  clearVideos({projectId,keys?}) / runFrames({projectId,keys?})【整段等分，同一套规则】 / rekey({projectId}) / compose({projectId})",
  "  prepareFramePick({projectId,key,count?})【只抽这一个方向的候选帧，免费】/ setFramePick({projectId,key,slot,index})【拖动第 slot 个输出帧到候选 index】/",
  "  setFramePicks({projectId,key,picks:[index,…]})【一次写回，长度必须等于每段抽帧数】/ resetFramePicks({projectId,key})【圆圈回到等分】",
  "阶段①「八方向绿幕图」有两种生成方式（默认转圈截帧）：",
  "  setImageMode({projectId,mode:turn|direct})【turn=转圈截帧（默认）：先生成一段「原地匀速转一整圈」的视频，再按时间截出八个方向，一致性好；direct=逐方向生图（备选）】/",
  "  runTurnVideo({projectId})【★花钱：一次 MiniMax 调用，整圈只有这一段视频】/ runTurnFrames({projectId,count?})【本地 ffmpeg 抽候选帧并切出八张方向图，免费】/",
  "  setTurnPick({projectId,key,index})【改某个方向的截帧位置（圆圈拖动），只重切那一张】/ setTurnPicks({projectId,picks:{front:index,…}})【看完整圈条带后整份写回】/",
  "  resetTurnPicks({projectId,direction?cw|ccw})【八个位置回到默认等分；direction 决定左右斜向怎么排】/ cutTurnFrames({projectId,keys?})",
  "  转圈模式的产物就是 images/<方向>.png（与逐方向生图完全相同），所以阶段②③④不用换做法。",
  "图片生成：listImageJobs() / createImageJob({name}) / getImageJob({jobId}) / deleteImageJob({jobId}) /",
  "  saveImageJob({jobId,name?,prompt?,suffix?,settings?,keying?,approved?,index?}) / uploadImageRef({jobId,name,data}) / removeImageRef({jobId,file}) /",
  "  addImageItem({jobId,name,data}) / removeImageItem({jobId,index}) / runImageJob({jobId,count?}) / keyImageJob({jobId})",
  "序列帧：listSequenceJobs() / createSequenceJob({name}) / getSequenceJob({jobId}) / deleteSequenceJob({jobId}) /",
  "  saveSequenceJob({jobId,name?,mode?,prompt?,suffix?,settings?,keying?,approved?,step?}) / uploadSequenceRef({jobId,kind:firstFrame|lastFrame|referenceImage|referenceVideo,name,data}) /",
  "  removeSequenceRef({jobId,kind,file?}) / runSequenceVideo({jobId}) / pollSequenceVideo({jobId}) / clearSequenceVideo({jobId}) /",
  "  runSequenceFrames({jobId,count?}) / keySequenceFrames({jobId}) / composeSequence({jobId})",
  "  ★ getImageJob / getSequenceJob 都回一个 `dir`（**本机绝对目录**）：把生成结果交给别的模块时用得上——",
  "    图片生成的作品绝对路径 = `dir + \"/\" + items[i].file`（形如 out/img-00.png）；序列帧抽好的帧看 `frames.files`，绝对路径 = `dir + \"/\" + file`。",
  "骨骼动画生成：listRigJobs() / createRigJob({name}) / getRigJob({jobId}) / deleteRigJob({jobId}) /",
  "  saveRigJob({jobId,name?,sheetPrompt?,suffix?,resetSheetPrompt?,settings?,approved?,stage?parts|layout|rig|atlas,part?}) /",
  "  uploadRigSource({jobId,name,data:角色整图}) / uploadRigPart({jobId,name:部件名,data:部件PNG}) / removeRigPart({jobId,name}) /",
  "  setRigPartVisibility({jobId,name,hidden}) / saveRigLayoutItem({jobId,name,x?,y?,width?,height?,rotation?,z?}) /",
  "  setRigSemantics({jobId,parts:[{name,role?,parent?,proximal?,distal?,tags?}]})【语义：这块是什么、挂在谁身上、骨骼从哪端伸到哪端】/",
  "  setRigBoneOffsets({jobId,bones:[{name,x?,y?,rotation?}]}) / resetRigBoneOffsets({jobId,names?})【手工骨骼偏移，重跑骨骼不会覆盖它】/",
  "  setRigAnimationSettings({jobId,animations:[{id,duration?,amplitude?}]}) / resetRigAnimationSettings({jobId,ids?})【动画参数】/",
  "  tintRigParts({jobId,names?|tag?,tint:{hue?,saturation?,lightness?,brightness?,contrast?,rgb?},note?})【换色，落成新版本】/",
  "  uploadRigTexture({jobId,name,data}) / setRigTextureVersion({jobId,name,version}) / removeRigTextureVersion({jobId,name,version})【贴图版本】/",
  "  runRigRedraw({jobId,name,prompt,erode?})【★花钱：一次 Seedream 调用，用生图模型重绘单个部件】/",
  "  runRigSheet({jobId})【花钱：一次 Seedream 调用，把角色拆成部件摊平图】/ runRigSegment({jobId})【本地分割，免费】/",
  "  runRigLayout({jobId,names?})【本地装配定位，免费；只给 names 就只重跑那几个部件】/",
  "  runRigBones({jobId})【本地生成骨架与动画，同时产出 Spine 4.2 skeleton.json 与 DragonBones 5.5 skeleton_ske.json】/",
  "  runRigAtlas({jobId})【本地打包图集，同时产出 Spine .atlas 与 DragonBones _tex.json】",
  "  ★ 自动摆位不准时用 setRigLayoutHints：先 read_image 看 getRigJob 返回的 partsMontagePath（部件按 partsOrder 顺序排列）",
  "45°地图地块生成（模块五，**实验性**）：listTileProjects() / createTileProject({name,style?,lang?,settings?}) / getTileProject({projectId,lang?}) /",
  "  deleteTileProject({projectId}) / saveTileProject({projectId,lang?,name?,style?,items?,settings?,resetItemsToDefault?})【改 style / items / settings 会让已生成的地块作废，重跑要花钱】/",
  "  runTileItems({projectId,keys?})【★花钱：按清单逐类生成，每个变体一次 Seedream 调用】/ runTileItem({projectId,key,variant?})【★花钱：只重跑某一张】/",
  "  setTileApproved({projectId,key?,variant?,approved})【② 验收，只打勾不作废任何东西】/",
  "  runTileMap({projectId,rows?,cols?,seed?,fill?,decorDensity?})【③ 本地铺图，免费，同种子 + 同布局 = 逐像素一致】/",
  "  saveTileMapCells({projectId,cells?,decor?,buildings?,seed?})【手动改布局，不作废已花钱的地块】/",
  "  runTileExport({projectId})【④ 导出地块包 + 地图 PNG + 布局 JSON，免费】/ cancelTileJob({projectId}) / revealTileProject({projectId})",
  "  ★ 四个阶段：generate → review → map → export。**没有「先做模板」这一步** —— 等距参考图在 runTileItems 开始时",
  "    按各建筑地块的占格形状自动渲染（形状 / 格子尺寸没变就直接复用，免费、不额外调用）。",
  "  ★ 几何交给代码、内容交给 AI：参考图由本机渲染，AI 只填菱形内部；生成后本地量一次、仿射对齐回标准菱形。",
  "地图编辑器（模块六，**全本地、零计费**；导入自己的素材图，四步：素材图 → 自动连接 → 环绕画布 → 导出 PNG/存档）：",
  "  listMapProjects() / createMapProject({name,grid?,cols?,rows?}) / getMapProject({projectId,lang?}) / saveMapProject({projectId,name}) / deleteMapProject({projectId}) /",
  "  importMapTileset({projectId,name,data:素材图base64,cell?,shape?,animRows?,fps?,clarity?,scale?})【新增素材：属性这一下就定死，之后只能删掉重来；cell/shape/animRows 留空 = 自动识别；fps = 这个素材自己的动画播放速度（0.5~30 帧/秒，留空 = 跟「设置 → 动画速度」那条全局速度走）；clarity = 把大图缩到格子的方式（smooth 面积平均，默认 / sharp 最近邻 / crisp 平均+锐化）；scale = 素材图每格几倍（默认 1，AI 那条路是 4）】/ importSampleTileset({projectId})【内置素材：本机现算、零成本，4 张自动连接图 + 1 张道具图；属性不可改、可删、可一键恢复】/",
  "  composeMapAsset({projectId,name?,files:[本机绝对路径…],shape?,cell?,animRows?,stampCols?,stampRows?})【把 AI 生成的那几张图按**事先定好的素材形态**整理成一张待确认的素材图，落在项目 `ai/` 下；返回 {file,shape,cell,width,height,frameCount,variants,animRows,scale,notes,stamp?}。四种形态的输入约定：`plain`（普通，默认）每张 = 一帧（一格内容）→ 裁到网格后竖排成一列（多张 = 翻页图）；`corner16`（整格）**只能 1 张** = **一块**无缝墙砖 → 宿主从这一块砖拼出 16 种接法（断口由代码加收口）；`a2quad`（拼块）每张 = **一个变体的一块**无缝材质 → 拼成 N 列 × 5 行；`stamp`（整图，多格印花）**每张 = 一帧的整张画** + 必须给 `stampCols`/`stampRows`（占几格，2~8）→ 宿主按占格切成 N×M 格、并烘出 4 个旋转，地图上一次印一整张（区域 / 通行性在导入时由用户点选）。**不要自己先拼多格排布**：模型画的多格各自独立，拼到地图上每一处交界都有缝（这条是实测返工过的）。**这一步只整理、不进素材列表** —— 返回的 openUrl 会让地图编辑器弹出「新增素材」并按这个形态预填好，用户点「确定」才真的导入。cell 留空 = 用地图项目的网格】/",
  "  ★ 「AI 生成素材」固定流程（地图编辑器素材窗口那颗按钮会自动开一个新对话并发来需求）：提示词里参数已齐、形态多半也定了、审核模式已定，**不要再问、不要停下等确认**。",
  "    ① 先定这块素材怎么用：成片铺开、边缘要自动接上（草地 / 水面 / 沙地 / 岩浆 / 雪地）→ `a2quad`（拼块）；要连成一条、拐角要对上（墙 / 路 / 栅栏 / 桥 / 管道）→ `corner16`（整格）；一块一块单独摆、不跟邻居接（树 / 箱子 / 道具 / 装饰）→ `plain`（普通）。",
  "    整格 / 拼块都只画**一块无缝砖**（不要画多格排布，也不要在砖里画边框 / 收口），怎么拼由宿主做。",
  "    ② 按这个形态规划生图（提示词里会写清每种形态该画几行几列、每块画什么）。",
  "    ③ 生成：帧数 1 = 图片生成 count:1；帧数 > 1 + 生图模型 = 图片生成 count:N；帧数 > 1 + 视频模型 = 先图片生成 count:1 当首帧 → 序列帧 upload(firstFrame) → runSequenceVideo → runSequenceFrames count:N。",
  "    ④ `composeMapAsset({projectId,name,files,shape:'<上面那个形态>'})` 整理（**必须把形态传进去**，宿主按它规整几何），最后把它返回的 openUrl 原样贴成 Markdown 链接。",
  "  recomposeMapTileset({projectId,tilesetId,files,clarity?})【★原地重烘一张素材：用同一份源图按**现在**的规则重新合成（整格给 1 张、普通/拼块按帧序给 N 张），保留素材 id 与图块序号 —— 地图上已经画好的格子一个都不用重画。整格/拼块的 16 块是烘进素材图的（收口、竖段换向、转角斜接都在里面），规则一改就只能靠这条重烘；删掉重导会把它画过的格子清空】/\n  saveMapTileset({projectId,tilesetId,name?,cell?,shape?,animRows?,fps?})【形态由尺寸自动识别，改形态/删素材会让图块序号平移，宿主按「素材 id + 图块 id」自动重新映射每格；fps 是**表现层**属性（0.5~30 帧/秒，null = 回到跟全局），改它不动几何、不动序号，随时能改 —— 一张地图上不同素材可以各走各的速度】/ removeMapTileset({projectId,tilesetId}) /",
  "  saveMapDoc({projectId,name?,cols?,rows?,layers?,addLayer?,removeLayerId?,moveLayer?,clearLayerId?,wrap?})【地图只有一张：改尺寸/图层/环绕都走它】/",
  "  applyMapOps({projectId,ops,stroke?,have?})【★ agent 也能画：ops = [{kind:'paint',layerId,cells:[{r,c,tile}]}, {kind:'fill',layerId,r,c,tile}, {kind:'rect',layerId,r0,c0,r1,c1,tile,filled}, {kind:'replace',layerId,from,to}]；tile 取 getMapProject 的 view.tilesets[].palette[].index（1 起，0 = 空）。have = 界面已有的 chunk key，宿主只回真正失效的 dropKeys】/",
  "  mapUndo({projectId,have?}) / mapRedo({projectId,have?})【宿主持撤销栈，界面不用管】/ mapPlan({projectId,view:{x,y,width,height},have?,layerIds?})【绘制计划：每项 = {l 层, r,c 格号, t 图块序号, x,y 目标像素, a 不透明度, cycle? 动画帧序}，界面画布与导出 PNG 执行同一份】/",
  "  runMapGenerate({projectId,kind:'random'|'maze'|'continent',tiles?,seed?,layerId?})【一键铺满：整层一次提交、一次撤销；同种子逐字节可复现】/",
  "  runMapPreview({projectId})【验收预览图 preview/map.png】/ runMapExport({projectId,scale?,formats?})【formats = {png?,json?,tilesets?,zip?}：默认 png+json，**产物超过一个自动打一个 zip**（zip:false 关掉）；tilesets:true 会把素材原图一起拷进 tilesets/，整包自包含；manifest.json 是我们自己的账本】/",
  "  cancelMapJob({projectId}) / setMapApproved({projectId,stage?,approved})【stage 空 = 四阶段全打】/ revealMapProject({projectId,target?})【target:'export' 打开导出目录，省略 = 项目目录】",
  "  ★ 四个阶段：素材（assets）→ 自动连接（rules，宿主自动完成、界面不显示）→ 地图（paint）→ 导出（export）。**没有任何一步需要 API Key**。",
  "  ★ 地图四周**环绕**：视口范围可以越出边界，宿主会把这些格子映射回图内；一张地图就一个 `map.json`，没有多地图。",
  "    生成的几何报告看 game_material_review 返回的 variants[].geomMode —— measured 是量测成功，template 是回退模板几何。",
  "    出现 template 多半是模型不对：必须用 Seedream 5.0 系列；4.0 会把 2:1 等距菱形画成近正方形（实测比例 1.058）。",
  "音乐生成编辑（模块七；直接生成走谱乐 AI、按积分计费；谱曲模式本地免费）：getMusicGuide({lang?})【直接生成指南】/ getMusicScoreGuide({lang?})【谱曲模式 scoremill 指南】/ listMusicJobs() / createMusicJob({name?,source?,settings?,reviewMode?,workflow:generate|compose}) / getMusicJob({jobId,lang?}) / saveMusicJob({jobId,name?,source?,settings?,reviewMode?}) / deleteMusicJob({jobId}) /",
  "  saveMusicScorePlan({jobId,plan})【保存谱曲方案，免费；plan 含 summary/style/mood/key/tempo/timeSignature/structure/instrumentation/sunoTags/sunoPrompt/negativeTags 等】/",
  "  runMusicScore({jobId,title?,plan?,script,basedOn?,label?})【★本地免费：script 是 scoremill Python，必须 s.save('score.mid')；宿主跑 Python、解析 MIDI、渲染试听，返回 openUrl】/",
  "  submitMusicScoreToSuno({jobId,scoreId?,confirm:true,model?,params?,regenerate?,copyrightAudio?,audioWeight?})【★计费：先把这一版试听音频上传给 Suno 作为参考（标准上传免费），再走 cover；**不上传 MIDI 原文件**；Suno 判定版权时需 copyrightAudio:true 走付费版权通道；已有歌曲必须 regenerate:true】/",
  "  setMusicApproved({jobId,stage?,songId?,versionId?,scoreId?,approved}) / revealMusicJob({jobId}) /",
  "  runMusicGeneration({jobId,engine,mode,model?,params?,regenerate?})【★计费：engine=suno|mureka|minimax|aceStep；mode 见指南；params 用 camelCase 或 API 的 snake_case 都收】/",
  "  cancelMusicGeneration({jobId})【只停本地轮询，已提交的仍会完成并计费】/ refreshMusicJob({jobId})【补查/补下载/恢复工具轮询】/",
  "  getMusicWav({jobId,songId}) / getMusicLrc({jobId,songIds?}) / listMusicHistory({page?,size?,filters?}) / listMusicStemInstruments() /",
  "  runMusicTool({jobId,kind,params?})【kind=stems|pro-stems|midi|sheet-music|style-analysis|convert；工具接口只接受公开 http(s) URL】/",
  "  musicPeaks({jobId,songId?,versionId?,scoreId?,buckets?}) / renderMusicEdit({jobId,songId?,versionId?,ops,label?,preview?,force?})【本地 ffmpeg，免费；ops={start,end,gainDb,fadeIn,fadeOut,normalize,lufs,truePeak,format,bitrate,channels,sampleRate}】/",
  "  saveMusicVersion({jobId,versionId,label?}) / deleteMusicVersion({jobId,versionId}) / exportMusic({jobId,songId?,versionId?,scoreId?,format?,name?,zip?})【导出到 out/，返回可下载 URL；给 scoreId 时导出乐谱包 MIDI+试听+方案+compose.py】",
  "  ★ 直接生成：先 getMusicGuide；用户给完整歌词时以歌词为权威文本；Suno 每次提交返回 2 首；已有歌曲后再生成必须 regenerate:true；生成后用 game_material_wait，再做后期或让用户点 openUrl 回界面。",
  "  ★ 谱曲模式：先 saveMusicScorePlan（方案用用户语言输出给用户看；manual 停下等确认）→ runMusicScore（本地免费）→ 贴 openUrl 让用户试听 → 有意见就 runMusicScore 出新版本（basedOn）→ 只有用户明确要求才 submitMusicScoreToSuno（计费；先上传试听音频再 cover，不上传 MIDI 原文件）。",
  "音效生成（模块八；火山引擎 Seed-Audio，每次生成真实计费）：listSfxJobs() / createSfxJob({name?,prompt,settings?:{format?,sampleRate?,speechRate?,loudnessRate?,pitchRate?,watermark?},reviewMode?}) / getSfxJob({jobId}) / saveSfxJob({jobId,name?,prompt?,settings?,reviewMode?}) / deleteSfxJob({jobId}) /",
  "  uploadSfxRef({jobId,kind:image|audio,name?,data})【参考图 1 张 / 参考音频 ≤3 条，两者互斥，单文件 ≤10MB】/ removeSfxRef({jobId,kind,file?}) /",
  "  runSfxGeneration({jobId})【★计费：同步接口，宿主包成后台任务；一次一条 take，失败不自动重试】/ cancelSfxGeneration({jobId})【只停本地请求，远端可能仍会完成并计费】/",
  "  setSfxApproved({jobId,stage?:generate|export,approved}) / revealSfxJob({jobId}) / exportSfx({jobId,takeId?,zip?})【导出到 out/；zip 打包全部 take】/",
  "  ★ 音效提示词当导演脚本写：声源 + 环境 + 强度/节奏 + 时长；单次输出上限 120 秒（没有 duration 参数）。参考音频在提示词里用 @音频1…@音频3；参考图与参考音频不能混用。失败重试会再计费，先问用户。",
  "说明：key 是方向英文字面量（front/back/downLeft/downRight/upLeft/upRight/left/right）；data 是原始文件字节的 base64（不带 data: 前缀）；",
  "生成类方法立刻返回 {started:true}，接着用 game_material_wait 等它跑完，再用 game_material_review 拿验收包。",
  "调用结果里若带 openUrl，请把它作为 Markdown 链接贴给用户，用户点击即切换到插件对应页面。"
].join("\n");

export interface StudioToolHost {
  /** 模型工具服务；缺失时不注册（例如最小化的测试组合）。 */
  tools?: { register: (definition: any) => () => void };
  /** 系统提示词服务；缺失时不注册工作流说明。 */
  systemPrompt?: { section: (section: { name: string; order: number; text: string }) => () => void };
}

/**
 * 注册对话调用面。
 *
 * @param host - 可选服务（tools / systemPrompt）
 * @param gateway - 已经注册成 typert 远程服务的网关实例，工具直接复用它的方法
 * @returns 每个贡献的 disposer 列表（按注册顺序）
 */
export function registerStudioTools(host: StudioToolHost, gateway: GameStudioGateway): Array<() => void> {
  const disposers: Array<() => void> = [];
  const tools = host.tools;

  /**
   * 统一的注册包装：把 output schema 与 render 固定下来，并让**每一个**工具
   * 的返回值都过一遍 `jsonSafe`（DSH 的新版会对工具输出做无损 JSON 校验，
   * 漏掉 `undefined` 键会让整次调用失败，见 jsonSafe 的注释）。
   */
  const register = (definition: Record<string, any>): void => {
    if (tools === undefined) return;
    const execute = definition.execute;
    const wrapped =
      typeof execute === "function"
        ? {
            ...definition,
            async execute(...args: any[]) {
              return jsonSafe(await execute.apply(this, args));
            }
          }
        : definition;
    disposers.push(tools.register(wrapped));
  };

  if (tools !== undefined) {
    register({
      name: `${PREFIX}call`,
      description: CALL_DESCRIPTION,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          method: { type: "string", enum: TOOL_METHODS.map((entry) => entry.method), description: "要调用的远程方法名。" },
          payload: { type: "object", additionalProperties: true, description: "方法入参对象；无参方法可省略。" }
        },
        required: ["method"]
      },
      output: {
        schema: OBJECT_SCHEMA,
        render: (_args: unknown, value: any) => textBlocks(renderCallResult(value))
      },
      async execute(args: any) {
        const method = asString(args?.method);
        const spec = TOOL_METHODS.find((entry) => entry.method === method);
        if (spec === undefined) throw new Error(`未知方法：${method}`);
        const payload = args?.payload === undefined ? undefined : asRecord(args.payload);
        if (spec.payload && payload === undefined) throw new Error(`${method} 需要一个 payload 对象`);
        if (!spec.payload && payload !== undefined && Object.keys(payload).length > 0) {
          throw new Error(`${method} 不接受 payload`);
        }
        // 「功能管理」的两道闸：被隐藏的模块整体拒掉；可见性本身只许用户在设置页里改。
        await assertModuleVisible(moduleOfMethod(method, payload));
        if (method === "saveConfig" && payload?.hiddenModules !== undefined) {
          throw new Error(
            "hiddenModules（功能可见性）只能由用户在「设置 → 游戏素材大师 → 功能管理」里修改，工具面不允许改动。"
          );
        }
        const fn = (gateway as any)[method];
        if (typeof fn !== "function") throw new Error(`方法未实现：${method}`);
        let value: unknown;
        try {
          value = payload === undefined ? await fn.call(gateway) : await fn.call(gateway, payload);
        } catch (error) {
          throw new Error(`${method} 调用失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const result: Record<string, any> = { method, ok: true, value: value ?? null };
        const intent = intentFromCall(method, payload ?? {}, value);
        if (intent !== undefined) {
          const hint = method === "composeMapAsset" ? "点开回到地图编辑器：「新增素材」已经打开并预填好这张图，确认一下就能用" : "点开可以看到这一步的实际产物并打「通过」";
          Object.assign(result, openInfo(intent, hint));
        }
        return result;
      }
    });

    register({
      name: `${PREFIX}status`,
      description: [
        "看一眼「游戏素材大师」的当前进度。",
        "不给 id 时列出全部项目 / 图片任务 / 序列帧任务；给了 id 就返回该目标的阶段进度、每个产物的状态与绝对 URL、是否有任务在跑。",
        "任何时候想确认「现在该做哪一步」都先调它。返回值里的 openUrl 请以 Markdown 链接贴给用户。"
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          module: { type: "string", enum: [...MODULES], description: "目标所属模块；给了 id 时可省略，宿主按 id 前缀判断。" },
          id: { type: "string", description: "项目 id（p…）/ 图片任务 id（i…）/ 序列帧任务 id（s…）。" }
        }
      },
      output: { schema: OBJECT_SCHEMA, render: (_args: unknown, value: any) => textBlocks(renderStatus(value)) },
      async execute(args: any) {
        const id = asString(args?.id);
        const hidden = await hiddenModulesNow();
        if (id === "") {
          // 只列可见模块的清单：隐藏的模块连「有哪些项目」都不给模型看一眼。
          await assertModuleVisible(moduleOf(args?.module));
          const [projects, images, sequences, rigs, tiles, maps, music, sfx] = await Promise.all([
            hidden.has("sprite") ? [] : listProjects(),
            hidden.has("image") ? [] : listImageJobs(),
            hidden.has("sequence") ? [] : listSequenceJobs(),
            hidden.has("rig") ? [] : listRigJobs(),
            hidden.has("tile") ? [] : listTileProjects(),
            hidden.has("map") ? [] : listMapProjects(),
            hidden.has("music") ? [] : listMusicJobs(),
            hidden.has("sfx") ? [] : listSfxJobs()
          ]);
          const links: Record<string, string> = {};
          for (const key of MODULES) if (!hidden.has(key)) links[key] = buildOpenLink({ module: key });
          return {
            module: moduleOf(args?.module) ?? null,
            hiddenModules: [...hidden],
            projects,
            imageJobs: images,
            sequenceJobs: sequences,
            rigJobs: rigs,
            tileProjects: tiles,
            mapProjects: maps,
            musicJobs: music,
            sfxJobs: sfx,
            links,
            hint: "用 game_material_status({module,id}) 看某个目标的细节；八方向图的四步是 images → videos → frames → sheet，45°地图地块是 generate → review → map → export，地图编辑器是 assets（素材）→ rules（自动连接）→ paint（地图）→ export（导出），全本地不花钱；音乐是 generate（生成）→ edit（编辑）→ export（导出），生成按谱乐 AI 积分计费；音效是 generate（生成，火山引擎 Seed-Audio）→ export（导出），每次生成真实计费。"
          };
        }
        // ⚠️ 这里**不能**再按 module 短路：`status({module:'tile', id})` 也走到这里，
        // 短路会把「带 id 的查询」变成「列清单」，assetBase / 几何报告全丢。
        // 只给了 module、没给 id 的情况，上面的 `id === ""` 分支已经覆盖了。
        const module = resolveTarget(args?.module, id);
        await assertModuleVisible(module);
        const snapshot = await snapshotOf(module, id);
        const stage = typeof args?.stage === "string" ? args.stage : undefined;
        return { ...snapshot, ...openInfo(intentOf(module, id, { stage }), "点开可以看到产物并打「通过」") };
      }
    });

    register({
      name: `${PREFIX}intake`,
      description: [
        "【固定流程第 0 步】用户一说要用「游戏素材大师」的某个功能，先调它，再动手。",
        "返回三样东西：① `blockers` —— 必须先解决的阻塞（例如还没配 API Key）；② `questions` —— 用户还没告知的关键参数，逐条问；",
        "③ `reviewModeQuestion` —— 必须问清楚「自动审核结果」还是「每一步人工审核」。",
        "在 `questions` 与 `reviewModeQuestion` 都得到用户答复之前，**不要**调用任何生成类 / 删除类方法。",
        "用户答复后：用 `game_material_reviewMode` 把审核模式记下来，用 `game_material_call` 把参数写进目标，再开始生成。",
        "已经明确告知过的参数不用重复问——只问这个工具列出来的、且用户确实没说的。"
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          module: { type: "string", enum: [...MODULES], description: "用户想用的是哪个模块。" },
          id: { type: "string", description: "已有目标的 id（想在它基础上继续时给）。" },
          told: {
            type: "array",
            items: { type: "string" },
            description: "用户已经明确告知过的参数名（如 prompt、count、mode、direction），这些不再重复问。"
          }
        },
        required: ["module"]
      },
      output: { schema: OBJECT_SCHEMA, render: (_args: unknown, value: any) => textBlocks(renderIntake(value)) },
      async execute(args: any) {
        const module = moduleOf(args?.module);
        if (module === undefined) throw new Error(`未知模块：${String(args?.module)}`);
        await assertModuleVisible(module);
        const id = asString(args?.id);
        const told = new Set<string>(Array.isArray(args?.told) ? args.told.map((entry: unknown) => String(entry)) : []);
        const config = await (gateway as any).getConfig();
        // 已有目标时先读它的真实状态：源图 / 提示词 / 素材已经在的项目里就不再问一遍。
        const target = id === "" ? undefined : await snapshotOf(module, id);
        // 带一条深链接：用户点一下就能切到插件对应页面（新建时只带 module）。
        return {
          ...intakeFor(module, id, told, config, target),
          ...openInfo(intentOf(module, id), "点开可以先看界面，再决定参数")
        };
      }
    });

    register({
      name: `${PREFIX}upload`,
      description: [
        "把本机文件上传进「游戏素材大师」——界面上那些「上传」框的对话等价物。",
        "参数 `path` 是文件的绝对路径或相对当前工作目录的路径，宿主自己读盘，**不要把 base64 贴进来**。",
        "kind 取值：sprite=source（源设定图）| video（**本地自选视频**，要用 `key` 指定槽位：turn=转圈视频，或 front/back/downLeft/downRight/upLeft/upRight/left/right 之一）；",
        "image=ref（参考图，最多 10 张）| item（直接加一张图，只做抠像用）；",
        "sequence=firstFrame | lastFrame | referenceImage | referenceVideo；rig=source（角色整图）| part（单个部件 PNG，文件名即部件名）；map=tileset（图集原图）；sfx=referenceImage（参考图）| referenceAudio（参考音频）。",
        "限制：图片 ≤30MB，视频 ≤40MB（平台请求体上限 64MB；界面上那条本地上传路更宽），类型按文件头嗅探。"
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          module: { type: "string", enum: [...MODULES], description: "目标所属模块。" },
          id: { type: "string", description: "项目 id（p…）或任务 id（i… / s…）。" },
          kind: { type: "string", enum: ["source", "video", "ref", "item", "firstFrame", "lastFrame", "referenceImage", "referenceVideo", "part", "tileset", "referenceAudio"], description: "上传到哪个槽位。" },
          key: { type: "string", description: "仅 sprite + kind=video 用：槽位 `turn`（转圈视频）或某个方向 key。" },
          path: { type: "string", description: "本机文件路径。" },
          name: { type: "string", description: "可选：展示用的文件名。" }
        },
        required: ["module", "id", "kind", "path"]
      },
      output: { schema: OBJECT_SCHEMA, render: (_args: unknown, value: any) => textBlocks(renderUpload(value)) },
      async execute(args: any) {
        const module = moduleOf(args?.module);
        if (module === undefined) throw new Error(`未知模块：${String(args?.module)}`);
        await assertModuleVisible(module);
        const id = asString(args?.id);
        const kind = asString(args?.kind);
        const path = asString(args?.path);
        if (path === "") throw new Error("path 不能为空");
        return uploadFromPath(gateway, module, id, kind, path, asString(args?.name) || undefined, asString(args?.key) || undefined);
      }
    });

    register({
      name: `${PREFIX}reviewMode`,
      description: [
        "记录用户选的审核模式（固定流程必问项之一）：`auto` = agent 自己审完结果就往下走；`manual` = 每一步产出后停下来等用户打「通过」。",
        "记在目标自己身上，之后每一轮都按它走，不必再问。重复调用即改选。",
        "用户明确说「自动跑完就行」→ auto；说「每步我看一下 / 我要审核」→ manual。用户没表态就不要猜，先问。"
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          module: { type: "string", enum: [...MODULES], description: "目标所属模块。" },
          id: { type: "string", description: "项目 id（p…）或任务 id（i… / s…）。" },
          reviewMode: { type: "string", enum: ["auto", "manual"], description: "审核模式。" }
        },
        required: ["module", "id", "reviewMode"]
      },
      output: { schema: OBJECT_SCHEMA, render: (_args: unknown, value: any) => textBlocks(renderReviewMode(value)) },
      async execute(args: any) {
        const module = moduleOf(args?.module);
        if (module === undefined) throw new Error(`未知模块：${String(args?.module)}`);
        await assertModuleVisible(module);
        const result = await (gateway as any).setReviewMode({
          module,
          id: asString(args?.id),
          reviewMode: asString(args?.reviewMode)
        });
        return { ...result, ...openInfo(intentOf(module, asString(args?.id)), "点开看验收结果") };
      }
    });

    register({
      name: `${PREFIX}wait`,
      description: [
        "等待某个目标跑完当前这一步。",
        "每 1.5 秒读一次状态，直到「没有任务在跑」或超时；返回等待结束时的完整状态（含 openUrl 与验收信息）。",
        "生成类调用（runImages / runVideos / runFrames / compose / runImageJob / runSequenceVideo …）之后紧接着调它，",
        "拿到 settled=true 再判断下一步。超时不算失败——超时后可以再调一次，或先把 openUrl 贴给用户。",
        "注意：等待期间不要同时提交同一个目标的新任务，重复提交会被宿主拒绝。"
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          module: { type: "string", enum: [...MODULES], description: "目标所属模块；可省略，按 id 前缀判断。" },
          id: { type: "string", description: "项目 id（p…）/ 图片任务 id（i…）/ 序列帧任务 id（s…）。" },
          timeoutSeconds: { type: "integer", description: "最长等待秒数，默认 120，上限 900。超时后返回当前状态。" }
        },
        required: ["id"]
      },
      output: { schema: OBJECT_SCHEMA, render: (_args: unknown, value: any) => textBlocks(renderWait(value)) },
      async execute(args: any, exec: any) {
        const id = asString(args?.id);
        if (id === "") throw new Error("id 不能为空");
        const module = resolveTarget(args?.module, id);
        await assertModuleVisible(module);
        const timeoutMs = clampInt(args?.timeoutSeconds, 120, 1, 900) * 1000;
        const startedAt = Date.now();
        let snapshot = await snapshotOf(module, id);
        while (snapshot.busy === true && Date.now() - startedAt < timeoutMs) {
          exec?.signal?.throwIfAborted?.();
          await sleep(1500, exec?.signal);
          snapshot = await snapshotOf(module, id);
        }
        const settled = snapshot.busy !== true;
        return {
          settled,
          timedOut: !settled,
          elapsedMs: Date.now() - startedAt,
          ...snapshot,
          ...openInfo(intentOf(module, id), "点开可以看到产物并打「通过」")
        };
      }
    });

    register({
      name: `${PREFIX}review`,
      description: [
        "出验收包：把某一步的每个产物连成可直接打开的绝对 URL，附状态、通过标记与报错，再给出建议的下一步。",
        "用户说「我看看」「验收一下」时用它，然后把 openUrl 以 Markdown 链接贴给用户，用户点击即切到插件对应页面。",
        "用自己的判断验收时：逐项看 status 与 error，全部 ready 才继续下一步；有 error 就按 hint 里的方法重跑那一步。",
        "阶段约定：八方向图 stage=images|videos|frames|sheet；骨骼动画 stage=parts|layout|rig|atlas；图片/序列帧任务只看某一个产物时用 index / step 过滤。"
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          module: { type: "string", enum: [...MODULES], description: "目标所属模块；可省略，按 id 前缀判断。" },
          id: { type: "string", description: "项目 id（p…）/ 图片任务 id（i…）/ 序列帧任务 id（s…）。" },
          stage: {
            type: "string",
            enum: ["images", "videos", "frames", "sheet", "generate", "review", "map", "export", "parts", "layout", "rig", "atlas", ...MAP_STAGES, ...MUSIC_STAGES, ...SFX_STAGES],
            description: "八方向图 / 地图地块 / 地图编辑器 / 骨骼动画专用：只看某一个阶段。"
          },
          direction: { type: "string", description: "八方向图专用：只看某一个方位（front/back/…）。" },
          index: { type: "integer", description: "图片任务专用：只看第几张（从 0 开始）。" },
          step: { type: "string", enum: ["video", "frames", "sheet"], description: "序列帧任务专用：只看某一步。" }
        },
        required: ["id"]
      },
      output: { schema: OBJECT_SCHEMA, render: (_args: unknown, value: any) => textBlocks(renderReview(value)) },
      async execute(args: any) {
        const id = asString(args?.id);
        if (id === "") throw new Error("id 不能为空");
        const module = resolveTarget(args?.module, id);
        await assertModuleVisible(module);
        const snapshot = await snapshotOf(module, id);
        const stage = typeof args?.stage === "string" ? args.stage : undefined;
        const direction = typeof args?.direction === "string" ? args.direction : undefined;
        const index = args?.index === undefined ? undefined : clampInt(args.index, 0, 0, 99);
        const step = typeof args?.step === "string" ? args.step : undefined;
        const key = typeof args?.key === "string" && args.key !== "" ? args.key : undefined;

        const packet: Record<string, any> = {
          module,
          id,
          name: snapshot.name,
          busy: snapshot.busy === true,
          ...openInfo(intentOf(module, id, { stage, direction }), "点开直接看产物并打「通过」")
        };

        if (module === "sprite") {
          const stages = (snapshot.stages as any[]).filter((entry) => stage === undefined || entry.stage === stage);
          if (stages.length === 0) throw new Error(`未知阶段：${stage}`);
          packet.stages = stages.map((entry) => ({
            ...entry,
            cells: entry.cells.filter((cell: any) => direction === undefined || cell.direction === direction)
          }));
          // 转圈模式要审的不只是八张方向图：整圈视频转得对不对、缩略条带与八个
          // 位置是不是落在该落的朝向上，都得能点开看。逐方向生图下这些是空的。
          packet.imageMode = snapshot.imageMode;
          packet.turn = snapshot.turn;
          packet.turnPicks = snapshot.turnPicks;
          packet.nextActions = spriteNextActions(snapshot, stage, direction);
        } else if (module === "image") {
          const items = (snapshot.items as any[]).filter((item) => index === undefined || item.index === index);
          if (items.length === 0) throw new Error(index === undefined ? "这个任务还没有产物" : `没有第 ${index} 张`);
          packet.items = items;
          packet.nextActions = imageNextActions(snapshot);
        } else if (module === "sequence") {
          const steps = (snapshot.steps as any[]).filter((entry) => step === undefined || entry.step === step);
          if (steps.length === 0) throw new Error(`未知步骤：${step}`);
          packet.steps = steps;
          packet.nextActions = sequenceNextActions(snapshot);
        } else if (module === "map") {
          const mapStages = snapshot.stages as Record<string, any>;
          const stageKeys = Object.keys(mapStages ?? {});
          if (stage !== undefined && !stageKeys.includes(stage)) {
            throw new Error(`未知阶段：${stage}（可选：${stageKeys.join(" / ")}）`);
          }
          packet.stages = stageKeys
            .filter((key) => stage === undefined || key === stage)
            .map((key) => ({ stage: key, ...mapStages[key] }));
          packet.grid = snapshot.grid;
          packet.cols = snapshot.cols;
          packet.rows = snapshot.rows;
          // 素材带**绝对 URL**（模型要直接贴给用户点）；调色板也跟着给，方便「让 agent
          // 自己画一张」时挑序号。
          packet.tilesets = snapshot.tilesets;
          packet.layers = snapshot.layers;
          packet.filled = snapshot.filled;
          packet.preview = snapshot.previewUrls;
          packet.previewUrls = snapshot.previewUrls;
          packet.exportBaseUrl = snapshot.exportBaseUrl;
          packet.exportFiles = snapshot.exportFiles;
          /** 导出目录的**绝对路径**（还没导出过 = 空串）：产物埋在 DSH_HOME 底下，模型直接报路径比让用户找方便。 */
          packet.exportPath = snapshot.exportPath;
          packet.warnings = [...(snapshot.warnings ?? []), ...(snapshot.exportWarnings ?? [])];
          packet.nextActions = (snapshot.nextActions ?? []).map((action: any) => `${action.step}：${action.why}`);
        } else if (module === "tile") {
          // ⚠️ 地图地块的 `stages` 是**对象**（{generate, review, map, export}），
          // 不是数组。之前它掉进了 `else`（骨骼动画）分支，那边无条件当成数组用
          // `.filter()` —— 于是 game_material_review 对 tile 直接抛
          // `snapshot.stages.filter is not a function`。真机验证才发现。
          const tileStages = snapshot.stages as Record<string, any>;
          const stageKeys = Object.keys(tileStages ?? {});
          if (stage !== undefined && !stageKeys.includes(stage)) {
            throw new Error(`未知阶段：${stage}（可选：${stageKeys.join(" / ")}）`);
          }
          packet.stages = stageKeys
            .filter((key) => stage === undefined || key === stage)
            .map((key) => ({ stage: key, ...tileStages[key] }));
          // 只要某个地块 / 变体：过滤 items，方便「就重跑这一张」的判断
          packet.items = (snapshot.items as any[]).filter((item) => key === undefined || item.key === key);
          if (packet.items.length === 0) throw new Error(`找不到地块：${key}`);
          packet.progress = snapshot.progress;
          packet.map = snapshot.map;
          packet.style = snapshot.style;
          packet.settings = snapshot.settings;
          // 给出「下一步该做什么」：几何回退过的、失败的、没生成的，都要点名
          const fallback = packet.items.flatMap((item: any) =>
            item.variants.filter((v: any) => v.geomMode === "template").map((v: any) => `${item.key} v${v.index + 1}`));
          const failed = packet.items.flatMap((item: any) =>
            item.variants.filter((v: any) => v.error !== undefined).map((v: any) => `${item.key} v${v.index + 1}：${v.error}`));
          const missing = packet.items.filter((item: any) => item.variants.length === 0).map((item: any) => item.key);
          packet.nextActions = {
            missing,
            fallback,
            failed,
            hint: fallback.length > 0
              ? "这些地块没量出 2:1 菱形，已按模板几何回退。多半是模型不对——请确认生图模型是 Seedream 5.0 系列（4.0 会把等距菱形画成近正方形），然后只重跑这几张：runTileItem({projectId, key, variant})。"
              : "几何都正常。可以继续验收、拼图（runTileMap）或导出（runTileExport）。"
          };
        } else if (module === "music") {
          const musicStages = snapshot.stages as Record<string, any>;
          const stageKeys = Object.keys(musicStages ?? {});
          if (stage !== undefined && !stageKeys.includes(stage)) {
            throw new Error(`未知阶段：${stage}（可选：${stageKeys.join(" / ")}）`);
          }
          packet.stages = stageKeys
            .filter((key) => stage === undefined || key === stage)
            .map((key) => ({ stage: key, ...musicStages[key] }));
          packet.source = snapshot.source;
          packet.settings = snapshot.settings;
          packet.workflow = snapshot.workflow;
          packet.scorePlan = snapshot.scorePlan;
          packet.compositions = snapshot.compositions;
          packet.currentScoreId = snapshot.currentScoreId;
          packet.songs = snapshot.songs;
          packet.versions = snapshot.versions;
          packet.tools = snapshot.tools;
          packet.exports = snapshot.exports;
          packet.songsReady = snapshot.songsReady;
          packet.nextActions = musicNextActions(snapshot, stage);
        } else if (module === "sfx") {
          const sfxStages = snapshot.stages as Record<string, any>;
          const stageKeys = Object.keys(sfxStages ?? {});
          if (stage !== undefined && !stageKeys.includes(stage)) {
            throw new Error(`未知阶段：${stage}（可选：${stageKeys.join(" / ")}）`);
          }
          packet.stages = stageKeys
            .filter((key) => stage === undefined || key === stage)
            .map((key) => ({ stage: key, ...sfxStages[key] }));
          packet.prompt = snapshot.prompt;
          packet.settings = snapshot.settings;
          packet.refs = snapshot.refs;
          packet.takes = snapshot.takes;
          packet.exports = snapshot.exports;
          packet.blocker = snapshot.blocker;
          packet.nextActions = sfxNextActions(snapshot);
        } else {
          // 骨骼动画（模块四）
          const stages = (snapshot.stages as any[]).filter((entry) => stage === undefined || entry.stage === stage);
          if (stages.length === 0) throw new Error(`未知阶段：${stage}`);
          packet.stages = stages;
          packet.parts = (snapshot.parts as any[]).filter((part) => stage !== "layout" || part.status === "ready");
          packet.review = snapshot.review;
          packet.nextActions = rigNextActions(snapshot, stage);
        }
        return packet;
      }
    });

    register({
      name: `${PREFIX}approve`,
      description: [
        "给某一步的产物打「通过」或取消通过（等价于界面上的验收按钮）。",
        "只有在用户明确说「这步可以」「通过」时才自动调用；用户要求逐步确认时，先贴 openUrl 停下来等回复。",
        "八方向图：module=sprite，id=项目 id，stage=images|videos|frames|sheet，key 可只对某个方位生效（省略即整阶段）。",
        "图片任务：module=image，id=任务 id，index 可只对某一张生效（省略即全任务）。",
        "序列帧：module=sequence，id=任务 id，step=video|frames|sheet（省略即全部三步）。",
        "骨骼动画：module=rig，id=任务 id，stage=parts|layout|rig|atlas（省略即四个阶段全打）；stage=parts 时可再带 part 只对某个部件生效。",
        "地图编辑器：module=map，id=项目 id，stage=assets|rules|paint|export（省略即四个阶段全打）。这条链路全本地，打勾只是记录「这步看过了」。",
        "音乐：module=music，id=任务 id，stage=compose|generate|edit|export；也可以带 songId / versionId / scoreId 只对某一首/某一版/某一版谱曲打勾。",
        "音效：module=sfx，id=任务 id，stage=generate|export（省略即两个阶段全打）。"
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          module: { type: "string", enum: [...MODULES], description: "目标所属模块；可省略，按 id 前缀判断。" },
          id: { type: "string", description: "项目 / 任务 id。" },
          stage: { type: "string", enum: ["images", "videos", "frames", "sheet", ...MAP_STAGES, ...MUSIC_STAGES, ...SFX_STAGES], description: "八方向图 / 地图编辑器 / 音乐 / 音效：阶段。" },
          songId: { type: "string", description: "音乐：只对某一首歌生效。" },
          versionId: { type: "string", description: "音乐：只对某个版本生效。" },
          scoreId: { type: "string", description: "音乐：只对某一版谱曲（MIDI）生效。" },
          key: { type: "string", description: "八方向图：只对某个方位生效（front/back/…）。" },
          index: { type: "integer", description: "图片任务：只对某一张生效。" },
          step: { type: "string", enum: ["video", "frames", "sheet"], description: "序列帧：只对某一步生效。" },
          part: { type: "string", description: "骨骼动画：stage=parts 时只对某个部件生效。" },
          approved: { type: "boolean", description: "true = 通过，false = 取消通过。" }
        },
        required: ["id", "approved"]
      },
      output: { schema: OBJECT_SCHEMA, render: (_args: unknown, value: any) => textBlocks(renderApprove(value)) },
      async execute(args: any) {
        const id = asString(args?.id);
        if (id === "") throw new Error("id 不能为空");
        if (typeof args?.approved !== "boolean") throw new Error("approved 必须是布尔值");
        const module = resolveTarget(args?.module, id);
        await assertModuleVisible(module);
        const approved = args.approved === true;

        if (module === "sprite") {
          const stage = asString(args?.stage, "images");
          if (!["images", "videos", "frames", "sheet"].includes(stage)) throw new Error(`未知阶段：${stage}`);
          const key = asString(args?.key) || undefined;
          if (key !== undefined && directionOf(key) === undefined) throw new Error(`未知方位：${key}`);
          await (gateway as any).setApproved({ projectId: id, stage, key, approved });
          return { module, id, stage, key: key ?? null, approved, ...openInfo({ module, projectId: id, stage }, "点开看验收结果") };
        }

        if (module === "image") {
          const job = await readImageJob(id);
          if (job === undefined) throw new Error(`找不到图片任务：${id}`);
          const index = args?.index === undefined ? undefined : clampInt(args.index, 0, 0, 99);
          const targets = (job.items ?? []).filter((item) => index === undefined || item.index === index);
          if (targets.length === 0) throw new Error(index === undefined ? "这个任务还没有产物" : `没有第 ${index} 张`);
          // 走 saveImageJob 而不是直接写文件：生图模型是全局设置，保存时由宿主对齐当前模型。
          await (gateway as any).saveImageJob(index === undefined ? { jobId: id, approved } : { jobId: id, approved, index });
          return { module, id, index: index ?? null, approved, count: targets.length, ...openInfo({ module: "image", jobId: id }, "点开看验收结果") };
        }

        if (module === "map") {
          const stage = asString(args?.stage) || undefined;
          if (stage !== undefined && !(MAP_STAGES as readonly string[]).includes(stage)) throw new Error(`未知阶段：${stage}（可选：${MAP_STAGES.join(" / ")}）`);
          // 单项目 = 单张地图：没有 mapId 这个维度了（打勾永远打整个项目）。
          await (gateway as any).setMapApproved({ projectId: id, stage, approved });
          return { module, id, stage: stage ?? null, approved, ...openInfo({ module: "map", jobId: id, stage }, "点开看验收结果") };
        }

        if (module === "tile") {
          const key = asString(args?.key) || undefined;
          const variant = args?.variant === undefined ? undefined : clampInt(args.variant, 0, 0, 99);
          await (gateway as any).setTileApproved({ projectId: id, key, variant, approved });
          return {
            module, id, key: key ?? null, variant: variant ?? null, approved,
            ...openInfo({ module: "tile", jobId: id }, "点开看验收结果")
          };
        }

        if (module === "sequence") {
          const job = await readSequenceJob(id);
          if (job === undefined) throw new Error(`找不到序列帧任务：${id}`);
          const step = asString(args?.step) || undefined;
          if (step !== undefined && !["video", "frames", "sheet"].includes(step)) throw new Error(`未知步骤：${step}`);
          await (gateway as any).saveSequenceJob(step === undefined ? { jobId: id, approved } : { jobId: id, approved, step });
          return { module, id, step: step ?? null, approved, ...openInfo({ module: "sequence", jobId: id }, "点开看验收结果") };
        }

        if (module === "music") {
          const stage = asString(args?.stage) || undefined;
          if (stage !== undefined && !(MUSIC_STAGES as readonly string[]).includes(stage)) {
            throw new Error(`未知阶段：${stage}（可选：${MUSIC_STAGES.join(" / ")}）`);
          }
          const songId = asString(args?.songId) || undefined;
          const versionId = asString(args?.versionId) || undefined;
          const scoreId = asString(args?.scoreId) || undefined;
          await (gateway as any).setMusicApproved(
            stage === undefined && songId === undefined && versionId === undefined && scoreId === undefined
              ? { jobId: id, approved }
              : { jobId: id, approved, ...(stage === undefined ? {} : { stage }), ...(songId === undefined ? {} : { songId }), ...(versionId === undefined ? {} : { versionId }), ...(scoreId === undefined ? {} : { scoreId }) }
          );
          return { module, id, stage: stage ?? null, songId: songId ?? null, versionId: versionId ?? null, scoreId: scoreId ?? null, approved, ...openInfo({ module: "music", jobId: id, stage, ...(scoreId === undefined ? {} : { scoreId }) }, "点开看验收结果") };
        }

        if (module === "sfx") {
          const stage = asString(args?.stage) || undefined;
          if (stage !== undefined && !(SFX_STAGES as readonly string[]).includes(stage)) {
            throw new Error(`未知阶段：${stage}（可选：${SFX_STAGES.join(" / ")}）`);
          }
          await (gateway as any).setSfxApproved({ jobId: id, approved, ...(stage === undefined ? {} : { stage }) });
          return { module, id, stage: stage ?? null, approved, ...openInfo({ module: "sfx", jobId: id, stage }, "点开看验收结果") };
        }

        const rigJob = await readRigJob(id);
        if (rigJob === undefined) throw new Error(`找不到骨骼动画任务：${id}`);
        const rigStage = asString(args?.stage) || undefined;
        if (rigStage !== undefined && !["parts", "layout", "rig", "atlas"].includes(rigStage)) throw new Error(`未知阶段：${rigStage}`);
        const part = asString(args?.part) || undefined;
        await (gateway as any).saveRigJob(
          rigStage === "parts" && part !== undefined ? { jobId: id, approved, stage: "parts", part } : rigStage === undefined ? { jobId: id, approved } : { jobId: id, approved, stage: rigStage }
        );
        return { module, id, stage: rigStage ?? null, part: part ?? null, approved, ...openInfo({ module: "rig", jobId: id, stage: rigStage }, "点开看验收结果") };
      }
    });
  }

  const systemPrompt = host.systemPrompt;
  if (systemPrompt !== undefined) {
    disposers.push(
      systemPrompt.section({
        name: "game-material-master",
        order: 8600,
        text: PROMPT_SECTION
      })
    );
  }

  return disposers;
}

const PROMPT_SECTION = [
  "## 游戏素材大师（game-material-master）",
  "本机已挂载「游戏素材大师」插件：八方向图生成 / 图片生成 / 序列帧生成 / 骨骼动画生成 / 45°地图地块 / 地图编辑器 / 音乐生成编辑 / 音效生成八个模块，界面在侧栏「游戏素材大师」面板。",
  "工具：`game_material_intake`（固定流程第 0 步）、`game_material_call`（万能通道，插件全部方法）、`game_material_upload`（按路径上传素材）、",
  "`game_material_reviewMode`、`game_material_status`、`game_material_wait`、`game_material_review`、`game_material_approve`。",
  "一律走这些工具，不要用 bash/shell 直接改 `<DSH_HOME>/game-material-master/` 下的 JSON——那会绕过宿主的复用与校验。",
  "",
  "### 固定流程（必须按这个顺序走）",
  "第 0 步 · 先问，再动手：用户一说要用某个功能，**先调用 `game_material_intake`**，把它返回的 `questions` 逐条问清楚，",
  "并且**必须问同一个问题**：「结果要自动审核，还是每一步人工审核？」——两者合并成一次提问，不要挤牙膏式地一问一停。",
  "在关键参数与审核模式都拿到答复之前，**不要调用任何生成类 / 删除类方法**。",
  "用户已经明确告知过的参数不必重复问；答复用 `game_material_call` 写进目标，审核模式用 `game_material_reviewMode` 记下来。",
  "第 1 步 · 逐阶段推进：八方向图是 images → videos → frames → sheet；图片生成是 prompt → runImageJob → keyImageJob；",
  "序列帧是 video → frames → sheet；骨骼动画是 parts → layout → rig → atlas。每次提交类调用之后**立刻** `game_material_wait`。",
  "骨骼动画只有第 ① 步（runRigSheet）花钱，②③④ 都是本地计算，重跑不额外计费；装配失败时用 runRigLayout({jobId, names:[…]}) 只重跑那几个部件。",
  "",
  "### 「AI 生成素材」自动任务（地图编辑器素材窗口发起）",
  "用户在地图编辑器的「素材」卡里点「AI 生成素材」时，插件会**自动开一个新对话**，把拼好的需求作为第一句话发过来：",
  "目标地图项目 id、素材名字、动画帧数、动画生成方式、素材主题、画法要求都在那段话里 —— **不要再调用 intake 追问、不要停下来等确认**，直接做完。",
  "**第一件事是定这块素材怎么用**（普通 / 整格 / 拼块；那段话里没指定时才由你判断）：",
  "  · `a2quad` 拼块 —— 成片铺开、边缘要自动接上：草地 / 水面 / 沙地 / 岩浆 / 雪地。每个变体只画**一块**无缝材质（四边能接上自己），5 种形状与边缘收口由宿主从这一块砖拼出来。",
  "  · `corner16` 整格 —— 要连成一条、拐角要对上：墙 / 路 / 栅栏 / 桥 / 管道。只画**一块**无缝墙砖（整张图就是这一块，不要分格），16 种接法与断口收口由宿主从这一块砖拼出来。",
  "  · `plain` 普通 —— 一块一块单独摆、不跟邻居接：树 / 箱子 / 道具 / 装饰。每张 = 一格内容。",
  "流程：帧数 1 或「生图模型」→ 图片生成 count:N（N = 帧数；拼块时 N = 变体数）；「视频模型」→ 先图片生成 count:1 当首帧，再序列帧 upload(firstFrame) → runSequenceVideo → runSequenceFrames count:N。",
  "最后 `composeMapAsset({projectId,name,files:[绝对路径…],shape:'<上面那个形态>'})` 整理成一张素材图（宿主按形态从这一块砖拼出全部格子；**会留 4 倍分辨率**，等用户在「新增素材」里选清晰度再缩到格子大小 —— 所以回链会带 `scale`；路径用 `getImageJob.dir` / `getSequenceJob.dir` 拼），",
  "把它返回的 `openUrl` 原样贴成 Markdown 链接 —— 用户点开就回到地图编辑器，素材窗口与「新增素材」都开好了、图与「这块素材怎么用」也预选好了，他点「确定」才真的导入。",
  "审核模式按那段话里写的（通常是 auto）；生成真实计费，失败只重跑失败的那一步。",
  "",
  "### 八方向图的第①步有两种生成方式（默认「转圈截帧」）",
  "`getProject` 返回的 `imageMode` 决定这一步怎么做，产物都是 `images/<方向>.png`，第②③④步不变：",
  "  · `turn`（默认）**转圈截帧**：`runTurnVideo({projectId})` 生成一段「角色原地匀速转一整圈」的绿幕视频（★一次 MiniMax 计费），",
  "    视频到手后宿主**自动**抽候选帧并切出八个方向（本机 ffmpeg，免费）；",
  "    八个方向的位置就是同一段视频的八个截帧下标，可以用 `setTurnPick({projectId,key,index})` 逐个调（只重切那一张），",
  "    或 `resetTurnPicks({projectId,direction?'cw'|'ccw'})` 回到默认等分。八个方向同源，一致性最好。",
  "    视频转得不对（转速不匀 / 动作太多 / 第一帧不是正面）时传 `runTurnVideo` 重做一次，别去调坐标。",
  "  · `direct` **逐方向生图**（备选）：`runImages({projectId})` 按依赖顺序逐个生图，单张更清晰但八个方向容易不一致。",
  "`setImageMode({projectId,mode:'turn'|'direct'})` 随时切换，两种方式的产物互不删除。",
  "",
  "### 骨骼动画的自动摆位不准时：给「视觉先验」（重要）",
  "第 ② 步的自动定位是**纯几何匹配**，对「模型重画过的部件」（裙摆、袖子这类服装裁片）会失手：",
  "它在错误位置也可能拿到不低的分数。这时**你（agent）就是那个视觉模型**，去做一次语义对应：",
  "  1. read_image 看 `getRigJob` 返回的 `sourcePath`（角色参考图）与 `partsMontagePath`（全部部件的蒙太奇图，",
  "     按 `partsOrder` 的先后从左上到右下排列，每格一个部件，带格线可以数格子）；",
  "  2. 逐个判断「这块部件在参考图的哪个位置」，给出**大致**的像素框（不需要精确，区域对就行）；",
  "  3. game_material_call({method:'setRigLayoutHints', payload:{jobId, hints:{部件名:{x,y,width,height}}}})",
  "     然后 runRigLayout({jobId}) 重新装配。",
  "实测效果：一张真实立绘从「头被摆到脚下面、16 个部件只有 3 个落在正确区域」变成「结构正确、13/16 落在指定区域」。",
  "先验框给大一点没关系（搜索区域会自动向外放宽 35%），但**别给错区域**——给错了它就会老老实实往错的地方搜。",
  "",
  "### 骨骼动画的三层修改：语义 / 骨骼偏移 / 动画参数（都是本地免费，且互不覆盖）",
  "这三层是**分开存的**，所以你重跑任何一步都不会抹掉另一层的人工改动。优先用它们，",
  "而不是让用户重新生成整条链路：",  "  1. **语义** `setRigSemantics({jobId, parts:[{name, role?, parent?, proximal?, distal?, tags?}]})`",
  "     —— 决定「这块是什么、挂在谁身上、骨骼从部件的哪一端伸到哪一端」。",
  "     `getRigJob` 返回的 `parts[].role/parent/proximal/distal` 是当前值，顶层 `semantics` 是校验结果",
  "     （`errors` 非空时写入会被拒绝并原样返回原因，据此修正后重试即可）。",
  "     **改语义只作废③骨骼与④图集，②里已经摆好的位置不受影响。**",
  "  2. **骨骼偏移** `setRigBoneOffsets({jobId, bones:[{name, x?, y?, rotation?}]})`",
  "     —— 手工微调某根骨头（位移单位是参考图像素，旋转是度）。它与「重新推骨骼」互不覆盖，",
  "     是「AI 重新想一遍、人调过的不丢」的保证；`resetRigBoneOffsets({jobId, names?})` 回到自动推的姿势。",
  "  3. **动画参数** `setRigAnimationSettings({jobId, animations:[{id, duration?, amplitude?}]})`",
  "     —— `amplitude` 统一缩放旋转与位移（动作太大/再夸张一点），`duration` 改循环秒数。",
  "     改完要 `runRigBones({jobId})` 重算。哪些动作会生成由 `saveRigJob` 的 `settings.animations` 决定。",
  "  4. **贴图变体** `tintRigParts({jobId, names?|tag?, tint, note?})` 换色、`setRigTextureVersion({jobId, name, version})` 切版本。",
  "     每一次换色 / 上传替换都**新增一个版本，永不覆盖原图**——所以「这张 AI 头发不行，换回原版」",
  "     只是切一下 `version`，成本为零。`getRigJob` 的 `parts[].versions` 是版本表（带 `note` 说明每版怎么来的），",
  "     `parts[].activeTexture` 是当前生效的版本号。换色是**本地计算、免费**，随时可以试。",
  "     `tag` 参数可以按语义标签批量（例如所有 `cloth` 一起换色），适合「这套衣服整体换个色调」。",
  "  ★ 判断依据：先 `getRigJob` 看 `rig.warnings`（几何推导的告警）、`semantics.errors/warnings`（结构问题）、",
  "  `atlas.warnings`。**构建失败时先读 `stage.error`**——导出前校验（Spine 4.2 四条地雷、DragonBones 的",
  "  `tweenEasing` 缺省即阶跃与 `curve` 编码规则、循环接缝、图集越界/缺区域）不通过会直接让那一步失败，",
  "  并把具体原因写在 error 里。",
  "  ★ ④ 图集现在同时产出**两种描述**：Spine 的 `skeleton.atlas` 与 DragonBones 的 `_tex.json`（`atlas.dragonBones[]`），",
  "  两者是同一次装箱出来的，不要只导一个就以为齐了。③ 也同时产出 `rig.skeleton`（Spine 4.2）与",
  "  `rig.dragonBones.skeleton`（DragonBones 5.5）——同一个骨架的两种写法，给不同的引擎用。",
  "第 2 步 · 每步都要审：`game_material_review` 拿验收包，逐项看 status / error / 绝对 URL。",
  "第 3 步 · 按审核模式分岔：`auto` → 自己判断没问题就 `game_material_approve` 打通过并进入下一步；",
  "`manual` → 贴出 openUrl 并**停下等用户回复**，只有用户明确说「通过 / 可以」才 `game_material_approve` 并继续。",
  "失败只重跑失败的那一项（`runImage` / `runVideos({regenerate:true, keys:[…]})` / `runFrames({keys:[…]})`），不要整批重来。",
  "",
  "### 验收链接",
  "`game_material_intake` / `status` / `wait` / `review` / `upload` 等返回的 `openUrl` 是给用户点的深链接。",
  "输出时必须原样写成 Markdown 链接（例如 `[查看第 2 步验收](http://…/?dsh-gmm=1&module=sprite&project=…&stage=videos)`）；",
  "用户点击后界面会原地切到插件对应页面。不要改写成裸文本，也不要自己编 URL。",
  "`manual` 模式下每完成一步都要贴一次；`auto` 模式下至少在全部完成或需要用户决策时贴。",
  "",
  "### 计费与重复提交",
  "生图与生视频都真实计费：不要为了确认状态而重复提交同一个目标；提交类调用返回后一律先 `game_material_wait`。",
  "",
  "### 被用户隐藏的功能（功能管理）",
  "用户可以在「设置 → 游戏素材大师 → 功能管理」里把某个模块隐藏起来。被隐藏的模块：",
  "  · 插件界面里不再出现它的页签与侧栏菜单项；",
  "  · 工具面**同样不可用**——`game_material_call` / `status` / `intake` / `upload` / `wait` / `review` / `approve` 都会明确报错。",
  "`game_material_status`（不带 id）返回的 `hiddenModules` 是当前被隐藏的模块 key 列表。",
  "遇到这类报错时**不要重试、也不要绕过**（例如直接改配置文件）：告诉用户这个功能被隐藏了，请他在设置里打开。",
  "`hiddenModules` 也不能通过 `game_material_call({method:\"saveConfig\"})` 修改——工具面会拒绝。",
  "",
  "### 音乐生成编辑（模块七，谱乐 AI）",
  "用户要写歌/做音乐时：先 `game_material_intake({module:'music'})` 问清「灵感还是完整歌词 / 用途与风格 / 要不要后期」，并问审核模式；",
  "然后 `createMusicJob` → `runMusicGeneration` → `game_material_wait`。**提交前先 `getMusicGuide`**（内置创作指南：风格提示词结构、歌词 QC、引擎/模型选择、生成设置、游戏循环与响度目标）。",
  "一次提交按谱乐 AI 积分计费：Suno 返回 2 首；已有歌曲后再生成必须 `regenerate:true`；不要为确认状态重复提交；失败重试也要先问用户。",
  "生成后用 `renderMusicEdit` 做裁剪/音量/淡入淡出/loudnorm（本地 ffmpeg、免费），用 `exportMusic` 导出；最后把工具返回的 `openUrl` 原样贴成 Markdown 链接，用户点开回到音乐编辑界面。",
  "用户给完整歌词时歌词是权威文本：不要重写，只修断句/结构标签/发音并说明改动。工具类接口（分轨/MIDI/乐谱/风格分析/转码）只接受公开 http(s) URL，编辑后的本地版本不能直接传。",
  "manual 模式：生成后先贴链接并停下等用户说「通过」；auto 模式：自己核对后继续，但失败/再生成仍要找用户确认。",
  "",
  "### 谱曲模式（模块七 · 本地 MIDI，谱曲免费）",
  "用户想「先谱曲 / 先出 MIDI / 要能改的曲子 / 先听听再决定要不要 AI 唱」时，用谱曲模式：",
  "`createMusicJob({workflow:'compose', source:{kind:'prompt', prompt, note, instrumental}, reviewMode})`。",
  "流程：`getMusicScoreGuide` 读 scoremill 指南 → 分析用户想法 → **用用户的语言把方案（曲风/调性/BPM/段落表/配器/主题/力度弧）输出给用户看** → `saveMusicScorePlan` → manual 模式停下等确认 → 写 `compose.py`（scoremill）→ `runMusicScore({jobId,title,plan,script})`（本地免费，宿主跑 Python + 渲染试听）→ 把 `openUrl` 贴给用户试听 → 有修改意见就再 `runMusicScore`（`basedOn` 指上一版，每版都保留）。",
  "只有用户**明确要求**「用 Suno 生成正式版 / 交给 Suno」时才调 `submitMusicScoreToSuno({jobId,scoreId,confirm:true})`：★真实计费；插件会先把这一版的**试听音频**上传给 Suno 作为参考（标准上传免费），再走 **cover** 生成。Suno 不接受 MIDI 原文件，但接受音频，所以「MIDI → 渲染音频 → 上传 cover」才是正确链路；结果不会逐音一致。若 Suno 判定版权，会返回 needsCopyrightConsent，用户确认后传 `copyrightAudio:true` 走付费版权通道。已有歌曲时必须 `regenerate:true`，并先问用户。",
  "谱曲脚本只做记谱：必须 `s.save('score.mid')`；不要自己渲染音频、不要联网。报错按 scoremill 的小节号只改那一处，最多重试 3 次。",
  "谱曲依赖本机 Python 3 + scoremill；缺了会在 `getConfig().musicScoreStatus` / `testMusicScore` 里说明。谱曲不需要谱乐 AI Key，交 Suno 才需要。",
  "",
  "### 音效生成（模块八，火山引擎 Seed-Audio）",
  "用户要音效 / 环境音 / UI 声 / 生物吼叫 / 角色配音时：先 `game_material_intake({module:'sfx'})` 问清「要什么声音 / 要不要参考」与审核模式。",
  "流程：`createSfxJob({name,prompt,settings:{format,sampleRate,speechRate?,loudnessRate?,pitchRate?,watermark?},reviewMode})` →（可选）`game_material_upload({module:'sfx', id, kind:'referenceImage'|'referenceAudio', path})` → `runSfxGeneration({jobId})`（★每次真实计费）→ `game_material_wait({module:'sfx', id})` → `game_material_review` → 把 `openUrl` 原样贴成 Markdown 链接。",
  "提示词要写成**导演脚本**：声源 + 环境 + 强度/节奏 + 时长（例如「暴雨中的金属撞击，短促有力，约 1 秒，带一点尾音」）。单次输出上限 120 秒；没有 duration 参数。",
  "参考：参考图最多 1 张；参考音频最多 3 条（每条 ≤30 秒 / ≤10MB），提示词里用 `@音频1…@音频3` 引用；**参考图与参考音频不能同时用**。",
  "一次生成 = 一条 take，永不覆盖；再生成一条会再计费。失败不自动重试，重试前先问用户。manual 模式生成后先贴链接并停下等用户说「通过」；auto 模式自己核对后继续。",
  "`seed-audio-1.0` 需要在火山引擎语音控制台开通；Key 是语音控制台的 API Key（`X-Api-Key`），不是火山方舟的 `ARK_API_KEY`。"
].join("\n");

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

// ── 固定流程第 0 步：问清楚再动手 ────────────────────────────────────────
//
// 用户只说「用八方向图做个角色」的时候，缺的信息其实很多：源图、统一附加
// 提示词、要不要改默认参数、以及最关键的一条——**结果谁来审核**。
// 这些一律由 `game_material_intake` 按真实状态算出来，而不是让模型凭感觉问：
// 已经配好的 / 有默认值的进 `known`，真正缺的进 `questions`，
// 必须先解决的进 `blockers`。这样「问了什么」是可复现、可测的。

const REVIEW_MODE_QUESTION = {
  id: "reviewMode",
  question: "结果要「自动审核」还是「每一步人工审核」？",
  options: [
    { value: "auto", label: "自动审核", detail: "agent 自己检查每步产出与报错，直接往下推进；只在失败或全部完成时才找你" },
    { value: "manual", label: "每一步人工审核", detail: "每步产出后 agent 把验收链接贴给你，你说「通过」它才进入下一步" }
  ],
  how: "用户答复后用 game_material_reviewMode 记下来（module + id + reviewMode）。"
};

function intakeFor(module: ModuleKey, id: string, told: Set<string>, config: any, target: any) {
  const reviewModeQuestion = REVIEW_MODE_QUESTION;
  const blockers: string[] = [];
  const questions: Array<Record<string, any>> = [];
  const known: Record<string, any> = {};
  /** 已经存在的事实（源图 / 提示词 / 素材）就不再问，直接列进 known。 */
  const hasSource = target !== undefined && target.sourceFile !== null && target.sourceFile !== undefined;
  const hasPrompt = target !== undefined && typeof target.prompt === "string" && target.prompt.trim() !== "";

  const ask = (key: string, question: string, why: string, how: string) => {
    if (told.has(key)) return;
    questions.push({ key, question, why, how });
  };

  if (module === "sprite" || module === "image" || module === "rig") {
    // 「配好了没」由宿主算好回传（`imageProviderBlocker`），工具面不再自己判 arkApiKey：
    // 生图后端可能是用户自己的服务，那种情况下没有 arkApiKey 也完全能用。
    if (config?.imageProviderBlocker !== null && config?.imageProviderBlocker !== undefined) {
      blockers.push(`${config.imageProviderBlocker}，配好点「测试连接」。`);
    }
    known.生图后端 = config?.imageProviderSummary;
    known.出图尺寸 = config?.imageProvider === "custom" ? config?.customSize : config?.arkSize;
  }
  if (module === "sequence") {
    if (config?.videoProvider === "custom") {
      if (config?.customVideoApiKeySet !== true) {
        blockers.push("还没配置自定义视频 API Key：设置 → 游戏素材大师 → 自定义 API（图生视频），配好点「测试连接」。");
      }
      known.视频模型 = config?.customVideoModel;
      known.BaseURL = config?.customVideoBaseUrl;
    } else if (config?.videoProvider === "comfy" || config?.comfyVideo === true) {
      known.视频模型 = "ComfyUI 工作流";
      known.BaseURL = config?.comfyBaseUrl;
    } else {
      if (config?.minimaxApiKeySet !== true) {
        blockers.push("还没配置 MiniMax API Key（生视频必需）：设置 → 游戏素材大师 → MiniMax API Key，配好点「测试连接」。");
      }
      known.视频模型 = config?.minimaxModel;
      known.BaseURL = config?.minimaxBaseUrl;
    }
  }
  if (module === "sprite") {
    known.默认单格尺寸 = `${config?.cellWidth ?? "?"}×${config?.cellHeight ?? "?"}`;
    known.默认每段抽帧数 = config?.frameCount;
    known.默认像素块 = config?.pixelSize;
    known.默认行序 = config?.rowOrder;
    known.阶段1两种生成方式 = "转圈截帧（默认）：一段「原地匀速转一整圈」的绿幕视频 → 按时间轴截出八个方向；逐方向生图（备选）：八个方向各自生图";
    known.四个阶段 = "① 八方向绿幕图（转圈截帧 / 逐方向生图）→ ② 行走动作视频 → ③ 提取序列帧 → ④ 抠绿幕合成整图";
  }
  if (module === "image") {
    known.默认张数范围 = "1~8（Seedream 约 0.2 元/张）";
    known.参考图上限 = "10 张，可在提示词里写「图一」「图二」";
  }
  if (module === "sequence") {
    known.两种输入模式 = "首尾帧模式（必须给首帧图）/ 多模态参考模式（参考图 ≤9 张 + 参考视频 ≤3 段），平台规定互斥";
    known.分辨率与时长档位 = config?.minimaxCapabilities;
  }
  if (module === "rig") {
    known.四个阶段 = "① 拆件 → ② 装配定位 → ③ 骨骼与动画 → ④ 图集";
    known.只有第一步花钱 = "① 拆件是一次 Seedream 生图（约 0.2 元）；②③④ 都是本地计算，重跑不额外花钱";
    known.默认拆件网格 = `${config ? "" : ""}4 列 × 4 行 = 16 个标准人形部件（头/脖子/躯干/胯/上臂/小臂/手/大腿/小腿/脚），格子位置即部件身份`;
    known.默认动画 = "idle 待机 / walk 行走 / run 奔跑 / wave 挥手 / jump 跳跃 / attack 攻击";
  }
  if (module === "map") {
    // ⚠️ 这里**故意不加** API Key 阻塞：整条链路（导入素材 / 自动连接 / 画地图 /
    // 导出）全在本地，一次模型调用都没有。写了阻塞就是让用户白配一次 Key。
    known.全本地不花钱 = "导入自己的素材图 → 自动连接 → 环绕画布上画 → 导出 PNG：一次模型调用都没有，不需要任何 API Key";
    known.四个阶段 = "① 素材（导入 PNG，形态按尺寸自动识别）→ ② 自动连接（宿主自动完成，界面不显示）→ ③ 地图（一张地图 / 多图层 / 四周环绕）→ ④ 导出（map.png + map.json）";
    known.单张地图 = "一个项目就是一张地图（`map.json`）：改尺寸 / 图层 / 环绕都在 saveMapDoc 里，没有「多张地图」这一层";
    known.三种自动连接 = "拼块自动连接（RPG Maker A2 那种一格 4 象限的图）/ 整格 16 块 / 普通图块；形态与格子尺寸由素材尺寸自动识别，识别错了用 saveMapTileset 改";
    known.内置素材 = "importSampleTileset 可以装一套内置素材（4 张自动连接图 + 1 张道具图），本机现算、零成本";
    known.一键生成 = "runMapGenerate 支持 random（随机铺满）/ maze（迷宫）/ continent（大陆），整层一次提交、一次撤销，同种子逐字节可复现";
    known.预览等于导出 = "界面画布与导出 PNG 执行的是**同一份绘制计划**（宿主算、客户端只执行），所以不存在「预览好看、导出位移」";
    if (target?.grid) known.当前网格 = target.grid;
    if (target?.reviewMode) known.审核模式 = target.reviewMode;
    ask("tileset", "素材从哪来？把素材图 PNG 的**本机绝对路径**给我（可以多张），或者你自己在界面「素材」里上传；也可以先用内置素材试手。", "这个模块是「导入派」：不生成素材，只把已有素材图切成可用地块。界面「素材」那张卡里还有一颗「AI 生成素材」：它会**自动开一个新对话**把生成需求发过来（帧数 1 = 一张静态素材；帧数 > 1 = 先生成再整理成会动的素材），做完用 composeMapAsset 整理并回一条带 dialog=add 的链接。", "用 game_material_upload({module:'map', id, kind:'tileset', path})，或 game_material_call 的 importMapTileset({projectId, name, data}) 传 base64，或 importSampleTileset({projectId}) 装内置素材；需要新素材时先定「这块素材怎么用」（自动判断：成片铺开→拼块、连成一条→整格、单独摆→普通），按它规划生图，再 composeMapAsset({projectId, name, files, shape}) 按形态规整。");
    ask("mapSize", "地图多大？（默认 32×32；改尺寸用 saveMapDoc 的 cols / rows）要分几层？（默认两层：图层 1 / 图层 2）", "尺寸与图层决定画布和最终 PNG 的像素大小；地图四周默认**环绕**。", "用 saveMapDoc({projectId, cols, rows, addLayer:{name}, wrap})。");
    ask("generate", "先一键铺一层再手改，还是直接手画？（一键生成：随机铺满 / 迷宫 / 大陆；也可以让 agent 直接拿坐标系画）", "一键生成是本地计算、不花钱，同一个种子结果完全一样，随时能撤销。", "用 runMapGenerate({projectId, kind:'random'|'maze'|'continent', tiles?, seed?, layerId?})，或 applyMapOps({projectId, ops}) 直接画。");
  }
  if (module === "tile") {
    if (config?.imageProviderBlocker !== null && config?.imageProviderBlocker !== undefined) {
      blockers.push(`${config.imageProviderBlocker}，配好点「测试连接」。`);
    }
    known.实验性 = "45°地图地块生成是实验性功能：几何（参考图/拼图/裁剪）由本地代码算、有像素级自检，可靠；不稳定的是「AI 能否照着占格形状画出对的造型」，非矩形占地经常要重跑。";
    known.生图后端 = config?.imageProviderSummary;
    known.四个阶段 = "① 生成地块（★计费；参考图会按占格形状自动渲染，不用手动准备）→ ② 验收 → ③ 拼成地图（本地免费，可反复）→ ④ 导出";
    known.几何由代码保证 = "等距参考图由本地代码按「占格形状」渲染（严格 2:1 等距），AI 只负责填内容。实测这样菱形比例达标率 100%";
    known.默认地块清单 = "9 类地形（草/土/石/灌木，各 1~2 变体）+ 4 个独立装饰（树/松树/巨石）+ 1 栋跨 2×2 格建筑";
    known.默认单元格 = `${config?.cellWidth ?? 64} 宽，高为 96（菱形占中部，上方留白给高出地面的装饰）`;
    // ⚠️ 属性名只能用标识符允许的字符：带圈数字 ② 之类不是合法标识符字符，
    // 写成 `known.只有第②步花钱` 会直接编译不过（Invalid character）。
    known.只有第1步花钱 = "生成一个变体 = 一次 Seedream 调用；参考图、规整、拼图、导出全在本地，免费且可反复";
    known.装饰与地面分开生成 = "树/巨石走「白底单图 + 锚点摆放」，不与地面画在同一张图上（同图会被画两遍）";
    if (target?.reviewMode) known.审核模式 = target.reviewMode;
    ask("style", "整套地块的画风描述是什么？（例如「像素画风，色彩明快饱和，干净色块，无噪点」；可留空走默认）", "它会追加到每个地块的提示词末尾，改一次整套画风都变。", "用 game_material_call 的 saveTileProject({projectId, style}) 保存。");
    ask("items", "要做哪几类地块？（默认给 9 类地形 + 4 个装饰 + 1 栋建筑，可以直接用，也可以增删改）", "地块清单决定画面里有什么，也决定要花多少次调用。", "用 saveTileProject({projectId, items:[…]}) 整份写回；每项含 key/label/kind/family/content/mode/variantCount。");
    ask("mapLayout", "地图要多大？（默认 14×14）要不要指定某几格用别的类别、或者撒装饰？", "布局是本地计算，改多少次都不花钱。", "用 runTileMap({projectId, rows, cols, seed, fill, decorDensity})；手动指定格子用 saveTileMapCells。");
  }

  if (module === "music") {
    // ⚠️ 不再因为缺谱乐 Key 直接阻塞：谱曲模式全程本地免费，不需要 Key。
    // 只把它写成 known，等用户选择「直接生成 / 交 Suno」时再要求配 Key。
    if (config?.musicBlocker !== null && config?.musicBlocker !== undefined) {
      known.直接生成需要Key = `${config.musicBlocker}（谱曲模式不需要 Key；最后交 Suno 才需要）`;
    }
    const scoreStatus = config?.musicScoreStatus;
    known.平台 = "谱乐 AI（YourMusic）Open API；当前只支持它";
    known.BaseURL = config?.musicBaseUrl ?? "https://api.yourmusic.fun";
    known.默认模型 = config?.musicModel ?? "chirp-v6";
    known.引擎与模式 = (config?.musicEngines ?? [])
      .map((engine: any) => `${engine.label}：${(engine.modes ?? []).map((mode: any) => mode.id).join(" / ")}`)
      .join("；");
    known.两种做法 = "直接生成（谱乐 AI 出音频，按积分计费）/ 谱曲模式（本机 scoremill 写 MIDI，免费；先试听、可反复改，满意后再可选交 Suno）";
    known.计费 = "直接生成与交 Suno 按谱乐 AI 积分计费；谱曲、试听、导出全部本地免费。Suno 一次返回 2 首；已有歌曲后再生成必须显式 regenerate:true。";
    known.四个阶段 = "compose（谱曲 / 试听）→ generate（交 Suno 生成）→ edit（裁剪 / 音量 / 淡入淡出 / 标准化）→ export（导出）";
    known.本地编辑免费 = "裁剪 / 音量 / 淡入淡出 / loudnorm 全在本机 ffmpeg 完成；只有平台生成与部分工具接口（WAV、分轨、MIDI、乐谱、风格分析、转码）会计费。";
    known.工具接口 = "stems 分轨 / pro-stems 高级分轨 / midi / sheet-music / style-analysis / convert；这些接口只接受公开可访问的 http(s) URL（生成歌曲的 audio_url 满足，本地编辑版本不满足）。";
    known.谱曲模式 = "对话里先分析想法、用用户语言输出方案（曲风/调性/BPM/段落表/配器），保存方案后用 scoremill 写 MIDI；宿主跑 Python 并把 MIDI 渲染成可试听的音频。每次修改都是新版本，旧版保留。";
    known.谱曲依赖 = scoreStatus === undefined || scoreStatus === null
      ? "尚未探测（getConfig().musicScoreStatus / testMusicScore 可查）"
      : `Python ${scoreStatus.python?.ok ? scoreStatus.python.version ?? "OK" : "缺失"} · scoremill ${scoreStatus.scoremill?.ok ? scoreStatus.scoremill.version ?? "OK" : "缺失"} · 试听 ${scoreStatus.renderer === "fluidsynth" ? "FluidSynth + SoundFont" : "内置简易音源"}${scoreStatus.blocker ? ` · 阻塞：${scoreStatus.blocker}` : ""}`;
    known.Suno交接 = "谱乐 AI 的 Suno **不接受 MIDI 原文件，但接受音频**：插件先把这一版 MIDI 渲染成试听音频，上传到 `/v1/suno/audio/upload` 拿参考 id，再走 cover 生成。标准上传免费；版权音频通道要用户确认并扣积分。结果不会逐音一致。";
    if (target?.workflow) known.工作流 = target.workflow === "compose" ? "谱曲模式（本地 MIDI）" : "直接生成（谱乐 AI）";
    if (target?.source) known.用户输入 = target.source.kind === "lyrics" ? "完整歌词" : "灵感提示词";
    if (target?.source?.prompt) known.提示词原文 = String(target.source.prompt).slice(0, 200);
    if (target?.source?.lyrics) known.歌词原文 = `${String(target.source.lyrics).slice(0, 200)}…（共 ${String(target.source.lyrics).length} 字）`;
    if (target?.reviewMode) known.审核模式 = target.reviewMode;
    const hasMusicText = target?.source !== undefined && ((typeof target.source.prompt === "string" && target.source.prompt.trim() !== "") || (typeof target.source.lyrics === "string" && target.source.lyrics.trim() !== "") || (typeof target.source.note === "string" && target.source.note.trim() !== ""));
    if (!hasMusicText) {
      ask("musicSource", "要做一首什么？给我一段灵感提示词，或者一整首歌词（二选一即可）。", "这是创作的起点；有歌词时会以歌词为权威文本，只有灵感时由 agent 写歌词/扩写。", "用 game_material_call({method:'createMusicJob', payload:{name, source:{kind:'prompt'|'lyrics', prompt, lyrics, title?, tags?, instrumental?}, workflow:'generate'|'compose'}}) 建任务。");
    }
    ask("musicWorkflow", "要直接生成，还是先谱曲（本地 MIDI）？直接生成 = 谱乐 AI 出成品音频、按积分计费；谱曲模式 = 先分析和规划、用 scoremill 写 MIDI 让你试听，可以反复改，满意后再可选交给 Suno。", "两条路的计费、可控性和修改方式完全不同：谱曲模式免费、可逐音改；直接生成更快但不可逐音控制。", "建任务时传 createMusicJob({workflow:'generate'|'compose', ...})；谱曲模式后续用 saveMusicScorePlan + runMusicScore。");
    ask("musicStyle", "想要什么风格 / 情绪 / 编制？有没有「不要」的元素（例如不要电吉他、不要合唱）？", "会变成风格标签与 negative_tags；谱曲模式下还会决定配器与段落写法。", "直接生成用 saveMusicJob({jobId, source:{tags, ...}, settings:{negativeTags}})；谱曲模式写进 plan.style / plan.mood / plan.instrumentation。");
    ask("musicUse", "这首歌在游戏里怎么用：主题曲 / 战斗 / 菜单 / 环境床 / 循环 / 短 stinger？要不要人声、大概多长？", "用途决定时长、结构、能不能循环，比堆风格词更重要。", "直接生成把结论写进 source.note，并用 settings.duration / instrumental 表达；谱曲模式写进 plan.structure / plan.lengthBars / plan.instrumental。");
    ask("musicCompose", "如果走谱曲模式：有偏好的调性 / BPM / 拍号 / 主题动机吗？要不要循环？想用什么乐器（例如古筝、弦乐、铜管、太鼓）？", "这些会直接变成方案与 scoremill 的声部/通道；不确定就让 agent 按用途拟一版方案给你确认。", "agent 先输出方案，再用 saveMusicScorePlan({jobId, plan}) 保存；谱曲用 runMusicScore({jobId, title, plan, script})。");
    ask("musicEngine", "（仅直接生成 / 交 Suno）引擎有偏好吗？（Suno / Mureka / MiniMax / ACE-Step；默认 Suno chirp-v6，纯音乐或需要固定 BPM 时 ACE-Step 更稳）", "不同引擎的模式、参数与计费方式不同；谱曲模式的本地部分不需要选引擎。", "直接生成：runMusicGeneration({jobId, engine, mode, params})；交 Suno：submitMusicScoreToSuno({jobId, scoreId, confirm:true, model?})。");
    ask("musicReview", "（仅直接生成）生成后要不要做后期处理？（裁剪掉头尾 / 调音量 / 淡入淡出 / 标准化到 -14 LUFS；默认不处理，保留原曲）", "后期是本地免费的，但会多出一些版本；谱曲模式的试听已经是本地渲染。", "renderMusicEdit({jobId, songId, ops:{start,end,gainDb,fadeIn,fadeOut,normalize}}) → game_material_wait。");
  }

  if (module === "sfx") {
    if (config?.sfxBlocker !== null && config?.sfxBlocker !== undefined) {
      blockers.push(config.sfxBlocker);
    }
    known.平台 = "火山引擎豆包语音 · 生成式音频（seed-audio-1.0）";
    known.BaseURL = config?.sfxBaseUrl ?? "https://openspeech.bytedance.com";
    known.默认模型 = config?.sfxModel ?? "seed-audio-1.0";
    known.单次上限 = "120 秒；没有 duration 参数，时长要写进提示词";
    known.计费 = "每次生成一条 take 都真实计费（按 original_duration）；失败重试会再计费，先问用户。";
    known.参考规则 = "参考图最多 1 张；参考音频最多 3 条（每条 ≤30 秒 / ≤10MB）；两者不能同时使用；提示词里用 @音频1…@音频3 引用。";
    known.两个阶段 = "generate（生成）→ export（导出）；v1 不做本地剪辑。";
    if (target?.prompt) known.提示词原文 = String(target.prompt).slice(0, 200);
    if (target?.settings) known.输出参数 = `${target.settings.format ?? "?"} / ${target.settings.sampleRate ?? "?"}Hz`;
    if (target?.reviewMode) known.审核模式 = target.reviewMode;
    if (!hasPrompt) {
      ask("sfxPrompt", "要什么声音？写清声源、环境、强度/节奏与大致时长，例如「暴雨中的金属撞击，短促有力，约 1 秒，带一点尾音」。", "生成式音频把提示词当导演脚本；写得越具体越稳。单次上限 120 秒。", "用 game_material_call({method:'createSfxJob', payload:{name, prompt, settings:{format,sampleRate}, reviewMode}}) 建任务，再 runSfxGeneration({jobId})（★计费）。");
    }
    ask("sfxRefs", "要不要参考图或参考音频？（可选；参考图与参考音频不能同时用。参考音频最多 3 条、每条 ≤30 秒。）", "参考图适合「按形象生成声线」，参考音频适合「按这个音色/风格生成」；不用参考也可以。", "用 game_material_upload({module:'sfx', id, kind:'referenceImage'|'referenceAudio', path})，或 uploadSfxRef({jobId, kind, name, data})。");
  }

  if (id === "") {
    questions.push({
      key: "target",
      question:
        module === "sprite"
          ? "新建一个项目，还是在已有项目上继续？"
          : module === "image"
            ? "新建一个图片任务，还是在已有任务上继续？"
            : module === "sequence"
              ? "新建一个序列帧任务，还是在已有任务上继续？"
              : module === "tile"
                ? "新建一个地图地块项目，还是在已有项目上继续？"
                : module === "map"
                  ? "新建一个地图项目，还是在已有项目上继续？"
                  : module === "music"
                    ? "新建一个音乐任务，还是在已有任务上继续？"
                    : module === "sfx"
                      ? "新建一个音效任务，还是在已有任务上继续？"
                      : "新建一个骨骼动画任务，还是在已有任务上继续？",
      why: "后面的参数都挂在项目 / 任务上。",
      how: "新建：game_material_call({method:'createProject'|'createImageJob'|'createSequenceJob'|'createRigJob'|'createTileProject'|'createMapProject'|'createMusicJob'|'createSfxJob', payload:{name}})，返回的 id 就是后续 payload 里的 projectId / jobId。"
    });
  }

  if (module === "sprite") {
    if (hasSource) known.源图 = target.sourceFile;
    else {
      ask(
        "source",
        "用哪张角色设定图作为源图？（PNG / JPG，≤30MB）",
        "八方向图从这一张出发派生其余七个方位，没有它无法开始。",
        "给我文件路径后我用 game_material_upload({module:'sprite', id, kind:'source', path}) 上传。"
      );
    }
    // 阶段①有两条路，代价与产物形态完全不同，必须问清楚（默认转圈截帧）。
    if (target?.imageMode !== undefined) {
      known.阶段1生成方式 = target.imageMode === "turn" ? "转圈截帧（默认）" : "逐方向生图";
    }
    ask(
      "generateMode",
      "阶段①「八方向绿幕图」用哪种生成方式？默认是「转圈截帧」（先生成一段原地匀速转一整圈的绿幕视频，再按时间截出八个方向——八个方向同源、一致性最好，一次视频调用；位置可以在时间轴上拖）；也可以选「逐方向生图」（每个方向单独生图，单张更清晰，但八方向容易不一致，八次调用）。",
      "这一步决定后面整条链路的产物形态与花费，先定下来再动手。",
      "转圈截帧：setImageMode({projectId,mode:'turn'}) → runTurnVideo({projectId}) → game_material_wait（视频到手会自动抽帧切图）→ 需要时 setTurnPick({projectId,key,index}) 调位置；逐方向生图：setImageMode({projectId,mode:'direct'}) → runImages({projectId})。"
    );
    if (target?.reviewMode) known.审核模式 = target.reviewMode;
    ask("suffix", "有没有跨方向都要遵守的统一要求？（例如「必须穿同一双靴子」「不要出现文字」；可留空）", "会追加到每一张生图提示词末尾，改一次八个方向全生效。", "用 game_material_call 的 savePrompts({projectId, suffix}) 保存。");
    if (target?.imageMode !== "turn") {
      ask("scope", "八个方向全做，还是只做指定方向？", "只做部分方向能明显省钱省时间。", "开始生成时 runImage({projectId,key}) 做单个方向，runImages({projectId}) 做全部。");
    }
    ask("tuning", "默认参数要改吗？（单格尺寸 / 每段抽帧数 / 像素块大小 / 行序 / 并发数；不改就用默认）", "这些决定了最终精灵图的规格。", "要改就用 saveSettings({projectId, settings})。");
    ask("prompts", "每个方向的生图/视频提示词要用默认模板，还是你自己写？（默认模板已经把方位与可见部位写对了，建议先用默认；转圈截帧对应的是「转圈视频提示词」）", "方位写错会导致八个方向看起来是抬头 / 低头而不是转身。", "要改就用 savePrompts。");
  }

  if (module === "image") {
    if (hasPrompt) known.提示词 = target.prompt;
    else ask("prompt", "想要什么画面？请给一句具体的中文提示词。", "生图的唯一必填项。", "saveImageJob({jobId, prompt}) 后 runImageJob({jobId, count})。");
    ask("count", "生成几张？（1~8，默认 1）", "按张计费。", "runImageJob({jobId, count})。");
    ask("refs", "要不要参考图？需要的话给我文件路径（最多 10 张）。", "带参考图时可以在提示词里写「图一」「图二」。", "game_material_upload({module:'image', id, kind:'ref', path})。");
    ask("keying", "生成后要不要自动抠绿幕导出透明 PNG？", "抠像是本地做的、不额外收费。", "saveImageJob({jobId, keying:{enabled:true}}) 再 keyImageJob({jobId})。");
  }

  if (module === "rig") {
    if (hasSource) known.角色参考图 = target.sourceFile;
    else {
      ask(
        "source",
        "用哪张**角色整图**作为参考？（PNG / JPG，≤30MB；要能看清全身）",
        "拆件、装配、骨骼全都以它为基准。",
        "给我文件路径后我用 game_material_upload({module:'rig', id, kind:'source', path}) 上传。"
      );
    }
    ask(
      "partsSource",
      "部件从哪来：让生图模型自动拆件（默认，一次约 0.2 元），还是你自己已经有分好的部件 PNG？",
      "已经有部件图的话可以跳过生图，直接用 uploadRigPart 逐张传（部件名就是文件名，例如 head.png / torso.png / left-upper-leg.png）。",
      "自动拆件：runRigSheet({jobId})；手工上传：game_material_upload({module:'rig', id, kind:'part', path})。"
    );
    ask("animations", "要生成哪些动画？（默认全做：待机/行走/奔跑/挥手/跳跃/攻击）", "动画是本地查表生成的，多做几个不额外花钱。", "saveRigJob({jobId, settings:{animations:[...]}})。");
    if (target?.reviewMode) known.审核模式 = target.reviewMode;
  }

  if (module === "sequence") {
    ask("mode", "用「首尾帧模式」还是「多模态参考模式」？（平台规定只能二选一）", "两种模式的素材要求完全不同。", "saveSequenceJob({jobId, mode:'frames'|'reference'})。");
    if (target !== undefined && (target.refs?.firstFrame !== null || target.refs?.referenceImages > 0 || target.refs?.referenceVideos > 0)) {
      known.已上传素材 = target.refs;
    } else {
      ask("material", "对应模式要用的素材：首尾帧模式给首帧图（尾帧可选）；参考模式给参考图（≤9 张）和/或参考视频（≤3 段，每段 2~15 秒）。", "没有素材无法提交。", "game_material_upload({module:'sequence', id, kind:'firstFrame'|'lastFrame'|'referenceImage'|'referenceVideo', path})。");
    }
    if (hasPrompt) known.提示词 = target.prompt;
    else ask("prompt", "希望这段动作是什么样的？请给一句提示词。", "视频生成的必填项。", "saveSequenceJob({jobId, prompt})。");
    ask("duration", "时长和分辨率用当前模型档位里的哪个？（不改就用默认）", "不同模型支持的档位不同。", "saveSequenceJob({jobId, settings:{duration, resolution}})。");
    ask("frames", "抽几帧、单格多大？（默认按全局配置）", "决定最终横向条图的规模。", "saveSequenceJob({jobId, settings:{frameCount, cellWidth, cellHeight}})。");
  }

  return {
    module,
    id: id === "" ? null : id,
    blockers,
    questions,
    reviewModeQuestion,
    known,
    nextStep:
      blockers.length > 0
        ? "先把 blockers 告诉用户并等它处理；同时把 questions 与 reviewModeQuestion 一起问掉，别分多轮挤牙膏。"
        : "把 questions 与 reviewModeQuestion 合并成一次提问（能一次问完就别拆开），等用户答复后再动手。",
    afterAnswered: "用户答复后：game_material_reviewMode 记审核模式 → game_material_call 写参数 → 开始生成 → game_material_wait。"
  };
}

// ── 上传：宿主自己读盘，模型只给路径 ────────────────────────────────────

const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const VIDEO_MAX_BYTES = 40 * 1024 * 1024;
/** 音效参考（图 / 音频）平台上限是 10MB。 */
const SFX_REF_MAX_BYTES = 10 * 1024 * 1024;

/** 各模块允许的 kind，避免把「源图」传到「参考视频」这类错位。 */
const UPLOAD_KINDS: Record<ModuleKey, string[]> = {
  sprite: ["source", "video"],
  image: ["ref", "item"],
  sequence: ["firstFrame", "lastFrame", "referenceImage", "referenceVideo"],
  rig: ["source", "part"],
  // 地图地块**不需要上传素材**：地块由代码渲染的菱形模板 + 提示词生成。
  // 留空数组而不是漏掉这一项 —— 漏掉会让类型检查失败，而空数组能让
  // 「上传」这条路给出明确的报错信息（见 uploadFromPath）。
  tile: [],
  // 地图编辑器就是**导入素材**起家的：这里上传的就是 tileset 图集原图。
  map: ["tileset"],
  // 音乐模块 v1 不导入本地音频：只编辑本任务生成/下载的歌曲。留空数组让
  // 上传这条路给出明确报错，而不是掉进 sequence 分支做别的事。
  music: [],
  // 音效模块：参考图 / 参考音频（两者互斥，上限 10MB）。
  sfx: ["referenceImage", "referenceAudio"]
};

/** sprite 的本地视频槽位：`turn`（转圈）或八个方向之一。 */
const SPRITE_VIDEO_SLOTS = ["turn", "front", "back", "downLeft", "downRight", "upLeft", "upRight", "left", "right"];

async function uploadFromPath(
  gateway: GameStudioGateway,
  module: ModuleKey,
  id: string,
  kind: string,
  path: string,
  name?: string,
  key?: string
): Promise<Record<string, any>> {
  if (id === "") throw new Error("id 不能为空");
  if (!UPLOAD_KINDS[module].includes(kind)) {
    throw new Error(`${module} 不支持 kind=${kind}（可用：${UPLOAD_KINDS[module].join(" / ")}）`);
  }
  const absolute = resolve(path);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`读不到文件：${absolute}`);
  }
  if (!info.isFile()) throw new Error(`不是文件：${absolute}`);
  // 「是不是视频」按 kind 判（序列帧的参考视频、sprite 的本地自选视频），
  // 上限与嗅探都跟着它走：落到图片那条路上会被图片嗅探当场拒掉，而且 30MB 的上限
  // 会让一段正常的手机视频莫名其妙传不进来。
  const isVideo = kind === "referenceVideo" || kind === "video";
  // 音效的参考音频不是图片：不能走 sniffImage，上限也是平台规定的 10MB。
  const isAudio = kind === "referenceAudio";
  const limit = isVideo ? VIDEO_MAX_BYTES : isAudio ? SFX_REF_MAX_BYTES : IMAGE_MAX_BYTES;
  if (info.size > limit) {
    throw new Error(`文件 ${(info.size / 1024 / 1024).toFixed(1)}MB 超过上限 ${(limit / 1024 / 1024).toFixed(0)}MB：${absolute}`);
  }
  const bytes = await readFile(absolute);
  const base64 = bytes.toString("base64");
  const fileName = name ?? basename(absolute);

  if (!isVideo && !isAudio && sniffImage(base64) === undefined) {
    throw new Error(`无法识别的图片格式（支持 PNG / JPEG / WebP / GIF / BMP）：${absolute}`);
  }

  const call = gateway as any;
  /** sprite 的本地视频要额外回报「落到哪个槽位、有没有顺手抽帧」。 */
  let videoResult: Record<string, any> | undefined;
  if (module === "sprite") {
    if (kind === "video") {
      // 槽位必须显式给：猜一个（比如默认转圈）会把一段行走视频塞进错误的位置，
      // 而且产物看起来「成功了」——只能等着后面几步出错。
      const slot = key ?? "";
      if (!SPRITE_VIDEO_SLOTS.includes(slot)) {
        throw new Error(
          `sprite + kind=video 必须给 key（可用：${SPRITE_VIDEO_SLOTS.join(" / ")}），收到：${slot === "" ? "（空）" : slot}`
        );
      }
      videoResult = await call.uploadVideo({ projectId: id, key: slot, name: fileName, data: base64 });
      return {
        module,
        id,
        kind,
        key: slot,
        name: fileName,
        path: absolute,
        bytes: info.size,
        video: videoResult,
        ...openInfo({ module, projectId: id }, "点开确认视频已就位")
      };
    }
    await call.uploadSource({ projectId: id, name: fileName, data: base64 });
  } else if (module === "image") {
    if (kind === "ref") await call.uploadImageRef({ jobId: id, name: fileName, data: base64 });
    else await call.addImageItem({ jobId: id, name: fileName, data: base64 });
  } else if (module === "map") {
    await call.importMapTileset({ projectId: id, name: fileName, data: base64 });
  } else if (module === "rig") {
    if (kind === "part") await call.uploadRigPart({ jobId: id, name: fileName, data: base64 });
    else await call.uploadRigSource({ jobId: id, name: fileName, data: base64 });
  } else if (module === "tile") {
    // 地图地块目前不需要上传素材：地块由模板 + 提示词生成。
    // 明确报错，而不是掉进 sequence 分支里做一件风马牛不相及的事。
    throw new Error("地图地块模块不需要上传素材：地块由「代码渲染的菱形模板 + 提示词」生成。要改画风请用 saveTileProject({style})");
  } else if (module === "music") {
    throw new Error("音乐模块 v1 不导入本地音频：只用 runMusicGeneration 生成的歌曲；要编辑本地文件请等后续版本。");
  } else if (module === "sfx") {
    await call.uploadSfxRef({
      jobId: id,
      kind: kind === "referenceAudio" ? "audio" : "image",
      name: fileName,
      data: base64
    });
  } else {
    await call.uploadSequenceRef({ jobId: id, kind, name: fileName, data: base64 });
  }

  return {
    module,
    id,
    kind,
    name: fileName,
    path: absolute,
    bytes: info.size,
    ...openInfo(module === "sprite" ? { module, projectId: id } : { module, jobId: id }, "点开确认素材已就位")
  };
}

function renderIntake(value: any): string {
  const lines: string[] = [`【固定流程第 0 步】${value.module}${value.id === null ? "（新目标）" : ` · ${value.id}`}`];
  if (value.blockers.length > 0) {
    lines.push("必须先解决：");
    for (const blocker of value.blockers) lines.push(`  ✗ ${blocker}`);
  }
  lines.push("要问用户的参数：");
  if (value.questions.length === 0) lines.push("  （没有遗漏——用户已经说清了，可以直接动手）");
  for (const question of value.questions) {
    lines.push(`  ? [${question.key}] ${question.question}`);
    lines.push(`      ${question.why}`);
  }
  lines.push(`必须问：${value.reviewModeQuestion.question}`);
  for (const option of value.reviewModeQuestion.options) lines.push(`  - ${option.label}：${option.detail}`);
  const knownKeys = Object.keys(value.known ?? {});
  if (knownKeys.length > 0) {
    lines.push("已知 / 有默认值（不必问，除非用户主动要改）：");
    for (const key of knownKeys) {
      const entry = value.known[key];
      lines.push(`  · ${key}：${typeof entry === "object" ? JSON.stringify(entry) : entry}`);
    }
  }
  lines.push(value.nextStep);
  lines.push(value.afterAnswered);
  return lines.join("\n");
}

function renderUpload(value: any): string {
  const tail = typeof value.openUrl === "string" ? `\n打开界面：[${value.openHint}](${value.openUrl})` : "";
  const slot = typeof value.key === "string" ? ` · 槽位 ${value.key}` : "";
  const video = value.video ?? {};
  const note =
    typeof value.key === "string"
      ? video.key === "turn"
        ? video.extractStarted === true
          ? "；已自动开始抽候选帧并切出八个方向图"
          : `；抽帧没有自动开始（${video.extractReason ?? "未知原因"}），需要手动 runTurnFrames`
        : "；接着到第 3 步 runFrames 抽帧即可"
      : "";
  return `已上传 ${value.name}（${(value.bytes / 1024).toFixed(0)} KB）→ ${value.module} · ${value.id} · ${value.kind}${slot}${note}${tail}`;
}

function renderReviewMode(value: any): string {
  const tail = typeof value.openUrl === "string" ? `\n打开界面：[${value.openHint}](${value.openUrl})` : "";
  return `${value.id} 的审核模式已记为「${value.reviewMode === "manual" ? "每一步人工审核" : "自动审核"}」。${
    value.reviewMode === "manual" ? "之后每一步产出后都要贴验收链接并停下等用户说通过。" : "之后 agent 自己审完即可继续。"
  }${tail}`;
}

// ── 工具结果的文字渲染 ──────────────────────────────────────────────────
// 模型看到的是这段文本；链接与关键计数必须一眼可见。

function renderCallResult(value: any): string {
  const head = `${value.method} → ok`;
  const body = JSON.stringify(value.value, null, 2);
  const clipped = body.length > 4000 ? `${body.slice(0, 4000)}\n…（已截断）` : body;
  const link = typeof value.openUrl === "string" ? `\n打开界面：[${value.openHint}](${value.openUrl})` : "";
  return `${head}\n${clipped}${link}`;
}

/**
 * 阶段一行文字。八方向图 / 图片 / 序列帧的阶段带 ready/total/running，
 * 骨骼动画的阶段只有 status——按同一套字段渲染，骨骼动画会印出一串 undefined。
 */
function renderStageLine(stage: any): string {
  const tail = `${stage.approved === true ? " · 已通过" : ""}${stage.stale ? " · 需重做" : ""}${stage.error ? ` · ${stage.error}` : ""}`;
  if (typeof stage.ready === "number" || typeof stage.total === "number") {
    return `${stage.title}：ready ${stage.ready ?? 0}/${stage.total ?? 0}，running ${stage.running ?? 0}，error ${stage.error ?? "-"}，已通过 ${stage.approved === true}`;
  }
  return `${stage.title}：${stage.status ?? "-"}${tail}`;
}

/** 骨骼动画阶段没有「格子」，产物是每阶段固定的几个 URL。 */
function renderRigStageDetail(stage: any): string[] {
  const lines: string[] = [];
  const push = (label: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0) lines.push(`      ${label}：${value}`);
  };
  if (stage.stage === "parts") {
    push("拆件图", stage.url);
    if (typeof stage.partReady === "number") lines.push(`      可用部件：${stage.partReady}`);
  } else if (stage.stage === "layout") {
    push("合成图", stage.composite);
    push("并排对比图", stage.comparison);
    if (Array.isArray(stage.unmatched) && stage.unmatched.length > 0) {
      lines.push(`      没匹配上（要手工摆或给先验）：${stage.unmatched.join("、")}`);
    }
  } else if (stage.stage === "rig") {
    push("骨架 JSON（Spine 4.2）", stage.skeleton);
    push("骨架 JSON（DragonBones 5.5）", stage.dragonBones?.skeleton);
    push("预览页（双击可播动画）", stage.preview);
    if (Array.isArray(stage.animations) && stage.animations.length > 0) lines.push(`      动画：${stage.animations.join("、")}`);
    for (const warning of stage.warnings ?? []) lines.push(`      ⚠ ${warning}`);
  } else if (stage.stage === "atlas") {
    push("图集 PNG", stage.image);
    push("图集文本（Spine）", stage.text);
    for (const entry of stage.dragonBones ?? []) push("贴图描述（DragonBones）", entry.url);
    if (typeof stage.width === "number" && typeof stage.height === "number") lines.push(`      尺寸：${stage.width}×${stage.height}`);
  }
  return lines;
}

/** 模块六四个阶段的显示名（key 与对话面契约不变，变的只是中文名）。 */
const MAP_STAGE_LABELS: Record<string, string> = { assets: "素材", rules: "自动连接", paint: "地图", export: "导出" };

/**
 * 地图编辑器的验收摘要：素材 / 阶段 / 地图 / 预览图 / 导出产物。
 *
 * 这里的每一条都是**能点开的绝对 URL** —— 模型把它贴进回复，用户点一下就能看图。
 * 判定依据用 `Array.isArray(value.tilesets)`（只有模块六的快照有这个字段）。
 */
function renderMapSummary(value: any): string[] {
  const lines: string[] = [];
  if (Array.isArray(value.stages)) {
    lines.push(
      `  阶段：${value.stages
        .map((stage: any) => `${MAP_STAGE_LABELS[stage.stage] ?? stage.stage}：${stage.status}${stage.approved ? " · 已通过" : ""}${stage.error ? ` · ${stage.error}` : ""}`)
        .join("  ")}`
    );
  }
  if (typeof value.cols === "number" && typeof value.rows === "number") lines.push(`  地图：${value.cols}×${value.rows}，已画 ${value.filled ?? 0} 格`);
  for (const layer of value.layers ?? []) lines.push(`    · ${layer.name}：${layer.filled} 格`);
  for (const tileset of value.tilesets ?? []) {
    lines.push(`  素材「${tileset.name}」${tileset.imageWidth}×${tileset.imageHeight} · ${tileset.reason ?? ""} · ${tileset.tileCount} 块 · 笔刷 ${tileset.palette?.length ?? 0} 个`);
    if (typeof tileset.url === "string") lines.push(`      ${tileset.url}`);
  }
  for (const url of value.previewUrls ?? value.preview ?? []) lines.push(`  验收预览图：${url}`);
  if (typeof value.exportBaseUrl === "string" && value.exportBaseUrl !== "") lines.push(`  导出目录：${value.exportBaseUrl}`);
  if (typeof value.exportPath === "string" && value.exportPath !== "") lines.push(`  导出目录（本机路径）：${value.exportPath}`);
  for (const file of value.exportFiles ?? []) lines.push(`      ${file}`);
  for (const warning of value.warnings ?? []) lines.push(`  ⚠ ${warning}`);
  return lines;
}

/** 音乐任务的验收/状态摘要：歌曲、版本、工具与导出都直接给可点的 URL。 */
function renderMusicSummary(value: any): string[] {
  const lines: string[] = [];
  const stageLabels: Record<string, string> = { compose: "谱曲", generate: "生成", edit: "编辑", export: "导出" };
  if (Array.isArray(value.stages)) {
    lines.push(
      `  阶段：${value.stages
        .map((stage: any) => `${stageLabels[stage.stage] ?? stage.stage}：${stage.status ?? "idle"}${stage.approved ? " · 已通过" : ""}${stage.error ? ` · ${stage.error}` : ""}`)
        .join("  ")}`
    );
  } else if (value.stages !== null && value.stages !== undefined) {
    lines.push(
      `  阶段：${Object.entries(value.stages)
        .map(([key, stage]: [string, any]) => `${stageLabels[key] ?? key}：${stage?.status ?? "idle"}${stage?.approved ? " · 已通过" : ""}${stage?.error ? ` · ${stage.error}` : ""}`)
        .join("  ")}`
    );
  }
  if (value.source !== undefined && value.source !== null) {
    const kind = value.source.kind === "lyrics" ? "完整歌词" : "灵感提示词";
    lines.push(`  输入：${kind}${value.source.title ? ` · 标题「${value.source.title}」` : ""}${value.source.instrumental ? " · 纯音乐" : ""}`);
    if (value.source.note) lines.push(`  补充要求：${String(value.source.note).slice(0, 200)}`);
    if (value.source.adaptedPrompt) lines.push(`  AI 扩写提示词：${String(value.source.adaptedPrompt).slice(0, 240)}`);
    if (value.source.adaptedTags) lines.push(`  风格标签：${String(value.source.adaptedTags).slice(0, 240)}`);
  }
  if (value.workflow === "compose") {
    lines.push("  工作流：谱曲模式（本地 MIDI；谱曲/试听免费，交 Suno 才计费）");
  }
  if (value.settings !== undefined && value.settings !== null) {
    lines.push(`  引擎：${value.settings.engine ?? "?"} · 模式：${value.settings.mode ?? "?"} · 模型：${value.settings.model ?? "?"}`);
  }
  if (value.scorePlan !== undefined && value.scorePlan !== null) {
    const plan = value.scorePlan as any;
    const head = [plan.style, plan.mood, plan.key, plan.tempo ? `${plan.tempo} BPM` : "", plan.timeSignature].filter(Boolean).join(" · ");
    lines.push(`  谱曲方案：${head || "（已保存）"}`);
    if (Array.isArray(plan.structure) && plan.structure.length > 0) {
      lines.push(`    段落：${plan.structure.map((entry: any) => `${entry.name}${entry.bars ? ` ${entry.bars}小节` : ""}${entry.energy ? ` ${entry.energy}` : ""}`).join(" → ")}`);
    }
    if (plan.summary) lines.push(`    ${String(plan.summary).slice(0, 400)}`);
  }
  for (const composition of value.compositions ?? []) {
    lines.push(
      `  谱曲「${composition.label}」：${composition.status}${composition.approved ? " · 已通过" : ""} · ${composition.midi?.bars ?? "?"} 小节 / ${Number(composition.midi?.duration ?? 0).toFixed(1)}s${composition.audioRenderer ? ` · ${composition.audioRenderer}` : ""}${composition.audioError ? ` · 试听失败：${composition.audioError}` : ""}`
    );
    if (typeof composition.midiUrl === "string") lines.push(`      MIDI：${composition.midiUrl}`);
    if (typeof composition.audioUrl === "string") lines.push(`      试听：${composition.audioUrl}`);
  }
  if (typeof value.songsReady === "number" && typeof value.songsTotal === "number") {
    lines.push(`  歌曲：${value.songsReady}/${value.songsTotal} 首就绪`);
  }
  for (const song of value.songs ?? []) {
    lines.push(
      `  - ${song.title ?? song.id}：${song.status}${song.approved ? " · 已通过" : ""}${song.duration ? ` · ${Number(song.duration).toFixed(1)}s` : ""}${song.downloadError ? ` · 下载失败：${song.downloadError}` : ""}${song.error ? ` · ${song.error}` : ""}`
    );
    if (typeof song.url === "string") lines.push(`      ${song.url}`);
    if (typeof song.wavUrl === "string") lines.push(`      WAV：${song.wavUrl}`);
    if (typeof song.lrcUrl === "string") lines.push(`      滚动歌词：${song.lrcUrl}`);
  }
  for (const version of value.versions ?? []) {
    lines.push(
      `  版本「${version.label}」：${version.status}${version.preview ? " · 试听" : ""}${version.error ? ` · ${version.error}` : ""} · ${version.format}${version.duration ? ` · ${Number(version.duration).toFixed(1)}s` : ""}`
    );
    if (typeof version.url === "string") lines.push(`      ${version.url}`);
  }
  for (const tool of value.tools ?? []) {
    lines.push(`  工具 ${tool.kind}：${tool.status}${tool.error ? ` · ${tool.error}` : ""}`);
    for (const file of tool.files ?? []) {
      lines.push(`      ${file.name}${typeof file.url === "string" ? `：${file.url}` : `：${file.file}`}`);
    }
    if (tool.result !== undefined && tool.kind === "style-analysis") {
      const result = tool.result as any;
      lines.push(`      风格：${(result.genres ?? []).join(" / ")}；标签：${(result.tags ?? []).join(" / ")}`);
      if (result.description) lines.push(`      ${String(result.description).slice(0, 240)}`);
    }
  }
  for (const entry of value.exports ?? []) {
    lines.push(`  导出：${entry.file}`);
    if (typeof entry.downloadUrl === "string") lines.push(`      ${entry.downloadUrl}`);
  }
  if (typeof value.blocker === "string" && value.blocker !== "") {
    lines.push(value.workflow === "compose" ? `  ⚠ 交 Suno 需要：${value.blocker}` : `  ⚠ ${value.blocker}`);
  }
  return lines;
}

/** 音效任务的摘要：阶段 / 提示词 / 参考 / takes / 导出。 */
function renderSfxSummary(value: any): string[] {
  const lines: string[] = [];
  const stageLabels: Record<string, string> = { generate: "生成", export: "导出" };
  if (Array.isArray(value.stages)) {
    lines.push(
      `  阶段：${value.stages
        .map((stage: any) => `${stageLabels[stage.stage] ?? stage.stage}：${stage.status ?? "idle"}${stage.approved ? " · 已通过" : ""}${stage.error ? ` · ${stage.error}` : ""}`)
        .join("  ")}`
    );
  } else if (value.stages !== null && value.stages !== undefined) {
    lines.push(
      `  阶段：${Object.entries(value.stages)
        .map(([key, stage]: [string, any]) => `${stageLabels[key] ?? key}：${stage?.status ?? "idle"}${stage?.approved ? " · 已通过" : ""}${stage?.error ? ` · ${stage.error}` : ""}`)
        .join("  ")}`
    );
  }
  if (typeof value.prompt === "string" && value.prompt !== "") lines.push(`  提示词：${value.prompt.slice(0, 300)}`);
  if (value.settings !== undefined && value.settings !== null) {
    lines.push(`  输出：${value.settings.format ?? "?"} / ${value.settings.sampleRate ?? "?"}Hz`);
  }
  const refs = value.refs ?? {};
  if (refs.image !== undefined && refs.image !== null) {
    lines.push(`  参考图：${refs.image.name ?? refs.image.file}${typeof refs.image.url === "string" ? ` · ${refs.image.url}` : ""}`);
  }
  if (Array.isArray(refs.audios) && refs.audios.length > 0) {
    lines.push(`  参考音频（${refs.audios.length} 条）：${refs.audios.map((entry: any) => entry.name ?? entry.file).join(" / ")}`);
  }
  if (typeof value.error === "string" && value.error !== "") lines.push(`  ⚠ 上次失败：${value.error}`);
  if (typeof value.blocker === "string" && value.blocker !== "") lines.push(`  ⚠ ${value.blocker}`);
  for (const take of value.takes ?? []) {
    lines.push(
      `  take ${take.id}：${take.format}${take.duration ? ` · ${Number(take.duration).toFixed(2)}s` : ""}${take.originalDuration ? `（计费 ${Number(take.originalDuration).toFixed(2)}s）` : ""} · ${take.bytes} 字节`
    );
    if (typeof take.prompt === "string" && take.prompt !== "") lines.push(`      提示词：${take.prompt.slice(0, 200)}`);
    if (typeof take.url === "string") lines.push(`      ${take.url}`);
  }
  for (const entry of value.exports ?? []) {
    lines.push(`  导出：${entry.file}`);
    if (typeof entry.downloadUrl === "string") lines.push(`      ${entry.downloadUrl}`);
  }
  return lines;
}

function renderStatus(value: any): string {
  if (Array.isArray(value.projects)) {
    const lines = [
      `项目（${value.projects.length}）：`,
      ...value.projects.map((p: any) => `  - ${p.id} ${p.name} — 图 ${p.imageReady}/8 · 视频 ${p.videoReady}/8 · 帧 ${p.framesReady}/8${p.sheetReady ? " · 整图✓" : ""}${p.imageMode === "turn" ? " · 阶段①转圈截帧" : p.imageMode === "direct" ? " · 阶段①逐方向生图" : ""}`),
      `图片任务（${value.imageJobs.length}）：`,
      ...value.imageJobs.map((j: any) => `  - ${j.id} ${j.name} — ${j.ready}/${j.total} 张（抠像 ${j.keyed}）`),
      `序列帧任务（${value.sequenceJobs.length}）：`,
      ...value.sequenceJobs.map((j: any) => `  - ${j.id} ${j.name} — 视频${j.videoReady ? "✓" : "✗"} 帧${j.frameReady ? "✓" : "✗"} 条图${j.sheetReady ? "✓" : "✗"}`),
      `音乐任务（${(value.musicJobs ?? []).length}）：`,
      ...(value.musicJobs ?? []).map((j: any) => `  - ${j.id} ${j.name} — ${j.workflow === "compose" ? `谱曲 ${j.compositions ?? 0} 版 · ` : ""}${j.songsReady}/${j.songsTotal} 首 · ${j.versions} 个版本${j.busy ? " · ⏳" : ""}`),
      `音效任务（${(value.sfxJobs ?? []).length}）：`,
      ...(value.sfxJobs ?? []).map((j: any) => `  - ${j.id} ${j.name} — ${j.takes ?? 0} 条${j.latestDuration === null || j.latestDuration === undefined ? "" : ` · 最新 ${Number(j.latestDuration).toFixed(2)}s`}${j.busy ? " · ⏳" : ""}`),
      ...(Array.isArray(value.hiddenModules) && value.hiddenModules.length > 0
        ? [`已隐藏的功能（工具面同样不可调用）：${value.hiddenModules.map((key: string) => MODULE_LABELS[key as ModuleKey] ?? key).join("、")}`]
        : []),
      value.hint
    ];
    return lines.join("\n");
  }
  const lines = [`${value.name}（${value.id}）${value.busy ? " — ⏳ 有任务在跑" : ""}`];
  // 拆件质检放在最前面：它管的是「这批拆件能不能信」，直接决定后面几步值不值得做。
  if (value.qa !== null && value.qa !== undefined) {
    lines.push(`  ${renderRigQa(value.qa)}`);
  }
  if (value.module === "music") lines.push(...renderMusicSummary(value));
  if (value.module === "sfx") lines.push(...renderSfxSummary(value));
  if (value.module !== "music" && value.module !== "sfx" && Array.isArray(value.stages)) {
    for (const stage of value.stages) {
      lines.push(`  ${renderStageLine(stage)}`);
      // 骨骼动画：阶段名之后直接把产物 URL 贴上，否则用户点不到东西。
      for (const detail of renderRigStageDetail(stage)) lines.push(detail);
    }
  }
  // 地图编辑器（模块六）：它的阶段是**对象**（不是数组），素材 / 预览图 / 导出清单
  // 也不在通用字段里，单独一段。
  if (Array.isArray(value.tilesets)) for (const line of renderMapSummary(value)) lines.push(line);
  // 八方向图：阶段①的两种生成方式差异很大，状态里必须写明走的是哪条、
  // 转圈视频与八个截帧位置各是什么——否则 agent 只能对着一张张方向图猜。
  if (value.imageMode !== undefined && value.turn !== undefined) {
    const turn = value.turn ?? {};
    lines.push(`  阶段①生成方式：${value.imageMode === "turn" ? "转圈截帧（默认）" : "逐方向生图（备选）"}`);
    if (value.imageMode === "turn") {
      lines.push(
        `  转圈视频：${turn.videoStatus ?? "empty"}${turn.remoteStatus ? `（${turn.remoteStatus}）` : ""}` +
          `${turn.frameCount > 0 ? ` · 候选帧 ${turn.frameCount} 张 / 时长 ${Number(turn.duration ?? 0).toFixed(2)} 秒` : " · 还没有候选帧"}` +
          `${turn.stale === true ? " · 候选帧已过期，需要重新抽帧" : ""}`
      );
      if (typeof turn.videoUrl === "string") lines.push(`  转圈视频地址：${turn.videoUrl}`);
      if (typeof turn.stripUrl === "string") lines.push(`  整圈缩略条带：${turn.stripUrl}`);
      const picks = value.turnPicks ?? {};
      const pickKeys = Object.keys(picks);
      if (pickKeys.length > 0) lines.push(`  八个截帧位置：${pickKeys.map((key) => `${key}=${picks[key]}`).join(" ")}`);
      if (typeof turn.error === "string" && turn.error !== "") lines.push(`  转圈视频错误：${turn.error}`);
    }
  }
  if (Array.isArray(value.parts)) {
    const ready = value.parts.filter((part: any) => part.status === "ready").length;
    const placed = value.parts.filter((part: any) => part.placed).length;
    lines.push(`  部件 ${ready} 件可用，已放置 ${placed}`);
    const unmatched = value.parts.filter((part: any) => part.status === "ready" && !part.placed).map((part: any) => part.name);
    if (unmatched.length > 0) lines.push(`  没定位到的：${unmatched.join("、")}`);
  }
  if (Array.isArray(value.items)) lines.push(`  图片 ${value.review?.ready ?? "?"} 张就绪，已通过 ${value.review?.approved ?? "?"}，失败 ${value.review?.error ?? "?"}`);
  if (Array.isArray(value.steps)) {
    for (const step of value.steps) lines.push(`  ${step.title}：${step.status}${step.approved ? " · 已通过" : ""}${step.error ? ` · ${step.error}` : ""}`);
  }
  if (typeof value.openUrl === "string") lines.push(`打开界面：[${value.openHint}](${value.openUrl})`);
  return lines.join("\n");
}

/** 拆件质检：把结论、重复件和建议都摆出来，agent 才能据此决定下一步。 */
function renderRigQa(qa: any): string {
  const head = `拆件质检：${qa.ok ? "通过" : "**不通过**"}（可信度 ${Math.round((qa.score ?? 0) * 100)}%）— ${qa.summary ?? ""}`;
  const lines = [head];
  for (const issue of qa.issues ?? []) {
    const mark = issue.level === "error" ? "✗" : "⚠";
    lines.push(`      ${mark} [${issue.code}] ${issue.message}`);
    if (typeof issue.suggestion === "string" && issue.suggestion !== "") lines.push(`        → ${issue.suggestion}`);
  }
  if (qa.expectedParts !== undefined) lines.push(`      （参考图目测约 ${qa.expectedParts} 个独立部位）`);
  return lines.join("\n");
}

function renderWait(value: any): string {
  const head = value.settled ? `已跑完（${(value.elapsedMs / 1000).toFixed(1)}s）` : `仍在跑（等待 ${(value.elapsedMs / 1000).toFixed(1)}s 后超时）`;
  return `${head}\n${renderStatus(value)}`;
}

function renderReview(value: any): string {
  const lines = [`${value.name}（${value.id}）验收包${value.busy ? " — ⏳ 仍有任务在跑" : ""}`];
  if (value.qa !== null && value.qa !== undefined) lines.push(renderRigQa(value.qa));
  // 地图编辑器（模块六）：产物形状和别的模块完全不同（素材 + 一张地图 + 导出清单），
  // 单独走一段，免得掉进下面按 cells / items 迭代的通用分支。
  if (value.module === "map") lines.push(...renderMapSummary(value));
  if (value.module === "music") lines.push(...renderMusicSummary(value));
  if (value.module === "sfx") lines.push(...renderSfxSummary(value));
  if (value.module !== "music" && value.module !== "sfx" && Array.isArray(value.stages)) {
    for (const stage of value.stages) {
      lines.push(`${stage.title}${stage.stale ? " · 需重做" : ""}`);
      // 骨骼动画的阶段**没有 cells**（产物是每阶段固定的几个 URL），
      // 一律按 cells 迭代会直接把整个工具调用炸掉（stage.cells is not iterable）。
      for (const detail of renderRigStageDetail(stage)) lines.push(detail);
      for (const cell of stage.cells ?? []) {
        lines.push(`  - ${cell.label}：${cell.status}${cell.approved ? " · 已通过" : ""}${cell.stale ? " · 需重做" : ""}${cell.error ? ` · ${cell.error}` : ""}`);
        if (typeof cell.url === "string") lines.push(`      ${cell.url}`);
      }
    }
  }
  if (Array.isArray(value.items)) {
    for (const item of value.items) {
      lines.push(`  - 第 ${item.index} 张：${item.status}${item.approved ? " · 已通过" : ""}${item.error ? ` · ${item.error}` : ""}`);
      if (typeof item.url === "string") lines.push(`      ${item.url}`);
      if (typeof item.keyedUrl === "string") lines.push(`      ${item.keyedUrl}（透明 PNG）`);
    }
  }
  if (Array.isArray(value.steps)) {
    for (const step of value.steps) {
      lines.push(`  - ${step.title}：${step.status}${step.approved ? " · 已通过" : ""}${step.stale ? " · 需重做" : ""}${step.error ? ` · ${step.error}` : ""}`);
      if (typeof step.url === "string") lines.push(`      ${step.url}`);
      for (const url of step.keyed ?? []) lines.push(`      ${url}`);
    }
  }
  if (Array.isArray(value.parts)) {
    for (const part of value.parts) {
      lines.push(
        `  - ${part.label ?? part.name}：${part.status}${part.approved ? " · 已通过" : ""}${part.placed ? " · 已定位" : " · 未定位"}${part.hidden ? " · 已隐藏" : ""}${typeof part.score === "number" ? ` · 相似度 ${part.score}` : ""}${part.error ? ` · ${part.error}` : ""}`
      );
      if (typeof part.url === "string") lines.push(`      ${part.url}`);
    }
  }
  for (const action of value.nextActions ?? []) lines.push(`建议：${action}`);
  if (typeof value.openUrl === "string") lines.push(`打开界面验收：[${value.openHint}](${value.openUrl})`);
  return lines.join("\n");
}

function renderApprove(value: any): string {
  const where = [value.stage, value.step, value.key, value.index === null || value.index === undefined ? undefined : `第 ${value.index} 张`]
    .filter((part) => part !== undefined && part !== null)
    .join(" / ");
  const tail = typeof value.openUrl === "string" ? `\n打开界面：[${value.openHint}](${value.openUrl})` : "";
  return `${value.id}${where === "" ? "" : ` · ${where}`} → ${value.approved ? "已标记通过" : "已取消通过"}${tail}`;
}

// ── 「下一步该做什么」的推荐 ────────────────────────────────────────────

function spriteNextActions(snapshot: any, stage: string | undefined, direction: string | undefined): string[] {
  const byStage = Object.fromEntries((snapshot.stages as any[]).map((entry) => [entry.stage, entry]));
  const actions: string[] = [];
  const pick = (key: string) => (stage === undefined || stage === key ? byStage[key] : undefined);

  const images = pick("images");
  if (images !== undefined && images.ready < images.total) {
    // 转圈截帧是默认路径，它的下一步与逐方向生图完全不同，提示必须分开写——
    // 报错信息里点错方法，模型会照着 runImages 一路跑到「八个方向不一致」上去。
    const turn = snapshot.turn ?? {};
    if (snapshot.imageMode === "turn") {
      if (turn.videoStatus !== "ready") {
        actions.push(
          snapshot.sourceFile === null
            ? "还没有源图：先用 game_material_call({method:'uploadSource', payload:{projectId,name,data}}) 上传一张设定图"
            : `转圈视频还没有：game_material_call({method:'runTurnVideo', payload:{projectId}}) 然后 game_material_wait（★花钱一次，约几分钟）；视频到手会自动抽候选帧并切出八个方向`
        );
        // 本地自选视频和远程生成是**并列**的两条路：用户手上已经有一段转圈视频时，
        // 这条一步到位、不花钱，不应该被埋在描述里。
        actions.push(
          "也可以不用远程生成：把现成的视频用 game_material_upload({module:'sprite', id, kind:'video', key:'turn', path}) 传进来（等价于界面上的「选择本地视频」），导入后同样会自动抽候选帧并切出八个方向"
        );
      } else {
        actions.push(
          `转圈视频已就绪，还差 ${images.total - images.ready} 张方向图：game_material_call({method:'runTurnFrames', payload:{projectId}}) 然后 game_material_wait（本地免费）`
        );
      }
      if (turn.frameCount > 0) {
        actions.push(
          `★ 先核对八个朝向：read_image 看 turn.stripUrl（整圈候选帧条带），确认每个方向落在第几帧——左侧脸/右侧脸反了就是转圈方向反了，` +
            `用 resetTurnPicks({direction:'cw'|'ccw'}) 一键重排；模型起步/收尾减速（前几帧还停在正面）时用 ` +
            `setTurnPicks({projectId, picks:{front:1, downRight:6, …}}) 整份写回（index 取 0…${Math.max(0, turn.frameCount - 1)}）`
        );
      }
    } else {
      actions.push(
        snapshot.sourceFile === null
          ? "还没有源图：先用 game_material_call({method:'uploadSource', payload:{projectId,name,data}}) 上传一张设定图"
          : `绿幕图还差 ${images.total - images.ready} 张：game_material_call({method:'runImages', payload:{projectId}}) 然后 game_material_wait`
      );
    }
  }
  const videos = pick("videos");
  if (videos !== undefined && videos.ready < videos.total && (images === undefined || images.ready === images.total)) {
    actions.push(`视频还差 ${videos.total - videos.ready} 段：game_material_call({method:'runVideos', payload:{projectId}}) 然后 game_material_wait（这一步最贵，约几分钟）`);
    actions.push(
      "某个方向已经有现成视频时，用 game_material_upload({module:'sprite', id, kind:'video', key:'<方向>', path}) 直接顶替那一段（不花钱），之后照旧 runFrames 抽帧"
    );
  }
  const frames = pick("frames");
  if (frames !== undefined && frames.ready < frames.total && (videos === undefined || videos.ready === videos.total)) {
    actions.push("序列帧还没抽完：game_material_call({method:'runFrames', payload:{projectId}}) 然后 game_material_wait");
  }
  const sheet = pick("sheet");
  if (sheet !== undefined && sheet.ready < sheet.total && (frames === undefined || frames.ready === frames.total)) {
    actions.push("整图还没合成：game_material_call({method:'compose', payload:{projectId}}) 然后 game_material_wait");
  }
  const stageEntry = byStage[stage ?? ""];
  if (stageEntry !== undefined && stageEntry.error > 0) {
    actions.push(`有 ${stageEntry.error} 个产物失败：先看返回里的 error，再对失败项用 runImage / runVideos({regenerate:true, keys:[…]}) / runFrames({keys:[…]}) 重跑`);
  }
  if (direction !== undefined) actions.push(`只看方位 ${direction} 的重跑：game_material_call({method:'runVideos', payload:{projectId, keys:['${direction}'], regenerate:true}})`);
  if (actions.length === 0) actions.push("这一步已全部就绪：可以 game_material_approve 打通过，或进入下一阶段");
  return actions;
}

function imageNextActions(snapshot: any): string[] {
  const actions: string[] = [];
  if (snapshot.review.ready === 0 && snapshot.review.error === 0) {
    actions.push("还没有产物：确认 prompt 非空后 game_material_call({method:'runImageJob', payload:{jobId,count}}) 然后 game_material_wait");
  }
  if (snapshot.review.error > 0) actions.push(`有 ${snapshot.review.error} 张失败：看 error 后调整提示词或参考图再重跑`);
  if (snapshot.keying?.enabled !== true) actions.push("还没开抠像：saveImageJob({jobId, keying:{enabled:true}}) 再 keyImageJob({jobId})");
  if (snapshot.review.approved === snapshot.review.ready && snapshot.review.ready > 0) actions.push("全部已通过：可以 game_material_call({method:'revealProject'|'getImageJob'}) 取用产物");
  return actions;
}

function rigNextActions(snapshot: any, stage: string | undefined): string[] {
  const byStage = Object.fromEntries((snapshot.stages as any[]).map((entry: any) => [entry.stage, entry]));
  const actions: string[] = [];

  // 拆件质检的结论优先于一切阶段建议：它不通过时，后面每一步都在错误素材上做功。
  const qa = snapshot.qa;
  if (qa !== null && qa !== undefined && qa.ok !== true) {
    const duplicate = (qa.issues ?? []).find((issue: any) => issue.code === "duplicate-parts");
    const lowConfidence = (qa.issues ?? []).find((issue: any) => issue.code === "layout-low-confidence");
    if (duplicate !== undefined) {
      actions.push(
        "**拆件质检不通过：有部件被重复画了多遍**。先用 read_image 看 partsMontagePath 确认哪几块是同一部位，" +
          "用 setRigPartVisibility({jobId,name,hidden:true}) 隐藏多余的（每组留 1 块），再重跑 runRigQa 与 runRigLayout"
      );
    }
    if (lowConfidence !== undefined) {
      actions.push(
        "**装配相似度整体偏低**：模板匹配对「重新绘制过、与参考图不像」的部件失手。" +
          "用 read_image 看 sourcePath 与 partsMontagePath，判断每块在参考图的位置，" +
          "setRigLayoutHints 写大致框后 runRigLayout；被遮挡的部位（例如裙下的整段大腿）直接给最终位置"
      );
    }
  } else if (qa !== null && qa !== undefined && qa.ok === true && qa.issues?.length > 0) {
    actions.push("拆件质检有提示项（见上面的 ⚠）：值得看一眼，但不阻塞");
  }

  const pick = (key: string) => (stage === undefined || stage === key ? byStage[key] : undefined);

  const parts = pick("parts");
  if (parts !== undefined && parts.status !== "ready") {
    actions.push(
      snapshot.sourceFile === null
        ? "还没有角色参考图：先用 game_material_upload({module:'rig', id, kind:'source', path}) 上传一张全身整图"
        : "拆件还没做：game_material_call({method:'runRigSheet', payload:{jobId}})，随后立刻 game_material_wait（这一步花钱，只跑一次）"
    );
  }
  const layout = pick("layout");
  if (layout !== undefined && parts?.status === "ready" && layout.status !== "ready") {
    actions.push("部件已就绪但还没装配：game_material_call({method:'runRigLayout', payload:{jobId}})，随后 game_material_wait（本地计算，免费）");
  }
  if (layout !== undefined && layout.status === "ready" && Object.keys(layout.hints ?? {}).length === 0) {
    actions.push(
      "如果自动摆位的结果不对（合成图上明显错位），先 read_image 看 getRigJob 返回的 sourcePath 与 partsMontagePath，" +
        "给每个部件一个大致像素框，用 setRigLayoutHints 写回去，再 runRigLayout 重跑一遍——实测这是把真实立绘摆对的关键一步"
    );
  }
  if (layout !== undefined && Array.isArray(layout.unmatched) && layout.unmatched.length > 0) {
    actions.push(
      `这些部件没匹配上：${layout.unmatched.join("、")}。可以让用户点开 openUrl 手工拖到正确位置，` +
        "也可以只重跑它们：runRigLayout({jobId, names:[…]})"
    );
  }
  const rig = pick("rig");
  if (rig !== undefined && layout?.status === "ready" && rig.status !== "ready") {
    actions.push("装配没问题了：game_material_call({method:'runRigBones', payload:{jobId}}) 生成 skeleton.json 与动画预览（免费）");
  }
  if (rig !== undefined && Array.isArray(rig.warnings) && rig.warnings.length > 0) {
    actions.push(`骨骼构建有告警：${rig.warnings.join("；")}`);
  }
  if (rig !== undefined && rig.status === "ready") {
    // 这三层是「AI 与手工共存」的实际落地：任何一层重跑都不会抹掉另外两层的人工改动。
    const semantics = snapshot.semantics;
    if (semantics !== undefined && semantics.ok !== false && semantics.confirmed !== true && semantics.count > 0) {
      actions.push(
        "语义还没被确认过：`getRigJob` 的 `parts[].role/parent/proximal/distal` 是按名字推断的默认值。" +
          "看一眼 partsMontagePath（蒙太奇图）就能判断有没有推断错的，用 setRigSemantics 改掉那几条——" +
          "改语义只作废骨骼与图集，②里已经摆好的位置不受影响"
      );
    }
    const presets = Array.isArray(rig.animationPresets) ? rig.animationPresets : [];
    const untouched = presets.filter((preset: any) => preset.duration === preset.defaultDuration && preset.amplitude === 1);
    if (presets.length > 0 && untouched.length === presets.length) {
      actions.push(
        "六个动作目前都是预设原值。如果角色的体型/节奏与预设不合（动作太大、循环太快），" +
          "用 setRigAnimationSettings({jobId, animations:[{id, amplitude, duration}]}) 调，再 runRigBones 重算——" +
          "幅度作用在缩放前的简写上，所以缓动不会被打乱"
      );
    }
    // 导出前校验不通过会让那一步直接失败，原因写在 error 里。
    const broken = [pick("rig"), pick("atlas")].filter((entry: any) => entry !== undefined && entry.status === "error");
    if (broken.length > 0) {
      actions.push("构建失败多半是**导出前校验**拦下的（Spine 4.2 wire format / DragonBones 的 tweenEasing 与 curve 编码 / 循环接缝 / 图集越界与缺区域）。先读 error 里的具体位置再改，不要盲目重跑");
    }
  }
  const atlas = pick("atlas");
  if (atlas !== undefined && rig?.status === "ready" && atlas.status !== "ready") {
    actions.push("骨骼就绪：game_material_call({method:'runRigAtlas', payload:{jobId}}) 打包纹理图集（免费）");
  }
  const failed = Object.values(byStage).filter((entry: any) => entry.status === "error");
  if (failed.length > 0) actions.push(`有阶段失败（${failed.map((entry: any) => entry.stage).join("、")}）：看返回里的 error 后只重跑那一步`);
  if (actions.length === 0) actions.push("四个阶段都已就绪：可以 game_material_approve 打通过，或把 openUrl 贴给用户验收动画预览");
  return actions;
}

function musicNextActions(snapshot: any, stage: string | undefined): string[] {
  const actions: string[] = [];
  const songs = Array.isArray(snapshot.songs) ? snapshot.songs : [];
  const ready = songs.filter((song: any) => song.status === "succeeded");
  const failed = songs.filter((song: any) => song.status === "failed");
  const pending = songs.filter((song: any) => song.status === "pending" || song.status === "processing");
  const versions = Array.isArray(snapshot.versions) ? snapshot.versions : [];
  const compositions = Array.isArray(snapshot.compositions) ? snapshot.compositions : [];
  if (snapshot.blocker) {
    actions.push(snapshot.workflow === "compose" ? `谱曲/试听不需要 Key；只有交 Suno 才需要：${snapshot.blocker}` : snapshot.blocker);
  }
  if (snapshot.workflow === "compose") {
    if (snapshot.scorePlan === undefined || snapshot.scorePlan === null) {
      actions.push("先分析用户的想法并保存谱曲方案：saveMusicScorePlan({jobId, plan})；manual 模式要停下等用户确认。");
    } else if (compositions.length === 0) {
      actions.push("方案已保存：写 compose.py（scoremill），再 runMusicScore({jobId, title, plan, script})；宿主会跑 Python 并渲染试听。");
    } else {
      actions.push("谱曲已就绪：把 openUrl 贴给用户试听；用户提修改意见就用 runMusicScore 出新版本（basedOn 指上一版），不要覆盖旧版。");
      actions.push("用户明确要求 Suno 正式版时：submitMusicScoreToSuno({jobId, scoreId, confirm:true})（★计费；先把试听音频上传为参考，再走 cover；版权音频需 copyrightAudio:true）。");
    }
    if (compositions.some((entry: any) => entry.audioError)) {
      actions.push("有版本没有试听音频：装 FluidSynth + SoundFont 可重新渲染，或让用户直接下载 MIDI。");
    }
  }
  if (snapshot.workflow !== "compose" && songs.length === 0) {
    actions.push("还没有提交生成：先 getMusicGuide 读创作指南，再用 runMusicGeneration({jobId, engine, mode, params}) 提交（★计费），随后 game_material_wait。");
  } else if (songs.length === 0) {
    // 谱曲模式还没交 Suno：不提示 runMusicGeneration，避免误触发计费。
  } else if (pending.length > 0) {
    actions.push(`还有 ${pending.length} 首在跑：game_material_wait({module:'music', id, timeoutSeconds:900})；超时用 refreshMusicJob 继续查，不要重复提交。`);
  } else if (ready.length === 0) {
    actions.push("全部失败：先看每首歌的 error，再决定是否调整提示词/参数；重试会再计费，先问用户。");
  } else {
    actions.push("歌曲已就绪：把 openUrl 贴给用户，回界面试听；要处理就用 renderMusicEdit（本地免费），要导出用 exportMusic。");
  }
  if (ready.length > 0) {
    actions.push("后期处理：renderMusicEdit({jobId, songId, ops:{start,end,gainDb,fadeIn,fadeOut,normalize,format}}) → game_material_wait；结果在 versions 里，原曲不动。");
    actions.push("导出：exportMusic({jobId, versionId?|songId?, format?, zip?})；多产物会自动打 zip。");
  }
  if (failed.length > 0) actions.push(`${failed.length} 首失败：失败重试会再计费，先向用户确认。`);
  if (versions.some((version: any) => version.status === "rendering")) actions.push("有版本正在渲染：game_material_wait 等它完成。");
  if (stage === "edit" && ready.length === 0 && songs.length === 0) actions.push("先完成生成，再来编辑。");
  if (actions.length === 0) actions.push("任务已就绪：可以继续生成、编辑或导出。");
  return actions;
}

function sequenceNextActions(snapshot: any): string[] {  const byStep = Object.fromEntries((snapshot.steps as any[]).map((entry: any) => [entry.step, entry]));
  const actions: string[] = [];
  if (byStep.video?.status !== "ready") {
    actions.push("视频还没好：game_material_call({method:'runSequenceVideo', payload:{jobId}}) 然后 game_material_wait（先确认首帧图或参考素材已上传）");
  }
  if (byStep.video?.status === "ready" && byStep.frames?.status !== "ready") {
    actions.push("视频已就绪但还没抽帧：game_material_call({method:'runSequenceFrames', payload:{jobId,count}})");
  }
  if (byStep.frames?.status === "ready" && byStep.sheet?.status !== "ready") {
    actions.push("帧已就绪但条图还没合成：game_material_call({method:'composeSequence', payload:{jobId}})");
  }
  if (byStep.frames?.stale === true) actions.push("抽帧参数改过，需要重抽：saveSequenceJob 保存参数后 runSequenceFrames");
  if (actions.length === 0) actions.push("三步都已就绪：可以 game_material_approve 打通过，或把 openUrl 贴给用户验收");
  return actions;
}
