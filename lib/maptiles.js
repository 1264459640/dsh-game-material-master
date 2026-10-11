/**
 * 地图编辑器（模块六）的**图集（tileset）模型与切分**。
 *
 * 一个项目可以导入多张图集；每张图集按**自动识别出来的形态**切成图块：
 *
 *   · `plain`    正方形网格：按 `cell` 行优先逐格切；`animRows` 时**同一列的每一行
 *                是同一块的一帧**（地形动画，AsLib 的「逐行动画」）
 *   · `corner16` 整格自动连接：切法与 plain 完全相同，只是每块会挂一个 4 位掩码
 *   · `a2quad`   A2 拼块：一格的四个象限从素材里各取一个小格（详见 `buildTiles`）
 *
 * ## 两条铁律
 *
 * 1. **图块 id 由矩形派生**（`t{x}_{y}`），不是数组下标。重新切分（改格尺寸、改形态）
 *    之后，同一个矩形的元数据仍然挂在同一个 id 上；用下标的话会静默漂移。
 * 2. **单元格里存的是「全局图块序号」（1-based，0 = 空）**，不是图块 id ——
 *    绘制计划、脏 chunk、`map.json` 都靠它。序号由 `flatTiles()` 唯一决定，
 *    顺序 = 图集顺序 → `tiles` 数组顺序，别的地方不许按下标自己算。
 *
 * ## A2 的真实几何（照 AsLib，`AsMap.hpp` 的 `drawMapBranch` / `map20n_Number`）
 *
 *   一张 A2 图：小格边长 `S = imageHeight / 10`（10 行小格），横向 `imageWidth % S === 0`。
 *   一个「逻辑块」（= 屏幕上一格）= 2×2 个小格。于是：
 *     · **块行号 0..4 = 形状号**（5 种），**块列号 = 变体号**（素材里横着排了几种）
 *     · 逻辑块尺寸 = 2S（32px 的块 = 16px 的小格），逻辑块列数 = `imageWidth / (2S)`
 *     · `detectLayout(64, 160)` → S=16、块 32×32、2 变体 × 5 形状
 *       （AsLib 要求「小格列数（= NumX）是偶数」，否则变体凑不成对）
 *   小格的行列号与小格内的象限是一一对应的：
 *     `smallRow = 2 * shape + (0 上 / 1 下)`，`smallCol = 2 * variant + (0 左 / 1 右)`
 *   这跟 AsLib 的 chip 下标 `NumX * 2 * shape + tm_id(+1)(+NumX)` 逐项相等 ——
 *   我们把 `tiles` 按小格行优先展开，于是 **1-based 序号 − 1 = AsLib 的 chip 下标**。
 *   渲染端（`maprender.ts`）按这个对应关系挑象限块，别自己另立一套顺序。
 */
import { pngSize } from "./bitmap.js";
import { A2_SHAPES } from "./mapauto.js";
export const COMMON_TILE_SIZES = [8, 16, 24, 32, 48, 64];
export function tileIdFor(rect) {
    return `t${rect.x}_${rect.y}`;
}
export function rectKey(rect) {
    return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}
/**
 * plain 兜底的试算顺序：**先 ≤32 的降序**（32 → 24 → 16 → 8），再 >32 的升序（48 → 64）。
 *
 * 为什么不直接取「能整除的最大尺寸」：像素画工作流的默认口径就是 32px，而「最大」
 * 会把 2×2 个 32px 道具并成一个 64px 格 —— 那是**静默改掉用户素材的语义**（一块里
 * 装四个道具），比报错难查得多。48 / 64 只在前面的都试不出来时才轮到。
 *
 * 举例（都是 32px 网格）：`256×192` = 8 列 × 6 行 —— 若取最大会得到 64px / 4×3；
 * `96×96` = 3×3 —— 若取最大会得到 48px。注意 `256×160`（8×5）**轮不到这一分支**：
 * 它会先命中上面的 A2 判据（高 = 5 × 32、宽能被 32 整除），那正是内置道具图走
 * `importSampleTileset` 的 `known` 通道显式声明形态、不经自动识别的原因。
 */
const PLAIN_PREFERRED_SIZES = [
    ...COMMON_TILE_SIZES.filter((size) => size <= 32).reverse(),
    ...COMMON_TILE_SIZES.filter((size) => size > 32)
];
/**
 * 自动识别切分方式。
 *
 * **先试 A2**（`imageHeight === 5 × 块边长` 且 `imageWidth` 能被块边长整除，从小到大），
 * 免得 64×160 的草地被当成普通网格；再按 `PLAIN_PREFERRED_SIZES` 找能整除两者的
 * 正方形网格；两个都不成立时退回 32×32，并在 reason 里说清为什么要裁像素。
 *
 * ⚠️ **尺寸判据天生有二义性，这里不是 bug**：`256×160` 既可能是「8 变体 × 5 形状的
 * 拼块图」，也可能是「8×5 的 32px 普通网格」（AsLib 靠清单文件里的 `type` 列区分，
 * 光看尺寸分不开）。这里的取舍是**优先给拼块结论**；内置素材那条路不吃这个判据
 * （`mapgen.importSampleTileset` 带显式的 `shape` / `cell` / `animRows`），
 * 用户自己导入的图靠界面上「这块素材怎么用」的下拉改（`saveMapTileset`）。
 */
export function detectLayout(imageWidth, imageHeight) {
    for (const size of COMMON_TILE_SIZES) {
        if (imageHeight !== size * A2_SHAPES || imageWidth % size !== 0)
            continue;
        return {
            ...layoutFor("a2quad", { width: size, height: size }, imageWidth, imageHeight),
            reason: `识别到：拼块自动连接（${imageWidth / size} 种变体 × ${A2_SHAPES} 种形状）`
        };
    }
    for (const size of PLAIN_PREFERRED_SIZES) {
        if (imageWidth < size || imageHeight < size)
            continue;
        if (imageWidth % size !== 0 || imageHeight % size !== 0)
            continue;
        return {
            ...layoutFor("plain", { width: size, height: size }, imageWidth, imageHeight),
            reason: `识别到：正方形网格 ${size}×${size}（${imageWidth / size} 列 × ${imageHeight / size} 行）`
        };
    }
    return {
        ...layoutFor("plain", { width: 32, height: 32 }, imageWidth, imageHeight),
        reason: `没找到能整除 ${imageWidth}×${imageHeight} 的常见尺寸，先按 32×32 切：右侧 / 底部不足一格的部分会被裁掉。`
    };
}
/**
 * 按指定的形态与格尺寸算切分结果（用户在图集设置里改形态 / 格尺寸时走这条）。
 *
 * 只取**完整的块**：横向 / 纵向不足一个块的像素被裁掉（`Math.floor`），
 * 因为半个块既挑不出象限也对不上邻接。A2 还要求格尺寸是偶数（小格 = 块 / 2）。
 */
export function layoutFor(shape, cell, imageWidth, imageHeight) {
    if (!Number.isInteger(cell.width) || !Number.isInteger(cell.height) || cell.width < 1 || cell.height < 1) {
        throw new Error(`图块尺寸必须是正整数，收到 ${cell.width}×${cell.height}`);
    }
    if (shape === "a2quad") {
        if (cell.width % 2 !== 0 || cell.height % 2 !== 0) {
            throw new Error(`A2 拼块要求逻辑块尺寸是偶数（小格 = 逻辑块 / 2），收到 ${cell.width}×${cell.height}`);
        }
        const cols = Math.floor(imageWidth / cell.width);
        // 形状只有 0..4：第 6 行以后永远选不到，切出来只会让序号表里多出用不上的块。
        const rows = Math.min(A2_SHAPES, Math.floor(imageHeight / cell.height));
        if (cols < 1 || rows < 1) {
            return {
                cell: { width: cell.width, height: cell.height },
                shape,
                cols: 0,
                rows: 0,
                count: 0,
                reason: `素材 ${imageWidth}×${imageHeight} 比一个逻辑块 ${cell.width}×${cell.height} 还小，切不出图块。`
            };
        }
        return {
            cell: { width: cell.width, height: cell.height },
            shape,
            cols,
            rows,
            count: cols * 2 * rows * 2,
            reason: `已设为：拼块自动连接（${cols} 种变体 × ${rows} 种形状）`
        };
    }
    const cols = Math.floor(imageWidth / cell.width);
    const rows = Math.floor(imageHeight / cell.height);
    if (cols < 1 || rows < 1) {
        return {
            cell: { width: cell.width, height: cell.height },
            shape,
            cols: 0,
            rows: 0,
            count: 0,
            reason: `素材 ${imageWidth}×${imageHeight} 比一个图块 ${cell.width}×${cell.height} 还小，切不出图块。`
        };
    }
    const count = cols * rows;
    const reason = shape === "corner16"
        ? `已设为：整格自动连接（${cell.width}×${cell.height} 切 ${cols} 列 × ${rows} 行，16 种邻接）`
        : `已设为：正方形网格 ${cell.width}×${cell.height}（${cols} 列 × ${rows} 行）`;
    return { cell: { width: cell.width, height: cell.height }, shape, cols, rows, count, reason };
}
/**
 * 按切分结果生成图块表，并**保留已有元数据**。
 *
 * 保留的判据是矩形派生的 id（`tileIdFor`）：改格尺寸后仍然存在的矩形**把旧 tile 上的
 * 字段原样带过来** —— 界面上按位序配好的 16 张连接块、改过的名字不会因为一次
 * 「改格尺寸」全被抹掉。消失的 id 丢弃，新出现的给默认值。
 *
 * ⚠️ 这里**不做白名单拷贝**，只覆盖由几何算出来的那几项（`id` / `rect` / `shape` /
 * `variant` / `frame`）。白名单是旧实现踩过的坑：`MapTile` 以后加一个字段
 * （锚点、通行、标签……），白名单没跟上就会在每次重切时静默清空 —— 而且只有
 * 「改过那个字段、又改了格尺寸」的用户才会遇到。反过来，几何派生项**必须**覆盖：
 * 沿用旧值会让块号与 rect 对不上，静默错位。
 *
 * 顺序（= `flatTiles` 的 1-based 序号顺序，改了就等同于换了一套语义值）：
 *   · plain / corner16：行优先逐格；`animRows` 时 `frame` = 行号（同列共用一个逻辑块）
 *   · a2quad：小格行优先；`shape` = 块行号、`variant` = 块列号、`frame` = 0
 */
export function buildTiles(input, previous = []) {
    const { shape, cell, imageWidth, imageHeight } = input;
    const previousById = new Map(previous.map((tile) => [tile.id, tile]));
    const tileOf = (rect, shapeAt, variant, frame) => {
        const id = tileIdFor(rect);
        const old = previousById.get(id);
        // 先整份继承旧 tile（含以后新增的字段），再覆盖几何派生项。
        const tile = old === undefined ? { id, rect, name: id } : { ...old };
        tile.id = id;
        tile.rect = rect;
        if (typeof tile.name !== "string" || tile.name === "")
            tile.name = id;
        if (shapeAt === undefined)
            delete tile.shape;
        else
            tile.shape = shapeAt;
        if (variant === undefined)
            delete tile.variant;
        else
            tile.variant = variant;
        tile.frame = frame;
        return tile;
    };
    if (shape === "a2quad") {
        if (cell.width % 2 !== 0 || cell.height % 2 !== 0) {
            throw new Error(`A2 拼块要求逻辑块尺寸是偶数（小格 = 逻辑块 / 2），收到 ${cell.width}×${cell.height}`);
        }
        const smallWidth = cell.width / 2;
        const smallHeight = cell.height / 2;
        // 只切完整的逻辑块：横向留半块的话，那一列凑不齐左右象限（AsLib 要求小格列数是偶数）。
        const smallCols = Math.floor(imageWidth / cell.width) * 2;
        const smallRows = Math.min(A2_SHAPES, Math.floor(imageHeight / cell.height)) * 2;
        const tiles = [];
        for (let smallRow = 0; smallRow < smallRows; smallRow++) {
            for (let smallCol = 0; smallCol < smallCols; smallCol++) {
                tiles.push(tileOf({ x: smallCol * smallWidth, y: smallRow * smallHeight, width: smallWidth, height: smallHeight }, Math.floor(smallRow / 2), Math.floor(smallCol / 2), 0));
            }
        }
        return tiles;
    }
    const cols = Math.floor(imageWidth / cell.width);
    const rows = Math.floor(imageHeight / cell.height);
    const animRows = input.animRows === true;
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            tiles.push(tileOf({ x: col * cell.width, y: row * cell.height, width: cell.width, height: cell.height }, undefined, undefined, animRows ? row : 0));
        }
    }
    return tiles;
}
/**
 * 展平成一个全项目通用的索引。
 *
 * 顺序 = 图集顺序 → `tileset.tiles` 数组顺序，**因此只要不动图集顺序与切分参数，
 * 序号就稳定**；这也是 `applyOps` 里存的序号能跨会话读回来的前提。
 * 序号的唯一真源是这里，别的任何地方都不许自己按数组下标算。
 */
export function flatTiles(tilesets) {
    const out = [];
    let index = 1;
    for (const tileset of tilesets) {
        for (const tile of tileset.tiles) {
            out.push({ index, tilesetId: tileset.id, tile, value: index });
            index++;
        }
    }
    return out;
}
export function flatIndexByValue(tilesets) {
    return new Map(flatTiles(tilesets).map((flat) => [flat.value, flat]));
}
// ── 图像尺寸探测 / 裁剪 ──────────────────────────────────────────────────
/** 从文件头拿尺寸；PNG 之外的类型回落到 ffmpeg（见 `bitmap.probeImageSize`）。 */
export function sizeFromBytes(bytes) {
    return pngSize(bytes);
}
/** 给验收 / 界面用的图块位图（裁剪出一块）。 */
export function cropTile(source, rect) {
    const width = Math.max(1, Math.min(rect.width, source.width - rect.x));
    const height = Math.max(1, Math.min(rect.height, source.height - rect.y));
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const from = ((rect.y + y) * source.width + rect.x) * 4;
        source.rgba.copy(rgba, y * width * 4, from, from + width * 4);
    }
    return { width, height, rgba };
}
