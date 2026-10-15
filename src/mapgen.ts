/**
 * 地图编辑器（模块六）的**数据层与作业**：**单项目 = 单张地图**。
 *
 * ## 落盘布局
 *
 * ```
 * <DSH_HOME>/game-material-master/map-jobs/<项目 id>/
 * ├── project.json          元数据：网格、素材、阶段、日志
 * ├── map.json              这张地图：图层元数据 + 每层数据（0 = 空）
 * ├── tilesets/<tsId>.png   导入的素材原图（原样保存，不改写）
 * ├── preview/map.png       验收图：宿主算好的地图渲染图
 * └── export/<安全名>/      导出：map.png + map.json + manifest.json
 * ```
 *
 * 参考 AsLib 的 RPG Map Maker：一屏、零术语、地图四周**环绕**、A2 素材自动连接、
 * 动画地块、内置素材、一键生成。旧的「多地图 / 地形族 / 掩码覆盖 / 等距网格 /
 * 层高偏移 / Tiled 导出」全部删掉 —— 那些正是「预览好看、导出位移」「族配不齐
 * 就静默画错块」的来源。
 *
 * ## 编辑路径
 *
 * 界面**不发整份文档**，只发 op；宿主是唯一写者：
 * `applyMapOps` → 改内存里的文档 → 回传「脏 chunk + 该丢哪些客户端缓存」→ 防抖落盘。
 * 落盘是「最多 2 秒一次 + 停了 500ms 再补一次」，所以拖动时不会每笔都重写整个
 * 地图文件；进程被杀最多丢 2 秒的编辑（写入本身仍是原子的）。
 *
 * 撤销 / 重做是宿主侧**逆操作日志**（结构操作才存整份快照），界面不需要自己维护
 * 撤销栈 —— 旧模块那个「整份草稿 + 客户端撤销栈」正是「撤销跳步」的来源。
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendJobLog, messageOf, readJson, sweepTempFiles, writeJsonAtomic, type JobLogEntry } from "./jsonio.js";
import { dataRoot } from "./config.js";
import { decodeFile, pngSize, probeImageSize, sniffImageExt, type Bitmap } from "./bitmap.js";
import {
  addLayer,
  applyOps,
  clearLayer,
  cloneDoc,
  createMapDoc,
  filledCount,
  isDocEmpty,
  moveLayer,
  normalizeMapDoc,
  removeLayer,
  renameLayer,
  resizeDoc,
  revertOps,
  type MapDoc,
  type MapOp
} from "./mapdoc.js";
import {
  assertGrid,
  assertMapSize,
  canonicalChunk,
  chunkKey,
  chunksInRange,
  dirtyChunksFor,
  layoutOf,
  normalizeGrid,
  parseChunkKey,
  viewCellRange,
  MAX_MAP_DIM,
  MAX_PLAN_CHUNKS,
  type MapGrid
} from "./mapgeom.js";
import { bitmapToPng, buildPlan, rasterize, type PlanBounds, type PlanChunk, type PlanLegendEntry, type RenderContext } from "./maprender.js";
import {
  COMMON_TILE_SIZES,
  buildTiles,
  detectLayout,
  flatIndexByValue,
  flatTiles,
  layoutFor,
  type MapTile,
  type MapRect,
  type MapTileset,
  type FlatTile,
  type TilesetShape
} from "./maptiles.js";
import { exportMap, safeFileName, type ExportFormatOptions, type ExportManifest } from "./mapexport.js";
import { primeSampleTextures, renderSampleTilesets } from "./mapsamplegen.js";

export type MapStage = "assets" | "rules" | "paint" | "export";

/** 四个阶段（对话面契约：`stage=assets|rules|paint|export`；`rules` 自动完成、界面不显示）。 */
export const MAP_STAGES: readonly MapStage[] = ["assets", "rules", "paint", "export"];

export interface MapStageState {
  status: "idle" | "running" | "done" | "error";
  at?: string;
  error?: string;
  approved?: boolean;
  approvedAt?: string;
}

export interface MapProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  grid: MapGrid;
  tilesets: MapTileset[];
  stages: Record<MapStage, MapStageState>;
  logs: JobLogEntry[];
  reviewMode?: "auto" | "manual";
}

/** 列表页用的摘要（不带素材明细，避免 `/listMapProjects` 把整份 tilesets 发出去）。 */
export interface MapProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  grid: MapGrid;
  tilesetCount: number;
  tileCount: number;
  stages: Record<MapStage, MapStageState>;
}

// ── 路径与 id ─────────────────────────────────────────────────────────────

export function mapJobsRoot(): string {
  return join(dataRoot(), "map-jobs");
}

export function mapProjectDir(id: string): string {
  return join(mapJobsRoot(), id);
}

export function mapProjectFile(id: string): string {
  return join(mapProjectDir(id), "project.json");
}

/** 单项目 = 单张地图，文档直接放项目根。 */
export function mapDocFile(id: string): string {
  return join(mapProjectDir(id), "map.json");
}

/** 项目内的相对路径 → 绝对路径（挡住目录穿越）。 */
export function mapAssetPath(id: string, relative: string): string {
  const base = mapProjectDir(id);
  const target = join(base, relative);
  if (!target.startsWith(base)) throw new Error(`非法的项目内路径：${relative}`);
  return target;
}

/** `m` 前缀，避免与 p / i / s / r / t 撞。 */
export function isValidMapProjectId(id: string): boolean {
  return /^m[a-z0-9]{4,40}$/.test(id);
}

/**
 * 子目录白名单（静态资源路由按**第一段**比对，漏一条就是 403 + 图裂）。
 *
 * ⚠️ 与 `index.ts` 的 `AssetScope` 类型、`resolveAssetTarget` 分支、`SCOPES` 数组
 * **四处必须同步**。`maps/` 已经不存在了（单项目单地图 → `map.json` 在项目根）。
 */
export const SERVABLE_MAP_DIRS = new Set(["tilesets", "preview", "export"]);

/** 新项目默认地图尺寸（单屏一屏就能画完）。 */
const DEFAULT_COLS = 32;
const DEFAULT_ROWS = 32;

function freshStages(): Record<MapStage, MapStageState> {
  // `rules`（自动连接）现在没有可配置项：素材形态在导入时就识别好了、过渡是内置的，
  // 所以它一开始就是 done。key 保留只为不破坏对话面的阶段契约。
  return {
    assets: { status: "idle" },
    rules: { status: "done", at: new Date().toISOString() },
    paint: { status: "idle" },
    export: { status: "idle" }
  };
}

// ── 读写（带写队列）──────────────────────────────────────────────────────

const projectWriteQueue = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = projectWriteQueue.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  projectWriteQueue.set(key, next.catch(() => undefined));
  return next;
}

async function writeMapProject(project: MapProject): Promise<void> {
  project.updatedAt = new Date().toISOString();
  await writeJsonAtomic(mapProjectFile(project.id), project);
}

/**
 * 改项目元数据（改名 / 打勾 / 网格开关）。
 *
 * 读—改—写走同一条队列，两个并发的打勾不会互相覆盖。
 */
export async function patchMapProject<T>(id: string, mutator: (project: MapProject) => T): Promise<T> {
  return enqueueWrite(id, async () => {
    const project = await readMapProject(id);
    if (project === undefined) throw new Error(`项目不存在：${id}`);
    const result = mutator(project);
    await writeMapProject(project);
    return result;
  });
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function createMapProject(name: string, options: { grid?: unknown; cols?: number; rows?: number } = {}): Promise<MapProject> {
  const grid = normalizeGrid(options.grid);
  assertGrid(grid);
  const cols = positiveInt(options.cols, DEFAULT_COLS);
  const rows = positiveInt(options.rows, DEFAULT_ROWS);
  assertMapSize(cols, rows);
  const id = `m${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const project: MapProject = {
    id,
    name: name.trim() === "" ? "未命名地图" : name.trim(),
    createdAt: now,
    updatedAt: now,
    grid,
    tilesets: [],
    stages: freshStages(),
    logs: []
  };
  await mkdir(mapProjectDir(id), { recursive: true });
  for (const sub of SERVABLE_MAP_DIRS) await mkdir(join(mapProjectDir(id), sub), { recursive: true });
  appendJobLog(project.logs, "info", `新建地图项目：${project.name}（${cols}×${rows}）`);
  // 顺手建一张空地图：用户导入素材后就能直接画
  await writeTheDoc(id, createMapDoc(id, project.name, cols, rows));
  await writeMapProject(project);
  return project;
}

export async function readMapProject(id: string): Promise<MapProject | undefined> {
  const raw = await readJson<MapProject>(mapProjectFile(id));
  if (raw === undefined || typeof raw !== "object") return undefined;
  void sweepTempFiles(mapProjectDir(id));
  const stages = { ...freshStages(), ...(raw.stages ?? {}) };
  if (stages.rules.status === "idle") stages.rules = { status: "done", at: stages.rules.at ?? new Date().toISOString(), approved: stages.rules.approved };
  return {
    ...raw,
    grid: normalizeGrid(raw.grid),
    tilesets: Array.isArray(raw.tilesets) ? raw.tilesets.map(normalizeTileset) : [],
    stages,
    logs: Array.isArray(raw.logs) ? raw.logs : []
  };
}

/**
 * 素材记录的自愈式归一化：**几何字段是唯一真源，`tiles` 由它现推**。
 *
 * 这样即使某次改了 `buildTiles` 的切分规则、或者老数据缺了新字段，读一次项目就
 * 自动补齐；逐块的人工元数据（名字 / 掩码 / 形状号）按「矩形 id」尽力保留。
 */
function normalizeTileset(raw: unknown): MapTileset {
  const source = asRecord(raw);
  const imageWidth = Math.max(1, Math.round(Number(source.imageWidth) || 1));
  const imageHeight = Math.max(1, Math.round(Number(source.imageHeight) || 1));
  const cell = normalizeCell(source.cell) ?? { width: 32, height: 32 };
  const shape = isTilesetShape(source.shape) ? source.shape : "plain";
  const animRows = source.animRows === true;
  const rawTiles = source.tiles;
  const previous: MapTile[] | undefined = Array.isArray(rawTiles) ? (rawTiles as MapTile[]) : undefined;
  const tiles = buildTiles({ shape, cell, imageWidth, imageHeight, animRows }, previous);
  const tileset: MapTileset = {
    id: typeof source.id === "string" && source.id !== "" ? source.id : `ts${randomUUID().slice(0, 6)}`,
    name: typeof source.name === "string" && source.name !== "" ? source.name : "素材",
    file: typeof source.file === "string" ? source.file : "",
    imageWidth,
    imageHeight,
    cell,
    shape,
    animRows,
    variants: variantsOf(shape, cell, imageWidth, imageHeight, animRows),
    builtin: source.builtin === true ? true : undefined,
    tiles
  };
  // 老数据里「整格自动连接」没配过掩码（旧版本压根没这条路径）——读一次就补齐，
  // 这样不用让用户回去重新切一次形态。告警交给 `warningsFor` 常驻显示。
  assignCorner16Masks(tileset, []);
  return tileset;
}

/** JSON 记录收口（读盘数据一律当作不认识的东西看）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isTilesetShape(value: unknown): value is TilesetShape {
  return value === "plain" || value === "a2quad" || value === "corner16";
}

/** 界面 / 工具面传上来的形态字符串收口：不合法**明确报错**，不静默改成别的值。 */
export function parseTilesetShape(value: unknown): TilesetShape | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isTilesetShape(value)) throw new Error(`未知素材形态：${String(value)}（可选 plain / a2quad / corner16）`);
  return value;
}

/** 整数收口；形状不对时抛中文错，不静默改成别的值。 */
function normalizeCell(input: unknown): { width: number; height: number } | undefined {
  if (input === undefined || input === null) return undefined;
  const source = asRecord(input);
  const width = Math.round(Number(source.width));
  const height = Math.round(Number(source.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 2048 || height > 2048) {
    throw new Error(`素材格子尺寸不合法：${JSON.stringify(input)}（应为 1..2048 的整数宽高）`);
  }
  return { width, height };
}

/** 变体数 / 动画帧数：A2 看块列数，普通形态看行数（`animRows` 时）。 */
function variantsOf(shape: TilesetShape, cell: { width: number; height: number }, imageWidth: number, imageHeight: number, animRows: boolean): number {
  if (shape === "a2quad") return Math.max(1, Math.floor(imageWidth / cell.width));
  if (animRows) return Math.max(1, Math.floor(imageHeight / cell.height));
  return 1;
}

export async function listMapProjects(): Promise<MapProjectSummary[]> {
  let names: string[] = [];
  try {
    names = await readdir(mapJobsRoot());
  } catch {
    return [];
  }
  const out: MapProjectSummary[] = [];
  for (const name of names) {
    if (!isValidMapProjectId(name)) continue;
    const project = await readMapProject(name);
    if (project === undefined) continue;
    out.push(await summarizeMapProject(project));
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function summarizeMapProject(project: MapProject): Promise<MapProjectSummary> {
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    grid: project.grid,
    tilesetCount: project.tilesets.length,
    tileCount: flatTiles(project.tilesets).length,
    stages: project.stages
  };
}

export async function deleteMapProject(id: string): Promise<void> {
  /**
   * ⚠️ 先把**还没落盘的防抖定时器**停掉。
   *
   * 不停的话，用户删完项目、目录已经移走，定时器几秒后照样 fire → 往不存在的
   * 目录里 rename，抛 ENOENT。那是**未处理的 promise 拒绝**（自检里直接把整个
   * 脚本打挂，真机上只是控制台一声闷响，但会污染日志）。
   */
  const state = docWrites.get(id);
  if (state?.timer != null) clearTimeout(state.timer);
  docWrites.delete(id);
  docCache.delete(id);
  history.delete(id);
  await rm(mapProjectDir(id), { recursive: true, force: true });
}

async function readProjectOrThrow(projectId: string): Promise<MapProject> {
  const project = await readMapProject(projectId);
  if (project === undefined) throw new Error(`项目不存在：${projectId}`);
  return project;
}

// ── 地图文档：内存真源 + 防抖落盘 ─────────────────────────────────────────

/** `项目id` → 文档。编辑期间这是**权威副本**，磁盘是它的稳态快照。 */
const docCache = new Map<string, MapDoc>();
interface WriteState {
  timer: NodeJS.Timeout | null;
  lastWrite: number;
}
const docWrites = new Map<string, WriteState>();
/** 上一笔编辑距今超过它就直接写盘（保证「最多丢 2 秒」）。 */
const WRITE_MAX_LATENCY_MS = 2000;
const WRITE_IDLE_MS = 500;

/** 读当前项目的地图文档（内存优先）；没有就返回 undefined。 */
export async function readTheDoc(projectId: string): Promise<MapDoc | undefined> {
  const cached = docCache.get(projectId);
  if (cached !== undefined) return cached;
  const raw = await readJson<MapDoc>(mapDocFile(projectId));
  const doc = normalizeMapDoc(raw, projectId);
  if (doc === undefined) return undefined;
  docCache.set(projectId, doc);
  return doc;
}

/** 内部：读不到就给一份空地图（不落盘，第一次写的时候才存）。 */
async function theDocOrFresh(projectId: string): Promise<MapDoc> {
  const doc = await readTheDoc(projectId);
  if (doc !== undefined) return doc;
  const fresh = createMapDoc(projectId, "地图", DEFAULT_COLS, DEFAULT_ROWS);
  docCache.set(projectId, fresh);
  return fresh;
}

export async function writeTheDoc(projectId: string, doc: MapDoc): Promise<void> {
  await enqueueWrite(projectId, async () => {
    await writeJsonAtomic(mapDocFile(projectId), doc);
  });
}

/**
 * 防抖落盘：**最多 2 秒延迟 + 停笔 500ms 补齐**。
 *
 * 每笔都写的话，拖动笔刷时每 60ms 就要把整张地图（最大 512×512×多层）序列化一遍，
 * 界面会明显发涩；完全不防抖又会丢编辑。这个窗口是两者的折中。
 */
function scheduleDocWrite(projectId: string, doc: MapDoc): void {
  const state = docWrites.get(projectId) ?? { timer: null, lastWrite: 0 };
  docWrites.set(projectId, state);
  const now = Date.now();
  const elapsed = now - state.lastWrite;
  if (elapsed >= WRITE_MAX_LATENCY_MS) {
    state.lastWrite = now;
    void writeTheDoc(projectId, doc).catch(() => undefined);
    return;
  }
  if (state.timer !== null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.lastWrite = Date.now();
    void writeTheDoc(projectId, doc).catch(() => undefined);
  }, Math.max(WRITE_IDLE_MS, WRITE_MAX_LATENCY_MS - elapsed));
  if (typeof state.timer.unref === "function") state.timer.unref();
}

/** 立刻落盘（导出前、改结构后、删项目前调用）。 */
export async function flushMapDoc(projectId: string): Promise<void> {
  const doc = docCache.get(projectId);
  if (doc === undefined) return;
  const state = docWrites.get(projectId);
  if (state?.timer != null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  await writeTheDoc(projectId, doc);
}

// ── 撤销 / 重做（宿主侧逆操作日志）─────────────────────────────────────────

interface HistoryEntry {
  undo: MapOp[];
  redo: MapOp[];
  /** 结构操作：整份快照（图层增删 / 改尺寸 / 改名这类没法用 op 表达的）。 */
  snapshot?: { before: MapDoc; after: MapDoc };
  /**
   * 这一条属于哪一笔操作（一次拖拽 / 一次填充）。
   *
   * ⚠️ 拖动时 op 是每 ~60ms 批量提交的，如果每次都压一条历史，**一次拖拽会变成
   * 好几步撤销**（真机实测：擦一条线要按 4 次撤销才回到原样）。同一个 `stroke`
   * 的后续提交直接**并进上一条**，撤销粒度才等于「一笔」。
   */
  stroke?: string;
}

interface HistoryState {
  entries: HistoryEntry[];
  index: number;
  bytes: number;
}

const history = new Map<string, HistoryState>();
const HISTORY_MAX_ENTRIES = 200;
const HISTORY_MAX_BYTES = 32 * 1024 * 1024;

function estimateEntryBytes(entry: HistoryEntry, doc: MapDoc): number {
  if (entry.snapshot !== undefined) return doc.cols * doc.rows * (doc.layers.length + 1) * 4;
  return (entry.redo.length + entry.undo.length) * 32;
}

function pushHistory(projectId: string, entry: HistoryEntry, doc: MapDoc): void {
  const state = history.get(projectId) ?? { entries: [], index: -1, bytes: 0 };
  // 撤销之后又画了新东西：把「未来」截断
  if (state.index < state.entries.length - 1) {
    for (const dropped of state.entries.slice(state.index + 1)) state.bytes -= estimateEntryBytes(dropped, doc);
    state.entries = state.entries.slice(0, state.index + 1);
  }
  const previous = state.entries[state.index];
  if (
    entry.snapshot === undefined &&
    entry.stroke !== undefined &&
    previous !== undefined &&
    previous.snapshot === undefined &&
    previous.stroke === entry.stroke
  ) {
    // 同一笔的后续提交：并进上一条（撤销粒度 = 一笔，而不是一次 flush）
    previous.undo = [...entry.undo, ...previous.undo];
    previous.redo = [...previous.redo, ...entry.redo];
    state.bytes += estimateEntryBytes(entry, doc);
    history.set(projectId, state);
    return;
  }
  state.entries.push(entry);
  state.bytes += estimateEntryBytes(entry, doc);
  state.index = state.entries.length - 1;
  while (state.entries.length > HISTORY_MAX_ENTRIES || (state.bytes > HISTORY_MAX_BYTES && state.entries.length > 1)) {
    const dropped = state.entries.shift();
    if (dropped === undefined) break;
    state.bytes -= estimateEntryBytes(dropped, doc);
    state.index--;
  }
  state.index = Math.max(-1, state.index);
  history.set(projectId, state);
}

export function historyState(projectId: string): { canUndo: boolean; canRedo: boolean; depth: number } {
  const state = history.get(projectId);
  if (state === undefined) return { canUndo: false, canRedo: false, depth: 0 };
  return { canUndo: state.index >= 0, canRedo: state.index < state.entries.length - 1, depth: state.entries.length };
}

function restoreDoc(target: MapDoc, snapshot: MapDoc): void {
  target.name = snapshot.name;
  target.cols = snapshot.cols;
  target.rows = snapshot.rows;
  target.layers = snapshot.layers.map((layer) => ({ ...layer }));
  target.data = Object.fromEntries(Object.entries(snapshot.data).map(([key, value]) => [key, [...value]]));
  target.updatedAt = new Date().toISOString();
}

// ── 渲染上下文与坐标 ──────────────────────────────────────────────────────

/**
 * 组装渲染上下文。
 *
 * ⚠️ 多了一个 `doc`：`RenderContext.layout` 的 cols/rows 只存在地图文档里
 * （项目元数据不存尺寸 —— 单项目单地图，尺寸是文档的属性）。
 */
export function renderContextFor(project: MapProject, doc: MapDoc): RenderContext {
  return {
    grid: project.grid,
    layout: layoutOf(project.grid, doc.cols, doc.rows),
    tilesets: project.tilesets,
    lookup: flatIndexByValue(project.tilesets)
  };
}

// ── 编辑 op 的提交 / 撤销 / 重做 ──────────────────────────────────────────

export interface ApplyOpsOutcome {
  changed: number;
  skipped: string[];
  /** 内容真的变了的 chunk（**规范** key，0..nx-1）。 */
  dirtyChunks: string[];
  /** 客户端报上来的 `have` 里，内容已经不对、必须重拉的那些 key（unwrapped）。 */
  dropKeys: string[];
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * 从客户端报上来的 `have` 里挑出「内容真变了」的那些。
 *
 * 客户端缓存的是**未取模**的 chunk key（画布可以拖到任何地方，同一格会以多个
 * 像素位置出现），而宿主算出来的是**规范** key（0..nx-1）。所以两边要先映射到
 * 同一套坐标才能比 —— 这一步刻意留在宿主：客户端一丝几何都不许算。
 */
function pickDropKeys(dirtyCanonical: readonly string[], have: readonly string[] | undefined, doc: MapDoc): string[] {
  if (have === undefined || have.length === 0) return [];
  const dirty = new Set(dirtyCanonical);
  const out: string[] = [];
  for (const key of have) {
    const chunk = parseChunkKey(key);
    if (chunk === undefined) continue;
    if (dirty.has(chunkKey(canonicalChunk(chunk, doc.cols, doc.rows)))) out.push(key);
  }
  return out;
}

function outcomeOf(projectId: string, changed: number, skipped: string[], layout: ReturnType<typeof layoutOf>, cells: Array<{ r: number; c: number }>, have: readonly string[] | undefined, doc: MapDoc): ApplyOpsOutcome {
  const dirtyChunks = cells.length === 0 ? [] : dirtyChunksFor(cells, layout);
  const state = historyState(projectId);
  return { changed, skipped, dirtyChunks, dropKeys: pickDropKeys(dirtyChunks, have, doc), canUndo: state.canUndo, canRedo: state.canRedo };
}

function indexCells(indices: readonly number[], doc: MapDoc): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  for (const index of indices) {
    if (index < 0 || index >= doc.cols * doc.rows) continue;
    out.push({ r: Math.floor(index / doc.cols), c: index % doc.cols });
  }
  return out;
}

function allCells(doc: MapDoc): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < doc.rows; r++) for (let c = 0; c < doc.cols; c++) out.push({ r, c });
  return out;
}

/**
 * 应用一批编辑 op（界面拖动时按 ~60ms 批量提交）。
 *
 * 返回「脏 chunk + 该丢哪些客户端缓存」：界面照做即可，不需要自己算
 * 「这一笔影响了哪几格的过渡块」—— 那是宿主的知识。
 */
export async function applyMapOps(projectId: string, ops: readonly unknown[], opts: { stroke?: string; have?: readonly string[] } = {}): Promise<ApplyOpsOutcome> {
  const project = await readProjectOrThrow(projectId);
  const doc = await theDocOrFresh(projectId);
  const layout = layoutOf(project.grid, doc.cols, doc.rows);
  const result = applyOps(doc, ops, layout);
  if (result.changed > 0) {
    pushHistory(projectId, { undo: result.undo, redo: ops as MapOp[], stroke: opts.stroke }, doc);
    scheduleDocWrite(projectId, doc);
  }
  return outcomeOf(projectId, result.changed, result.skipped, layout, result.dirty, opts.have, doc);
}

export async function undoMap(projectId: string, have?: readonly string[]): Promise<ApplyOpsOutcome> {
  const project = await readProjectOrThrow(projectId);
  const doc = await theDocOrFresh(projectId);
  const state = history.get(projectId);
  if (state === undefined || state.index < 0) return outcomeOf(projectId, 0, [], layoutOf(project.grid, doc.cols, doc.rows), [], have, doc);
  const entry = state.entries[state.index];
  let cells: Array<{ r: number; c: number }>;
  if (entry.snapshot !== undefined) {
    restoreDoc(doc, entry.snapshot.before);
    cells = allCells(doc);
  } else {
    let indices: number[];
    try {
      indices = revertOps(doc, entry.undo);
    } catch {
      // 栈被容量上限裁剪过之后，这一步的逆操作可能已经对不上：**放弃这一步**，
      // 把它从栈里剔掉让下一次撤销落到更早的一步，而不是每次都卡在同一条上
      // （界面里抛异常就是「点了撤销整个面板报错」）。
      state.entries.splice(state.index, 1);
      state.index = Math.max(-1, state.index - 1);
      return outcomeOf(projectId, 0, [], layoutOf(project.grid, doc.cols, doc.rows), [], have, doc);
    }
    cells = indexCells(indices, doc);
  }
  state.index--;
  scheduleDocWrite(projectId, doc);
  // 结构快照可能把尺寸改回去了 —— 脏块必须按**改完之后**的布局算。
  return outcomeOf(projectId, cells.length, [], layoutOf(project.grid, doc.cols, doc.rows), cells, have, doc);
}

export async function redoMap(projectId: string, have?: readonly string[]): Promise<ApplyOpsOutcome> {
  const project = await readProjectOrThrow(projectId);
  const doc = await theDocOrFresh(projectId);
  const state = history.get(projectId);
  if (state === undefined || state.index >= state.entries.length - 1) return outcomeOf(projectId, 0, [], layoutOf(project.grid, doc.cols, doc.rows), [], have, doc);
  const entry = state.entries[state.index + 1];
  let cells: Array<{ r: number; c: number }>;
  if (entry.snapshot !== undefined) {
    restoreDoc(doc, entry.snapshot.after);
    cells = allCells(doc);
  } else {
    let indices: number[];
    try {
      indices = revertOps(doc, entry.redo);
    } catch {
      state.entries.splice(state.index + 1, 1);
      return outcomeOf(projectId, 0, [], layoutOf(project.grid, doc.cols, doc.rows), [], have, doc);
    }
    cells = indexCells(indices, doc);
  }
  state.index++;
  scheduleDocWrite(projectId, doc);
  // 结构快照可能改掉了尺寸 —— 脏块按**改完之后**的布局算（同 undoMap）。
  return outcomeOf(projectId, cells.length, [], layoutOf(project.grid, doc.cols, doc.rows), cells, have, doc);
}

// ── 结构操作（存快照，可撤销）─────────────────────────────────────────────

export interface DocStructurePatch {
  name?: string;
  cols?: number;
  rows?: number;
  layers?: Array<{ id: string; name?: string }>;
  addLayer?: { name?: string };
  removeLayerId?: string;
  moveLayer?: { id: string; toIndex: number };
  clearLayerId?: string;
  /** 地图四周是否环绕（落在项目网格上；不给就保持不变）。 */
  wrap?: boolean;
}

export async function saveMapDocStructure(projectId: string, patch: DocStructurePatch): Promise<{ doc: MapDoc; dropped: number; warnings: string[] }> {
  const project = await readProjectOrThrow(projectId);
  const doc = await theDocOrFresh(projectId);
  const before = cloneDoc(doc);
  const warnings: string[] = [];
  let structural = false;
  let dropped = 0;
  if (typeof patch.name === "string" && patch.name.trim() !== "" && patch.name.trim() !== doc.name) {
    doc.name = patch.name.trim();
    structural = true;
  }
  for (const layerPatch of patch.layers ?? []) {
    if (typeof layerPatch?.name !== "string" || layerPatch.name.trim() === "") continue;
    if (renameLayer(doc, layerPatch.id, layerPatch.name.trim())) structural = true;
    else warnings.push(`图层不存在：${layerPatch?.id}`);
  }
  if (patch.addLayer !== undefined) {
    addLayer(doc, patch.addLayer?.name);
    structural = true;
  }
  if (typeof patch.removeLayerId === "string") {
    if (removeLayer(doc, patch.removeLayerId)) structural = true;
    else warnings.push("至少要留一个图层，最后一个删不掉。");
  }
  if (patch.moveLayer !== undefined) {
    if (moveLayer(doc, patch.moveLayer?.id, Math.round(Number(patch.moveLayer?.toIndex)) || 0)) structural = true;
    else warnings.push(`图层不存在：${patch.moveLayer?.id}`);
  }
  if (typeof patch.clearLayerId === "string") {
    // ⚠️ 先判存在性：`clearLayer` 对「图层不存在」与「本来就空」都返回 0，
    // 不判的话用户会拿到一句「这一层本来就是空的。」—— 而那一层根本不存在。
    if (!doc.layers.some((layer) => layer.id === patch.clearLayerId)) {
      warnings.push(`图层不存在：${patch.clearLayerId}`);
    } else if (clearLayer(doc, patch.clearLayerId) > 0) {
      structural = true;
    } else {
      warnings.push("这一层本来就是空的。");
    }
  }
  if (Number.isFinite(patch.cols) || Number.isFinite(patch.rows)) {
    const cols = Number.isFinite(patch.cols) ? Math.round(Number(patch.cols)) : doc.cols;
    const rows = Number.isFinite(patch.rows) ? Math.round(Number(patch.rows)) : doc.rows;
    assertMapSize(cols, rows);
    if (cols !== doc.cols || rows !== doc.rows) {
      const result = resizeDoc(doc, cols, rows);
      dropped = result.dropped;
      structural = true;
      if (dropped > 0) warnings.push(`缩小地图丢掉了 ${dropped} 个已画的格子（可以撤销）。`);
    }
  }
  if (structural) {
    const after = cloneDoc(doc);
    doc.updatedAt = new Date().toISOString();
    pushHistory(projectId, { undo: [], redo: [], snapshot: { before, after } }, doc);
    scheduleDocWrite(projectId, doc);
  }
  // 环绕开关落在项目网格上：它只影响渲染与命中测试，不动一个格子。
  if (typeof patch.wrap === "boolean" && patch.wrap !== project.grid.wrap) {
    const grid = { ...project.grid, wrap: patch.wrap };
    assertGrid(grid);
    await patchMapProject(projectId, (fresh) => {
      fresh.grid = grid;
      appendJobLog(fresh.logs, "info", `地图环绕：${patch.wrap === true ? "开" : "关"}`);
    });
  }
  if (structural) await flushMapDoc(projectId);
  return { doc: cloneDoc(doc), dropped, warnings };
}

// ── 素材：导入 / 改形态 / 删除 ────────────────────────────────────────────

export interface ImportTilesetResult {
  /** 本次导入的素材（内置素材一次进来 5 张）。 */
  tilesets: MapTileset[];
  warnings: string[];
}

interface RegisterInput {
  id: string;
  name: string;
  bytes: Buffer;
  /** 内置素材那条路：形态与格子是**生成时就知道的**，不走自动识别。 */
  known?: { shape: TilesetShape; cell: { width: number; height: number }; animRows: boolean; builtin?: boolean };
  /**
   * 新增素材时用户手填的属性（都是可选的，留空 = 走自动识别）。
   * 在**量到真实尺寸之后**才套上去 —— 校验用同一套 `normalizeCell` / `parseTilesetShape`，
   * 填了不合法的就退回识别结果，不静默改成别的值。
   */
  overrides?: { cell?: Record<string, unknown>; shape?: unknown; animRows?: unknown };
}

/**
 * 导入一张素材图。**属性在这一刻定下来，之后只能删掉重来**（界面上不再提供修改入口）。
 *
 * `opts` 里留空的项走自动识别；给了就用用户的（值不合法就退回识别，不静默改）。
 */
export async function importMapTileset(
  projectId: string,
  name: string,
  base64: string,
  opts: { cell?: { width?: unknown; height?: unknown }; shape?: unknown; animRows?: unknown } = {}
): Promise<ImportTilesetResult> {
  const project = await readProjectOrThrow(projectId);
  if (base64.trim() === "") throw new Error("图片内容为空。");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new Error("图片内容为空。");
  const warnings: string[] = [];
  const tileset = await registerTileset(projectId, {
    id: newTilesetId(),
    name: name.trim() === "" ? `素材 ${project.tilesets.length + 1}` : name.trim(),
    bytes,
    overrides: { cell: opts.cell, shape: opts.shape, animRows: opts.animRows }
  }, warnings);
  await patchMapProject(projectId, (fresh) => {
    fresh.tilesets.push(tileset);
    fresh.stages.assets = { status: "done", at: new Date().toISOString(), approved: fresh.stages.assets.approved };
    appendJobLog(fresh.logs, "info", `导入素材：${tileset.name}（${tileset.imageWidth}×${tileset.imageHeight} → ${tileset.tiles.length} 块）`);
  });
  return { tilesets: [tileset], warnings };
}

/**
 * 装内置素材：**本机现算**（`mapsamplegen.renderSampleTilesets()`），零成本、确定性。
 *
 * 4 张 A2 图（草地 / 土路 / 水 / 石墙）+ 1 张道具网格图。同名素材已经在项目里就
 * 跳过（不会因为点两次变成十张图），跳过的原因写进 warnings。
 */
export async function importSampleTileset(projectId: string): Promise<ImportTilesetResult> {
  // ⚠️ 先 prime 一次纹理覆盖表（幂等）：`renderSampleTilesets()` 是**同步**契约，
  // 而覆盖图（`--ark` 生成的那份 base64）解码要走 ffmpeg。配了覆盖却没 prime 时它会
  // 明确抛错（不静默退回程序化纹理），所以这条路径必须先把这一步做掉 ——
  // 现在覆盖表是空的，这一步是空操作。
  await primeSampleTextures();
  const project = await readProjectOrThrow(projectId);
  const existing = new Set(project.tilesets.map((tileset) => tileset.name));
  const warnings: string[] = [];
  const created: MapTileset[] = [];
  for (const sample of renderSampleTilesets()) {
    if (existing.has(sample.name)) {
      warnings.push(`内置素材「${sample.name}」已经在项目里了，跳过。`);
      continue;
    }
    const tileset = await registerTileset(projectId, {
      id: newTilesetId(),
      name: sample.name,
      bytes: sample.bytes,
      known: { shape: sample.shape, cell: sample.cell, animRows: sample.animRows, builtin: true }
    }, warnings);
    await patchMapProject(projectId, (fresh) => {
      fresh.tilesets.push(tileset);
      fresh.stages.assets = { status: "done", at: new Date().toISOString(), approved: fresh.stages.assets.approved };
    });
    created.push(tileset);
  }
  if (created.length > 0) {
    await patchMapProject(projectId, (fresh) => {
      appendJobLog(fresh.logs, "info", `导入内置素材：${created.map((tileset) => tileset.name).join("、")}`);
    });
  }
  return { tilesets: created, warnings };
}

function newTilesetId(): string {
  return `ts${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
}

/**
 * 登记一张素材图：写原图 → 量尺寸 → 定形态与格子 → 建块。
 *
 * `known` 是内置素材那条路：它的形态与格子是**生成时就知道的**（不用再猜）。
 */
async function registerTileset(projectId: string, input: RegisterInput, warnings: string[]): Promise<MapTileset> {
  /**
   * ⚠️ 用户填的属性**先校验**，再写文件：`normalizeCell` 对不合法的尺寸是**抛错**的
   * （明确拒绝，不静默改成别的值），而原图是在这个函数里写盘的 —— 先写后抛会留下孤儿图。
   */
  const overrideCell = input.overrides?.cell === undefined ? undefined : normalizeCell(input.overrides.cell);
  const ext = sniffImageExt(input.bytes);
  const relative = `tilesets/${input.id}.${ext}`;
  await mkdir(join(mapProjectDir(projectId), "tilesets"), { recursive: true });
  // 写原图（不改写：形态参数随便调，随时能重算）
  await writeFile(mapAssetPath(projectId, relative), input.bytes);
  const size = await probeSize(mapAssetPath(projectId, relative), input.bytes);
  const guess = input.known ?? detectLayout(size.width, size.height);
  const shape = parseTilesetShape(input.overrides?.shape) ?? guess.shape;
  const cell = overrideCell ?? guess.cell;
  const animRows = input.known?.animRows ?? (input.overrides?.animRows === true);
  if (!commonSizeFits(size.width, size.height)) {
    // ⚠️ 文案要跟着产品规则走：属性在新增时定死、界面不再提供修改入口 ——
    // 所以这里告诉用户「删掉重新新增」，而不是让他去找一个界面上没有的入口。
    warnings.push(`这张图（${size.width}×${size.height}）不是常见瓦片尺寸的整数倍，已按 ${cell.width}×${cell.height} 试切；不对的话删掉它、按你想要的格子大小重新新增一张。`);
  }
  const tiles = buildTiles({ shape, cell, imageWidth: size.width, imageHeight: size.height, animRows });
  const tileset: MapTileset = {
    id: input.id,
    name: input.name,
    file: relative,
    imageWidth: size.width,
    imageHeight: size.height,
    cell,
    shape,
    animRows,
    variants: variantsOf(shape, cell, size.width, size.height, animRows),
    // 内置素材：属性**不允许修改**（见 saveMapTileset），可以整张删掉，也能一键恢复
    builtin: input.known?.builtin === true ? true : undefined,
    tiles
  };
  assignCorner16Masks(tileset, warnings);
  return tileset;
}

/** 整格自动连接（corner16）要的块数（就是 16 个邻接掩码）。 */
const CORNER16_COUNT = 16;

/**
 * 给「整格自动连接」素材按位序配掩码（`mapauto` 的 N=1 / E=2 / S=4 / W=8）。
 *
 * ⚠️ 这一段以前**根本没人写**：`MapTile.mask` 只声明不赋值，于是 `maprender` 永远走
 * 「一块掩码都没配」的兜底 —— 整张图只画第一块，而界面上「整格自动连接」是个已经
 * 摆出来的选项，用户选了等于什么都没发生（还不报错）。契约 §3 写的是「导入时由宿主
 * 按位序一次性算好」，落点就在这里。
 *
 * - 只有**恰好 16 块**时才自动配（行优先第 i 块 = 掩码 i，正好是 4×4 的位序表）；
 * - 块数不对就**一块都不配**，把原因写进 warnings（界面会显示出来）；
 * - 已经配过的一律不动：重切 / 换格子尺寸时 `buildTiles` 会按「矩形 id」整份继承旧
 *   tile（含 mask），所以人工调过的位序不会被冲掉。
 */
function assignCorner16Masks(tileset: MapTileset, warnings: string[]): void {
  if (tileset.shape !== "corner16") return;
  if (tileset.tiles.every((tile) => typeof tile.mask === "number")) return;
  if (tileset.tiles.length !== CORNER16_COUNT) {
    warnings.push(`整格自动连接需要 ${CORNER16_COUNT} 块，这张素材有 ${tileset.tiles.length} 块：没有自动配掩码，画出来会统一用第一块。`);
    return;
  }
  tileset.tiles.forEach((tile, index) => {
    tile.mask = index;
  });
}

/** 尺寸能不能被常见瓦片尺寸整除（A2 图另有一条 `height === 5×格子高` 的规则）。 */
function commonSizeFits(width: number, height: number): boolean {
  return COMMON_TILE_SIZES.some((size) => width % size === 0 && height % size === 0) || COMMON_TILE_SIZES.some((size) => height === size * 5 && width % size === 0);
}

async function probeSize(file: string, bytes: Buffer): Promise<{ width: number; height: number }> {
  const fromHeader = pngSize(bytes);
  if (fromHeader !== undefined) return fromHeader;
  return probeImageSize(file);
}

/**
 * 改素材（名称 / 格子尺寸 / 形态 / 逐行动画）。
 *
 * ⚠️ 改了这些，图块序号可能整体平移 —— 地图里存的是序号，**必须按
 * 「素材 id + 图块 id」把地图的每一格重新映射**，否则会出现「明明画了却
 * 变成别的块」：序号指向了新表里的另一个位置。对不上的格子清零并计数。
 */
export async function saveMapTileset(
  projectId: string,
  tilesetId: string,
  patch: { name?: string; cell?: { width: number; height: number }; shape?: TilesetShape; animRows?: boolean }
): Promise<{ tileset: MapTileset; warnings: string[] }> {
  const project = await readProjectOrThrow(projectId);
  const beforeKeys = indexKeys(project.tilesets);
  const warnings: string[] = [];
  const nextCell = normalizeCell(patch.cell);
  const nextShape = parseTilesetShape(patch.shape);
  let updated: MapTileset | undefined;
  await patchMapProject(projectId, (fresh) => {
    const tileset = fresh.tilesets.find((item) => item.id === tilesetId);
    if (tileset === undefined) throw new Error(`素材不存在：${tilesetId}`);
    /**
     * 内置素材的属性**不允许修改**（这是产品约定：属性在新增那一刻定下来）。
     * 想换形态 / 格子就自己新增一张；内置的可以整张删掉，再用「恢复默认素材」拿回来。
     */
    if (tileset.builtin === true) throw new Error(`「${tileset.name}」是内置素材，属性不能改 —— 可以删掉它，或者自己新增一张素材。`);
    if (typeof patch.name === "string" && patch.name.trim() !== "") tileset.name = patch.name.trim();
    const shape = patch.shape ?? tileset.shape;
    const cell = nextCell ?? tileset.cell;
    const animRows = typeof patch.animRows === "boolean" ? patch.animRows : tileset.animRows;
    const changed = shape !== tileset.shape || cell.width !== tileset.cell.width || cell.height !== tileset.cell.height || animRows !== tileset.animRows;
    if (changed) {
      const previousIds = new Set(tileset.tiles.map((tile) => tile.id));
      tileset.shape = shape;
      tileset.cell = cell;
      tileset.animRows = animRows;
      tileset.variants = variantsOf(shape, cell, tileset.imageWidth, tileset.imageHeight, animRows);
      tileset.tiles = buildTiles({ shape, cell, imageWidth: tileset.imageWidth, imageHeight: tileset.imageHeight, animRows }, tileset.tiles);
      const removed = [...previousIds].filter((id) => !tileset.tiles.some((tile) => tile.id === id)).length;
      if (removed > 0) warnings.push(`${removed} 块的元数据随切分变化被丢掉（矩形已经不存在了）。`);
      appendJobLog(fresh.logs, "info", `改素材形态：${tileset.name}（${shape} / ${cell.width}×${cell.height}）`);
    }
    // 换形态也要能补掩码：用户可能先按普通图块导入、后来才改成「整格自动连接」。
    assignCorner16Masks(tileset, warnings);
    updated = tileset;
  });
  if (updated === undefined) throw new Error(`素材不存在：${tilesetId}`);
  const fresh = await readProjectOrThrow(projectId);
  const remap = await remapDocToIndices(projectId, beforeKeys, indexKeys(fresh.tilesets));
  warnings.push(...remap.warnings);
  return { tileset: updated, warnings };
}

/** 序号 → 「素材 id / 图块 id」键（重新映射时用它认人，而不是认序号）。 */
function indexKeys(tilesets: readonly MapTileset[]): Map<number, string> {
  return new Map(flatTiles(tilesets).map((tile) => [tile.index, `${tile.tilesetId}/${tile.tile.id}`]));
}

/**
 * 把地图每一格的序号从旧表平移到新表。
 *
 * 找不到对应图块的格子清零并计数：**不清零的后果是静默画错块**（旧序号落到
 * 新表里另一个位置），比报错难查得多。
 */
async function remapDocToIndices(projectId: string, before: Map<number, string>, after: Map<number, string>): Promise<{ pruned: number; warnings: string[] }> {
  const doc = await readTheDoc(projectId);
  if (doc === undefined) return { pruned: 0, warnings: [] };
  const newIndexByKey = new Map([...after.entries()].map(([index, key]) => [key, index]));
  let lost = 0;
  let remapped = 0;
  for (const layer of doc.layers) {
    const data = doc.data[layer.id];
    if (data === undefined) continue;
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      if (value <= 0) continue;
      const key = before.get(value);
      const next = key === undefined ? undefined : newIndexByKey.get(key);
      if (next === undefined) {
        data[i] = 0;
        lost++;
      } else if (next !== value) {
        data[i] = next;
        remapped++;
      }
    }
  }
  const warnings: string[] = [];
  if (lost > 0) warnings.push(`有 ${lost} 个格子指向的图块已经不存在，已清空。`);
  if (remapped > 0) warnings.push(`有 ${remapped} 个格子跟着素材变化重新映射了图块序号。`);
  if (lost > 0 || remapped > 0) await writeTheDoc(projectId, doc);
  return { pruned: lost, warnings };
}

export async function removeMapTileset(projectId: string, tilesetId: string): Promise<{ removed: string; pruned: number; warnings: string[] }> {
  const project = await readProjectOrThrow(projectId);
  const tileset = project.tilesets.find((item) => item.id === tilesetId);
  if (tileset === undefined) throw new Error(`素材不存在：${tilesetId}`);
  const beforeKeys = indexKeys(project.tilesets);
  await patchMapProject(projectId, (fresh) => {
    fresh.tilesets = fresh.tilesets.filter((item) => item.id !== tilesetId);
    appendJobLog(fresh.logs, "info", `移除素材：${tileset.name}`);
  });
  await rm(mapAssetPath(projectId, tileset.file), { force: true });
  const fresh = await readProjectOrThrow(projectId);
  const remap = await remapDocToIndices(projectId, beforeKeys, indexKeys(fresh.tilesets));
  return { removed: tileset.name, pruned: remap.pruned, warnings: remap.warnings };
}

// ── 一键生成（纯本地、同种子逐字节确定性）─────────────────────────────────

/** AsLib 的 xorshift32 同款（`AsRand.hpp`）：同样的种子给同样的序列。 */
interface Prng {
  /** 返回 0..inclusiveMax（含）；`inclusiveMax < 0` 时返回 0。 */
  upto: (inclusiveMax: number) => number;
}

function xorshift32(seed: number): Prng {
  let state = (seed >>> 0) === 0 ? 0xffffffff : seed >>> 0;
  const next = (): number => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  };
  return {
    upto: (inclusiveMax: number) => (inclusiveMax <= 0 ? 0 : (next() & 0x7fffffff) % (inclusiveMax + 1))
  };
}

/** 不传种子就现抽一个（返回给调用方，方便「同一个种子再铺一次」）。 */
function normalizeSeed(seed: unknown): number {
  if (seed === undefined || seed === null) return Number.parseInt(randomUUID().slice(0, 8), 16) >>> 0 || 1;
  const n = Math.round(Number(seed));
  if (!Number.isFinite(n)) throw new Error(`种子必须是整数：${String(seed)}`);
  return (n >>> 0) === 0 ? 0xffffffff : n >>> 0;
}

async function normalizeTilePool(tiles: readonly number[] | undefined, project: MapProject): Promise<number[]> {
  const available = flatTiles(project.tilesets).map((tile) => tile.index);
  if (tiles === undefined || tiles.length === 0) return available;
  const max = available.length;
  return tiles.map((value) => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`图块序号越界：${String(value)}（可选 0..${max}）`);
    return n;
  });
}

/**
 * 一键铺满某一层（整个操作是**一次提交**，所以一次撤销就能回到原样）。
 *
 * 三种算法都是本机算的、零计费：
 * - `random`：整层在 `tiles` 里均匀随机。
 * - `maze`：奇数尺寸上的迭代 DFS 挖洞；墙 = `tiles[0]`、通路 = `tiles[1] ?? 0`。
 * - `continent`：17×17 菱形四角递归插值 + 种子随机，按 `tiles` 顺序映射
 *   `[浅底, 海, 草地, 雪]`，不足 4 个时回退到 `tiles[0]`。
 */
export async function runMapGenerate(
  projectId: string,
  opts: { kind: "random" | "maze" | "continent"; tiles?: readonly number[]; seed?: number; layerId?: string }
): Promise<{ changed: number; seed: number; warnings: string[] }> {
  const project = await readProjectOrThrow(projectId);
  const doc = await theDocOrFresh(projectId);
  const layerId = typeof opts.layerId === "string" && doc.layers.some((layer) => layer.id === opts.layerId) ? opts.layerId : doc.layers[0]?.id;
  if (layerId === undefined) throw new Error("地图文档没有图层，先建一层。");
  if (opts.kind !== "random" && opts.kind !== "maze" && opts.kind !== "continent") throw new Error(`未知生成算法：${String(opts.kind)}（可选 random / maze / continent）`);
  const pool = await normalizeTilePool(opts.tiles, project);
  const seed = normalizeSeed(opts.seed);
  const warnings: string[] = [];
  const values = generateValues(opts.kind, doc.cols, doc.rows, pool, seed, warnings);
  const cells: Array<{ r: number; c: number; tile: number }> = [];
  for (let r = 0; r < doc.rows; r++) {
    for (let c = 0; c < doc.cols; c++) cells.push({ r, c, tile: values[r * doc.cols + c] ?? 0 });
  }
  const ops: MapOp[] = [{ kind: "paint", layerId, cells }];
  const result = await applyMapOps(projectId, ops, {});
  await patchMapProject(projectId, (fresh) => {
    const label = opts.kind === "random" ? "随机铺满" : opts.kind === "maze" ? "迷宫" : "大陆";
    appendJobLog(fresh.logs, "info", `一键生成（${label}）：改了 ${result.changed} 格，种子 ${seed}`);
  });
  return { changed: result.changed, seed, warnings: [...warnings, ...result.skipped] };
}

function generateValues(kind: "random" | "maze" | "continent", cols: number, rows: number, tiles: readonly number[], seed: number, warnings: string[]): number[] {
  if (kind === "random") return generateRandom(cols, rows, tiles, seed, warnings);
  if (kind === "maze") return generateMaze(cols, rows, tiles, seed, warnings);
  return generateContinent(cols, rows, tiles, seed, warnings);
}

function generateRandom(cols: number, rows: number, tiles: readonly number[], seed: number, warnings: string[]): number[] {
  if (tiles.length === 0) {
    warnings.push("项目里还没有图块：随机铺出来全是空的。先导入素材（或 importSampleTileset 装内置素材）。");
    return new Array(cols * rows).fill(0);
  }
  const rng = xorshift32(seed);
  const out = new Array<number>(cols * rows);
  for (let i = 0; i < out.length; i++) out[i] = tiles[rng.upto(tiles.length - 1)];
  return out;
}

/**
 * 迷宫：奇数尺寸上的**迭代 DFS 挖洞**（AsLib `asMazeMapMake` 同款）。
 *
 * 偶数边长按 `cols-1` / `rows-1` 生成，多出来的那一行 / 一列**留空**（0），
 * 并在 warnings 里说清楚 —— 静默丢掉半行比出个缺口更难查。
 */
function generateMaze(cols: number, rows: number, tiles: readonly number[], seed: number, warnings: string[]): number[] {
  const width = cols % 2 === 1 ? cols : cols - 1;
  const height = rows % 2 === 1 ? rows : rows - 1;
  const wall = tiles[0] ?? 0;
  const path = tiles.length >= 2 ? tiles[1] : 0;
  if (tiles.length === 0) warnings.push("没有指定图块：迷宫只画得出 0（空），先导入素材或用 tiles 指定墙与通路。");
  if (cols % 2 === 0 || rows % 2 === 0) warnings.push(`地图尺寸 ${cols}×${rows} 是偶数：迷宫按 ${width}×${height} 生成，多出来的那一行 / 一列留空。`);
  const out = new Array<number>(cols * rows).fill(0);
  if (width < 3 || height < 3) {
    warnings.push(`地图太小（${cols}×${rows}）：迷宫至少要 3×3，这一层留空。`);
    return out;
  }
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) out[r * cols + c] = wall;
  const rng = xorshift32(seed);
  const visited = new Uint8Array(cols * rows);
  const stack: Array<{ r: number; c: number }> = [{ r: 1, c: 1 }];
  out[cols + 1] = path;
  visited[cols + 1] = 1;
  const steps = [
    { dr: -1, dc: 0 },
    { dr: 0, dc: -1 },
    { dr: 1, dc: 0 },
    { dr: 0, dc: 1 }
  ];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const options = steps.filter((step) => {
      const r = current.r + step.dr * 2;
      const c = current.c + step.dc * 2;
      return r > 0 && r < height - 1 && c > 0 && c < width - 1 && visited[r * cols + c] === 0;
    });
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const step = options[rng.upto(options.length - 1)];
    const nextR = current.r + step.dr * 2;
    const nextC = current.c + step.dc * 2;
    out[(current.r + step.dr) * cols + (current.c + step.dc)] = path;
    out[nextR * cols + nextC] = path;
    visited[nextR * cols + nextC] = 1;
    stack.push({ r: nextR, c: nextC });
  }
  return out;
}

/**
 * 世界地图的节点网格：17×17 个节点 = 16×16 个格子（AsLib 的区块边长同款）。
 *
 * 区块边长固定 16：地图尺寸不是 16 的倍数时，最后一个区块照样按 16 格生成高度场，
 * **只取实际存在的那几格**（补齐 + 裁掉）—— 少这一步，接缝上的节点就对不齐了。
 */
const WORLD_CHUNK = 16;
const WORLD_NODES = WORLD_CHUNK + 1;

/**
 * 大陆 / 海岛：AsLib `asWorldMapSimplePaint` 那套（四角随机 + 菱形方形递归）。
 *
 * ## 为什么角点必须是**纯函数**
 *
 * 第一版给每个区块开一条独立随机流、各抽四个角，结果相邻区块在共享边上取值不同：
 * 48×48 导出成 PNG 就是一盘**轴对齐的大矩形**（一整块纯蓝、一整块纯棕，中间一个硬十字）。
 * 现在角点高度只由「全局角点坐标」决定（`cornerHeight`），于是：
 *
 * - 区块 `(i,j)` 的右下角 == 区块 `(i+1,j+1)` 的左上角；
 * - 区块 `(i,j)` 的右边 == 区块 `(i+1,j)` 的左边（角点相同 ⇒ 两边的第一次插值相同）；
 * - 连**边中点的抖动**也只由「全局节点坐标 + 这一层的 size」决定，所以整条共享边在
 *   两个区块里算出来的是同一个值 —— 接缝处不会有细缝。
 */
function generateContinent(cols: number, rows: number, tiles: readonly number[], seed: number, warnings: string[]): number[] {
  const under = tiles[0] ?? 0;
  const sea = tiles[1] ?? under;
  const green = tiles[2] ?? under;
  const snow = tiles[3] ?? under;
  if (tiles.length < 4) warnings.push(`只给了 ${tiles.length} 个图块：大陆按「浅底 / 海 / 草地 / 雪」的顺序取，缺的回退到第 1 块。`);
  if (tiles.length === 0) warnings.push("项目里还没有图块：大陆铺出来全是空的。先导入素材（或 importSampleTileset 装内置素材）。");
  const out = new Array<number>(cols * rows).fill(under);
  const chunkCols = Math.max(1, Math.ceil(cols / WORLD_CHUNK));
  const chunkRows = Math.max(1, Math.ceil(rows / WORLD_CHUNK));
  for (let chunkI = 0; chunkI < chunkCols; chunkI++) {
    for (let chunkJ = 0; chunkJ < chunkRows; chunkJ++) {
      const baseI = chunkI * WORLD_CHUNK;
      const baseJ = chunkJ * WORLD_CHUNK;
      const levels = worldLevels(seed, chunkI, chunkJ);
      for (let i2 = 0; i2 < WORLD_CHUNK; i2++) {
        const r = baseI + i2;
        if (r >= rows) break;
        for (let j2 = 0; j2 < WORLD_CHUNK; j2++) {
          const c = baseJ + j2;
          if (c >= cols) break;
          const level = levels[i2][j2];
          // 色带照 AsLib 原样：<15 雪、≤50 草地、(50,110] 浅底、>110 海。
          out[r * cols + c] = level < 15 ? snow : level <= 50 ? green : level <= 110 ? under : sea;
        }
      }
    }
  }
  return out;
}

/** 全局角点高度：**只看角点坐标**（相邻区块共享的那个角必然算出同一个值）。 */
function cornerHeight(seed: number, cornerI: number, cornerJ: number): number {
  // 种子混合式照 AsLib：seed + i + j*0x3220 + (i^j)*0x292。
  const mixed = (seed + cornerI + Math.imul(cornerJ, 0x3220) + Math.imul(cornerI ^ cornerJ, 0x292)) >>> 0;
  return xorshift32(mixed === 0 ? 0xffffffff : mixed).upto(255);
}

/**
 * 一个节点的抖动：**全局节点坐标 + 这一层的 size** 的纯函数。
 *
 * 「纯」是接缝连续的关键：共享边上的节点会被左右两个区块各算一次，只有输入完全一样
 * 才会得到同一个高度。用 `Map` 缓存没有必要 —— 一次 48×48 也就几千次哈希。
 */
function nodeJitter(seed: number, nodeI: number, nodeJ: number, size: number): number {
  if (size <= 0) return 0;
  let hash = (seed ^ Math.imul(nodeI + 1, 0x3220) ^ Math.imul(nodeJ + 1, 0x292) ^ Math.imul(size + 1, 0x9e3779b1)) >>> 0;
  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  return ((hash ^ (hash >>> 16)) >>> 0) % (size + 1);
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * 一个区块的高度场：四角取自 `cornerHeight` → 菱形方形递归到 **size === 1**（每格一个节点）。
 *
 * 每个节点都只赋值一次（正方形中心 + 四条边中点），所以共享边的两边输入相同、
 * 结果也相同。边的中点**也加抖动**：只做平均的话一个区块就是一块平板（AsLib 的观感上限）。
 */
function worldLevels(seed: number, chunkI: number, chunkJ: number): number[][] {
  const levels: number[][] = Array.from({ length: WORLD_NODES }, () => new Array<number>(WORLD_NODES).fill(0));
  const baseI = chunkI * WORLD_CHUNK;
  const baseJ = chunkJ * WORLD_CHUNK;
  const last = WORLD_CHUNK;
  const topLeft = cornerHeight(seed, baseI, baseJ);
  const topRight = cornerHeight(seed, baseI, baseJ + last);
  const bottomLeft = cornerHeight(seed, baseI + last, baseJ);
  const bottomRight = cornerHeight(seed, baseI + last, baseJ + last);
  levels[0][0] = topLeft;
  levels[0][last] = topRight;
  levels[last][0] = bottomLeft;
  levels[last][last] = bottomRight;
  subdivide(levels, seed, baseI, baseJ, WORLD_CHUNK / 2, WORLD_CHUNK / 2, WORLD_CHUNK / 2, topLeft, topRight, bottomLeft, bottomRight);
  return levels;
}

/**
 * 菱形方形的一步：填正方形中心与四条边中点，再递归四个子方块。
 *
 * `(r,c)` 是本区块内**正方形的中心**（也是区块内坐标），`size` 是半边长；
 * `baseI/baseJ` 把它换算成全局节点坐标 —— 抖动的输入必须是全局坐标，否则相邻区块
 * 在共享边上各抖各的。
 */
function subdivide(
  levels: number[][],
  seed: number,
  baseI: number,
  baseJ: number,
  r: number,
  c: number,
  size: number,
  topLeft: number,
  topRight: number,
  bottomLeft: number,
  bottomRight: number
): void {
  if (size < 1) return;
  const jitterAt = (nodeI: number, nodeJ: number): number => nodeJitter(seed, baseI + nodeI, baseJ + nodeJ, size);
  const center = clamp255(((topLeft + topRight + bottomLeft + bottomRight) >> 2) + jitterAt(r, c));
  const topEdge = clamp255(((topLeft + topRight) >> 1) + jitterAt(r - size, c));
  const bottomEdge = clamp255(((bottomLeft + bottomRight) >> 1) + jitterAt(r + size, c));
  const leftEdge = clamp255(((topLeft + bottomLeft) >> 1) + jitterAt(r, c - size));
  const rightEdge = clamp255(((topRight + bottomRight) >> 1) + jitterAt(r, c + size));
  levels[r][c] = center;
  levels[r - size][c] = topEdge;
  levels[r + size][c] = bottomEdge;
  levels[r][c - size] = leftEdge;
  levels[r][c + size] = rightEdge;
  const half = size >> 1;
  if (half < 1) return;
  subdivide(levels, seed, baseI, baseJ, r - half, c - half, half, topLeft, topEdge, leftEdge, center);
  subdivide(levels, seed, baseI, baseJ, r - half, c + half, half, topEdge, topRight, center, rightEdge);
  subdivide(levels, seed, baseI, baseJ, r + half, c - half, half, leftEdge, center, bottomLeft, bottomEdge);
  subdivide(levels, seed, baseI, baseJ, r + half, c + half, half, center, rightEdge, bottomEdge, bottomRight);
}

// ── 计划查询 ──────────────────────────────────────────────────────────────


export interface PlanQueryResult {
  grid: MapGrid;
  cols: number;
  rows: number;
  bounds: PlanBounds;
  /** 视口覆盖到的所有 chunk（unwrapped key；客户端缓存认的就是这一套）。 */
  visibleKeys: string[];
  /** 只含 `visibleKeys - have`（客户端要重画的那些）。 */
  chunks: PlanChunk[];
  legend: PlanLegendEntry[];
  fps: number;
  frameCount: number;
  truncated: boolean;
  warnings: string[];
}

/**
 * 视口 → 绘制计划。
 *
 * `viewCellRange` 会带一行 padding（自动连接要看邻居），环绕时它的起点可以是
 * 负数、也可以超过地图尺寸 —— 所以同一格会以多个像素位置出现在计划里，这是
 * 有意的：界面只负责 drawImage，不需要知道环绕。
 */
export async function mapPlan(
  projectId: string,
  o: {
    view: { x: number; y: number; width: number; height: number };
    have?: readonly string[];
    layerIds?: readonly number[];
    /**
     * **预览用**：还在笔里、还没提交的 op。
     *
     * 盖到一份 `cloneDoc` 上算计划 —— 不 `pushHistory`、不 `scheduleDocWrite`，
     * 所以「画的过程中格子能显示出来，但一次都没存」。提交之后客户端会把这些
     * chunk 标成待重拉，宿主再用真实数据发一遍，画面不会停在预览上。
     */
    pending?: readonly unknown[];
  }
): Promise<PlanQueryResult> {
  const project = await readProjectOrThrow(projectId);
  let doc = await theDocOrFresh(projectId);
  /**
   * 预览期间必须**强制回传**被这一笔碰到的块，哪怕客户端说「我有」。
   *
   * ⚠️ 这是真机踩出来的：客户端查计划时会带 `have`（我有哪些块），而预览改的格子在
   * 它已有的块里 —— 宿主一看「你有」就不发了，于是**拖了一路什么都没有**，
   * 松手提交后 `dropKeys` 才让那几块重拉、画面才出现。自检当时那条断言写得太松
   * （`chunks 有 op` 或 `visibleKeys 非空`），把它放过去了。
   */
  const forced = new Set<string>();
  if (Array.isArray(o.pending) && o.pending.length > 0) {
    const preview = cloneDoc(doc);
    // 同一个 applyOps：预览与真实编辑**走同一套校验与语义**，不会画出「提交后不一样」的东西
    const previewLayout = layoutOf(project.grid, preview.cols, preview.rows);
    const overlay = applyOps(preview, o.pending, previewLayout);
    doc = preview;
    for (const key of dirtyChunksFor(overlay.dirty, previewLayout)) forced.add(key);
  }
  const context = renderContextFor(project, doc);
  const range = viewCellRange(context.layout, o.view);
  const covering = chunksInRange(range);
  const truncated = covering.length > MAX_PLAN_CHUNKS;
  const visible = truncated ? covering.slice(0, MAX_PLAN_CHUNKS) : covering;
  const visibleKeys = visible.map(chunkKey);
  const wanted = new Set(visibleKeys);
  const have = new Set(o.have ?? []);
  const plan = buildPlan(context, doc, { range, layers: o.layerIds === undefined ? undefined : [...o.layerIds], includeLegend: true });
  return {
    grid: project.grid,
    cols: doc.cols,
    rows: doc.rows,
    bounds: plan.bounds,
    visibleKeys,
    chunks: plan.chunks.filter((chunk) => wanted.has(chunk.key) && (!have.has(chunk.key) || forced.has(chunk.key))),
    legend: plan.legend,
    fps: plan.fps,
    frameCount: plan.frameCount,
    truncated,
    warnings: plan.warnings
  };
}

// ── 视图 ──────────────────────────────────────────────────────────────────

export function mapAssetBase(projectId: string): string {
  return `/dsh-game-material-master/map-assets/${projectId}/`;
}

export interface MapViewTileset {
  id: string;
  name: string;
  /** 相对项目目录，例如 `tilesets/tsxxx.png`。 */
  file: string;
  imageWidth: number;
  imageHeight: number;
  cell: { width: number; height: number };
  shape: TilesetShape;
  animRows: boolean;
  variants: number;
  tileCount: number;
  /** 识别说明（中文、人话）。 */
  reason: string;
  /**
   * 调色板里可点的笔刷：`index` 是要写进图层数据的值（1-based 全局图块序号），
   * `rect` 是缩略图要从素材原图裁的矩形。
   *
   * ⚠️ **A2 素材只出一个条目**：用户点的是「草地」这个自动连接笔刷，不是某个
   * 16px 小格。界面不要自己从 `legend` 里推可点的块 —— legend 是画布渲染用的
   * （含小格），调色板必须读这里。
   */
  palette: Array<{ index: number; rect: MapRect }>;
  /** 内置素材（`importSampleTileset` 装的那几张）：界面标「自带」用。 */
  builtin?: boolean;
}

export interface MapProjectView {
  id: string;
  name: string;
  assetBase: string;
  grid: MapGrid;
  cols: number;
  rows: number;
  tilesets: MapViewTileset[];
  legend: PlanLegendEntry[];
  layers: Array<{ id: string; name: string; filled: number }>;
  filled: number;
  stages: MapProject["stages"];
  reviewMode?: "auto" | "manual";
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** 计划上限（界面提示「缩得太小，放大一点」用）。 */
  maxChunks: number;
  warnings: string[];
  logs: MapProject["logs"];
  /** `preview/` 下的文件名（相对路径，界面拼 assetBase）。 */
  preview: string[];
  /** `export/<安全名>/`。 */
  exportBase: string;
  exportFiles: string[];
  /**
   * 导出目录的**绝对路径**（还没导出过就是空串）。
   *
   * 界面上要把它原样写出来：导出产物埋在 `<DSH_HOME>/game-material-master/map-jobs/…` 底下，
   * 只给一个「打开导出目录」按钮的话，用户永远不知道文件到底落在哪 ——
   * 「导出窗口意味不明」的一半就是它。
   */
  exportPath: string;
}

/**
 * 界面视图。
 *
 * `options` 里的 `projectId` / `origin` 是旧调用的兼容位（**视图一律用相对路径**，
 * 绝对 URL 由 `mapSnapshot` 拼给模型）—— 留着是为了不改动已有的调用点签名。
 */
export async function mapView(p: MapProject, options: { projectId?: string; origin?: string } = {}): Promise<MapProjectView> {
  void options;
  const doc = await theDocOrFresh(p.id);
  const flat = flatTiles(p.tilesets);
  const listing = await readExportListingRelative(p);
  const state = historyState(p.id);
  const layers = doc.layers.map((layer) => ({ id: layer.id, name: layer.name, filled: filledCount(doc, layer.id) }));
  return {
    id: p.id,
    name: p.name,
    assetBase: mapAssetBase(p.id),
    grid: p.grid,
    cols: doc.cols,
    rows: doc.rows,
    tilesets: p.tilesets.map((tileset) => ({
      id: tileset.id,
      name: tileset.name,
      file: tileset.file,
      imageWidth: tileset.imageWidth,
      imageHeight: tileset.imageHeight,
      cell: tileset.cell,
      shape: tileset.shape,
      animRows: tileset.animRows,
      variants: tileset.variants,
      tileCount: tileset.tiles.length,
      builtin: tileset.builtin === true ? true : undefined,
      reason: layoutFor(tileset.shape, tileset.cell, tileset.imageWidth, tileset.imageHeight).reason,
      palette: paletteFor(tileset, flat)
    })),
    legend: flat.map((tile) => ({ index: tile.index, tilesetId: tile.tilesetId, rect: tile.tile.rect })),
    layers,
    filled: layers.reduce((sum, layer) => sum + layer.filled, 0),
    stages: p.stages,
    reviewMode: p.reviewMode,
    busy: mapBusy(p.id),
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    maxChunks: MAX_PLAN_CHUNKS,
    warnings: warningsFor(p, doc),
    logs: p.logs.slice(-40),
    preview: (await readPreviewFiles(p.id)).map((name) => `preview/${name}`),
    exportBase: listing?.base ?? "",
    exportFiles: listing?.files ?? [],
    exportPath: listing === undefined ? "" : join(mapProjectDir(p.id), "export", listing.dirName)
  };
}

/**
 * 素材 → 可点的笔刷列表。
 *
 * 普通素材每格一个条目；**A2 素材只出一个**：用户点的是「草地」这个自动连接笔刷，
 * 形状由邻居现推（`mapauto.a2QuadrantShapes`），所以画笔要落在**满格那一行**上 ——
 * 那一行的 32×32 逻辑块正好是一张完整的缩略图。写进图层数据的值取同一块的第一个
 * 小格序号：渲染时从它身上认「哪张素材、哪个变体」，形状由宿主现算。
 */
function paletteFor(tileset: MapTileset, flat: readonly FlatTile[]): Array<{ index: number; rect: MapRect }> {
  const mine = flat.filter((tile) => tile.tilesetId === tileset.id);
  if (tileset.shape !== "a2quad") return mine.map((tile) => ({ index: tile.index, rect: tile.tile.rect }));
  let fullRow = 0;
  for (const tile of mine) fullRow = Math.max(fullRow, tile.tile.shape ?? 0);
  const pick = mine.find((tile) => (tile.tile.shape ?? 0) === fullRow && (tile.tile.variant ?? 0) === 0) ?? mine[0];
  if (pick === undefined) return [];
  const variant = pick.tile.variant ?? 0;
  return [
    {
      index: pick.index,
      rect: { x: variant * tileset.cell.width, y: fullRow * tileset.cell.height, width: tileset.cell.width, height: tileset.cell.height }
    }
  ];
}

/**
 * 观测告警：只在「看出来的确会画错」时才说，全部中文。
 *
 * ⚠️ 这里**不放**「尺寸是偶数 ⇒ 迷宫会被截断」：默认尺寸就是 32×32（偶数），
 * 用户从没点过迷宫也会一直看到它。那条提示留在 `runMapGenerate` 的返回里 ——
 * 只有真的生成迷宫时才该出现。
 */
function warningsFor(project: MapProject, doc: MapDoc): string[] {
  const out: string[] = [];
  if (project.tilesets.length === 0) out.push("还没有素材：先导入一张 tileset 图，或者用 importSampleTileset 装内置素材。");
  for (const tileset of project.tilesets) {
    if (tileset.cell.width !== project.grid.tileWidth || tileset.cell.height !== project.grid.tileHeight) {
      out.push(`素材「${tileset.name}」的格子是 ${tileset.cell.width}×${tileset.cell.height}，项目网格是 ${project.grid.tileWidth}×${project.grid.tileHeight}：画出来会按网格缩放。`);
    }
    if (tileset.shape === "a2quad" && tileset.imageHeight !== tileset.cell.height * 5) {
      out.push(`素材「${tileset.name}」是 A2 拼块，但高度 ${tileset.imageHeight} 不等于 5×格子高（${tileset.cell.height * 5}）：形状行数对不上，自动连接会取错块。`);
    }
    // 「整格自动连接」但掩码没配齐：`assignCorner16Masks` 只在**恰好 16 块**时按位序配，
    // 块数不对就一块都不配（掩码不是猜的），画出来会统一用第一块 —— 这件事必须常驻显示。
    if (tileset.shape === "corner16") {
      const masks = new Set(tileset.tiles.map((tile) => tile.mask).filter((mask) => typeof mask === "number"));
      if (masks.size < CORNER16_COUNT) {
        out.push(`素材「${tileset.name}」是整格自动连接，但 ${tileset.tiles.length} 块里只有 ${masks.size} 个掩码（需要 ${CORNER16_COUNT} 块）：没配到的地方会统一用第一块。`);
      }
    }
  }
  const bottom = doc.layers[0];
  if (bottom !== undefined && filledCount(doc, bottom.id) === 0) out.push(`第 0 层（${bottom.name}）还是空的：先用笔刷铺一层，或者 runMapGenerate 一键生成。`);
  // 旧版项目（**第一版**模块六）把地图存在 `maps/<mapId>.json`，新版只读项目根的 `map.json`。
  // 于是用户升级后打开旧项目会看到一张**空的**地图 —— 什么都不说的话就是「我画的东西不见了」。
  // 旧文件并没有删，所以这里只提醒一句、给个去处（真去读两份数据等于养一套迁移口径）。
  if (existsSync(join(mapProjectDir(project.id), "maps"))) {
    out.push("这是旧版地图项目：原来的地图数据在项目目录的 maps/ 里，新版界面只读 map.json，所以现在看到的是一张空地图（maps/ 里的旧文件没有删）。");
  }
  return out;
}

// ── 作业（预览 / 导出）────────────────────────────────────────────────────

/**
 * 「已经有人预定要开工」的项目。
 *
 * `mapBusy` 读的就是这个集合，而作业是在**几个 await 之后**才真正开始的 ——
 * 两次并发提交（界面上手快连点、或工具面重复调用）会双双通过 `mapBusy` 检查，
 * 然后两个作业抢同一份文档。所以先用一个**同步**的预定集合把位置占住。
 * 占位一直保留到作业结束（`background` 的 finally 里释放）。
 */
const reserved = new Set<string>();
const cancelled = new Set<string>();

export function mapBusy(projectId: string): boolean {
  return reserved.has(projectId);
}

export function cancelMapJob(projectId: string): void {
  cancelled.add(projectId);
}

/** 同步占位；占不到就返回原因（调用方直接回 `{started:false, reason}`）。 */
function reserve(projectId: string): string | undefined {
  if (reserved.has(projectId)) return "这个项目已经有任务在跑了，等它跑完再提交。";
  reserved.add(projectId);
  return undefined;
}

async function background(projectId: string, stage: "paint" | "export", run: () => Promise<void>): Promise<void> {
  cancelled.delete(projectId);
  await patchMapProject(projectId, (project) => {
    project.stages[stage] = { status: "running", at: new Date().toISOString() };
  }).catch(() => undefined);
  try {
    await run();
    await patchMapProject(projectId, (project) => {
      if (project.stages[stage].status === "running") project.stages[stage] = { status: "done", at: new Date().toISOString(), approved: project.stages[stage].approved };
    });
  } catch (error) {
    const message = messageOf(error);
    await patchMapProject(projectId, (project) => {
      project.stages[stage] = { status: "error", error: message, at: new Date().toISOString() };
      appendJobLog(project.logs, "error", `${stage === "paint" ? "预览" : "导出"}失败：${message}`);
    }).catch(() => undefined);
  } finally {
    reserved.delete(projectId);
  }
}

/** 解一遍素材位图（单张解不开不该让整次渲染失败，缺图的地方按透明跳过）。 */
async function decodeTilesets(project: MapProject): Promise<Map<string, Bitmap>> {
  const lookup = new Map<string, Bitmap>();
  for (const tileset of project.tilesets) {
    if (tileset.file === "") continue;
    try {
      lookup.set(tileset.id, await decodeFile(mapAssetPath(project.id, tileset.file)));
    } catch {
      /* 缺图时渲染按空处理 */
    }
  }
  return lookup;
}

/** 验收预览（本地免费）：只出**一张**地图渲染图 `preview/map.png`。 */
export async function runPreviewStage(projectId: string): Promise<{ started: boolean; reason?: string }> {
  const reason = reserve(projectId);
  if (reason !== undefined) return { started: false, reason };
  let project: MapProject;
  try {
    project = await readProjectOrThrow(projectId);
  } catch (error) {
    reserved.delete(projectId);
    throw error;
  }
  if (project.tilesets.length === 0) {
    reserved.delete(projectId);
    return { started: false, reason: "还没有导入素材。" };
  }
  void background(projectId, "paint", async () => {
    const fresh = await readProjectOrThrow(projectId);
    const doc = await theDocOrFresh(projectId);
    await flushMapDoc(projectId);
    if (cancelled.has(projectId)) return;
    const bitmaps = await decodeTilesets(fresh);
    const raster = rasterize(renderContextFor(fresh, doc), doc, bitmaps, { scale: 1 });
    const previewDir = join(mapProjectDir(projectId), "preview");
    await mkdir(previewDir, { recursive: true });
    await writeFile(join(previewDir, "map.png"), bitmapToPng(raster.bitmap));
    await patchMapProject(projectId, (current) => {
      appendJobLog(current.logs, "info", `生成地图预览图：preview/map.png（${doc.cols}×${doc.rows}，${raster.bitmap.width}×${raster.bitmap.height} 像素）`);
      // ⚠️ 一条 op 都没画进去 = 全透明 PNG。不提示的话界面只会看到一块空白，
      // 而阶段照样标 done（导出那条同款提示见 mapexport 的「所有图层都是空的」）。
      if (raster.drawn === 0) appendJobLog(current.logs, "warn", "地图还是空的：预览图是全透明的，先画点东西再看大图。");
      for (const warning of raster.warnings) appendJobLog(current.logs, "warn", `预览告警：${warning}`);
    });
  });
  return { started: true };
}

/**
 * 导出目录名：跟着**地图名**走（改名地图 = 换一个自包含目录，旧目录原样留着）。
 *
 * ⚠️ `runExportStage` / `readExportListingRelative` / `mapRevealDir` 三处必须同口径 ——
 * 分别算一次的话，会出现「界面列的清单在 A 目录、点开的是 B 目录」这种只看得到空文件夹的坏法。
 */
export function mapExportDirName(doc: MapDoc | undefined, project: { id: string; name: string }): string {
  return safeFileName(doc?.name ?? project.name, doc?.id ?? project.id);
}

/** 导出目录的绝对路径。 */
export function mapExportDir(projectId: string, doc: MapDoc | undefined, project: { id: string; name: string }): string {
  return join(mapProjectDir(projectId), "export", mapExportDirName(doc, project));
}

/**
 * 「在文件夹中显示」要打开的绝对路径。
 *
 * `target: "export"` 时打开**导出目录**（用户点的是「打开导出目录」，以前却打开项目根 ——
 * 那里并没有他要的文件）；还没导出过就退回项目目录，并由 `fallback` 告诉调用方，
 * 免得 explorer 收到一个不存在的路径（macOS 的 open 会直接报错）。
 */
export async function mapRevealDir(projectId: string, target: string): Promise<{ dir: string; fallback: boolean }> {
  const project = await readProjectOrThrow(projectId);
  if (target !== "export") return { dir: mapProjectDir(projectId), fallback: false };
  const dir = mapExportDir(projectId, await readTheDoc(projectId), project);
  if (existsSync(dir)) return { dir, fallback: false };
  return { dir: mapProjectDir(projectId), fallback: true };
}

/** 导出（本地免费）：`map.png` + `map.json`(+ 素材原图 / zip) + `manifest.json`。 */
export async function runExportStage(projectId: string, options: { scale?: number; formats?: ExportFormatOptions } = {}): Promise<{ started: boolean; reason?: string }> {
  const reason = reserve(projectId);
  if (reason !== undefined) return { started: false, reason };
  let project: MapProject;
  try {
    project = await readProjectOrThrow(projectId);
    if (project.tilesets.length === 0) {
      reserved.delete(projectId);
      return { started: false, reason: "还没有导入素材，导出的地图会是空的。" };
    }
  } catch (error) {
    reserved.delete(projectId);
    throw error;
  }
  const scale = Number.isFinite(options.scale) ? Math.max(1, Math.round(Number(options.scale))) : undefined;
  void background(projectId, "export", async () => {
    const fresh = await readProjectOrThrow(projectId);
    const doc = await theDocOrFresh(projectId);
    if (isDocEmpty(doc)) throw new Error("地图还是空的，先画点东西再导出。");
    await flushMapDoc(projectId);
    if (cancelled.has(projectId)) return;
    // 导出目录按**地图名**取（改名地图 = 换一个自包含目录，旧目录原样留着）。
    const dirName = mapExportDirName(doc, fresh);
    const manifest = await exportMap({
      project: { id: fresh.id, name: fresh.name },
      doc,
      context: renderContextFor(fresh, doc),
      dir: join(mapProjectDir(projectId), "export", dirName),
      formats: { ...(options.formats ?? {}), ...(scale === undefined ? {} : { scale }) },
      // ⚠️ 一定要显式给 `lookup`：mapexport 的兜底分支会自己 `import` 本模块取路径 ——
      // 那是条循环引用（本模块 → mapexport → 本模块）。给我们已经解好的位图，
      // 运行时永远走不到那条兜底。
      lookup: await decodeTilesets(fresh)
    });
    await patchMapProject(projectId, (current) => {
      appendJobLog(current.logs, "info", `导出「${doc.name}」：${manifest.files.length} 个文件 → export/${dirName}/`);
    });
  });
  return { started: true };
}

/** 相对路径版的导出清单（界面用；绝对 URL 版见 `readExportListing`）。 */
async function readExportListingRelative(project: MapProject): Promise<{ base: string; files: string[]; warnings: string[]; dirName: string } | undefined> {
  // 目录名跟着**地图名**走（与 runExportStage 同一处口径）。
  const doc = await readTheDoc(project.id);
  const dirName = mapExportDirName(doc, project);
  const manifest = await readJson<ExportManifest>(join(mapProjectDir(project.id), "export", dirName, "manifest.json"));
  if (manifest === undefined) return undefined;
  return { base: `export/${dirName}/`, files: (manifest.files ?? []).map((file) => file.path), warnings: manifest.warnings ?? [], dirName };
}

/** 最近的导出清单（验收包用）：`base` 与每个文件都是**绝对 URL**。 */
export async function readExportListing(projectId: string, origin: string): Promise<{ base: string; files: string[] } | undefined> {
  const project = await readMapProject(projectId);
  if (project === undefined) return undefined;
  const listing = await readExportListingRelative(project);
  if (listing === undefined) return undefined;
  return {
    base: absoluteAssetUrl(projectId, origin, listing.base),
    files: listing.files.map((file) => absoluteAssetUrl(projectId, origin, `${listing.base}${file}`))
  };
}

async function readPreviewFiles(projectId: string): Promise<string[]> {
  try {
    const names = await readdir(join(mapProjectDir(projectId), "preview"));
    return names.filter((name) => name.endsWith(".png")).sort();
  } catch {
    return [];
  }
}

// ── 对话调用面用的快照（绝对 URL）─────────────────────────────────────────

export interface MapSnapshot extends Omit<MapProjectView, "assetBase" | "tilesets" | "preview" | "exportBase"> {
  /** 给**模型**用的绝对 URL 基址（界面用的是相对路径）。 */
  assetBase: string;
  tilesets: Array<MapViewTileset & { url: string }>;
  /** 验收预览图的绝对 URL。 */
  previewUrls: string[];
  /** 上一次导出的目录（绝对 URL）与文件（绝对 URL）。 */
  exportBaseUrl: string;
  exportWarnings: string[];
  /** 该做哪一步。 */
  nextActions: Array<{ step: string; why: string }>;
}

function absoluteAssetUrl(projectId: string, origin: string, relative: string): string {
  return `${origin}/dsh-game-material-master/map-assets/${projectId}/${relative}`;
}

/**
 * 工具用的快照：把界面里的**相对**资源路径全部换成可点的**绝对** URL
 * （模型要直接贴给用户），并附上「下一步该做什么」。
 */
export async function mapSnapshot(project: MapProject, origin: string, options: { projectId?: string; origin?: string } = {}): Promise<MapSnapshot> {
  void options;
  const view = await mapView(project);
  const { preview, exportBase, ...rest } = view;
  const listing = await readExportListing(project.id, origin);
  const relative = await readExportListingRelative(project);
  const nextActions: MapSnapshot["nextActions"] = [];
  if (view.tilesets.length === 0) {
    nextActions.push({ step: "assets", why: "还没有素材：importMapTileset({projectId,name,data}) 传图片 base64，或者 importSampleTileset({projectId}) 装内置素材（免费、本机现算）。" });
  }
  if (view.filled === 0) {
    nextActions.push({ step: "paint", why: "地图还是空的：runMapGenerate({projectId,kind:'random'|'maze'|'continent'}) 一键铺，或者 applyMapOps({projectId,ops}) 直接画。" });
  } else if (exportBase === "") {
    nextActions.push({ step: "export", why: "还没导出过：runMapExport({projectId}) 出 map.png + map.json（本地免费）。" });
  }
  if (nextActions.length === 0) nextActions.push({ step: "done", why: "素材、地图、导出都有产物了。可以继续改地图，或 runMapPreview({projectId}) 重新出验收图。" });
  return {
    ...rest,
    assetBase: `${origin}/dsh-game-material-master/map-assets/${project.id}/`,
    tilesets: view.tilesets.map((tileset) => ({ ...tileset, url: absoluteAssetUrl(project.id, origin, tileset.file) })),
    previewUrls: preview.map((relative) => absoluteAssetUrl(project.id, origin, relative)),
    exportBaseUrl: listing?.base ?? "",
    exportWarnings: relative?.warnings ?? [],
    nextActions
  };
}

// 尺寸上限是几何模块的口径，但网关与自检脚本一直是按 `mapgen.MAX_MAP_DIM` 读的
// （模块六的公开面就是这个文件），所以在这里转出去，别让调用方猜它搬去了哪。
export { MAX_MAP_DIM };
