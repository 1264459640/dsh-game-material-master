/**
 * 地图编辑器（模块六）的**内置示例素材生成器**（纯程序化，零成本、确定性）。
 *
 * ## 为什么要自己产一套
 *
 * AsLib RPG Map Maker 自带的 `Picture/MapChip/*_pipo.png` 是**第三方版权素材，不能打包**
 * 进本插件。所以内置示例素材改成**本机现算**：不需要下载、不需要 API Key、不花一分钱，
 * 而且同一份输入两次生成的 PNG **逐字节一致**（可以直接用哈希比对，见
 * `scripts/make-map-sample-tileset.mjs --check`）。
 *
 * ## 产物长什么样（全部 32px 逻辑格）
 *
 * - **4 张 A2 图**（草地 / 土路 / 水 / 石墙）：`64×160` = 4 列 × 10 行**小格**（16×16），
 *   即 2 个块列 × 5 个块行、每块 32×32。块列号 = 变体号（0..1），块行号 = **形状号**（0..4）。
 *   形状语义照 AsLib：0 = 左/上都不连通（孤岛）、1 = 只上连通、2 = 只左连通、
 *   3 = 左上都连通但没有对角、4 = 左/上/左上都连通（满格）。
 *   每个形状块内是 2×2 个小格，**四个小格是镜像的**：形状 0 在小格的「横向外边 + 纵向外边」
 *   各压一条 5px 宽的邻接地貌过渡带（孤岛 → 整块四周一圈带），形状 1 只压横向外边、
 *   形状 2 只压纵向外边、形状 3 只在朝对角那一角画 L 形内角带、形状 4 不压（纯本体）。
 *   过渡带靠内的 2px 用**有序抖动矩阵**做过渡（不用随机数发生器，任何调用顺序下都一样）。
 * - **1 张道具网格图**：`8×5` 个 32px 图块（树 / 花 / 石头 / 木箱 / 栅栏 / 蘑菇 / 断枝 / 石头堆）。
 * - **变体 = 帧**：变体 1 是噪声种子 + 1（水再错开 90° 波纹相位）的同一地貌，
 *   两帧逐像素不同 —— 这是内置素材里唯一的动画来源（水最明显）。
 *
 * ## 纹理从哪来
 *
 * 默认走 `renderLocalTexture(kind, size, seed)`：基色 + 抖动噪声 + 少量像素细节。
 * 留了一条可选覆盖通道：`SAMPLE_TEXTURE_OVERRIDE`（由
 * `scripts/make-map-sample-tileset.mjs --ark` 用 Seedream 生成并降采样成 32×32 后写回），
 * 里面某个地貌有 base64 PNG 就用它当纹理源，没有就程序化。默认那份是**空对象**。
 * 覆盖图走 `bitmap.ts` 的统一解码入口 `decodeFile`（ffmpeg），所以调用方要先
 * `await primeSampleTextures()` 一次 —— `renderSampleTilesets()` 本身保持同步契约；
 * 配了覆盖却没 prime 会**明确抛错**，不会静默退回程序化纹理。
 *
 * ## 确定性怎么保证（这是硬要求）
 *
 * - **不许 `Math.random()` / `Date.now()`**：所有「随机」都来自 `mulberry32(seed)`
 *   与整数哈希 `noise2d(x, y, seed)`，同样的种子永远给同样的序列。
 * - 像素颜色全部走整数运算 + 位运算截断，没有任何浮点累积误差参与分支
 *   （唯一的浮点是 `Math.sin` 的波纹相位，同样的参数在同一个 JS 引擎里结果一致）。
 * - 行序、遍历顺序固定（行优先），不依赖 Map / Set 的插入顺序做输出。
 * - zlib 压缩级别固定为 6（见 `png.ts`），所以 PNG 字节也是稳定的。
 *
 * 依赖只有 `./bitmap.js` + `./png.js` + Node 内置模块，**不联网、不新增依赖**。
 */

import { encodePng } from "./png.js";
import { decodeFile, type Bitmap } from "./bitmap.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_TEXTURE_OVERRIDE } from "./mapsample.js";

/** 生成出来的一套图集里的一张图。 */
export interface SampleTileset {
  /** 中文名，例如「内置 · 草地」。 */
  name: string;
  /** 写进 `tilesets/` 的文件名，例如 `sample-grass.png`。 */
  file: string;
  /** PNG 字节。 */
  bytes: Buffer;
  /** `a2quad` = A2 自动连接拼块图；`plain` = 普通逐格图（道具网格走这条）。 */
  shape: "plain" | "a2quad";
  /** 逻辑格尺寸。 */
  cell: { width: number; height: number };
  /** 普通形态下「每一行是一帧」；A2 图靠变体做动画，这个字段恒 false。 */
  animRows: boolean;
}

/** 地貌种类（= 一张 A2 图的主题，也是纹理覆盖表的键）。 */
export type TextureKind = "grass" | "dirt" | "water" | "stone";

/** A2 图的块形状数（0..4）。 */
export const SAMPLE_SHAPES = 5;
/** A2 图的变体数（块列数）。 */
export const SAMPLE_VARIANTS = 2;
/** 逻辑格边长（像素）。 */
export const SAMPLE_CELL = 32;
/** A2 小格边长（像素）—— 一个逻辑格 = 2×2 个小格。 */
const A2_CELL = SAMPLE_CELL / 2;
/** 过渡带宽度（像素）：贴着小格的外边，靠内侧 2px 做抖动过渡。 */
const BAND = 5;
/** 过渡带内侧的抖动宽度（像素）。 */
const BAND_DITHER = 2;
/**
 * 内角带（形状 3）向角内延伸的长度（像素）。
 *
 * 为什么不画一个 5×5 的小方块：那只有整块 1% 的面积，逐像素平均绝对差最多 3~5 色阶
 * —— 界面上根本看不出形状 3 与形状 4 的区别（`--check` 会断言这个差值 > 6）。
 * 改成 5px 宽、向角内延伸 9px 的 **L 形**内角带（约占整块 29%），仍然紧贴小格的角，
 * 缩小视野后也能一眼看出「这里缺一个对角邻居」。
 */
const CORNER_ARM = 9;

export interface SampleKindSpec {
  kind: TextureKind;
  /** 中文名（图集名，界面直接显示）。 */
  name: string;
  /** 写进 `tilesets/` 的文件名。 */
  file: string;
  /** 邻接地貌（过渡带用谁的颜色）；`undefined` = 没有邻接地貌，用深色阴影。 */
  neighbor?: TextureKind;
  /** 给程序化纹理用的固定种子。 */
  seed: number;
}

/**
 * 四种地貌与它们的邻接关系（**固定表**，不随调用变化）。
 *
 * 邻接是**成对**的：草地↔土路要能互相压边；水只挨着草地（岸边）；石墙没有邻接地貌，
 * 过渡带画深色阴影（墙脚）。表里没写的组合不会出现在内置素材里。
 */
export const SAMPLE_KINDS: readonly SampleKindSpec[] = [
  { kind: "grass", name: "内置 · 草地", file: "sample-grass.png", neighbor: "dirt", seed: 1001 },
  { kind: "dirt", name: "内置 · 土路", file: "sample-dirt.png", neighbor: "grass", seed: 2002 },
  { kind: "water", name: "内置 · 水", file: "sample-water.png", neighbor: "grass", seed: 3003 },
  { kind: "stone", name: "内置 · 石墙", file: "sample-stone.png", neighbor: undefined, seed: 4004 }
];

/** 道具网格图的一行 8 个道具（中文名，顺序即图块从左到右的顺序）。 */
export const SAMPLE_PROP_NAMES: readonly string[] = [
  "树",
  "花",
  "石头",
  "木箱",
  "栅栏",
  "蘑菇",
  "断枝",
  "石头堆"
];

/** 道具网格图的行数（每一行是同一组道具的一帧，界面上按行切）。 */
export const SAMPLE_PROP_ROWS = 5;
/** 道具网格图的文件名。 */
export const SAMPLE_PROP_FILE = "sample-props.png";
/** 道具网格图的中文名。 */
export const SAMPLE_PROP_NAME = "内置 · 道具";

// ---------------------------------------------------------------------------
// 确定性随机：所有「随机」都必须经过这里
// ---------------------------------------------------------------------------

/**
 * mulberry32：32 位状态的确定性 PRNG（同一 seed 永远给同一序列）。
 *
 * 为什么不用 `Math.random`：内置素材的要求是「两次生成逐字节一致」，
 * 而 `Math.random` 不可播种；出问题也没法复现到某一次的具体输出。
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 整数哈希噪声：同 (x, y, seed) 恒等；用来做逐像素抖动，不受调用顺序影响。 */
export function noise2d(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// 位图小工具（只在本文件内用；不动 bitmap.ts）
// ---------------------------------------------------------------------------

/** 造一张全透明的位图。 */
function createBitmap(width: number, height: number): Bitmap {
  return { width, height, rgba: Buffer.alloc(width * height * 4) };
}

/** 写一个像素；越界静默忽略（画过渡带时经常画到边上）。 */
function setPixel(bitmap: Bitmap, x: number, y: number, color: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return;
  const i = (y * bitmap.width + x) * 4;
  bitmap.rgba[i] = color[0];
  bitmap.rgba[i + 1] = color[1];
  bitmap.rgba[i + 2] = color[2];
  bitmap.rgba[i + 3] = color[3];
}

/** 读一个像素；越界给全透明。 */
function getPixel(bitmap: Bitmap, x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return [0, 0, 0, 0];
  const i = (y * bitmap.width + x) * 4;
  return [bitmap.rgba[i], bitmap.rgba[i + 1], bitmap.rgba[i + 2], bitmap.rgba[i + 3]];
}

/** 把 `src` 整张盖到 `dst` 的 (dx, dy) 上（不透明覆盖，不做 alpha 混合 —— 素材本来就全不透明）。 */
function blit(dst: Bitmap, src: Bitmap, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const color = getPixel(src, x, y);
      if (color[3] === 0) continue;
      setPixel(dst, dx + x, dy + y, color);
    }
  }
}

/** 复制一张位图。 */
function cloneBitmap(src: Bitmap): Bitmap {
  return { width: src.width, height: src.height, rgba: Buffer.from(src.rgba) };
}

/** 整数收口到 0..255。 */
function clamp255(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value | 0;
}

/** 手画线段（Bresenham）—— 道具的树枝、花瓣靠它。 */
function drawLine(bitmap: Bitmap, x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number, number], width = 1): void {
  let x = x0 | 0;
  let y = y0 | 0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (width <= 1) setPixel(bitmap, x, y, color);
    else for (let oy = 0; oy < width; oy++) for (let ox = 0; ox < width; ox++) setPixel(bitmap, x + ox, y + oy, color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/** 手画实心圆（道具的树冠、花心、石头）。 */
function drawDisc(bitmap: Bitmap, cx: number, cy: number, radius: number, color: readonly [number, number, number, number]): void {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(bitmap, x, y, color);
    }
  }
}

/** 手画实心椭圆（道具的树冠、蘑菇伞盖）。 */
function drawEllipse(bitmap: Bitmap, cx: number, cy: number, rx: number, ry: number, color: readonly [number, number, number, number]): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPixel(bitmap, x, y, color);
    }
  }
}

/** 手画空心矩形（木箱的边框、栅栏的横杆）。 */
function strokeRect(bitmap: Bitmap, x: number, y: number, w: number, h: number, color: readonly [number, number, number, number], thickness = 1): void {
  for (let t = 0; t < thickness; t++) {
    for (let i = x + t; i < x + w - t; i++) {
      setPixel(bitmap, i, y + t, color);
      setPixel(bitmap, i, y + h - 1 - t, color);
    }
    for (let j = y + t; j < y + h - t; j++) {
      setPixel(bitmap, x + t, j, color);
      setPixel(bitmap, x + w - 1 - t, j, color);
    }
  }
}

/** 手画实心矩形。 */
function fillRect(bitmap: Bitmap, x: number, y: number, w: number, h: number, color: readonly [number, number, number, number]): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) setPixel(bitmap, x + i, y + j, color);
  }
}

// ---------------------------------------------------------------------------
// 程序化纹理
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

interface KindPalette {
  /** 暗色 / 亮色（逐像素在这两个之间抖动）。 */
  dark: Rgb;
  light: Rgb;
  /** 细节色（草叶尖、石子、水波高光、砖缝）。 */
  accent: Rgb;
}

const PALETTES: Record<TextureKind, KindPalette> = {
  grass: { dark: [58, 104, 48], light: [96, 156, 74], accent: [140, 196, 104] },
  dirt: { dark: [112, 84, 54], light: [160, 128, 86], accent: [90, 68, 46] },
  water: { dark: [40, 92, 158], light: [74, 140, 206], accent: [186, 226, 246] },
  stone: { dark: [104, 104, 112], light: [152, 152, 160], accent: [78, 78, 86] }
};

function mixColor(from: Rgb, to: Rgb, t: number): [number, number, number] {
  return [clamp255(from[0] + (to[0] - from[0]) * t), clamp255(from[1] + (to[1] - from[1]) * t), clamp255(from[2] + (to[2] - from[2]) * t)];
}

/**
 * 程序化纹理：基色 + 抖动噪声 + 少量像素细节。
 *
 * `phase` 只对**水**有意义（波纹相位）；`frame`（帧号）影响**所有**地貌：
 * 它同时改噪声种子与图案的空间偏移，所以「同一地貌的第 1 帧」与第 0 帧是逐像素不同的
 * 两帧，而不是同一张图复制两遍。这对有结构的地貌（石墙的砖缝）尤其重要 ——
 * 只换噪声种子时，砖缝位置一模一样，两帧的平均绝对差只有 4 色阶（实测），
 * 界面上看不出在动。
 */
export function renderLocalTexture(kind: TextureKind, size: number, seed: number, phase = 0, frame = 0): Bitmap {
  const bitmap = createBitmap(size, size);
  const palette = PALETTES[kind];
  // 帧号 → 图案来源坐标偏移 8px + 噪声种子 +17：两者一起保证两帧没有相关性。
  const shift = frame * 8;
  const noiseSeed = seed + frame * 17;
  const wrap = (value: number) => ((value % size) + size) % size;

  // 逐像素基色 + 抖动。噪声来自整数哈希，所以与遍历顺序无关。
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = wrap(x + shift);
      const sy = wrap(y + shift);
      let t = 0.18 + 0.64 * noise2d(sx, sy, noiseSeed);
      if (kind === "water") {
        // 两层正弦叠加做波纹：相位差让变体 0 / 1 的亮点位置明显错开。
        const wave =
          Math.sin((sx / size) * Math.PI * 4 + phase) * 0.5 +
          Math.sin((sy / size) * Math.PI * 2 + phase * 1.5) * 0.5;
        t = 0.24 + 0.42 * (0.5 + 0.5 * wave) + 0.16 * noise2d(sx, sy, noiseSeed);
      } else if (kind === "stone") {
        // 砌砖：每 8 行一条砖缝，奇数行错半块。
        const row = Math.floor(sy / 8);
        const offset = row % 2 === 0 ? 0 : 8;
        const brickX = ((sx + offset) % 16 + 16) % 16;
        const brickY = sy % 8;
        if (brickY === 0 || brickX === 0) t = 0.06;
        else if (brickY === 1 || brickX === 1) t = 0.88;
        else t = 0.3 + 0.4 * noise2d(sx, sy, noiseSeed) + (row % 2 === 0 ? 0.04 : 0);
      }
      const color = mixColor(palette.dark, palette.light, t);
      setPixel(bitmap, x, y, [color[0], color[1], color[2], 255]);
    }
  }

  // 细节（草叶 / 石子 / 波光 / 石斑）也必须跟着帧走：只用 `seed` 的话，两帧的基色纹理
  // 变了、细节却在原地不动，逐像素平均绝对差只有 4 色阶（实测），看起来像「贴图闪了一下」。
  const rand = mulberry32(noiseSeed ^ 0x5f3759df);
  const accent: [number, number, number, number] = [palette.accent[0], palette.accent[1], palette.accent[2], 255];
  if (kind === "grass" || kind === "dirt") {
    // 草叶 / 石子：短笔画，数量与位置都由上面的 PRNG 决定。
    const strokes = kind === "grass" ? size * 3 : size;
    for (let i = 0; i < strokes; i++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const length = kind === "grass" ? 1 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 2);
      for (let k = 0; k < length; k++) {
        setPixel(bitmap, x + (kind === "grass" && rand() < 0.4 ? 1 : 0), y - k, accent);
      }
    }
  }
  if (kind === "water") {
    // 波光高光：跟着相位一起移动，两帧才看得出「在流动」。
    for (let i = 0; i < size / 2; i++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const shifted = ((x + Math.round((phase / (Math.PI * 2)) * size)) % size + size) % size;
      setPixel(bitmap, shifted, y, accent);
      setPixel(bitmap, (shifted + 1) % size, y, accent);
    }
  }
  if (kind === "stone") {
    for (let i = 0; i < size; i++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      setPixel(bitmap, x, y, accent);
    }
  }
  return bitmap;
}

/** 覆盖图里的地貌清单：`SAMPLE_TEXTURE_OVERRIDE` 里真正填了 base64 的那些。 */
export function overrideKinds(): TextureKind[] {
  return SAMPLE_KINDS.map((item) => item.kind).filter((kind) => hasOverride(kind));
}

function hasOverride(kind: TextureKind): boolean {
  const value = SAMPLE_TEXTURE_OVERRIDE[kind];
  return typeof value === "string" && value.trim() !== "";
}

/** `primeSampleTextures()` 解出来的覆盖纹理（键 = 地貌）。 */
const overrideTextures = new Map<TextureKind, Bitmap>();
/** 是否已经 prime 过：用来把「没配覆盖」和「配了但忘了 prime」区分开（后者要明确报错）。 */
let overridesPrimed = false;

/**
 * 把 `SAMPLE_TEXTURE_OVERRIDE` 里的 base64 PNG 解码成纹理（**异步**，只在配了覆盖时才需要）。
 *
 * 为什么是独立的异步函数：解码走 `bitmap.ts` 的统一入口 `decodeFile`（内部是 ffmpeg），
 * 它能吃任意色深 / 调色板 / 隔行的 PNG，而 Seedream 返回的图未必是 8 位 RGBA 直存 ——
 * 自己手写解码器在真实返回上大概率一跑就炸（而且那条路径没法在自检里实测）。
 * 但 `renderSampleTilesets()` 的契约是**同步**的（见 §9 的接口），所以解码拆出来：
 * 调用方 `await primeSampleTextures()` 一次，之后同步渲染。
 *
 * 覆盖表是空对象（默认）时它是空操作，不需要调用 —— 但**配了覆盖却没 prime** 时
 * `textureFor()` 会明确抛错，绝不静默退回程序化纹理（那会得到「界面看着能用、
 * 纹理却不是他生成的那张」，最难查）。
 */
export async function primeSampleTextures(): Promise<void> {
  overridesPrimed = true;
  overrideTextures.clear();
  const kinds = overrideKinds();
  if (kinds.length === 0) return;
  const dir = mkdtempSync(join(tmpdir(), "gmm-sample-"));
  try {
    for (const kind of kinds) {
      const file = join(dir, `${kind}.png`);
      writeFileSync(file, Buffer.from(SAMPLE_TEXTURE_OVERRIDE[kind], "base64"));
      overrideTextures.set(kind, await decodeFile(file));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 取某个地貌的纹理：优先用 `SAMPLE_TEXTURE_OVERRIDE` 里的（`--ark` 生成、已降采样成 32×32），
 * 没有就程序化。
 *
 * `variant` 是**帧号**：程序化纹理按它改噪声种子、图案偏移与波纹相位，所以同一个地貌的
 * 两个变体是逐像素不同的两帧，而不是同一张图复制两遍。覆盖表里只有一张静态纹理，
 * 两个变体就只能是同一张 —— 想要真动画就不要给这个地貌配覆盖图。
 */
export function textureFor(kind: TextureKind, size: number, phase = 0, variant = 0): Bitmap {
  if (hasOverride(kind)) {
    const decoded = overrideTextures.get(kind);
    if (decoded === undefined) {
      const reason = overridesPrimed
        ? "已经 prime 过，但缓存里没有它（prime 中途失败？）"
        : "纹理还没解码（没有调用过 primeSampleTextures）";
      throw new Error(
        `内置素材的「${kind}」配了 SAMPLE_TEXTURE_OVERRIDE，但${reason}：` +
          `先 \`await primeSampleTextures()\` 再生成内置素材（解码走 ffmpeg，是异步的）。`
      );
    }
    return normalizeTexture(decoded, size);
  }
  const spec = SAMPLE_KINDS.find((item) => item.kind === kind);
  return renderLocalTexture(kind, size, spec?.seed ?? 1, phase, variant);
}

/** 把任意尺寸的纹理源收成 `size × size`（多则居中裁剪，少则平铺）。 */
function normalizeTexture(source: Bitmap, size: number): Bitmap {
  if (source.width === size && source.height === size) return cloneBitmap(source);
  const out = createBitmap(size, size);
  const originX = Math.floor((source.width - size) / 2);
  const originY = Math.floor((source.height - size) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = ((x + originX) % source.width + source.width) % source.width;
      const sy = ((y + originY) % source.height + source.height) % source.height;
      setPixel(out, x, y, getPixel(source, sx, sy));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A2 拼块图
// ---------------------------------------------------------------------------

/**
 * 抖动过渡：用 4×4 有序抖动矩阵决定「这一像素盖邻接地貌还是露本体」。
 *
 * 这里故意不用随机数发生器：矩阵是常量，过渡带在任何调用顺序下都长得一模一样，
 * 而且天然严格限制在固定宽度内（不会有一条像素随机飘出去的毛边）。
 */
const DITHER_4X4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** `depth` = 从带外缘往里数第几像素（0 = 最外面）。 */
function ditherHit(x: number, y: number, depth: number): boolean {
  const threshold = DITHER_4X4[(y % 4) * 4 + (x % 4)];
  // 外缘 3 行（5-2）全实心，内侧 2 行按矩阵交错，形成 5px 宽、边缘毛糙的过渡。
  return depth < BAND - BAND_DITHER || threshold < (BAND - depth) * 5;
}

/** 取过渡带该用哪个像素：有邻接地貌就取它的纹理，没有就用深色阴影。 */
function bandPixel(
  neighbor: Bitmap | undefined,
  shadow: readonly [number, number, number, number],
  x: number,
  y: number
): [number, number, number, number] {
  if (neighbor === undefined) return [shadow[0], shadow[1], shadow[2], 255];
  const color = getPixel(neighbor, x & (SAMPLE_CELL - 1), y & (SAMPLE_CELL - 1));
  return [color[0], color[1], color[2], 255];
}

/**
 * 在一个**小格**上压一条过渡带。
 *
 * `edge` 是小格的外边（`left` / `right` / `top` / `bottom`）—— 同一个小格在块里的位置
 * 不同，同一条边可能是「外」也可能是「内」，所以边由调用方按 (dx, dy) 显式给出，
 * **不能写死往左边画**（写死会让 TR / BR 两个小格的接缝对不上）。
 */
function applyBandEdge(
  target: Bitmap,
  originX: number,
  originY: number,
  edge: "left" | "right" | "top" | "bottom",
  neighbor: Bitmap | undefined,
  shadow: readonly [number, number, number, number]
): void {
  for (let d = 0; d < BAND; d++) {
    for (let i = 0; i < A2_CELL; i++) {
      let lx: number;
      let ly: number;
      if (edge === "left") {
        lx = d;
        ly = i;
      } else if (edge === "right") {
        lx = A2_CELL - 1 - d;
        ly = i;
      } else if (edge === "top") {
        lx = i;
        ly = d;
      } else {
        lx = i;
        ly = A2_CELL - 1 - d;
      }
      if (!ditherHit(lx, ly, d)) continue;
      // 最外 1px 压一条深色描边：地形边界有一条暗线，缩小视野后也能一眼看出「这里是边界」，
      // 而且让「形状 0 vs 形状 1」这类只差一条带的对比有足够的色阶差（见 `--check` 的断言）。
      const color: [number, number, number, number] =
        d === 0
          ? [shadow[0], shadow[1], shadow[2], 255]
          : bandPixel(neighbor, shadow, originX + lx, originY + ly);
      setPixel(target, originX + lx, originY + ly, color);
    }
  }
}

/**
 * 形状 3 的记号：在**朝对角的那一角**画一段 L 形内角带，紧贴小格的角。
 *
 * 形状 3 = 左/上都连通但没有对角，所以整块里只有四个角各缺一块「邻接地貌」；
 * 形状 4 什么都不画。这一块就是「有没有对角邻居」在贴图上的唯一区别，
 * 所以它必须足够大（见 `CORNER_ARM`），否则大小两个形状在界面上看不出差别。
 *
 * L 形朝向对角的**内侧**边界再压 1px 深色描边（和石墙过渡带同一个阴影色），
 * 让「缺角」有立体感，而不是平贴一块别的颜色。
 */
function applyDiagonalCorner(
  target: Bitmap,
  originX: number,
  originY: number,
  dx: 0 | 1,
  dy: 0 | 1,
  neighbor: Bitmap | undefined,
  shadow: readonly [number, number, number, number]
): void {
  for (let j = 0; j < CORNER_ARM; j++) {
    for (let i = 0; i < CORNER_ARM; i++) {
      const vertical = i < BAND;
      const horizontal = j < BAND;
      if (!vertical && !horizontal) continue;
      // 朝向本体的一侧（L 的内缘）画描边。
      const rim = (vertical && j === CORNER_ARM - 1) || (horizontal && i === CORNER_ARM - 1);
      const lx = dx === 0 ? i : A2_CELL - 1 - i;
      const ly = dy === 0 ? j : A2_CELL - 1 - j;
      const color: [number, number, number, number] = rim
        ? [shadow[0], shadow[1], shadow[2], 255]
        : bandPixel(neighbor, shadow, originX + lx, originY + ly);
      setPixel(target, originX + lx, originY + ly, color);
    }
  }
}

/**
 * 单个形状块的完整像素（32×32）。
 *
 * 块内是 2×2 个小格，**四个小格是镜像的**：每个小格的「横向外边」「纵向外边」
 * 「对角角」由它在块里的位置决定（见下表）。形状号给的是「这两个方向的邻居连通不连通」：
 *
 * | 形状 | 含义 | 每个小格画什么 |
 * |---|---|---|
 * | 0 | 左、上都不连通 | 横向外边 + 纵向外边（孤岛，整块四周一圈带） |
 * | 1 | 上连通、左不连通 | 只画横向外边 |
 * | 2 | 左连通、上不连通 | 只画纵向外边 |
 * | 3 | 左上都连通、对角不连通 | 只在朝对角那一角画 L 形内角带（5px 宽、向角内延伸 9px） |
 * | 4 | 全连通 | 不画带（纯本体纹理） |
 *
 * | 小格 | 横向外边 | 纵向外边 | 对角角 |
 * |---|---|---|---|
 * | TL (0,0) | 左 | 上 | 左上 |
 * | TR (1,0) | 右 | 上 | 右上 |
 * | BL (0,1) | 左 | 下 | 左下 |
 * | BR (1,1) | 右 | 下 | 右下 |
 */
function renderShapeBlock(base: Bitmap, shape: number, neighbor: Bitmap | undefined): Bitmap {
  const block = cloneBitmap(base);
  // 石墙没有邻接地貌：过渡带用同色系的深色阴影（墙脚），而不是凭空造一种地形。
  const shadow: [number, number, number, number] = [20, 18, 26, 255];
  for (const dx of [0, 1] as const) {
    for (const dy of [0, 1] as const) {
      const originX = dx * A2_CELL;
      const originY = dy * A2_CELL;
      const horizontal = dx === 0 ? "left" : "right";
      const vertical = dy === 0 ? "top" : "bottom";
      if (shape === 0) {
        applyBandEdge(block, originX, originY, horizontal, neighbor, shadow);
        applyBandEdge(block, originX, originY, vertical, neighbor, shadow);
      } else if (shape === 1) {
        applyBandEdge(block, originX, originY, horizontal, neighbor, shadow);
      } else if (shape === 2) {
        applyBandEdge(block, originX, originY, vertical, neighbor, shadow);
      } else if (shape === 3) {
        applyDiagonalCorner(block, originX, originY, dx, dy, neighbor, shadow);
      }
    }
  }
  return block;
}

/**
 * 帧间亮度差（色阶）。见 `applyFrameTint` 的说明。
 */
const FRAME_TINT = 7;

/**
 * 帧级微调：第 1 帧的**整块**（本体纹理 + 过渡带）统一提亮 `FRAME_TINT` 色阶。
 *
 * 为什么需要它：过渡带在两个变体里是同一份邻接地貌纹理（它不属于本图的帧），
 * 而形状 0 的带占了整块一半以上的面积 —— 于是「只换本体纹理」的帧差会被稀释。
 * 石墙尤其极端：它的带是一整片纯色阴影、零纹理，只换本体时两帧的逐像素平均绝对差
 * 只有 3.7 色阶（实测），界面上等于没有动画。
 *
 * 这是**补充**手段，不是唯一手段：本体的噪声种子 / 图案偏移 / 波纹相位仍然逐帧不同
 * （那才是「能看出在动」的部分）。`--check` 会断言每张图的两个变体平均绝对差 > 6。
 */
function applyFrameTint(bitmap: Bitmap, frame: number): void {
  if (frame === 0) return;
  const delta = frame * FRAME_TINT;
  const rgba = bitmap.rgba;
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = clamp255(rgba[i] + delta);
    rgba[i + 1] = clamp255(rgba[i + 1] + delta);
    rgba[i + 2] = clamp255(rgba[i + 2] + delta);
  }
}

/**
 * A2 图：`64×160` = 4 列 × 10 行的 16×16 小格。
 *
 * 块列号 = 变体（0..1），块行号 = 形状（0..4）；每个逻辑块 32×32，
 * 内部是 2×2 个 16×16 小格 —— 也就是 `detectLayout` 认出来的 `a2quad` 结构。
 *
 * **变体就是帧**：变体 1 是「相位 / 噪声种子错开的同一地貌」，两帧平均绝对差要显著
 * （水的波纹要能看出在动）。这是内置素材里唯一的动画来源。
 */
export function renderA2Sheet(spec: SampleKindSpec): Bitmap {
  const bitmap = createBitmap(A2_CELL * 4, A2_CELL * 10);
  const neighborKind = spec.neighbor;
  const neighborSpec = SAMPLE_KINDS.find((item) => item.kind === neighborKind);
  // 邻接地貌取变体 0 的相位：它是「别的地貌」，不该跟着本图的帧一起动。
  const neighbor = neighborKind === undefined ? undefined : renderLocalTexture(neighborKind, SAMPLE_CELL, neighborSpec?.seed ?? 7, 0);
  for (let variant = 0; variant < SAMPLE_VARIANTS; variant++) {
    // 变体 1：噪声种子 +17、图案偏移 8px、水再错开 90° 波纹相位 —— 两帧逐像素就不同。
    const phase = spec.kind === "water" ? (variant * Math.PI) / 2 : 0;
    const base = textureFor(spec.kind, SAMPLE_CELL, phase, variant);
    for (let shape = 0; shape < SAMPLE_SHAPES; shape++) {
      const block = renderShapeBlock(base, shape, neighbor);
      applyFrameTint(block, variant);
      blit(bitmap, block, variant * SAMPLE_CELL, shape * SAMPLE_CELL);
    }
  }
  return bitmap;
}

// ---------------------------------------------------------------------------
// 道具网格图
// ---------------------------------------------------------------------------

const P = {
  trunk: [92, 62, 36, 255],
  trunkDark: [64, 42, 26, 255],
  leafDark: [40, 92, 46, 255],
  leaf: [62, 126, 58, 255],
  leafLight: [96, 164, 74, 255],
  petal: [232, 108, 150, 255],
  petalLight: [248, 176, 200, 255],
  center: [250, 208, 96, 255],
  stem: [64, 118, 54, 255],
  stoneDark: [96, 96, 104, 255],
  stone: [132, 132, 140, 255],
  stoneLight: [172, 172, 180, 255],
  wood: [162, 118, 66, 255],
  woodDark: [110, 76, 42, 255],
  woodLight: [198, 156, 96, 255],
  fence: [148, 126, 92, 255],
  fenceDark: [102, 86, 62, 255],
  cap: [196, 62, 54, 255],
  capDark: [150, 40, 36, 255],
  cream: [238, 226, 198, 255]
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** 画一个道具（32×32，透明底）。`name` 用中文名，见 `SAMPLE_PROP_NAMES`。 */
function drawProp(bitmap: Bitmap, name: string): void {
  switch (name) {
    case "树": {
      fillRect(bitmap, 14, 18, 5, 12, P.trunk);
      fillRect(bitmap, 14, 18, 2, 12, P.trunkDark);
      drawDisc(bitmap, 16, 14, 10, P.leafDark);
      drawDisc(bitmap, 15, 12, 8, P.leaf);
      drawDisc(bitmap, 12, 10, 4, P.leafLight);
      break;
    }
    case "花": {
      fillRect(bitmap, 15, 18, 2, 10, P.stem);
      setPixel(bitmap, 18, 22, P.stem);
      setPixel(bitmap, 13, 24, P.stem);
      drawDisc(bitmap, 16, 13, 4, P.petal);
      drawDisc(bitmap, 16, 13, 2, P.petalLight);
      drawDisc(bitmap, 16, 13, 1, P.center);
      break;
    }
    case "石头": {
      drawEllipse(bitmap, 16, 20, 11, 8, P.stoneDark);
      drawEllipse(bitmap, 16, 19, 9, 6, P.stone);
      drawDisc(bitmap, 12, 17, 3, P.stoneLight);
      break;
    }
    case "木箱": {
      fillRect(bitmap, 6, 10, 20, 17, P.wood);
      strokeRect(bitmap, 6, 10, 20, 17, P.woodDark, 1);
      drawLine(bitmap, 7, 11, 24, 26, P.woodDark);
      drawLine(bitmap, 24, 11, 7, 26, P.woodDark);
      fillRect(bitmap, 7, 11, 18, 1, P.woodLight);
      break;
    }
    case "栅栏": {
      fillRect(bitmap, 4, 8, 4, 20, P.fence);
      fillRect(bitmap, 14, 6, 4, 22, P.fence);
      fillRect(bitmap, 24, 8, 4, 20, P.fence);
      fillRect(bitmap, 2, 12, 28, 3, P.fenceDark);
      fillRect(bitmap, 2, 20, 28, 3, P.fenceDark);
      fillRect(bitmap, 4, 8, 1, 20, P.fenceDark);
      fillRect(bitmap, 14, 6, 1, 22, P.fenceDark);
      fillRect(bitmap, 24, 8, 1, 20, P.fenceDark);
      break;
    }
    case "蘑菇": {
      fillRect(bitmap, 14, 18, 4, 10, P.cream);
      drawEllipse(bitmap, 16, 16, 11, 7, P.capDark);
      drawEllipse(bitmap, 16, 15, 9, 6, P.cap);
      drawDisc(bitmap, 12, 13, 2, P.cream);
      drawDisc(bitmap, 20, 15, 2, P.cream);
      drawDisc(bitmap, 16, 18, 1, P.cream);
      break;
    }
    case "断枝": {
      drawLine(bitmap, 5, 24, 26, 12, P.trunkDark, 3);
      drawLine(bitmap, 5, 24, 26, 12, P.trunk, 2);
      drawLine(bitmap, 16, 17, 12, 10, P.trunk, 2);
      drawLine(bitmap, 21, 14, 27, 8, P.trunk, 2);
      drawDisc(bitmap, 27, 8, 2, P.leaf);
      drawDisc(bitmap, 12, 10, 2, P.leaf);
      break;
    }
    case "石头堆": {
      drawEllipse(bitmap, 10, 22, 8, 6, P.stoneDark);
      drawEllipse(bitmap, 10, 21, 6, 4, P.stone);
      drawEllipse(bitmap, 22, 23, 7, 5, P.stoneDark);
      drawEllipse(bitmap, 22, 22, 5, 4, P.stoneLight);
      drawDisc(bitmap, 17, 14, 5, P.stone);
      drawDisc(bitmap, 15, 12, 2, P.stoneLight);
      break;
    }
    default:
      // 认不出的名字不静默画空图：那是自检夹具和实现脱节的信号。
      throw new Error(`未知道具名：${name}`);
  }
  // 底部一圈极浅的接地阴影，让道具不是「浮」在地块上。
  for (let x = 4; x < 28; x++) {
    if (getPixel(bitmap, x, 30)[3] === 0) setPixel(bitmap, x, 30, [0, 0, 0, 60]);
  }
}

/** 道具网格图：`8×5` 个 32px 图块（列 = 道具，行 = 帧）。 */
export function renderPropSheet(): Bitmap {
  const bitmap = createBitmap(SAMPLE_CELL * SAMPLE_PROP_NAMES.length, SAMPLE_CELL * SAMPLE_PROP_ROWS);
  for (let row = 0; row < SAMPLE_PROP_ROWS; row++) {
    for (let col = 0; col < SAMPLE_PROP_NAMES.length; col++) {
      const tile = createBitmap(SAMPLE_CELL, SAMPLE_CELL);
      drawProp(tile, SAMPLE_PROP_NAMES[col]);
      blit(bitmap, tile, col * SAMPLE_CELL, row * SAMPLE_CELL);
    }
  }
  return bitmap;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 生成整套内置示例素材：4 张 A2 图 + 1 张道具网格图。
 *
 * **确定性**：同一个进程里调两次，返回的 `bytes` 逐字节一致
 * （`scripts/make-map-sample-tileset.mjs --check` 会真的断言这一点）。
 */
export function renderSampleTilesets(): SampleTileset[] {
  const out: SampleTileset[] = [];
  for (const spec of SAMPLE_KINDS) {
    const sheet = renderA2Sheet(spec);
    out.push({
      name: spec.name,
      file: spec.file,
      bytes: encodePng(sheet.rgba, sheet.width, sheet.height),
      shape: "a2quad",
      cell: { width: SAMPLE_CELL, height: SAMPLE_CELL },
      animRows: false
    });
  }
  const props = renderPropSheet();
  out.push({
    name: SAMPLE_PROP_NAME,
    file: SAMPLE_PROP_FILE,
    bytes: encodePng(props.rgba, props.width, props.height),
    shape: "plain",
    cell: { width: SAMPLE_CELL, height: SAMPLE_CELL },
    animRows: false
  });
  return out;
}
