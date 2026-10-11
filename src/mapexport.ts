/**
 * 地图编辑器（模块六）的**导出**：`map.png`（合并所有层）+ `map.json` + `manifest.json`。
 *
 * ## 为什么只剩三个文件
 *
 * 旧实现导 PNG（分层 + 合并）+ 自有 JSON + Tiled 的 `.tmj` / `.tsj`（含 wangsets、
 * firstgid、图集 PNG 拷贝）。删掉的理由：
 *
 * - **Tiled 那套没人验证得了**：本机联不上 Tiled 本体，wangsets 的位序只能照文档写，
 *   自检断言的是「我们写出来的字段」，不是「Tiled 读得懂」。等于把风险留在发布里。
 * - **分层 PNG 是重复的**：合并图 + `map.json` 里的每层语义序号已经能还原每一层，
 *   多出来的文件只会各自过期（旧模块就出过「改了地图，分层图还是旧的」）。
 * - **图集拷贝进导出目录**让「导出」变成一个会写出十几 MB 的操作，且拷来的图集
 *   与项目里的原图会分叉。
 *
 * ## 两条口径
 *
 * 1. `map.json` 里 `layers[].data` 写的是**语义序号**（1-based 全局图块序号，0 = 空），
 *    不是解析后的贴图 —— 自己格式要能继续改（A2 的形状是渲染时现算的）。
 * 2. `map.png` 走 `maprender.rasterize`，也就是**与界面预览同一份绘制计划**。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeFile, type Bitmap } from "./bitmap.js";
import { type MapDoc } from "./mapdoc.js";
import { flatTiles } from "./maptiles.js";
import { bitmapToPng, planBounds, rasterize, type PlanBounds, type RenderContext } from "./maprender.js";
// ⚠️ `mapgen` 反过来也 import 本文件（`runExportStage` 调 `exportMap`）。ESM 的循环
// 引用对「只在函数体里用到的绑定」是安全的（下面只在调用时读 `mapAssetPath`）。
import { mapAssetPath } from "./mapgen.js";

export const OWN_JSON_FORMAT = "dsh-gem-map@2";

export interface ExportFormatOptions {
  /** 合并 PNG（默认 true）。 */
  png?: boolean;
  /** `map.json`（默认 true）。 */
  json?: boolean;
  /** 整数缩放（像素画专用，最近邻）。 */
  scale?: number;
}

/** 网关 / 深链接用的选项形状（`mapId` 只为兼容旧参数，单项目单地图后不再使用）。 */
export interface ExportOptions {
  mapId?: string;
  formats?: ExportFormatOptions;
}

export interface ExportedFile {
  /** 相对导出目录的路径。 */
  path: string;
  bytes: number;
  kind: string;
}

export interface ExportManifest {
  files: ExportedFile[];
  warnings: string[];
  bounds: PlanBounds;
  mapPng?: string;
  mapJson?: string;
}

/** 文件名安全化：名字直接进目录会踩到 `/`、`:` 与超长名。 */
export function safeFileName(input: string, fallback = "map"): string {
  const cleaned = (input ?? "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned === "" ? fallback : cleaned;
}

/**
 * `map.json`。
 *
 * ⚠️ `tilesets[].image` 是**相对项目目录**的路径（`tilesets/<id>.png`）：导出目录里
 * 只有三个文件，图集原图不拷贝（见文件头）。要用 `legend` 自己拼图的调用方，得回项目
 * 目录取这些图 —— 这条写在这里，免得读 `map.json` 的人以为它是相对导出目录的。
 *
 * `project` 按契约留在签名上（旧版写过 `project` 段），`dsh-gem-map@2` 的形态里不带它：
 * 一张地图就是一个项目，再套一层只是重复。
 */
export function buildOwnJson(context: RenderContext, doc: MapDoc, project: { id: string; name: string }): object {
  void project;
  return {
    format: OWN_JSON_FORMAT,
    grid: { tileWidth: context.grid.tileWidth, tileHeight: context.grid.tileHeight, wrap: context.grid.wrap },
    cols: doc.cols,
    rows: doc.rows,
    tilesets: context.tilesets.map((tileset) => ({
      id: tileset.id,
      name: tileset.name,
      image: tileset.file,
      cell: { width: tileset.cell.width, height: tileset.cell.height },
      shape: tileset.shape,
      variants: tileset.variants,
      tileCount: tileset.tiles.length
    })),
    legend: flatTiles(context.tilesets).map((flat) => ({ index: flat.index, tilesetId: flat.tilesetId, rect: flat.tile.rect })),
    layers: doc.layers.map((layer) => ({ name: layer.name, data: [...(doc.data[layer.id] ?? [])] }))
  };
}

export interface ExportInput {
  project: { id: string; name: string };
  doc: MapDoc;
  context: RenderContext;
  /** 导出目录（`<项目目录>/export/<安全名>/`）。 */
  dir: string;
  formats?: ExportFormatOptions;
  /** 已经解码好的图集（tilesetId → 位图）。不给就按项目目录自己解一遍。 */
  lookup?: Map<string, Bitmap>;
}

/** 解出导出用的图集位图。解不出来的留给 `rasterize` 报警（不能静默缺图）。 */
async function decodeTilesets(projectId: string, context: RenderContext): Promise<Map<string, Bitmap>> {
  const out = new Map<string, Bitmap>();
  for (const tileset of context.tilesets) {
    const file = mapAssetPath(projectId, tileset.file);
    const bitmap = await decodeFile(file).catch(() => undefined);
    if (bitmap !== undefined) out.set(tileset.id, bitmap);
  }
  return out;
}

/**
 * 导出：`map.png` + `map.json` + `manifest.json`（后两者可关）。
 *
 * 会抛错的地方只有一处：图超过 `MAX_RENDER_PIXELS`（那是明确的用户错误，不是坏数据）。
 * 其余问题（图集解不出来、地图是空的、缺掩码）一律进 `warnings` 并继续导出 ——
 * 导出失败时用户至少还能拿到 `map.json` 里的数据。
 */
export async function exportMap(input: ExportInput): Promise<ExportManifest> {
  const { dir, context, doc } = input;
  const formats = input.formats ?? {};
  const wantPng = formats.png !== false;
  const wantJson = formats.json !== false;
  const scale = Math.max(1, Math.round(formats.scale ?? 1));
  const files: ExportedFile[] = [];
  const warnings: string[] = [];
  const manifest: ExportManifest = { files, warnings, bounds: planBounds(context, doc) };
  await mkdir(dir, { recursive: true });

  const write = async (path: string, content: Buffer | string, kind: string): Promise<void> => {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    await writeFile(join(dir, path), data);
    files.push({ path, bytes: data.length, kind });
  };
  const writeJson = (path: string, value: unknown): Promise<void> => write(path, `${JSON.stringify(value, null, 2)}\n`, "json");

  if (wantPng) {
    const lookup = input.lookup ?? (await decodeTilesets(input.project.id, context));
    const raster = rasterize(context, doc, lookup, { scale });
    manifest.bounds = raster.bounds;
    warnings.push(...raster.warnings);
    if (raster.drawn === 0) warnings.push("这张地图所有图层都是空的，导出的 PNG 是全透明的。");
    await write("map.png", bitmapToPng(raster.bitmap), "image");
    manifest.mapPng = "map.png";
  }

  if (wantJson) {
    await writeJson("map.json", buildOwnJson(context, doc, input.project));
    manifest.mapJson = "map.json";
  }

  // 清单自己也要落盘：验收包（`game_material_review`）与「在文件夹中显示」都读它。
  // 盘上的 files 里补一条 manifest.json（bytes 0 —— 序列化那一刻还不知道自己的大小）；
  // `write` 随后往 `files` 里 push 的是带真实字节数的那条，返回值与旧实现一致地含它。
  await writeJson("manifest.json", { ...manifest, files: [...manifest.files, { path: "manifest.json", bytes: 0, kind: "json" }] });
  return manifest;
}
