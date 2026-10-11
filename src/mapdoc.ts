/**
 * 地图编辑器（模块六）的**文档模型与编辑操作**。
 *
 * 一张地图 = 若干图层，每个图层是一段 `cols × rows` 的数组：
 * `0` 表示空，其余是**全局图块序号**（见 `maptiles.flatTiles`）。
 *
 * ## 三条口径
 *
 * 1. **宿主是唯一写者**：界面不发「整份文档」，只发 op（`applyOps`）。
 *    撤销 = 逆操作日志，因此撤销栈不占内存、也不需要 diff。
 * 2. **派生数据不落盘**：A2 的象限形状、动画帧、脏 chunk 全在渲染 / 应用时算
 *    （`maprender.buildPlan` / `mapgeom.dirtyChunksFor`）。旧模块把「自动过渡的
 *    最终贴图、跨格占格、垫底」存成三份缓存，各自都出过「过期后凭空多出一栋楼」。
 * 3. **操作必须是纯函数**：`applyOps(doc, ops, layout)` 直接改传入的 doc 并返回被
 *    改的格子与逆操作。界面拖动时按 ~60ms 批量提交，宿主应用后回传脏 chunk。
 *
 * ## 图层为什么瘦成 `{ id, name }`
 *
 * 旧模型的 `kind` / `heightOffset` / `opacity` / `visible` / `locked` / `baseFamilyId`
 * 全部删掉：前四个只在界面与导出之间制造「两边口径不同」的空间（层高偏移与层不透明度
 * 各出过「预览 ≠ 导出」），`baseFamilyId` 是族体系的遗留，`locked` 则是一个纯界面状态
 * 却写在文档里、还会让 op 静默整批跳过。AsLib 的做法就是「只有名字的叠放顺序」。
 */

import { DEFAULT_GRID, MAX_MAP_DIM, assertMapSize, layoutOf, wrapCell, type MapLayout } from "./mapgeom.js";

export interface MapLayer {
  id: string;
  name: string;
}

export interface MapDoc {
  id: string;
  name: string;
  cols: number;
  rows: number;
  layers: MapLayer[];
  /** `layerId` → 图层数据（长度 `cols × rows`）。 */
  data: Record<string, number[]>;
  createdAt: string;
  updatedAt: string;
}

export function cellIndex(doc: { cols: number }, r: number, c: number): number {
  return r * doc.cols + c;
}

export function emptyData(cols: number, rows: number): number[] {
  return new Array(cols * rows).fill(0);
}

/** 默认图层。名字缺省时只给一个中性名 —— 具体名字由调用方（`createMapDoc` / `addLayer`）给。 */
export function defaultLayer(id: string, name?: string): MapLayer {
  return { id, name: typeof name === "string" && name !== "" ? name : "图层" };
}

/** 默认两层（AsLib 同款：一层地面、一层装饰）。名字**中文硬编码** —— 宿主侧没有 i18n 通道。 */
function defaultLayers(): MapLayer[] {
  return [defaultLayer("l0", "图层 1"), defaultLayer("l1", "图层 2")];
}

export function createMapDoc(id: string, name: string, cols: number, rows: number): MapDoc {
  assertMapSize(cols, rows);
  const now = new Date().toISOString();
  const layers = defaultLayers();
  const data: Record<string, number[]> = {};
  for (const layer of layers) data[layer.id] = emptyData(cols, rows);
  return { id, name, cols, rows, layers, data, createdAt: now, updatedAt: now };
}

/** 读盘 / 外部输入 → 合法文档：补缺字段、把图层数据裁齐到 `cols × rows`。 */
export function normalizeMapDoc(raw: unknown, fallbackId: string): MapDoc | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const cols = Math.max(1, Math.min(MAX_MAP_DIM, Math.round(Number(input.cols) || 32)));
  const rows = Math.max(1, Math.min(MAX_MAP_DIM, Math.round(Number(input.rows) || 32)));
  const rawLayers = Array.isArray(input.layers) ? (input.layers as unknown[]) : [];
  // id 重复会让两层共用同一段数据（改一层等于同时改两层，且不报错）—— 这里必须去重。
  const used = new Set<string>();
  const layers: MapLayer[] = [];
  for (const [index, item] of rawLayers.entries()) {
    const layer = item as Record<string, unknown> | null;
    const id = typeof layer?.id === "string" && layer.id !== "" ? layer.id : `l${index}`;
    const name = typeof layer?.name === "string" && layer.name !== "" ? layer.name : `图层 ${index + 1}`;
    let unique = id;
    if (used.has(unique)) {
      let bump = 0;
      while (used.has(`l${bump}`)) bump++;
      unique = `l${bump}`;
    }
    used.add(unique);
    layers.push({ id: unique, name });
  }
  if (layers.length === 0) layers.push(...defaultLayers());
  const layersData = (input.data ?? {}) as Record<string, unknown>;
  const data: Record<string, number[]> = {};
  for (const layer of layers) {
    const source = layersData[layer.id];
    const target = emptyData(cols, rows);
    if (Array.isArray(source)) {
      for (let i = 0; i < target.length; i++) {
        const value = Number(source[i]);
        target[i] = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
      }
    }
    data[layer.id] = target;
  }
  const now = new Date().toISOString();
  return {
    id: typeof input.id === "string" && input.id !== "" ? input.id : fallbackId,
    name: typeof input.name === "string" && input.name !== "" ? input.name : "未命名地图",
    cols,
    rows,
    layers,
    data,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now
  };
}

export function cloneDoc(doc: MapDoc): MapDoc {
  const data: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(doc.data)) data[key] = [...value];
  return { ...doc, layers: doc.layers.map((layer) => ({ ...layer })), data };
}

// ── 结构操作（图层 / 尺寸）────────────────────────────────────────────────

export function nextLayerId(doc: MapDoc): string {
  let index = doc.layers.length;
  while (doc.layers.some((layer) => layer.id === `l${index}`)) index++;
  return `l${index}`;
}

export function addLayer(doc: MapDoc, name?: string): MapLayer {
  const layer = defaultLayer(nextLayerId(doc), name !== undefined && name !== "" ? name : `图层 ${doc.layers.length + 1}`);
  doc.layers.push(layer);
  doc.data[layer.id] = emptyData(doc.cols, doc.rows);
  doc.updatedAt = new Date().toISOString();
  return layer;
}

export function removeLayer(doc: MapDoc, layerId: string): boolean {
  if (doc.layers.length <= 1) return false;
  const index = doc.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) return false;
  doc.layers.splice(index, 1);
  delete doc.data[layerId];
  doc.updatedAt = new Date().toISOString();
  return true;
}

export function moveLayer(doc: MapDoc, layerId: string, toIndex: number): boolean {
  const index = doc.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) return false;
  const target = Math.min(doc.layers.length - 1, Math.max(0, Math.round(toIndex)));
  if (target === index) return false;
  const [layer] = doc.layers.splice(index, 1);
  doc.layers.splice(target, 0, layer);
  doc.updatedAt = new Date().toISOString();
  return true;
}

/** 改名。空名字**明确拒绝**（返回 false），不静默换成「图层」。 */
export function renameLayer(doc: MapDoc, layerId: string, name: string): boolean {
  const layer = doc.layers.find((item) => item.id === layerId);
  if (layer === undefined) return false;
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed === "") return false;
  if (layer.name === trimmed) return false;
  layer.name = trimmed;
  doc.updatedAt = new Date().toISOString();
  return true;
}

/** 清空一层，返回**清掉的格子数**（已经是空的就返回 0，不改 `updatedAt`）。 */
export function clearLayer(doc: MapDoc, layerId: string): number {
  const data = doc.data[layerId];
  if (data === undefined) return 0;
  let cleared = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) {
      data[i] = 0;
      cleared++;
    }
  }
  if (cleared > 0) doc.updatedAt = new Date().toISOString();
  return cleared;
}

/**
 * 改地图尺寸（左上角对齐）。缩小时被丢掉的格子**计数返回**，且可撤销
 * （调用方在改之前存一份快照）。
 */
export function resizeDoc(doc: MapDoc, cols: number, rows: number): { dropped: number } {
  assertMapSize(cols, rows);
  if (cols === doc.cols && rows === doc.rows) return { dropped: 0 };
  let dropped = 0;
  for (const layer of doc.layers) {
    const source = doc.data[layer.id] ?? emptyData(doc.cols, doc.rows);
    const target = emptyData(cols, rows);
    const copyCols = Math.min(cols, doc.cols);
    const copyRows = Math.min(rows, doc.rows);
    for (let r = 0; r < copyRows; r++) {
      for (let c = 0; c < copyCols; c++) target[r * cols + c] = source[r * doc.cols + c];
    }
    for (let r = 0; r < doc.rows; r++) {
      for (let c = 0; c < doc.cols; c++) {
        if (r < copyRows && c < copyCols) continue;
        if (source[r * doc.cols + c] > 0) dropped++;
      }
    }
    doc.data[layer.id] = target;
  }
  doc.cols = cols;
  doc.rows = rows;
  doc.updatedAt = new Date().toISOString();
  return { dropped };
}

// ── 编辑操作 ──────────────────────────────────────────────────────────────

export type MapOp =
  | { kind: "paint"; layerId: string; cells: Array<{ r: number; c: number; tile: number }> }
  | { kind: "fill"; layerId: string; r: number; c: number; tile: number }
  | { kind: "rect"; layerId: string; r0: number; c0: number; r1: number; c1: number; tile: number; filled: boolean }
  | { kind: "replace"; layerId: string; from: number; to: number };

export interface ApplyResult {
  /** 被改动的格子**数**（不是列表 —— 格子列表在 `dirty` 里）。 */
  changed: number;
  /** 认不出来的 op 或越界条目（界面要提示，不要静默丢）。 */
  skipped: string[];
  /** 被改动的格子（**规范**坐标），上游用 `dirtyChunksFor` 换算脏 chunk。 */
  dirty: Array<{ r: number; c: number }>;
  /** 逆操作（撤销就是把它们按原顺序应用回去）。 */
  undo: MapOp[];
}

/** 画一条线（Bresenham）：拖动时两点之间的格子不能漏（漏了就是「虚线」）。 */
export function lineCells(r0: number, c0: number, r1: number, c1: number): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  let r = Math.round(r0);
  let c = Math.round(c0);
  const rEnd = Math.round(r1);
  const cEnd = Math.round(c1);
  const dr = Math.abs(rEnd - r);
  const dc = Math.abs(cEnd - c);
  const sr = r < rEnd ? 1 : -1;
  const sc = c < cEnd ? 1 : -1;
  let err = dr - dc;
  for (;;) {
    out.push({ r, c });
    if (r === rEnd && c === cEnd) break;
    const e2 = 2 * err;
    if (e2 > -dc) {
      err -= dc;
      r += sr;
    }
    if (e2 < dr) {
      err += dr;
      c += sc;
    }
    if (out.length > 1_000_000) break;
  }
  return out;
}

/** 图块序号收口：非正数与 NaN 一律当「清空」（0），小数取整。 */
function tileValue(input: unknown): number {
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * 应用一批 op。
 *
 * **不会抛异常**：拖动时指针滑出地图是常事，越界条目记进 `skipped` 由界面提示。
 * 坐标一律不取整（不合法就是 `越界格`）—— `Math.round` 会把用户根本没点到的格子
 * 悄悄涂上，这正是旧模块「涂在隔壁格」那类问题的来源。
 *
 * `layout` 是**双层保险**：上游（`mapPlan` / 客户端命中测试）已经给过规范坐标，
 * 这里再按 `layout` wrap 一次。`layout.wrap` 为 false 时越界就是越界，直接跳过。
 */
export function applyOps(doc: MapDoc, ops: readonly unknown[], layout: MapLayout): ApplyResult {
  const changed = new Set<number>();
  const dirty = new Map<number, { r: number; c: number }>();
  const undo: MapOp[] = [];
  const skipped: string[] = [];

  const canonical = (r: number, c: number): { r: number; c: number } | undefined => {
    if (!Number.isInteger(r) || !Number.isInteger(c)) return undefined;
    // 不环绕时 `wrapCell` 原样返回，下面的范围判断就是唯一的拦截。
    const wrapped = wrapCell(layout, r, c);
    if (wrapped.r < 0 || wrapped.c < 0 || wrapped.r >= doc.rows || wrapped.c >= doc.cols) return undefined;
    return wrapped;
  };

  const paintValue = (layerId: string, cells: ReadonlyArray<{ r: number; c: number; tile: number }>): Array<{ r: number; c: number; tile: number }> => {
    const data = doc.data[layerId];
    const before: Array<{ r: number; c: number; tile: number }> = [];
    for (const cell of cells) {
      // 单元格本身不成形（null / 数字）时 `cell.r` 会直接抛 —— 校验层的承诺是「不抛」。
      if (cell === null || typeof cell !== "object") {
        skipped.push("认不出的 op");
        continue;
      }
      const target = canonical(cell.r, cell.c);
      if (target === undefined) {
        skipped.push(`越界格 (${cell.r},${cell.c})`);
        continue;
      }
      const index = target.r * doc.cols + target.c;
      const tile = tileValue(cell.tile);
      const previous = data[index];
      if (previous === tile) continue;
      before.push({ r: target.r, c: target.c, tile: previous });
      data[index] = tile;
      changed.add(index);
      dirty.set(index, target);
    }
    return before;
  };

  for (const raw of ops) {
    const op = raw as MapOp | null;
    if (op === null || typeof op !== "object" || typeof (op as { kind?: unknown }).kind !== "string") {
      skipped.push("认不出的 op");
      continue;
    }
    if (typeof op.layerId !== "string" || doc.data[op.layerId] === undefined) {
      skipped.push(`图层不存在：${String(op.layerId)}`);
      continue;
    }
    if (op.kind === "paint") {
      if (!Array.isArray(op.cells)) {
        skipped.push("paint 缺 cells");
        continue;
      }
      const before = paintValue(op.layerId, op.cells);
      if (before.length > 0) undo.push({ kind: "paint", layerId: op.layerId, cells: before });
    } else if (op.kind === "fill") {
      const start = canonical(op.r, op.c);
      if (start === undefined) {
        skipped.push(`越界格 (${op.r},${op.c})`);
        continue;
      }
      const data = doc.data[op.layerId];
      const tile = tileValue(op.tile);
      const target = data[cellIndex(doc, start.r, start.c)];
      if (target === tile) continue;
      // 洪水填充**不跨环绕接缝**（AsLib 同款）：在 0..cols / 0..rows 平面上做，
      // 越界邻居直接停。跨接缝填会把整张图一圈一圈填满，而且没人能预期到。
      const cells: Array<{ r: number; c: number; tile: number }> = [];
      const seen = new Set<number>();
      const stack: Array<{ r: number; c: number }> = [start];
      while (stack.length > 0) {
        const cell = stack.pop() as { r: number; c: number };
        if (cell.r < 0 || cell.c < 0 || cell.r >= doc.rows || cell.c >= doc.cols) continue;
        const index = cell.r * doc.cols + cell.c;
        if (seen.has(index)) continue;
        if (data[index] !== target) continue;
        seen.add(index);
        cells.push({ r: cell.r, c: cell.c, tile });
        stack.push({ r: cell.r + 1, c: cell.c }, { r: cell.r - 1, c: cell.c }, { r: cell.r, c: cell.c + 1 }, { r: cell.r, c: cell.c - 1 });
      }
      const before = paintValue(op.layerId, cells);
      if (before.length > 0) undo.push({ kind: "paint", layerId: op.layerId, cells: before });
    } else if (op.kind === "rect") {
      // 四个角一起校验：不合法就整条跳过。只按格遍历、让 paintValue 逐格报错的话，
      // 一个浮点矩形会刷出上百条同样的 `越界格`，真正的问题被淹掉。
      if (![op.r0, op.c0, op.r1, op.c1].every((value) => Number.isInteger(value))) {
        skipped.push(`越界格 (${op.r0},${op.c0})`);
        continue;
      }
      const r0 = Math.min(op.r0, op.r1);
      const r1 = Math.max(op.r0, op.r1);
      const c0 = Math.min(op.c0, op.c1);
      const c1 = Math.max(op.c0, op.c1);
      const tile = tileValue(op.tile);
      const cells: Array<{ r: number; c: number; tile: number }> = [];
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const onEdge = r === r0 || r === r1 || c === c0 || c === c1;
          if (onEdge || op.filled !== false) cells.push({ r, c, tile });
        }
      }
      const before = paintValue(op.layerId, cells);
      if (before.length > 0) undo.push({ kind: "paint", layerId: op.layerId, cells: before });
    } else if (op.kind === "replace") {
      const data = doc.data[op.layerId];
      const from = Math.round(Number(op.from));
      const to = tileValue(op.to);
      const cells: Array<{ r: number; c: number; tile: number }> = [];
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== from) continue;
        cells.push({ r: Math.floor(index / doc.cols), c: index % doc.cols, tile: to });
      }
      const before = paintValue(op.layerId, cells);
      if (before.length > 0) undo.push({ kind: "paint", layerId: op.layerId, cells: before });
    } else {
      skipped.push(`不支持的 op：${String((op as { kind: unknown }).kind)}`);
    }
  }
  if (changed.size > 0) doc.updatedAt = new Date().toISOString();
  return {
    changed: changed.size,
    skipped,
    dirty: [...dirty.values()].sort((a, b) => a.r - b.r || a.c - b.c),
    undo: undo.reverse()
  };
}

/**
 * 撤销：把逆操作原样应用（它本身也是 op）。
 *
 * 契约里没有 `layout` 参数 —— 逆操作记下来的坐标本来就是**规范坐标**，这里补一个
 * 只为了能复用 `applyOps`；wrap 对规范坐标是恒等变换，所以用哪个网格都不影响结果。
 */
export function revertOps(doc: MapDoc, undo: readonly MapOp[]): number[] {
  const layout = layoutOf(DEFAULT_GRID, doc.cols, doc.rows);
  return applyOps(doc, undo, layout).dirty.map((cell) => cell.r * doc.cols + cell.c);
}

/** 用到的图块序号（删图集 / 改切分前查引用）。 */
export function usedTileIndices(doc: MapDoc): Set<number> {
  const out = new Set<number>();
  for (const layer of doc.layers) {
    for (const value of doc.data[layer.id] ?? []) {
      if (value > 0) out.add(value);
    }
  }
  return out;
}

export function filledCount(doc: MapDoc, layerId?: string): number {
  let n = 0;
  for (const layer of doc.layers) {
    if (layerId !== undefined && layer.id !== layerId) continue;
    for (const value of doc.data[layer.id] ?? []) if (value > 0) n++;
  }
  return n;
}

export function isDocEmpty(doc: MapDoc): boolean {
  return filledCount(doc) === 0;
}

/** 把越界 / 不存在的图块序号清掉：返回被清掉的格子数（删图集 / 改切分之后要调用）。 */
export function pruneTileIndices(doc: MapDoc, maxIndex: number): number {
  let pruned = 0;
  for (const layer of doc.layers) {
    const data = doc.data[layer.id];
    if (data === undefined) continue;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > maxIndex) {
        data[i] = 0;
        pruned++;
      }
    }
  }
  return pruned;
}
