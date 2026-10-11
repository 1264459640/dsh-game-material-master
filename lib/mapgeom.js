/**
 * 地图编辑器（模块六）的**网格内核**：纯函数、不碰磁盘、不碰网络。
 *
 * 只有一种格网：正方形俯视（16×16 / 32×32 那种）。等距那一套随旧流水线一起删掉，
 * 「格网类型」这个字段也就不存在了 —— 留着它只会在别的模块里又长出一层分支。
 *
 * ## 为什么把它单独抽一层
 *
 * 旧模块（`tilegeom.ts` / `tilemap.ts`）的坐标口径散在三处，界面还要复刻一份，
 * 于是「保存后整体抬高」「点到的格子不是涂到的格子」反复出现。这个模块是
 * 新模块**唯一的坐标真源**：宿主渲染、导出、chunk 划分、命中测试全走这里；
 * 浏览器半区**只被允许**复刻 `pointToCell` / `cellAnchor` / `cellTopLeft`
 * （`verify-map-client.mjs` 拿本文件的真实现做黄金对照钉住）。
 *
 * ## 环绕（关键，改错了只会静默错位）
 *
 * 地图是**环面**：格坐标允许为负、允许 ≥ rows/cols，取模由 `wrapRow` / `wrapCol`
 * 负责；像素位置则**按线性公式照算**。于是同一格内容可以在屏幕上出现多次 ——
 * 左右边界靠上一行的那一块，就是「图外多画的一份」。AsLib 同款，用户不必关心边界。
 * 两个静默坑：
 *
 *   · 计划里的 `r` / `c` 用**规范坐标**（取模后 0..rows/cols−1），但 `x` / `y` 是
 *     **绝对像素**（可以越界）。两边只取模一边，内容就画到屏幕外了 —— 不报错，
 *     只是「看着是空的」。
 *   · 视口覆盖范围（`viewCellRange`）在环绕下**每一维最多铺一整轮**。放开这个限制
 *     内容不会错，只会全是重复，而且把绘制计划撑爆。
 *
 * 格子的「锚点」= 单元格底边中点（贴图按底边中点对齐锚点落地）。需要中心时调
 * `cellCenter()`：**别把锚点当中心** —— 跨格贴图曾经因此整体偏半格，真机表现是
 * 「房子浮在半空」。
 */
export const DEFAULT_GRID = { tileWidth: 32, tileHeight: 32, wrap: true };
/** 单边最大格数。超过就明确拒绝，而不是把进程 OOM 掉。 */
export const MAX_MAP_DIM = 512;
/** 单张地图最大格数（与逐边上限一致）。 */
export const MAX_MAP_CELLS = MAX_MAP_DIM * MAX_MAP_DIM;
/** 渲染计划的 chunk 边长（格）。一次笔刷最多弄脏 4 个 chunk。 */
export const MAP_CHUNK_SIZE = 32;
/**
 * 把任意输入收敛成一份合法网格。缺项回落默认值；**形状不合法不修**，
 * 交给 `assertGrid` 抛出可执行的原因（静默改成别的比例更难排查）。
 */
export function normalizeGrid(input) {
    const raw = (input ?? {});
    const int = (value, fallback) => {
        const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
        return Number.isFinite(n) ? Math.round(n) : fallback;
    };
    return {
        tileWidth: int(raw.tileWidth, DEFAULT_GRID.tileWidth),
        tileHeight: int(raw.tileHeight, DEFAULT_GRID.tileHeight),
        wrap: typeof raw.wrap === "boolean" ? raw.wrap : DEFAULT_GRID.wrap
    };
}
/** 网格是否合法；不合法抛 `Error`（文案要能直接告诉用户改成什么）。 */
export function assertGrid(grid) {
    for (const [label, value] of [["瓦片宽", grid.tileWidth], ["瓦片高", grid.tileHeight]]) {
        if (!Number.isInteger(value) || value < 1 || value > 2048) {
            throw new Error(`${label}必须是 1~2048 的整数，收到 ${String(value)}`);
        }
    }
    if (typeof grid.wrap !== "boolean")
        throw new Error(`环绕开关必须是布尔值，收到 ${String(grid.wrap)}`);
}
export function assertMapSize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        throw new Error(`地图尺寸必须是正整数，收到 ${cols}×${rows}`);
    }
    if (cols > MAX_MAP_DIM || rows > MAX_MAP_DIM) {
        throw new Error(`地图单边最多 ${MAX_MAP_DIM} 格，收到 ${cols}×${rows}。请把格网调大或把地图改小。`);
    }
}
export function layoutOf(grid, cols, rows) {
    assertGrid(grid);
    assertMapSize(cols, rows);
    return {
        grid,
        cols,
        rows,
        stepX: grid.tileWidth,
        stepY: grid.tileHeight,
        width: cols * grid.tileWidth,
        height: rows * grid.tileHeight,
        wrap: grid.wrap
    };
}
// ── 环绕 ─────────────────────────────────────────────────────────────────
/** 取模到 `0..size-1`（负数也对：JS 的 `%` 会给负余数）。 */
function mod(value, size) {
    const rest = value % size;
    return rest < 0 ? rest + size : rest;
}
/** 行坐标取模；不环绕时**原样返回**（越界就是越界，由调用方判断 inMap）。 */
export function wrapRow(layout, r) {
    return layout.wrap ? mod(r, layout.rows) : r;
}
export function wrapCol(layout, c) {
    return layout.wrap ? mod(c, layout.cols) : c;
}
export function wrapCell(layout, r, c) {
    return { r: wrapRow(layout, r), c: wrapCol(layout, c) };
}
// ── 格子 ↔ 像素 ──────────────────────────────────────────────────────────
/** 格子中心像素。 */
export function cellCenter(layout, r, c) {
    return { x: c * layout.stepX + layout.grid.tileWidth / 2, y: r * layout.stepY + layout.grid.tileHeight / 2 };
}
/**
 * 格子锚点 = 单元格**底边中点**（贴图锚点落地的那个像素点）。
 * 越界坐标照样给出正确的线性位置 —— 环绕就是靠这一点把图外的副本摆出去的。
 */
export function cellAnchor(layout, r, c) {
    const center = cellCenter(layout, r, c);
    return { x: center.x, y: (r + 1) * layout.stepY };
}
/**
 * 一张贴图贴在某个格子上时，它的左上角在哪。
 *
 * `anchorX` / `anchorY` 是贴图内部的归一化锚点（默认底边中点）。贴图比一格大时
 * （树、房子）只改 width/height 即可，锚点自动跟着走。
 */
export function cellTopLeft(layout, r, c, width, height, anchorX = 0.5, anchorY = 1) {
    const anchor = cellAnchor(layout, r, c);
    return { x: anchor.x - width * anchorX, y: anchor.y - height * anchorY };
}
/**
 * 像素 → 格子，**不取模**。越界返回图外的负坐标 / 超界坐标，`inMap` 为 false。
 *
 * 环绕的取模由 `pointToCell` 做；`viewCellRange` 特意用这一版，因为「视口在图外的
 * 哪一侧」必须靠越界坐标才看得出来。
 */
export function pointToCellRaw(layout, x, y) {
    const c = Math.floor(x / layout.stepX);
    const r = Math.floor(y / layout.stepY);
    return { r, c, inMap: r >= 0 && c >= 0 && r < layout.rows && c < layout.cols };
}
/** 像素 → 格子。环绕时取模且 `inMap` **恒 true**（图外像素等价于图内对应位置）。 */
export function pointToCell(layout, x, y) {
    const raw = pointToCellRaw(layout, x, y);
    if (!layout.wrap)
        return raw;
    return { r: wrapRow(layout, raw.r), c: wrapCol(layout, raw.c), inMap: true };
}
/** 逐格遍历顺序 = 绘制顺序（行优先，等价于 Tiled 的 `renderorder: right-down`）。 */
export function drawOrderRows(cols, rows) {
    const out = [];
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            out.push([r, c]);
    return out;
}
export function chunkOf(r, c) {
    return { cx: Math.floor(c / MAP_CHUNK_SIZE), cy: Math.floor(r / MAP_CHUNK_SIZE) };
}
/** `"cx,cy"`；环绕下**可以是负的**（界面收到的 `have` 里就有）。 */
export function chunkKey(chunk) {
    return `${chunk.cx},${chunk.cy}`;
}
/**
 * 解析 chunk key。**必须严格**：`Number.parseInt("1.5")` 会得到 `1`，
 * 于是客户端报上来的脏 key 会被当成另一个 chunk —— 增量缓存静默错一整块。
 */
export function parseChunkKey(key) {
    const matched = /^(-?\d+),(-?\d+)$/.exec(key);
    if (matched === null)
        return undefined;
    const cx = Number(matched[1]);
    const cy = Number(matched[2]);
    if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy))
        return undefined;
    return { cx, cy };
}
/** chunk 覆盖的格子范围，**不裁剪**（环绕下要能表示负的起点）。 */
export function rangeOfChunk(chunk) {
    return {
        r0: chunk.cy * MAP_CHUNK_SIZE,
        c0: chunk.cx * MAP_CHUNK_SIZE,
        r1: (chunk.cy + 1) * MAP_CHUNK_SIZE,
        c1: (chunk.cx + 1) * MAP_CHUNK_SIZE
    };
}
/** 覆盖 `range` 的所有 chunk（原始坐标，可能越界；规范化交给 `canonicalChunk`）。 */
export function chunksInRange(range) {
    const out = [];
    if (range.r1 <= range.r0 || range.c1 <= range.c0)
        return out;
    const cx0 = Math.floor(range.c0 / MAP_CHUNK_SIZE);
    const cx1 = Math.floor((range.c1 - 1) / MAP_CHUNK_SIZE);
    const cy0 = Math.floor(range.r0 / MAP_CHUNK_SIZE);
    const cy1 = Math.floor((range.r1 - 1) / MAP_CHUNK_SIZE);
    for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++)
            out.push({ cx, cy });
    }
    return out;
}
/**
 * 把 chunk 取模成 `0..nx-1` × `0..ny-1`（`nx = ceil(cols/32)`）。
 *
 * 客户端缓存与脏标记**只认规范 key**，否则同一块内容会以无数个越界 key 反复入缓存，
 * 而且永远匹配不上脏标记 —— 表现是「涂了不刷新」，也不报错。
 */
export function canonicalChunk(chunk, cols, rows) {
    const nx = Math.max(1, Math.ceil(cols / MAP_CHUNK_SIZE));
    const ny = Math.max(1, Math.ceil(rows / MAP_CHUNK_SIZE));
    return { cx: mod(chunk.cx, nx), cy: mod(chunk.cy, ny) };
}
/** 整张地图的规范 chunk（导出 / 全量计划用）。 */
export function allChunks(cols, rows) {
    const out = [];
    const nx = Math.max(1, Math.ceil(cols / MAP_CHUNK_SIZE));
    const ny = Math.max(1, Math.ceil(rows / MAP_CHUNK_SIZE));
    for (let cy = 0; cy < ny; cy++)
        for (let cx = 0; cx < nx; cx++)
            out.push({ cx, cy });
    return out;
}
/**
 * 一批格子会弄脏哪些 chunk（返回**规范** key，可直接与客户端的 `have` 比对）。
 *
 * 范围取 3×3 邻域：自动连接会改邻近格的外观，而邻居可能在隔壁 chunk。环绕时
 * `r = 0` 的上一行邻居是 `rows-1`，必须落到 `rows-1` 所在的 chunk —— 漏了这一步，
 * 表现是「贴着上边界涂，另一边接缝不更新」，不报错。
 */
export function dirtyChunksFor(cells, layout) {
    const keys = new Set();
    const push = (r, c) => {
        const cell = layout.wrap ? wrapCell(layout, r, c) : { r, c };
        if (cell.r < 0 || cell.c < 0 || cell.r >= layout.rows || cell.c >= layout.cols)
            return;
        keys.add(chunkKey(canonicalChunk(chunkOf(cell.r, cell.c), layout.cols, layout.rows)));
    };
    for (const cell of cells) {
        for (let dr = -1; dr <= 1; dr++)
            for (let dc = -1; dc <= 1; dc++)
                push(cell.r + dr, cell.c + dc);
    }
    return [...keys].sort();
}
function clampInt(value, low, high) {
    return Math.max(low, Math.min(high, value));
}
/**
 * 视口矩形覆盖到的格子范围（`padding` 默认 1：自动连接需要看一圈邻居）。
 *
 * 用 `pointToCellRaw` 的四角 —— 视口在图外时坐标是负的 / 超界的，正好能算出要
 * 补画的图外副本。
 *
 * 环绕下**每一维最多铺一整轮**（`rows` / `cols`）：多出来的部分与前面完全重复，
 * 画了也看不见，却会把 chunk 数与计划条数按倍数放大（`MAP_CHUNK_SIZE` 那一侧
 * 还有 `MAX_PLAN_CHUNKS` 兜着，这里必须自己收口）。非环绕下裁到 `0..cols/rows`，
 * 视口完全在图外时返回空 range（`r1 === r0`），`chunksInRange` 会给出空数组。
 */
export function viewCellRange(layout, view, padding = 1) {
    const corners = [
        { x: view.x, y: view.y },
        { x: view.x + view.width, y: view.y },
        { x: view.x, y: view.y + view.height },
        { x: view.x + view.width, y: view.y + view.height }
    ].map((point) => pointToCellRaw(layout, point.x, point.y));
    const r0 = Math.min(...corners.map((hit) => hit.r)) - padding;
    const c0 = Math.min(...corners.map((hit) => hit.c)) - padding;
    const r1 = Math.max(...corners.map((hit) => hit.r)) + 1 + padding;
    const c1 = Math.max(...corners.map((hit) => hit.c)) + 1 + padding;
    if (!layout.wrap) {
        return {
            r0: clampInt(r0, 0, layout.rows),
            c0: clampInt(c0, 0, layout.cols),
            r1: clampInt(r1, 0, layout.rows),
            c1: clampInt(c1, 0, layout.cols)
        };
    }
    return {
        r0,
        c0,
        r1: Math.min(r1, r0 + layout.rows),
        c1: Math.min(c1, c0 + layout.cols)
    };
}
/** 导出用：把（可能越界的）范围裁到 `0..cols` × `0..rows`。 */
export function clampRangeToMap(layout, range) {
    return {
        r0: clampInt(range.r0, 0, layout.rows),
        c0: clampInt(range.c0, 0, layout.cols),
        r1: clampInt(range.r1, 0, layout.rows),
        c1: clampInt(range.c1, 0, layout.cols)
    };
}
