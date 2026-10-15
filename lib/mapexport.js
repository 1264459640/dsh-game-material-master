/**
 * 地图编辑器（模块六）的**导出**：`map.png`（合并所有层）+ `map.json` + `manifest.json`，
 * 需要时再加一份 `tilesets/`（素材原图）和一个 `.zip` 包。
 *
 * ## 为什么是这几个文件
 *
 * 旧实现导 PNG（分层 + 合并）+ 自有 JSON + Tiled 的 `.tmj` / `.tsj`（含 wangsets、
 * firstgid、图集 PNG 拷贝）。删掉的理由：
 *
 * - **Tiled 那套没人验证得了**：本机联不上 Tiled 本体，wangsets 的位序只能照文档写，
 *   自检断言的是「我们写出来的字段」，不是「Tiled 读得懂」。等于把风险留在发布里。
 * - **分层 PNG 是重复的**：合并图 + `map.json` 里的每层语义序号已经能还原每一层，
 *   多出来的文件只会各自过期（旧模块就出过「改了地图，分层图还是旧的」）。
 *
 * 素材原图是**用户显式勾选**才拷的（`formats.tilesets`）：勾了以后 `map.json` 里
 * `tilesets[].image`（形如 `tilesets/tsxxxx.png`）**在导出目录里也成立** —— 拷进去的
 * 相对路径与项目里同形，所以整包自包含，拿到别处（别的机器 / 引擎工程）能直接用。
 * 不勾就还是老样子：目录里只有地图本身的产物，图集回项目目录取。
 *
 * `.zip` 是**打包给用户下载**用的（`formats.zip`；不给 = 产物超过一个就自动打）：
 * 界面上的「导出」是一次点击，多个文件分头下载既麻烦又容易被浏览器拦。
 * `manifest.json` 是**我们自己的账本**，不进 zip。
 *
 * ## 三条口径
 *
 * 1. `map.json` 里 `layers[].data` 写的是**语义序号**（1-based 全局图块序号，0 = 空），
 *    不是解析后的贴图 —— 自己格式要能继续改（A2 的形状是渲染时现算的）。
 * 2. `map.png` 走 `maprender.rasterize`，也就是**与界面预览同一份绘制计划**。
 * 3. **每次导出先把这个导出目录清空**：`export/<安全名>/` 整份是我们生成的，
 *    不清的话「上次导了 JSON、这次只导 PNG」会留下一份过期的 `map.json`，
 *    用户打开文件夹看到的东西和界面上列的清单对不上。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeFile } from "./bitmap.js";
import { flatTiles } from "./maptiles.js";
import { bitmapToPng, planBounds, rasterize } from "./maprender.js";
// ⚠️ `mapgen` 反过来也 import 本文件（`runExportStage` 调 `exportMap`）。ESM 的循环
// 引用对「只在函数体里用到的绑定」是安全的（下面只在调用时读 `mapAssetPath`）。
import { mapAssetPath } from "./mapgen.js";
import { zipEntries } from "./zip.js";
export const OWN_JSON_FORMAT = "dsh-gem-map@2";
/** 文件名安全化：名字直接进目录会踩到 `/`、`:` 与超长名。 */
export function safeFileName(input, fallback = "map") {
    const cleaned = (input ?? "")
        .replace(/[^\p{L}\p{N}_-]+/gu, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
    return cleaned === "" ? fallback : cleaned;
}
/**
 * `map.json`。
 *
 * ⚠️ `tilesets[].image` 是**相对导出目录 / 项目目录**的同一条路径（`tilesets/<id>.png`）。
 *
 * - 勾了「素材原图」（`formats.tilesets`）：这个路径在导出目录里成立，整包自包含；
 * - 没勾：导出目录里没有这些图，读 `map.json` 的人得回项目目录取 —— 这条写在这里，
 *   免得把 `image` 当成「相对导出目录」而在别处找不到文件。
 *
 * `project` 按契约留在签名上（旧版写过 `project` 段），`dsh-gem-map@2` 的形态里不带它：
 * 一张地图就是一个项目，再套一层只是重复。
 */
export function buildOwnJson(context, doc, project) {
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
/** 解出导出用的图集位图。解不出来的留给 `rasterize` 报警（不能静默缺图）。 */
async function decodeTilesets(projectId, context) {
    const out = new Map();
    for (const tileset of context.tilesets) {
        const file = mapAssetPath(projectId, tileset.file);
        const bitmap = await decodeFile(file).catch(() => undefined);
        if (bitmap !== undefined)
            out.set(tileset.id, bitmap);
    }
    return out;
}
/** 素材图在 zip / 导出目录里的落点：与项目里同形（`tilesets/<文件名>`），所以 `map.json` 的引用不用改。 */
function tilesetExportPath(file) {
    const name = file.split(/[\\/]/u).pop() ?? "";
    return `tilesets/${name}`;
}
/**
 * 导出：`map.png` + `map.json` + 可选的 `tilesets/**` + 可选的 zip，外加自己的 `manifest.json`。
 *
 * 会抛错的地方只有一处：图超过 `MAX_RENDER_PIXELS`（那是明确的用户错误，不是坏数据）。
 * 其余问题（图集解不出来、地图是空的、缺掩码、某张素材原图读不到）一律进 `warnings`
 * 并继续导出 —— 导出失败时用户至少还能拿到 `map.json` 里的数据。
 */
export async function exportMap(input) {
    const { dir, context, doc } = input;
    const formats = input.formats ?? {};
    const wantPng = formats.png !== false;
    const wantJson = formats.json !== false;
    const wantTilesets = formats.tilesets === true;
    const scale = Math.max(1, Math.round(formats.scale ?? 1));
    const files = [];
    const warnings = [];
    const manifest = { files, warnings, bounds: planBounds(context, doc) };
    // 整份目录是我们生成的：先清空，免得上一轮「导过 JSON」留下的 map.json 混在这一轮里
    // （用户打开文件夹看到的东西必须与界面上那份清单一致）。
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const write = async (path, content, kind) => {
        const file = join(dir, path);
        // ⚠️ 子目录（`tilesets/x.png`）要先建出来：`writeFile` 不会替你建父目录，
        // 少了这一句，拷素材原图那条路会以 ENOENT 静默失败（表现为「勾了却没拷进去」）。
        await mkdir(dirname(file), { recursive: true });
        const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        await writeFile(file, data);
        files.push({ path, bytes: data.length, kind });
    };
    const writeJson = (path, value) => write(path, `${JSON.stringify(value, null, 2)}\n`, "json");
    /** 参与打包的产物（相对导出目录）。`manifest.json` 是我们自己的账本，不进 zip。 */
    const content = [];
    if (wantPng) {
        const lookup = input.lookup ?? (await decodeTilesets(input.project.id, context));
        const raster = rasterize(context, doc, lookup, { scale });
        manifest.bounds = raster.bounds;
        warnings.push(...raster.warnings);
        if (raster.drawn === 0)
            warnings.push("这张地图所有图层都是空的，导出的 PNG 是全透明的。");
        await write("map.png", bitmapToPng(raster.bitmap), "image");
        manifest.mapPng = "map.png";
        content.push("map.png");
    }
    if (wantTilesets) {
        for (const tileset of context.tilesets) {
            if (tileset.file === "")
                continue;
            const relative = tilesetExportPath(tileset.file);
            try {
                await write(relative, await readFile(mapAssetPath(input.project.id, tileset.file)), "image");
                content.push(relative);
            }
            catch (error) {
                warnings.push(`素材「${tileset.name}」的原图没能放进包里（${error instanceof Error ? error.message : String(error)}）。`);
            }
        }
    }
    if (wantJson) {
        await writeJson("map.json", buildOwnJson(context, doc, input.project));
        manifest.mapJson = "map.json";
        content.push("map.json");
    }
    /** 打了包才 download 得动：多选一次点击给一个文件，比让浏览器连下好几个靠谱。 */
    const wantZip = formats.zip === true || (formats.zip !== false && content.length > 1);
    if (wantZip && content.length > 0) {
        const entries = [];
        for (const path of content)
            entries.push({ path, data: await readFile(join(dir, path)) });
        const zipName = `${safeFileName(doc.name, doc.id)}.zip`;
        await write(zipName, zipEntries(entries), "archive");
        manifest.mapZip = zipName;
    }
    // 清单自己也要落盘：验收包（`game_material_review`）与「在文件夹中显示」都读它。
    // 盘上的 files 里补一条 manifest.json（bytes 0 —— 序列化那一刻还不知道自己的大小）；
    // `write` 随后往 `files` 里 push 的是带真实字节数的那条，返回值与旧实现一致地含它。
    await writeJson("manifest.json", { ...manifest, files: [...manifest.files, { path: "manifest.json", bytes: 0, kind: "json" }] });
    return manifest;
}
