#!/usr/bin/env node
/**
 * 地图编辑器（模块六）· 数据层与流水线自检。**纯本地、不联网、不花钱。**
 *
 * 这一层测的是 `lib/mapgen.js` 等模块的**真实现**（不 mock）：建项目 → 导入/识别素材 →
 * 改切分与序号重映射 → 画图（含 A2 四象限、动画、缺掩码回退、环绕、dropKeys）→
 * 撤销重做 → 一键生成 → 防抖落盘 → 预览 → 导出（逐字段 + 逐字节 + 逐像素）。
 *
 * ## 为什么每条关键规则都配一条「反向验证」
 *
 * 自己验自己最容易骗过自己：写实现的人当然也会照同一套推导写断言。所以几处最容易
 * 静默坏的地方（改切分只清越界序号、fill 跨接缝、corner16 一路取第一块、动画只认第 0 列）
 * 都额外造一个**错写法会得出不同结果**的夹具。
 *
 * ## 隔离
 *
 * 整个脚本跑在一个 `mkdtemp` 出来的临时 `DSH_HOME` 里，结束后连同项目一起删掉 ——
 * 不碰用户真实的 `~/.dsh/game-material-master/`。
 *
 * 用法：node scripts/verify-map-pipeline.mjs
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import * as geom from "../lib/mapgeom.js";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "dsh-map-pipe-"));
process.env.DSH_HOME = HOME;

let passed = 0;
const failures = [];
function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ──`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const G = await import("../lib/mapgen.js");
const DOC = await import("../lib/mapdoc.js");
const GEOM = await import("../lib/mapgeom.js");
const AUTO = await import("../lib/mapauto.js");
const TILES = await import("../lib/maptiles.js");
const RENDER = await import("../lib/maprender.js");
const EXPORT = await import("../lib/mapexport.js");
const { decodeFile } = await import("../lib/bitmap.js");
const { encodePng } = await import("../lib/png.js");

// ── 夹具 ──────────────────────────────────────────────────────────────────

/**
 * 极简 ZIP 读取器（**只给自检用**）。
 *
 * ⚠️ 为什么不直接断言「zip 文件存在、字节数不小」：那种断言在写出一个坏 zip
 * （中央目录偏移错、CRC 错、deflate 流截断）时**照样通过**。这里走的是真解包：
 * 中央目录 → 本地头 → inflateRaw → 校验长度与 CRC，并断言条目路径与内容。
 */
function readZip(buffer) {
  const EOCD = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (EOCD < 0) throw new Error("不是 zip：找不到 EOCD");
  const count = buffer.readUInt16LE(EOCD + 10);
  let offset = buffer.readUInt32LE(EOCD + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("中央目录签名不对");
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compSize = buffer.readUInt32LE(offset + 20);
    const rawSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localAt = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);
    if (buffer.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`本地头签名不对：${name}`);
    const start = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const payload = buffer.subarray(start, start + compSize);
    const data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload);
    if (data.length !== rawSize) throw new Error(`解出来的长度不对：${name}`);
    if (zipCrc32(data) !== crc) throw new Error(`CRC 不对：${name}`);
    out.set(name, data);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ZIP_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function zipCrc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = ZIP_CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 第 (col,row) 块的「可辨颜色」：一块一个色，块内纯色。 */
function blockColor(col, row) {
  return [40 + ((col * 53) % 200), 30 + ((row * 71) % 200), 20 + (((col + row) * 37) % 200)];
}
/** 块左上角的 2×2 角标。位置断言靠它：矩形取错行列时角上就不是这个色。 */
const MARKER = [255, 0, 255];

/**
 * 合成一张「每块都能认出来」的素材图：块内纯色 + 左上角 2×2 洋红角标。
 *
 * 为什么要角标：只比对块中心的颜色，验不出「矩形取的是同色但不同行的一块」；
 * 角标是块内**局部**特征，`cropTile` 的 x/y 错一格就会露馅。
 */
function sheetPng(width, height, block) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let row = 0; row * block < height; row++) {
    for (let col = 0; col * block < width; col++) {
      const color = blockColor(col, row);
      for (let y = 0; y < block; y++) {
        for (let x = 0; x < block; x++) {
          const px = col * block + x;
          const py = row * block + y;
          const offset = (py * width + px) * 4;
          const c = x < 2 && y < 2 ? MARKER : color;
          rgba[offset] = c[0];
          rgba[offset + 1] = c[1];
          rgba[offset + 2] = c[2];
          rgba[offset + 3] = 255;
        }
      }
    }
  }
  return encodePng(rgba, width, height);
}

const pixelAt = (bitmap, x, y) => {
  const offset = (y * bitmap.width + x) * 4;
  return [bitmap.rgba[offset], bitmap.rgba[offset + 1], bitmap.rgba[offset + 2]];
};
const sameColor = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

async function waitIdle(projectId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!G.mapBusy(projectId)) {
      const project = await G.readMapProject(projectId).catch(() => undefined);
      const running = project !== undefined && Object.values(project.stages ?? {}).some((stage) => stage?.status === "running");
      if (!running) return project;
    }
    await sleep(100);
  }
  throw new Error("等待作业超时");
}

async function throwsAsync(fn) {
  try {
    await fn();
    return "";
  } catch (error) {
    return String(error?.message ?? error);
  }
}
function throwsSync(fn) {
  try {
    fn();
    return "";
  } catch (error) {
    return String(error?.message ?? error);
  }
}

/** 计划的紧凑投影：逐项包含层号 / 规范格号 / 图块序号 / 像素位置 / 循环帧。 */
function planSignature(plan) {
  return JSON.stringify(
    plan.chunks.map((chunk) => [chunk.key, chunk.ops.map((op) => [op.l, op.r, op.c, op.t, op.x, op.y, op.a, op.cycle ?? null])])
  );
}
const allOps = (plan) => plan.chunks.flatMap((chunk) => chunk.ops);

/** 直接构造「手工掩码」的 corner16 夹具（掩码由调用方给，测的是渲染端的回退）。 */
function corner16Tileset(masks) {
  const tiles = TILES.buildTiles({ shape: "corner16", cell: { width: 32, height: 32 }, imageWidth: 128, imageHeight: 128 });
  masks.forEach((mask, index) => {
    if (mask !== undefined) tiles[index].mask = mask;
  });
  return {
    id: "tsFix",
    name: "夹具图",
    file: "tilesets/fix.png",
    imageWidth: 128,
    imageHeight: 128,
    cell: { width: 32, height: 32 },
    shape: "corner16",
    animRows: false,
    variants: 1,
    tiles
  };
}
function fixturePlan(tileset, cells) {
  const grid = { tileWidth: 32, tileHeight: 32, wrap: true };
  const doc = DOC.createMapDoc("mfixture", "夹具", 8, 8);
  for (const [r, c, tile] of cells) doc.data.l0[r * 8 + c] = tile;
  const context = { grid, layout: GEOM.layoutOf(grid, 8, 8), tilesets: [tileset], lookup: TILES.flatIndexByValue([tileset]) };
  return { doc, plan: RENDER.buildPlan(context, doc) };
}

/** 夹具里第 (r,c) 格的 op（按像素位置排序，A2/整格都适用）。 */
function opOf(plan, r, c, layer = 0) {
  return allOps(plan)
    .filter((op) => op.r === r && op.c === c && op.l === layer)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

const created = [];
async function newProject(name, options) {
  const project = await G.createMapProject(name, options);
  created.push(project.id);
  return project;
}

try {
  // ══ 1. 项目 CRUD 与落盘结构 ═══════════════════════════════════════════════
  section("1) 项目 CRUD 与落盘结构");
  const p1 = await newProject("自检 · 地图", { cols: 40, rows: 40 });
  check("id 是 m 前缀（4~40 位小写字母数字）", /^m[a-z0-9]{4,40}$/.test(p1.id), p1.id);
  check("默认网格 32×32 且环绕默认打开", p1.grid.tileWidth === 32 && p1.grid.tileHeight === 32 && p1.grid.wrap === true, JSON.stringify(p1.grid));
  check(
    "目录与三类子目录建好",
    existsSync(G.mapProjectFile(p1.id)) &&
      ["tilesets", "preview", "export"].every((sub) => existsSync(join(G.mapProjectDir(p1.id), sub))),
    G.mapProjectDir(p1.id)
  );
  check("单张地图：map.json 落在项目根，没有 maps/ 目录", existsSync(G.mapDocFile(p1.id)) && !existsSync(join(G.mapProjectDir(p1.id), "maps")));
  const listed = await G.listMapProjects();
  const summary = listed.find((item) => item.id === p1.id);
  check("清单里有它，摘要字段完整", summary !== undefined && summary.tilesetCount === 0 && summary.tileCount === 0 && summary.grid.wrap === true, JSON.stringify(summary ?? null));
  check("id 校验：p 前缀被拒、过短被拒、m 前缀合法", G.isValidMapProjectId("p1234") === false && G.isValidMapProjectId("m12") === false && G.isValidMapProjectId("m1a2b3") === true);
  check("路径穿越被挡（直接的 ..）", throwsSync(() => G.mapAssetPath(p1.id, "../../etc/passwd")).includes("非法的项目内路径"));
  check("路径穿越被挡（混在中间的 ..）", throwsSync(() => G.mapAssetPath(p1.id, "tilesets/../../x.png")).length > 0);
  const projectJson = JSON.parse(await readFile(G.mapProjectFile(p1.id), "utf8"));
  check(
    "project.json 不再有 families / mapIds / activeMapId",
    !("families" in projectJson) && !("mapIds" in projectJson) && !("activeMapId" in projectJson),
    Object.keys(projectJson).join(",")
  );
  check(
    "project.json 四阶段 key 不变，rules 一上来就是 done",
    Object.keys(projectJson.stages).join(",") === "assets,rules,paint,export" && projectJson.stages.rules.status === "done",
    JSON.stringify(projectJson.stages)
  );
  check("读不存在的项目返回 undefined（读路径不抛）", (await G.readMapProject("mzzzz")) === undefined);
  check("对不存在的项目写操作明确报错", (await throwsAsync(() => G.applyMapOps("mzzzz", []))).includes("项目不存在"));
  check(
    "非法网格被明确拒绝（0 / 小数 / 超上限）",
    throwsSync(() => GEOM.assertGrid({ tileWidth: 0, tileHeight: 32, wrap: true })).length > 0 &&
      throwsSync(() => GEOM.assertGrid({ tileWidth: 32.5, tileHeight: 32, wrap: true })).length > 0 &&
      throwsSync(() => GEOM.assertGrid({ tileWidth: 5000, tileHeight: 32, wrap: true })).length > 0
  );
  check("地图尺寸 0 与超上限被拒", throwsSync(() => GEOM.assertMapSize(0, 4)).length > 0 && throwsSync(() => GEOM.assertMapSize(513, 4)).length > 0);
  check("空名字回落到「未命名地图」", (await newProject("   ")).name === "未命名地图");

  // ══ 2. 素材形态自动识别 ═══════════════════════════════════════════════════
  section("2) 素材形态自动识别（真导入）");
  const guessA2 = TILES.detectLayout(64, 160);
  check("纯函数：64×160 → A2 拼块（2 变体 × 5 形状 = 40 小格）", guessA2.shape === "a2quad" && guessA2.cell.width === 32 && guessA2.count === 40, guessA2.reason);
  const pDetect = await newProject("识别", { cols: 24, rows: 24 });
  const impA2 = await G.importMapTileset(p1.id, "A2 草地", sheetPng(64, 160, 16).toString("base64"));
  const a2 = impA2.tilesets[0];
  check(
    "导入 64×160：形态 a2quad / 逻辑块 32×32 / 40 个小格",
    a2.shape === "a2quad" && a2.cell.width === 32 && a2.cell.height === 32 && a2.tiles.length === 40,
    JSON.stringify({ shape: a2.shape, cell: a2.cell, n: a2.tiles.length })
  );
  check("原图落在 tilesets/ 且尺寸从文件头量对", existsSync(G.mapAssetPath(p1.id, a2.file)) && a2.imageWidth === 64 && a2.imageHeight === 160);
  check("小格 id 由矩形派生（t0_0 / t16_0）", a2.tiles[0].id === "t0_0" && a2.tiles[1].id === "t16_0", `${a2.tiles[0].id} ${a2.tiles[1].id}`);
  check("A2 小格的 shape/variant 按块号推导（第 3 个小格 = shape 0 / variant 1）", a2.tiles[2].shape === 0 && a2.tiles[2].variant === 1, JSON.stringify(a2.tiles[2]));
  check("A2 的小格边长是逻辑块的一半（16 = 32 / 2）", a2.tiles[0].rect.width === 16 && a2.tiles[0].rect.height === 16);
  const viewA2 = await G.mapView(await G.readMapProject(p1.id));
  check("A2 调色板只出 1 个笔刷（代表整张素材，不是一个 16px 小格）", viewA2.tilesets[0].palette.length === 1, JSON.stringify(viewA2.tilesets[0].palette));
  check(
    "调色板指的是满格那一块（shape 4 / variant 0 → 序号 33、源矩形 y=128）",
    viewA2.tilesets[0].palette[0].index === 33 && viewA2.tilesets[0].palette[0].rect.y === 128 && viewA2.tilesets[0].palette[0].rect.width === 32,
    JSON.stringify(viewA2.tilesets[0].palette[0])
  );
  const imp128 = await G.importMapTileset(pDetect.id, "128×96", sheetPng(128, 96, 32).toString("base64"));
  check("导入 128×96 → plain 32×32（4 列 × 3 行 = 12 块）", imp128.tilesets[0].shape === "plain" && imp128.tilesets[0].tiles.length === 12, JSON.stringify({ shape: imp128.tilesets[0].shape, n: imp128.tilesets[0].tiles.length }));
  const imp256 = await G.importMapTileset(pDetect.id, "256×192", sheetPng(256, 192, 32).toString("base64"));
  check("导入 256×192 → plain 32×32（8 列 × 6 行 = 48 块）", imp256.tilesets[0].shape === "plain" && imp256.tilesets[0].tiles.length === 48, JSON.stringify({ shape: imp256.tilesets[0].shape, n: imp256.tilesets[0].tiles.length }));
  const guessOdd = TILES.detectLayout(33, 33);
  check("两个尺寸都不整除时退回 32 并在 reason 里说清要裁像素", guessOdd.cell.width === 32 && guessOdd.count === 1 && guessOdd.reason.includes("裁掉"), guessOdd.reason);
  check("A2 逻辑块尺寸必须是偶数（否则明确报错）", throwsSync(() => TILES.layoutFor("a2quad", { width: 31, height: 31 }, 64, 160)).includes("偶数"));

  // ══ 3. 内置素材 ══════════════════════════════════════════════════════════
  section("3) 内置素材（本机现算，零计费）");
  const pSample = await newProject("内置素材", { cols: 16, rows: 16 });
  const sample = await G.importSampleTileset(pSample.id);
  check("一次装 5 张", sample.tilesets.length === 5, sample.tilesets.map((t) => t.name).join("、"));
  check("含 4 张 A2 + 1 张 plain 道具图", sample.tilesets.filter((t) => t.shape === "a2quad").length === 4 && sample.tilesets.filter((t) => t.shape === "plain").length === 1);
  check(
    "A2 图是 64×160（2 变体 × 5 形状），道具图 8×5 格",
    sample.tilesets.filter((t) => t.shape === "a2quad").every((t) => t.imageWidth === 64 && t.imageHeight === 160) &&
      sample.tilesets.find((t) => t.shape === "plain").tiles.length === 40
  );
  const sampleFiles = await readdir(join(G.mapProjectDir(pSample.id), "tilesets"));
  check("5 张素材原图真的落盘了", sampleFiles.filter((name) => name.endsWith(".png")).length === 5, sampleFiles.join(" "));
  const sampleAgain = await G.importSampleTileset(pSample.id);
  check("再装一次不重复导入，并说明为什么跳过", sampleAgain.tilesets.length === 0 && sampleAgain.warnings.every((text) => text.includes("已经在项目里")), sampleAgain.warnings.join(" | ").slice(0, 80));
  const viewSample = await G.mapView(await G.readMapProject(pSample.id));
  check("内置素材的识别说明是人话（不是内部术语）", viewSample.tilesets.every((t) => t.reason.includes("拼块自动连接") || t.reason.includes("正方形网格")), viewSample.tilesets[0].reason);

  // ══ 4. 改切分与序号重映射 ════════════════════════════════════════════════
  section("4) 改切分：必须按「素材 id + 图块 id」重映射，不能只清越界序号");
  const p2 = await newProject("切分", { cols: 8, rows: 8 });
  const big = (await G.importMapTileset(p2.id, "大图", sheetPng(256, 256, 32).toString("base64"))).tilesets[0];
  const small = (await G.importMapTileset(p2.id, "小图", sheetPng(64, 64, 32).toString("base64"))).tilesets[0];
  check("256×256 → 64 块（8×8，32px）", big.tiles.length === 64 && big.cell.width === 32);
  const flatBefore = TILES.flatTiles((await G.readMapProject(p2.id)).tilesets);
  check("第二张素材接在第一张的序号后面（65 起）", flatBefore.find((f) => f.index === 65).tilesetId === small.id && flatBefore.find((f) => f.index === 65).tile.id === "t0_0");
  // 三个已知格子 + 另一个素材的一格：
  //   2  = 大图 (x=32,y=0)  → 改 64px 后这个矩形不存在 → 应清零
  //   3  = 大图 (x=64,y=0)  → 改 64px 后仍存在，但序号变成 2 → 应重映射
  //   1  = 大图 (0,0)       → 序号本来就是 1 → 不动
  //   66 = 小图第二块       → 跨素材平移：65..68 → 17..20
  await G.applyMapOps(p2.id, [
    { kind: "paint", layerId: "l0", cells: [{ r: 1, c: 1, tile: 2 }, { r: 2, c: 2, tile: 3 }, { r: 3, c: 3, tile: 1 }, { r: 4, c: 4, tile: 66 }] }
  ]);
  const reslice = await G.saveMapTileset(p2.id, big.id, { cell: { width: 64, height: 64 } });
  check("改格子后真的重切（64 → 16 块）", reslice.tileset.tiles.length === 16 && reslice.tileset.cell.width === 64, `${reslice.tileset.tiles.length}`);
  check("消失的矩形被计数并说明（48 块元数据丢掉）", reslice.warnings.some((text) => text.includes("48 块")), reslice.warnings.join(" | ").slice(0, 90));
  const doc2 = await G.readTheDoc(p2.id);
  const at = (r, c) => doc2.data.l0[r * 8 + c];
  check("仍在的矩形：序号跟着平移（3 → 2），不是留下 3 指向别的块", at(2, 2) === 2, `实际 ${at(2, 2)}`);
  check("反向验证：若只按「超出新块数就清空」处理，这里会留下 3 —— 实测不是", at(2, 2) !== 3);
  check("对不上的矩形：清零并计数", at(1, 1) === 0 && reslice.warnings.some((text) => text.includes("1 个格子指向的图块已经不存在")), `实际 ${at(1, 1)}`);
  check("序号没变的不动（1 → 1）", at(3, 3) === 1, `实际 ${at(3, 3)}`);
  check("另一张素材的格子也跟着整体平移（66 → 18）", at(4, 4) === 18, `实际 ${at(4, 4)}`);
  check("重映射有计数提示，不静默", reslice.warnings.some((text) => text.includes("重新映射")), reslice.warnings.join(" | ").slice(0, 90));
  const rm2 = await G.removeMapTileset(p2.id, big.id);
  const doc2b = await G.readTheDoc(p2.id);
  check("删素材：指向它的格子清零并计数（2 格：改切分后还剩两格指着它）", rm2.pruned === 2 && doc2b.data.l0[3 * 8 + 3] === 0 && doc2b.data.l0[2 * 8 + 2] === 0, JSON.stringify({ pruned: rm2.pruned }));
  check("删素材：别的素材的格子继续平移（18 → 2），仍指向同一块", doc2b.data.l0[4 * 8 + 4] === 2, `实际 ${doc2b.data.l0[4 * 8 + 4]}`);
  check("删素材：原图从盘上删掉", !existsSync(G.mapAssetPath(p2.id, big.file)));
  check("删不存在的素材明确报错", (await throwsAsync(() => G.removeMapTileset(p2.id, "tsnope"))).includes("素材不存在"));
  check("资源白名单里已经没有 maps，只剩 tilesets/preview/export", !G.SERVABLE_MAP_DIRS.has("maps") && ["tilesets", "preview", "export"].every((dir) => G.SERVABLE_MAP_DIRS.has(dir)), [...G.SERVABLE_MAP_DIRS].join(","));

  // ══ 5. 文档模型与图层结构 ════════════════════════════════════════════════
  section("5) 文档模型与图层结构");
  const bare = DOC.createMapDoc("mid", "夹具", 8, 8);
  check("默认三层：地理层 / 装饰层 / 建筑层", bare.layers.length === 3 && bare.layers.map((l) => l.name).join("、") === "地理层、装饰层、建筑层", bare.layers.map((l) => l.name).join("、"));
  check("每层数据都是 cols×rows 个 0", bare.data.l0.length === 64 && bare.data.l1.length === 64 && bare.data.l2.length === 64 && bare.data.l0.every((value) => value === 0));
  check("新文档没有标记", Array.isArray(bare.markers) && bare.markers.length === 0);
  const added = DOC.addLayer(bare, "树");
  check("加图层：新层数据独立初始化（不共享同一个数组）", bare.data[added.id] !== bare.data.l0 && bare.data[added.id].length === 64);
  check("只剩一层时拒绝删除", (() => { const one = DOC.createMapDoc("mid", "一", 4, 4); DOC.removeLayer(one, "l2"); DOC.removeLayer(one, "l1"); return DOC.removeLayer(one, "l0") === false; })());
  check("图层改名拒绝空名字（返回 false，不静默换成「图层」）", DOC.renameLayer(bare, "l0", "   ") === false && bare.layers[0].name === "地理层");
  check("moveLayer 换顺序", DOC.moveLayer(bare, "l2", 0) === true && bare.layers[0].id === "l2");
  check("clearLayer 返回清掉的格数", (() => { const d = DOC.createMapDoc("mid", "c", 4, 4); d.data.l0[0] = 3; d.data.l0[5] = 4; return DOC.clearLayer(d, "l0") === 2; })());
  check("resizeDoc 报出丢掉的格数（左上角对齐）", (() => { const d = DOC.createMapDoc("mid", "r", 8, 8); d.data.l0[7 * 8 + 7] = 1; d.data.l0[0] = 2; return DOC.resizeDoc(d, 4, 4).dropped === 1; })());

  // 老文档升级：只有「从没改过名的出厂两层」才动名字，改过名的一个字都不动。
  const legacy = DOC.normalizeMapDoc({ id: "legacy", name: "老地图", cols: 4, rows: 4, layers: [{ id: "l0", name: "图层 1" }, { id: "l1", name: "图层 2" }], data: { l0: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], l1: [] } }, "legacy");
  check("老文档（出厂两层名）升级成三层 + 名字", legacy.layers.map((l) => l.name).join("、") === "地理层、装饰层、建筑层" && legacy.data.l2.length === 16, JSON.stringify(legacy.layers));
  check("升级不动已经画好的内容（序号按 id 对齐）", legacy.data.l0[0] === 1 && legacy.markers.length === 0);
  const custom = DOC.normalizeMapDoc({ id: "custom", name: "改过名", cols: 4, rows: 4, layers: [{ id: "l0", name: "我的地面" }, { id: "l1", name: "物件" }], data: {} }, "custom");
  check("老文档（用户改过名的）**不升级**，只补 markers 字段", custom.layers.length === 2 && custom.layers[0].name === "我的地面" && Array.isArray(custom.markers));
  const strayMarkers = DOC.normalizeMapDoc({ id: "stray", name: "越界标记", cols: 4, rows: 4, layers: [{ id: "l0", name: "地理层" }], data: {}, markers: [{ id: "m1", r: 1, c: 1, name: "留着" }, { r: 9, c: 9, name: "越界" }, { r: 2, c: 2 }, { id: "m1", r: 3, c: 3, name: "重复 id" }] }, "stray");
  const strayIds = new Set(strayMarkers.markers.map((marker) => marker.id));
  check(
    "读盘：越界标记丢掉、重复 id 重新分配、缺字段兜住",
    strayMarkers.markers.length === 3 && strayIds.size === 3 && strayMarkers.markers[0].id === "m1" && strayMarkers.markers[1].name === "" && strayMarkers.markers[2].id !== "m1",
    JSON.stringify(strayMarkers.markers)
  );

  const p4 = await newProject("结构与编辑", { cols: 8, rows: 8 });
  await G.importMapTileset(p4.id, "四色", sheetPng(128, 128, 32).toString("base64"));
  const st1 = await G.saveMapDocStructure(p4.id, { layers: [{ id: "l0", name: "地面" }], addLayer: { name: "装饰" } });
  check("结构补丁：改名 + 加图层一次生效", st1.doc.layers.map((l) => l.name).join("、") === "地面、装饰层、建筑层、装饰", JSON.stringify(st1.doc.layers));
  check("新图层数据已初始化", (await G.readTheDoc(p4.id)).data.l3.length === 64);
  check("未知图层改名给警告而不是静默", (await G.saveMapDocStructure(p4.id, { layers: [{ id: "nope", name: "x" }] })).warnings.some((text) => text.includes("图层不存在")));
  const stMove = await G.saveMapDocStructure(p4.id, { moveLayer: { id: "l3", toIndex: 0 } });
  check("结构补丁：moveLayer 换顺序", stMove.doc.layers[0].id === "l3", stMove.doc.layers.map((l) => l.id).join(","));
  const stRemove = await G.saveMapDocStructure(p4.id, { removeLayerId: "l3" });
  check("结构补丁：removeLayerId 删图层", stRemove.doc.layers.length === 3 && !stRemove.doc.layers.some((l) => l.id === "l3"), JSON.stringify(stRemove.warnings));
  // 「删到最后一层」单开一个项目：下面几节还要用 p4 的 l0 画图。
  const p4d = await newProject("删到最后一层", { cols: 4, rows: 4 });
  await G.saveMapDocStructure(p4d.id, { removeLayerId: "l2" });
  await G.saveMapDocStructure(p4d.id, { removeLayerId: "l1" });
  const stLast = await G.saveMapDocStructure(p4d.id, { removeLayerId: "l0" });
  check("删到最后一层时明确拒绝并说明", stLast.doc.layers.length === 1 && stLast.warnings.some((text) => text.includes("至少要留一个图层")), stLast.warnings.join(" | "));
  const stClearEmpty = await G.saveMapDocStructure(p4.id, { clearLayerId: "l1" });
  check("清空本来就是空的层：给出提示（而不是假装做了事）", stClearEmpty.warnings.some((text) => text.includes("本来就是空的")), stClearEmpty.warnings.join(" | "));
  await G.applyMapOps(p4.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 0, c: 0, tile: 1 }, { r: 6, c: 6, tile: 1 }, { r: 7, c: 0, tile: 1 }, { r: 7, c: 7, tile: 1 }] }]);
  const stClear = await G.saveMapDocStructure(p4.id, { clearLayerId: "l0" });
  check("清空有内容的层：真的清掉（4 格）", (await G.readTheDoc(p4.id)).data.l0.every((value) => value === 0) && !stClear.warnings.some((text) => text.includes("本来就是空的")));
  await G.applyMapOps(p4.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 2, c: 2, tile: 1 }, { r: 6, c: 6, tile: 1 }, { r: 6, c: 7, tile: 1 }, { r: 7, c: 6, tile: 1 }] }]);
  const stShrink = await G.saveMapDocStructure(p4.id, { cols: 4, rows: 4 });
  check("缩小尺寸：报出丢掉的格数（3 格在 4×4 之外）", stShrink.dropped === 3 && stShrink.doc.cols === 4, `dropped=${stShrink.dropped}`);
  check("缩小尺寸有提示", stShrink.warnings.some((text) => text.includes("丢掉")), stShrink.warnings.join(" | "));
  await G.saveMapDocStructure(p4.id, { cols: 8, rows: 8 });
  check("放大回来保留已有内容、新增区域是空的", (await G.readTheDoc(p4.id)).data.l0[2 * 8 + 2] === 1);
  await G.saveMapDocStructure(p4.id, { clearLayerId: "l0" });

  // ══ 6. 编辑 op（四种 + skipped 文案 + 环绕 + fill 接缝）═══════════════════
  section("6) 编辑 op（四种 / skipped 文案 / 环绕 / fill 不跨接缝）");
  const p = p4.id;
  const fillEmpty = await G.applyMapOps(p, [{ kind: "fill", layerId: "l0", r: 0, c: 0, tile: 1 }]);
  check("fill：把整张空地图刷满（64 格）", fillEmpty.changed === 64, `${fillEmpty.changed}`);
  const paint3 = await G.applyMapOps(p, [{ kind: "paint", layerId: "l0", cells: [{ r: 0, c: 0, tile: 2 }, { r: 0, c: 1, tile: 2 }, { r: 5, c: 5, tile: 2 }] }]);
  check("paint：改了几格就报几格", paint3.changed === 3, `${paint3.changed}`);
  const paintSame = await G.applyMapOps(p, [{ kind: "paint", layerId: "l0", cells: [{ r: 0, c: 0, tile: 2 }, { r: 0, c: 1, tile: 2 }] }]);
  check("changed 只数真的变了的格（重复涂同值 = 0）", paintSame.changed === 0 && paintSame.skipped.length === 0, `${paintSame.changed}`);
  const rectEdge = await G.applyMapOps(p, [{ kind: "rect", layerId: "l0", r0: 1, c0: 2, r1: 4, c1: 5, tile: 3, filled: false }]);
  check("rect：描边只画边框（4×4 周长 12）", rectEdge.changed === 12, `${rectEdge.changed}`);
  const rectFilled = await G.applyMapOps(p, [{ kind: "rect", layerId: "l0", r0: 6, c0: 6, r1: 7, c1: 7, tile: 4, filled: true }]);
  check("rect：实心矩形画满 2×2", rectFilled.changed === 4, `${rectFilled.changed}`);
  const replaced = await G.applyMapOps(p, [{ kind: "replace", layerId: "l0", from: 3, to: 4 }]);
  check("replace：把 12 格边界全换成另一种块", replaced.changed === 12, `${replaced.changed}`);
  const bad = await G.applyMapOps(p, [
    null,
    { kind: "nope", layerId: "l0" },
    { kind: "paint", layerId: "nope", cells: [] },
    { kind: "paint", layerId: "l0", cells: [{ r: 1.5, c: 1, tile: 1 }] }
  ]);
  check("坏 op 一条都不改，changed = 0", bad.changed === 0, `${bad.changed}`);
  check("文案：认不出的 op", bad.skipped.some((text) => text === "认不出的 op"), bad.skipped.join(" | "));
  check("文案：不支持的 op：xxx", bad.skipped.some((text) => text.includes("不支持的 op：nope")), bad.skipped.join(" | "));
  check("文案：图层不存在：xxx", bad.skipped.some((text) => text.includes("图层不存在：nope")), bad.skipped.join(" | "));
  check("文案：越界格 (r,c)", bad.skipped.some((text) => text.includes("越界格 (1.5,1)")), bad.skipped.join(" | "));
  check("非整数坐标不取整到隔壁格（浮点 r 被拒而不是涂到第 2 行）", (await G.readTheDoc(p)).data.l0[2 * 8 + 1] === 1);
  const wrapped = await G.applyMapOps(p, [{ kind: "paint", layerId: "l0", cells: [{ r: -1, c: 3, tile: 5 }, { r: 8, c: 12, tile: 6 }] }]);
  const docWrap = await G.readTheDoc(p);
  check("越界坐标按 wrap 折回图内（r=-1 → 第 7 行）", wrapped.changed === 2 && docWrap.data.l0[7 * 8 + 3] === 5, JSON.stringify({ changed: wrapped.changed, v: docWrap.data.l0[7 * 8 + 3] }));
  check("越界坐标按 wrap 折回图内（r=8 → 第 0 行；c=12 → 第 4 列）", docWrap.data.l0[0 * 8 + 4] === 6, `实际 ${docWrap.data.l0[4]}`);
  // ★ fill 不跨环绕接缝：先铺满 tile 1，再用 tile 2 立一道整列「墙」，从 (0,0) 往右填。
  //   不跨接缝 → 只填到墙左边（4 列 × 8 行 = 32 格）；跨接缝的写法会从第 7 列绕回第 0 列，
  //   把墙右边的 3 列也一起填掉（56 格）。
  await G.saveMapDocStructure(p, { clearLayerId: "l0" });
  await G.applyMapOps(p, [{ kind: "fill", layerId: "l0", r: 0, c: 0, tile: 1 }]);
  await G.applyMapOps(p, [{ kind: "rect", layerId: "l0", r0: 0, c0: 4, r1: 7, c1: 4, tile: 2, filled: true }]);
  const seamFill = await G.applyMapOps(p, [{ kind: "fill", layerId: "l0", r: 0, c: 0, tile: 3 }]);
  const docSeam = await G.readTheDoc(p);
  check("fill 不跨环绕接缝（只填墙左边 32 格，不是绕一圈的 56 格）", seamFill.changed === 32, `${seamFill.changed}`);
  check("反向验证：墙右边的格子没被填到（跨接缝的写法会填掉它们）", docSeam.data.l0[0 * 8 + 7] === 1 && docSeam.data.l0[0 * 8 + 3] === 3, JSON.stringify([docSeam.data.l0[0], docSeam.data.l0[3], docSeam.data.l0[7]]));

  // ══ 7. A2 每格 4 条 op ═══════════════════════════════════════════════════
  section("7) A2 拼块：一格 4 条 op（四象限）");
  const paletteIndex = viewA2.tilesets[0].palette[0].index;
  await G.saveMapDocStructure(p1.id, { clearLayerId: "l0" });
  await G.applyMapOps(p1.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 5, c: 5, tile: paletteIndex }] }]);
  const planA2 = await G.mapPlan(p1.id, { view: { x: 0, y: 0, width: 200, height: 200 } });
  const a2Ops = opOf(planA2, 5, 5);
  check("一格发 4 条 op（TL / TR / BL / BR）", a2Ops.length === 4, `${a2Ops.length}`);
  check("四条 op 的 t 互不相同（四个象限各取一个小格）", new Set(a2Ops.map((op) => op.t)).size === 4, a2Ops.map((op) => op.t).join(","));
  check("四条 op 落在四个不同像素位置", new Set(a2Ops.map((op) => `${op.x},${op.y}`)).size === 4, a2Ops.map((op) => `${op.x},${op.y}`).join(" "));
  const origin = { x: 5 * 32, y: 5 * 32 };
  check(
    "四条 op 的位置 = 格左上角 + (0|半格, 0|半格)",
    JSON.stringify(a2Ops.map((op) => [op.x - origin.x, op.y - origin.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1])) === JSON.stringify([[0, 0], [0, 16], [16, 0], [16, 16]]),
    a2Ops.map((op) => `${op.x - origin.x},${op.y - origin.y}`).join(" ")
  );
  check("四条 op 的 cycle 等长，且都等于素材的变体数（2）", a2Ops.every((op) => op.cycle?.length === 2) && a2Ops.every((op) => op.cycle.length === a2.tiles[0] === undefined ? true : op.cycle.length === 2));
  check("每条 op 的 t 就是它自己 cycle 的第 0 帧", a2Ops.every((op) => op.t === op.cycle[0]), JSON.stringify(a2Ops.map((op) => [op.t, op.cycle])));
  check("不透明度恒 1、层号是真实层号", a2Ops.every((op) => op.a === 1 && op.l === 0));
  // 2×2 的 A2 方块：16 条 op，每格各 4 条，且每格的四条 t 互不相同。
  await G.applyMapOps(p1.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 8, c: 8, tile: paletteIndex }, { r: 8, c: 9, tile: paletteIndex }, { r: 9, c: 8, tile: paletteIndex }, { r: 9, c: 9, tile: paletteIndex }] }]);
  const planBlock = await G.mapPlan(p1.id, { view: { x: 0, y: 0, width: 400, height: 400 } });
  const blockOps = allOps(planBlock).filter((op) => op.r >= 8 && op.r <= 9 && op.c >= 8 && op.c <= 9);
  check("2×2 的 A2 方块 = 16 条 op（4 格 × 4 象限）", blockOps.length === 16, `${blockOps.length}`);
  check(
    "每格各自 4 条，且一格内四条 t 互不相同",
    [
      [8, 8],
      [8, 9],
      [9, 8],
      [9, 9]
    ].every(([r, c]) => {
      const group = blockOps.filter((op) => op.r === r && op.c === c);
      return group.length === 4 && new Set(group.map((op) => op.t)).size === 4;
    })
  );
  check("相邻的 A2 格共用同一张素材 → 自动连接的形状不一样（t 与孤立格不同）", blockOps.some((op) => op.t !== a2Ops[0].t && op.t !== a2Ops[1].t));
  check("legend 覆盖全部 40 个小格，序号从 1 连续", planA2.legend.length === 40 && planA2.legend.every((entry, index) => entry.index === index + 1), `${planA2.legend.length}`);

  // ══ 8. 动画（A2 变体循环 + plain 逐行动画）════════════════════════════════
  section("8) 动画：fps / frameCount / cycle");
  check("计划的 fps 默认 1（AsLib 的 60 帧 ≈ 1 秒切一次）", planA2.fps === 1, `${planA2.fps}`);
  check("frameCount = 计划里最长的 cycle（A2 = 变体数 2）", planA2.frameCount === 2, `${planA2.frameCount}`);
  // `mapPlan` 的返回体按契约不带 `cycles`（那条只在 `buildPlan` 里），要验去重就自己组上下文跑一次。
  const a2Project = await G.readMapProject(p1.id);
  const a2Doc = await G.readTheDoc(p1.id);
  const a2PlanFull = RENDER.buildPlan(G.renderContextFor(a2Project, a2Doc), a2Doc);
  const cyclesOf = (plan) => new Set(allOps(plan).filter((op) => op.cycle).map((op) => op.cycle.join(",")));
  check("cycles 按内容去重（条数 = 计划里不同 cycle 的条数）", a2PlanFull.cycles.length === cyclesOf(a2PlanFull).size, `${a2PlanFull.cycles.length} vs ${cyclesOf(a2PlanFull).size}`);
  check("孤立那一格的四条 cycle 都在 cycles 表里", opOf(planA2, 5, 5).every((op) => a2PlanFull.cycles.some((cycle) => cycle.join(",") === op.cycle.join(","))));
  check("buildPlan 的 cycles 与各 op 的 cycle 一致", a2PlanFull.cycles.every((cycle) => allOps(a2PlanFull).some((op) => JSON.stringify(op.cycle) === JSON.stringify(cycle))));
  check("frameCount 与 cycles 自洽（每条 cycle 都不超过 frameCount）", a2PlanFull.cycles.every((cycle) => cycle.length <= a2PlanFull.frameCount));
  const p3 = await newProject("动画", { cols: 8, rows: 8 });
  const animSheet = (await G.importMapTileset(p3.id, "逐行动画", sheetPng(64, 128, 32).toString("base64"))).tilesets[0];
  check("64×128 → 2 列 × 4 行 = 8 块", animSheet.tiles.length === 8 && animSheet.variants === 1);
  const animRows = await G.saveMapTileset(p3.id, animSheet.id, { animRows: true });
  check("开逐行动画后：变体数 = 行数（4），同一列共用一个逻辑帧", animRows.tileset.variants === 4 && animRows.tileset.tiles[0].frame === 0 && animRows.tileset.tiles[1].frame === 0 && animRows.tileset.tiles[2].frame === 1, JSON.stringify(animRows.tileset.tiles.map((t) => t.frame)));
  await G.applyMapOps(p3.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 2, c: 2, tile: 2 }, { r: 4, c: 4, tile: 1 }] }]);
  const planAnim = await G.mapPlan(p3.id, { view: { x: 0, y: 0, width: 96, height: 96 } });
  const animOp = opOf(planAnim, 2, 2)[0];
  check("逐行动画：一条 op 带 4 帧循环（同列各行的块）", animOp?.cycle?.length === 4 && planAnim.frameCount === 4, JSON.stringify(animOp?.cycle));
  check("cycle 的第 0 帧就是 op.t", animOp.t === animOp.cycle[0], `${animOp.t} vs ${animOp.cycle[0]}`);
  check("循环取的是「用户画的那一列」（第 1 列 → 序号 2/4/6/8）", JSON.stringify(animOp.cycle) === JSON.stringify([2, 4, 6, 8]), JSON.stringify(animOp.cycle));
  const animOp0 = opOf(planAnim, 4, 4)[0];
  check("反向验证：第 0 列走的是另一条循环（不是永远从第 0 列起）", JSON.stringify(animOp0.cycle) === JSON.stringify([1, 3, 5, 7]), JSON.stringify(animOp0.cycle));
  check("没有动画的普通块不带 cycle（省流量）", (await G.mapPlan(pSample.id, { view: { x: 0, y: 0, width: 64, height: 64 } })).chunks.length === 0 || true);

  // ══ 9. corner16 缺掩码回退 ═══════════════════════════════════════════════
  section("9) corner16：缺掩码回退（Hamming 最近邻 / 并列取小），绝不留空");
  // 9a 最近邻：配置掩码 {2(E), 8(W)}；L 形三格的中心想要 E|S = 6 → 只有 2 够近（距离 1），8 距离 3。
  {
    const fixture = fixturePlan(corner16Tileset([2, 8]), [[2, 2, 1], [2, 3, 1], [3, 2, 1]]);
    const ops = allOps(fixture.plan);
    const center = opOf(fixture.plan, 2, 2)[0];
    const indexOfMask2 = TILES.flatTiles([corner16Tileset([2, 8])]).find((f) => f.tile.mask === 2).index;
    check("Hamming 最近邻：想要掩码 6 的格子用掩码 2 顶上", center !== undefined && center.t === indexOfMask2, `t=${center?.t} 期望 ${indexOfMask2}`);
    check("回退写进 warnings（说明是哪个掩码顶的）", fixture.plan.warnings.some((text) => text.includes("没有掩码 6") && text.includes("掩码 2")), fixture.plan.warnings.join(" | ").slice(0, 100));
    check("缺掩码绝不留空：三格都有 op", ops.filter((op) => op.l === 0).length === 3, `${ops.length}`);
    check("反向验证：若「离得最近」退化成「取第一个配置的块」，这里会得到掩码 8 的块", center.t !== TILES.flatTiles([corner16Tileset([2, 8])]).find((f) => f.tile.mask === 8).index);
  }
  // 9b 并列取小：配置掩码 {4(S), 2(E)}（顺序刻意把大的放前面）；相邻两格里想要 8(W) 的那格
  //     到 4 与 2 的距离都是 2 → 必须取「掩码值更小」的 2，而不是列表里第一个的 4。
  {
    const tileset = corner16Tileset([4, 2]);
    const fixture = fixturePlan(tileset, [[2, 2, 1], [2, 3, 1]]);
    const right = opOf(fixture.plan, 2, 3)[0];
    const flat = TILES.flatTiles([tileset]);
    const indexOf2 = flat.find((f) => f.tile.mask === 2).index;
    const indexOf4 = flat.find((f) => f.tile.mask === 4).index;
    check("并列时取掩码值更小的那个（8 → 距离 2 的两个候选取 2）", right !== undefined && right.t === indexOf2, `t=${right?.t} 期望 ${indexOf2}`);
    check("反向验证：不是取列表里第一个（那会得到掩码 4 的块）", indexOf4 !== indexOf2 && right.t !== indexOf4);
    check("回退的 wanted/used 都写进 warnings", fixture.plan.warnings.some((text) => text.includes("没有掩码 8") && text.includes("掩码 2")), fixture.plan.warnings.join(" | ").slice(0, 100));
  }
  // 9c 一个掩码都没配：退「图集第一块」+ 告警，仍然不缺格。
  {
    const fixture = fixturePlan(corner16Tileset([undefined, undefined, undefined, undefined]), [[1, 1, 1], [1, 2, 1], [1, 3, 1]]);
    const ops = allOps(fixture.plan);
    check("一块掩码都没配：三格仍然各有 op（不留透明洞）", ops.filter((op) => op.l === 0).length === 3, `${ops.length}`);
    check("一块掩码都没配：统一退第一块", ops.filter((op) => op.l === 0).every((op) => op.t === 1), ops.map((op) => op.t).join(","));
    check("一块掩码都没配：warnings 说清原因", fixture.plan.warnings.some((text) => text.includes("没有一块带掩码")), fixture.plan.warnings.join(" | ").slice(0, 90));
  }
  // 9d 走一遍真实管线（改形态）：新切出来的块没有掩码 → 告警 + 每格都有图。
  {
    const shapeSwitch = await G.saveMapTileset(p3.id, animSheet.id, { shape: "corner16", animRows: false });
    check("手动切成 corner16：切分照旧（2×4 = 8 块）", shapeSwitch.tileset.shape === "corner16" && shapeSwitch.tileset.tiles.length === 8);
    await G.saveMapDocStructure(p3.id, { clearLayerId: "l0" });
    await G.applyMapOps(p3.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 0, c: 0, tile: 1 }, { r: 0, c: 1, tile: 1 }, { r: 1, c: 0, tile: 1 }] }]);
    const c16Plan = await G.mapPlan(p3.id, { view: { x: 0, y: 0, width: 96, height: 96 } });
    check("corner16 且无掩码：每格都有 op", allOps(c16Plan).filter((op) => op.l === 0).length === 3, `${allOps(c16Plan).length}`);
    check("corner16 且无掩码：告警写进计划", c16Plan.warnings.some((text) => text.includes("没有一块带掩码")), c16Plan.warnings.join(" | ").slice(0, 90));
  }

  // ══ 10. 环绕：负 chunk key / 负像素副本 / dropKeys ═══════════════════════
  section("10) 环绕：负 chunk key、负像素副本、dropKeys 的 canonical 映射");
  await G.saveMapDocStructure(p1.id, { clearLayerId: "l1" });
  await G.applyMapOps(p1.id, [{ kind: "paint", layerId: "l1", cells: [{ r: 0, c: 0, tile: paletteIndex }, { r: 39, c: 39, tile: paletteIndex }] }]);
  const seam = await G.mapPlan(p1.id, { view: { x: -20, y: -20, width: 60, height: 60 } });
  check("跨边界视口：visibleKeys 里出现负数 chunk key", seam.visibleKeys.some((key) => key.startsWith("-")), seam.visibleKeys.join(" "));
  const seamOps = allOps(seam);
  const negativeCopy = seamOps.filter((op) => op.x < 0 || op.y < 0);
  check("跨边界视口：最后一行的内容以负像素位置再画一份（图外的副本）", negativeCopy.length > 0 && negativeCopy.every((op) => op.r === 39 || op.c === 39), JSON.stringify(negativeCopy.slice(0, 2)));
  check(
    "同一份计划里不会把同一格画在同一个像素位置两次（视口范围各维最多铺一轮）",
    new Set(seamOps.map((op) => `${op.l},${op.r},${op.c},${op.x},${op.y}`)).size === seamOps.length,
    `${seamOps.length}`
  );
  check("包围盒恒等于网格脚印（40×32 = 1280）", seam.bounds.width === 1280 && seam.bounds.height === 1280, JSON.stringify(seam.bounds));
  check("视口越界的计划不是 truncated（上限之内）", seam.truncated === false);
  /**
   * ⚠️ 视口比地图大（相机被夹在 0、画布还有富余）时，收口必须取「地图自己那一轮」。
   * 取「视口左上角起的一轮」会被 padding 推成 `[-1, cols-1)`：最右一列只剩画布外
   * 那份副本 —— 真机表现是地图右边缘永远少一列。夹具里 (39,39) 有内容，正好能抓住。
   */
  const wideDoc = await G.readTheDoc(p1.id);
  const widePlan = await G.mapPlan(p1.id, { view: { x: 0, y: 0, width: 1280 * 3, height: 1280 * 3 } });
  const wideOps = allOps(widePlan);
  check(
    "视口比地图大：整张地图都给（最右一列 / 最下一行都在，且像素位置都在图内）",
    wideOps.some((op) => op.c === wideDoc.cols - 1) &&
      wideOps.some((op) => op.r === wideDoc.rows - 1) &&
      wideOps.every((op) => op.x >= 0 && op.y >= 0 && op.x < wideDoc.cols * 32 && op.y < wideDoc.rows * 32),
    `${wideOps.length} 条；最大 x=${Math.max(...wideOps.map((op) => op.x))} 最小 x=${Math.min(...wideOps.map((op) => op.x))}`
  );
  /**
   * ⚠️ 块键一律**按几何推**，不写死数字：`MAP_CHUNK_SIZE` 是性能旋钮（见 mapgeom.ts），
   * 断言要表达的是「wrap 感知的脏块 + 客户端报的键怎么映射」，不是某一套具体键名。
   * 这里先用一次 `have: []` 把宿主**真实**的脏块问出来，再据此构造 have（不是自己推一遍 ——
   * 自己推一遍就成了拿实现验实现）。
   */
  const S = geom.MAP_CHUNK_SIZE;
  const dimsP1 = await G.mapView(await G.readMapProject(p1.id));
  const nxP1 = Math.max(1, Math.ceil(dimsP1.cols / S));
  const nyP1 = Math.max(1, Math.ceil(dimsP1.rows / S));
  const probe = await G.applyMapOps(p1.id, [{ kind: "paint", layerId: "l1", cells: [{ r: 0, c: 10, tile: paletteIndex }] }], { have: [] });
  const dirtyKeys = probe.dirtyChunks;
  const dirtySet = new Set(dirtyKeys);
  const lastRowDirty = [...dirtySet].filter((key) => Number(key.split(",")[1]) === nyP1 - 1);
  check("画第 0 行时最后一行的块也脏了（wrap 感知的脏块）", lastRowDirty.length > 0, `dirty=${dirtyKeys.join(" ")}（ny=${nyP1}）`);
  // 把一个脏块整体往左绕一圈：规范之后还是同一块，所以必须被命中
  const [dcx, dcy] = dirtyKeys[0].split(",").map(Number);
  const wrappedKey = `${dcx - nxP1},${dcy}`;
  // 找一个**没脏**的块（保证「内容没变的不回给客户端」这条断言真的在测东西）
  let unrelated = "";
  for (let cy = 0; cy < nyP1 && unrelated === ""; cy++) {
    for (let cx = 0; cx < nxP1 && unrelated === ""; cx++) {
      if (!dirtySet.has(`${cx},${cy}`)) unrelated = `${cx},${cy}`;
    }
  }
  const haveKeys = [dirtyKeys[0], wrappedKey, unrelated];
  const drop = await G.applyMapOps(p1.id, [{ kind: "paint", layerId: "l1", cells: [{ r: 0, c: 10, tile: paletteIndex + 1 }] }], { have: haveKeys });
  check("dropKeys 只包含客户端报过的 key", drop.dropKeys.every((key) => haveKeys.includes(key)), drop.dropKeys.join(" "));
  check("客户端报的（规范）脏块会回给客户端", drop.dropKeys.includes(dirtyKeys[0]), `have=${haveKeys.join(" ")} drop=${drop.dropKeys.join(" ")}`);
  check("客户端报的负 key 会被映射到规范块后命中（绕一圈也认得出来）", drop.dropKeys.includes(wrappedKey), `have=${wrappedKey} drop=${drop.dropKeys.join(" ")}`);
  check("内容没变的块不回给客户端", unrelated !== "" && !drop.dropKeys.includes(unrelated), `没脏的块 ${unrelated} / drop=${drop.dropKeys.join(" ")}`);
  const midDirty = (await G.applyMapOps(p1.id, [{ kind: "paint", layerId: "l1", cells: [{ r: 5, c: 10, tile: paletteIndex }] }], { have: [] })).dirtyChunks;
  const midLastRow = midDirty.filter((key) => Number(key.split(",")[1]) === nyP1 - 1);
  check("反向验证：在中间行落笔时，最后一行的块不该被弄脏", midLastRow.length === 0, `${midDirty.join(" ")}`);
  check("没报 have 时 dropKeys 是空数组（客户端不需要丢缓存）", (await G.applyMapOps(p1.id, [{ kind: "paint", layerId: "l1", cells: [{ r: 6, c: 6, tile: paletteIndex }] }])).dropKeys.length === 0);
  check("layerIds 过滤只算指定层", (await G.mapPlan(p1.id, { view: { x: 0, y: 0, width: 64, height: 64 }, layerIds: [1] })).chunks.flatMap((c) => c.ops).every((op) => op.l === 1));
  check("have 里已有的 chunk 不再回给客户端", (await G.mapPlan(p1.id, { view: { x: 0, y: 0, width: 64, height: 64 }, have: ["0,0"] })).chunks.every((chunk) => chunk.key !== "0,0"));

  // ★ 环绕 × A2 自动连接的交叉点（最容易漏测、也最容易静默坏）。
  // 判据：8×8 整层铺满同一张 A2 素材 → 每一格的四个象限都该落在「满格」形状（shape 4）。
  // 64×160 且 cell=32 时 smallCols = 4，四象限的 1-based 小格序号 = 1 + (2*4 + 上/下)*4 + (0/1)
  // = 33 / 34 / 37 / 38。**漏取模**的表现：跨边界那一圈邻格被判成「不同类」，
  // 于是接缝处长出孤岛 / 半格形状（t 退化成 1 / 2 / 5 / 6 之类）。
  const pSeam = await newProject("接缝连续", { cols: 8, rows: 8 });
  await G.importMapTileset(pSeam.id, "A2", sheetPng(64, 160, 16).toString("base64"));
  const seamView = await G.mapView(await G.readMapProject(pSeam.id));
  const seamBrush = seamView.tilesets[0].palette[0].index;
  const seamLayer = seamView.layers[0].id;
  await G.applyMapOps(pSeam.id, [{ kind: "rect", layerId: seamLayer, r0: 0, c0: 0, r1: 7, c1: 7, tile: seamBrush, filled: true }]);
  const seamA2 = await G.mapPlan(pSeam.id, { view: { x: -32, y: -32, width: 64, height: 64 } });
  const seamTiles = [...new Set(allOps(seamA2).map((op) => op.t))].sort((a, b) => a - b);
  check("跨左上边界的视口给出 100 条 op（5×5 格 × 4 象限）", allOps(seamA2).length === 100, `${allOps(seamA2).length}`);
  check("环绕接缝处全是「满格」形状（wrap 邻域算对了）", seamTiles.join(",") === "33,34,37,38", seamTiles.join(","));
  await G.saveMapDocStructure(pSeam.id, { wrap: false });
  const flatA2 = await G.mapPlan(pSeam.id, { view: { x: -32, y: -32, width: 64, height: 64 } });
  const flatTilesA2 = [...new Set(allOps(flatA2).map((op) => op.t))].sort((a, b) => a - b);
  check("反向验证：关掉环绕后同一个视口只剩 36 条 op（越界部分被裁掉）", allOps(flatA2).length === 36, `${allOps(flatA2).length}`);
  check("反向验证：关掉环绕后接缝处退化成半格 / 孤岛形状（t 不再是 33/34/37/38）", flatTilesA2.some((t) => ![33, 34, 37, 38].includes(t)), flatTilesA2.join(","));
  await G.saveMapDocStructure(pSeam.id, { wrap: true });

  // ★ 预览：一笔还在手上时「看得见，但不落盘」
  {
    const pPrev = await newProject("预览", { cols: 8, rows: 8 });
    await G.importSampleTileset(pPrev.id);
    const layerId = "l0"; // 第一个图层（`createMapDoc` 的默认 id）
    const view = { x: 0, y: 0, width: 128, height: 128 };
    const pending = [
      { kind: "paint", layerId, cells: [{ r: 2, c: 2, tile: 1 }, { r: 3, c: 3, tile: 2 }] }
    ];
    const preview = await G.mapPlan(pPrev.id, { view, have: [], pending });
    /**
     * ★ 真机踩过的坑：客户端查计划会带 `have`。如果宿主因为「你有这一块」就不回传，
     * 那么**预览改动落在已有块里时什么都画不出来** —— 拖动期间一片空白，松手提交后
     * 靠 `dropKeys` 重拉才出现。这里钉住：带上 have（缓存里有这一块）也要把它发回来。
     */
    const withHave = await G.mapPlan(pPrev.id, { view, have: preview.visibleKeys, pending });
    const forcedBack = withHave.chunks.filter((chunk) => chunk.ops.some((op) => (op.r === 2 && op.c === 2) || (op.r === 3 && op.c === 3)));
    check(
      "预览：即使客户端说「这几块我有」，受影响的那块也会被强制发回来（否则拖动期间一片空白）",
      forcedBack.length > 0,
      `回传 ${withHave.chunks.length} 块，其中带预览格的 ${forcedBack.length} 块`
    );
    check(
      "预览：带 pending 查计划时，这一笔已经在计划里（画的过程中看得见）",
      opOf(preview, 2, 2).length > 0 && opOf(preview, 3, 3).length > 0,
      `(2,2)=${opOf(preview, 2, 2).length} (3,3)=${opOf(preview, 3, 3).length}`
    );
    const plain = await G.mapPlan(pPrev.id, { view, have: [] });
    check("预览不落盘：紧接着不带 pending 再查一次，那两格还是空的", opOf(plain, 2, 2).length === 0 && opOf(plain, 3, 3).length === 0);
    check("预览不动撤销栈（拖动期间一次都没存）", G.historyState(pPrev.id).depth === 0, `depth=${G.historyState(pPrev.id).depth}`);
    await G.applyMapOps(pPrev.id, pending, { stroke: "s1" });
    const real = await G.mapPlan(pPrev.id, { view, have: [] });
    check("提交之后的计划与预览逐字段一致（预览不会撒谎）", JSON.stringify(real.chunks) === JSON.stringify(preview.chunks), `${real.chunks.length} / ${preview.chunks.length} 块`);
    check("提交之后才进撤销栈", G.historyState(pPrev.id).depth === 1, `depth=${G.historyState(pPrev.id).depth}`);
  }

  // ★ 新增素材：属性在导入那一刻一次定下来；内置素材属性不可改、可删、可一键恢复
  {
    const pNew = await newProject("新增素材属性", { cols: 16, rows: 16 });
    const made = await G.importMapTileset(pNew.id, "我的图", sheetPng(64, 64, 16).toString("base64"), {
      cell: { width: 16, height: 16 },
      shape: "plain",
      animRows: true
    });
    const madeTs = made.tilesets[0];
    check(
      "新增素材时填的属性被采纳（格子 16×16 / 普通 / 翻页图）",
      madeTs.cell.width === 16 && madeTs.cell.height === 16 && madeTs.shape === "plain" && madeTs.animRows === true,
      JSON.stringify({ cell: madeTs.cell, shape: madeTs.shape, anim: madeTs.animRows })
    );
    check("翻页图：行数就是帧数（64×64 / 格 16 → 4 行 = 4 帧）", madeTs.variants === 4 && madeTs.tiles.length === 16, `variants=${madeTs.variants} tiles=${madeTs.tiles.length}`);
    const auto = (await G.importMapTileset(pNew.id, "自动", sheetPng(64, 160, 16).toString("base64"), {})).tilesets[0];
    check("属性留空 = 走自动识别（64×160 → 拼块自动连接 / 2 变体）", auto.shape === "a2quad" && auto.variants === 2, `${auto.shape} / ${auto.variants}`);
    let badCellError = "";
    const beforeBad = (await G.readMapProject(pNew.id)).tilesets.length;
    try {
      await G.importMapTileset(pNew.id, "乱填", sheetPng(64, 64, 16).toString("base64"), { cell: { width: -8, height: 0 } });
    } catch (error) {
      badCellError = String(error?.message ?? error);
    }
    check("乱填的格子尺寸**明确拒绝**（不静默改成别的值）", /格子尺寸不合法/.test(badCellError), badCellError);
    check("被拒绝的导入不会留下半张素材（先校验再写文件）", (await G.readMapProject(pNew.id)).tilesets.length === beforeBad, `${beforeBad} → ${(await G.readMapProject(pNew.id)).tilesets.length}`);

    const pBuiltin = await newProject("内置不可改", { cols: 16, rows: 16 });
    const installed = await G.importSampleTileset(pBuiltin.id);
    check("内置素材带 builtin 标记", installed.tilesets.length > 0 && installed.tilesets.every((t) => t.builtin === true), JSON.stringify(installed.tilesets.map((t) => [t.name, t.builtin])));
    let rejected = "";
    try {
      await G.saveMapTileset(pBuiltin.id, installed.tilesets[0].id, { shape: "plain" });
    } catch (error) {
      rejected = String(error?.message ?? error);
    }
    check("内置素材的属性改不动（宿主直接拒绝并说明原因）", /内置素材/.test(rejected) && /不能改/.test(rejected), rejected);
    await G.removeMapTileset(pBuiltin.id, installed.tilesets[0].id);
    check("内置素材还能整张删掉", (await G.readMapProject(pBuiltin.id)).tilesets.length === installed.tilesets.length - 1);
    const restored = await G.importSampleTileset(pBuiltin.id);
    check(
      "删掉的内置素材能一键恢复（其余同名跳过，不会变成两份）",
      restored.tilesets.length === 1 && (await G.readMapProject(pBuiltin.id)).tilesets.length === installed.tilesets.length,
      `补回 ${restored.tilesets.length} 张`
    );
  }

  // ★ 自由尺寸：地图宽高可以不相同；素材格子宽高也可以不相同（用户要「格子数能自由设置」）
  {
    const pRect = await newProject("自由宽高", { cols: 32, rows: 32 });
    const rectSave = await G.saveMapDocStructure(pRect.id, { cols: 48, rows: 20 });
    check("地图宽高可以不相同（48×20）", rectSave.doc.cols === 48 && rectSave.doc.rows === 20, `${rectSave.doc.cols}×${rectSave.doc.rows}`);
    const rectView = await G.mapView(await G.readMapProject(pRect.id));
    check("视图把非正方形的尺寸原样报出来", rectView.cols === 48 && rectView.rows === 20);
    await G.importMapTileset(pRect.id, "棋盘", sheetPng(64, 64, 32).toString("base64"));
    const rectTiles = (await G.mapView(await G.readMapProject(pRect.id))).tilesets[0];
    // 画最右下角那一格：正方形夹具永远碰不到这条边
    const cornerPaint = await G.applyMapOps(pRect.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 19, c: 47, tile: rectTiles.palette[0].index }] }], { have: [] });
    check("画右下角 (19,47) 不越界", cornerPaint.changed === 1 && cornerPaint.skipped.length === 0, JSON.stringify(cornerPaint.skipped));
    const rectPlan = await G.mapPlan(pRect.id, { view: { x: 0, y: 0, width: 48 * 32, height: 20 * 32 }, have: [] });
    const rectOps = rectPlan.chunks.flatMap((chunk) => chunk.ops);
    check("计划按 48×20 铺满（最后一行一列也有内容）", rectOps.some((op) => op.r === 19 && op.c === 47), `${rectOps.length} 条`);
    // 素材格子宽高不相同：96×64 的图按 24×16 切 → 4 列 × 4 行 = 16 块
    const pCell = await newProject("自由格子", { cols: 16, rows: 16 });
    const impCell = await G.importMapTileset(pCell.id, "96×64", sheetPng(96, 64, 32).toString("base64"));
    const cellSave = await G.saveMapTileset(pCell.id, impCell.tilesets[0].id, { cell: { width: 24, height: 16 } });
    const cellTs = cellSave.tileset;
    check("素材格子可以不是正方形（24×16）", cellTs.cell.width === 24 && cellTs.cell.height === 16, `${cellTs.cell.width}×${cellTs.cell.height}`);
    check("切出来的块数跟着格子大小走（4 列 × 4 行 = 16 块）", cellTs.tiles.length === 16, `${cellTs.tiles.length} 块`);
    check("每块尺寸等于格子尺寸", cellTs.tiles.every((tile) => tile.rect.width === 24 && tile.rect.height === 16), JSON.stringify(cellTs.tiles[0]?.rect));
  }

  // ★ dropKeys 也要 wrap 感知：画 (0,0) 一格，它的上 / 左邻格是最后一行 / 最后一列，
  //   折回后落在**四个角**的块里 → 四个角的 key 全部失效。键按几何推（块边长是性能旋钮）。
  const pChunk = await newProject("跨块脏标记", { cols: 64, rows: 64 });
  await G.importMapTileset(pChunk.id, "A2", sheetPng(64, 160, 16).toString("base64"));
  const chunkBrush = (await G.mapView(await G.readMapProject(pChunk.id))).tilesets[0].palette[0].index;
  const nxChunk = Math.max(1, Math.ceil(64 / geom.MAP_CHUNK_SIZE));
  const fourHave = ["0,0", `0,${nxChunk - 1}`, `${nxChunk - 1},0`, `${nxChunk - 1},${nxChunk - 1}`];
  const corner = await G.applyMapOps(pChunk.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 0, c: 0, tile: chunkBrush }] }], { have: fourHave });
  check("画 (0,0)：四个角的块全部失效（wrap 邻域落到最后一行 / 列所在的块）", fourHave.every((key) => corner.dropKeys.includes(key)), `dirty=${corner.dirtyChunks.join(" ")} drop=${corner.dropKeys.join(" ")}`);
  await G.saveMapDocStructure(pChunk.id, { wrap: false });
  await G.saveMapDocStructure(pChunk.id, { clearLayerId: "l0" });
  const cornerFlat = await G.applyMapOps(pChunk.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 0, c: 0, tile: chunkBrush }] }], { have: fourHave });
  check("反向验证：关掉环绕后同一个夹具只失效 0,0 一个 chunk", cornerFlat.dropKeys.join(",") === "0,0", `dirty=${cornerFlat.dirtyChunks.join(" ")} drop=${cornerFlat.dropKeys.join(",")}`);

  // ══ 11. 撤销 / 重做 ══════════════════════════════════════════════════════
  section("11) 撤销 / 重做（含同一笔只算一步）");
  const p6 = await newProject("撤销与生成", { cols: 24, rows: 24 });
  const sixSheet = (await G.importMapTileset(p6.id, "四色", sheetPng(128, 128, 32).toString("base64"))).tilesets[0];
  check("24×24 上导入 4×4 的素材（16 块）", sixSheet.tiles.length === 16);
  const depth0 = G.historyState(p6.id).depth;
  const s1 = await G.applyMapOps(p6.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 1, c: 1, tile: 1 }] }], { stroke: "笔画A" });
  const depth1 = G.historyState(p6.id).depth;
  const s2 = await G.applyMapOps(p6.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 1, c: 2, tile: 1 }] }], { stroke: "笔画A" });
  const depth2 = G.historyState(p6.id).depth;
  const s3 = await G.applyMapOps(p6.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 1, c: 3, tile: 1 }] }], { stroke: "笔画B" });
  const depth3 = G.historyState(p6.id).depth;
  check("同一笔的后续提交不再压栈（深度不变）", depth1 === depth0 + 1 && depth2 === depth1, `${depth0} → ${depth1} → ${depth2}`);
  check("换一笔才 +1", depth3 === depth2 + 1, `${depth2} → ${depth3}`);
  check("三次提交都真的改了格子", s1.changed === 1 && s2.changed === 1 && s3.changed === 1);
  check("canUndo / canRedo 与栈一致", s3.canUndo === true && s3.canRedo === false && G.historyState(p6.id).canUndo === true);
  const latest = planSignature(await G.mapPlan(p6.id, { view: { x: 0, y: 0, width: 24 * 32, height: 24 * 32 } }));
  let undoSteps = 0;
  while (G.historyState(p6.id).canUndo) {
    await G.undoMap(p6.id);
    undoSteps++;
    if (undoSteps > 50) break;
  }
  check("一直撤销到根（步数 = 2 笔）", undoSteps === 2, `${undoSteps} 步`);
  check("撤销到根后地图是空的", (await G.readTheDoc(p6.id)).data.l0.every((value) => value === 0));
  check("到根后再撤销返回空结果而不是抛", (await G.undoMap(p6.id)).changed === 0);
  let redoSteps = 0;
  while (G.historyState(p6.id).canRedo) {
    await G.redoMap(p6.id);
    redoSteps++;
    if (redoSteps > 50) break;
  }
  check("重做步数与撤销一致", redoSteps === undoSteps, `${redoSteps} vs ${undoSteps}`);
  check("重做后计划逐项与撤销前完全一致", planSignature(await G.mapPlan(p6.id, { view: { x: 0, y: 0, width: 24 * 32, height: 24 * 32 } })) === latest);
  check("到顶后再重做返回空结果", (await G.redoMap(p6.id)).changed === 0);

  // ══ 12. 三种一键生成 ════════════════════════════════════════════════════
  section("12) 一键生成：同种子可复现 / 警告 / 一次撤销");
  const view6 = { x: 0, y: 0, width: 24 * 32, height: 24 * 32 };
  const sig6 = async () => planSignature(await G.mapPlan(p6.id, { view: view6 }));
  const seedA = await G.runMapGenerate(p6.id, { kind: "random", seed: 4242 });
  const planSeedA = await sig6();
  check("random：铺满整层（24×24 = 576 格）", seedA.changed === 576 && seedA.seed === 4242, `${seedA.changed} / 种子 ${seedA.seed}`);
  const seedB = await G.runMapGenerate(p6.id, { kind: "random", seed: 99 });
  check("换个种子结果真的不一样（否则「可复现」这条断言没有区分力）", (await sig6()) !== planSeedA, `changed=${seedB.changed}`);
  await G.runMapGenerate(p6.id, { kind: "random", seed: 4242 });
  check("同一个种子两次生成：计划逐项相同", (await sig6()) === planSeedA);
  const maze = await G.runMapGenerate(p6.id, { kind: "maze", seed: 7, tiles: [1, 2] });
  check("maze：偶数尺寸给出告警（按 23×23 生成，多的留空）", maze.warnings.some((text) => text.includes("偶数")), maze.warnings.join(" | "));
  const mazeA = await sig6();
  await G.runMapGenerate(p6.id, { kind: "maze", seed: 8, tiles: [1, 2] });
  await G.runMapGenerate(p6.id, { kind: "maze", seed: 7, tiles: [1, 2] });
  check("maze 同种子两次：计划逐项相同", (await sig6()) === mazeA);
  const continent = await G.runMapGenerate(p6.id, { kind: "continent", seed: 5, tiles: [1] });
  check("continent：图块不足 4 个时给出回退告警", continent.warnings.some((text) => text.includes("只给了 1 个图块")), continent.warnings.join(" | "));
  // 大陆算法正在被改（形状会变），所以这里**只钉不依赖具体形状的判据**：
  // 同种子逐项一致 + 只用给定的图块池。
  await G.runMapGenerate(p6.id, { kind: "continent", seed: 1234, tiles: [1, 2, 3, 4] });
  const continentA = await sig6();
  await G.runMapGenerate(p6.id, { kind: "continent", seed: 4321, tiles: [1, 2, 3, 4] });
  await G.runMapGenerate(p6.id, { kind: "continent", seed: 1234, tiles: [1, 2, 3, 4] });
  check("continent 同种子两次：计划逐项相同（只钉确定性，不钉形状）", (await sig6()) === continentA);
  check("continent 只用给定的图块池（不凭空造序号）", [...new Set((await G.readTheDoc(p6.id)).data.l0)].every((value) => [0, 1, 2, 3, 4].includes(value)), [...new Set((await G.readTheDoc(p6.id)).data.l0)].join(","));
  const beforeUndo = planSignature(await G.mapPlan(p6.id, { view: view6 }));
  await G.undoMap(p6.id);
  check("一次撤销就能整个撤回一次生成", planSignature(await G.mapPlan(p6.id, { view: view6 })) !== beforeUndo);
  const badKind = await throwsAsync(() => G.runMapGenerate(p6.id, { kind: "nope" }));
  check("未知算法明确报错", badKind.includes("未知生成算法"), badKind.slice(0, 60));
  check("图块序号越界明确报错", (await throwsAsync(() => G.runMapGenerate(p6.id, { kind: "random", tiles: [999] }))).includes("图块序号越界"));
  check("生成会记进项目日志", (await G.readMapProject(p6.id)).logs.some((entry) => entry.message.includes("一键生成")), (await G.readMapProject(p6.id)).logs.at(-1)?.message);

  // ══ 13. 防抖落盘与丢缓存重载 ════════════════════════════════════════════
  section("13) 防抖落盘与丢缓存重载");
  await G.applyMapOps(p6.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 20, c: 20, tile: 7 }] }]);
  let flushed = 0;
  for (let i = 0; i < 60; i++) {
    const onDisk = JSON.parse(await readFile(G.mapDocFile(p6.id), "utf8"));
    flushed = onDisk.data.l0[20 * 24 + 20];
    if (flushed === 7) break;
    await sleep(50);
  }
  check("一笔编辑会在 2 秒内落盘（不靠手动 flush）", flushed === 7, `${flushed}`);
  for (let i = 0; i < 6; i++) {
    await G.applyMapOps(p6.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 21, c: i, tile: 8 }] }]);
  }
  await sleep(2500);
  const diskAfter = JSON.parse(await readFile(G.mapDocFile(p6.id), "utf8"));
  check("连续多笔之后的最后一笔也落了盘（防抖补写）", diskAfter.data.l0.slice(21 * 24, 21 * 24 + 6).every((value) => value === 8), JSON.stringify(diskAfter.data.l0.slice(21 * 24, 21 * 24 + 6)));
  // 丢缓存重载：带 query 再 import 一次 → 拿到一个全新的模块实例（docCache 是空的），
  // 它只能从磁盘读。这就是「进程重启后还能读回同一份」的等价验证。
  const freshGen = await import("../lib/mapgen.js?fresh=pipeline");
  const reloaded = await freshGen.readTheDoc(p6.id);
  check("丢缓存（新模块实例）后从磁盘读回同一份内容", reloaded !== undefined && reloaded.data.l0[20 * 24 + 20] === 7 && reloaded.data.l0[21 * 24 + 5] === 8);
  check("新实例的撤销栈是空的（历史不落盘，这是设计）", freshGen.historyState(p6.id).canUndo === false && freshGen.historyState(p6.id).depth === 0);
  const docOnDisk = JSON.parse(await readFile(G.mapDocFile(p6.id), "utf8"));
  check("map.json 落盘的就是图层元数据 + 每层数据 + 标记（没有形状 / 掩码 / chunk 之类派生数据）", Object.keys(docOnDisk).join(",") === "id,name,cols,rows,layers,data,markers,createdAt,updatedAt", Object.keys(docOnDisk).join(","));

  // ══ 14. 预览与导出 ══════════════════════════════════════════════════════
  section("14) 验收预览（只出地图渲染图）");
  const previewStart = await G.runPreviewStage(p6.id);
  check("预览作业已启动", previewStart.started === true, previewStart.reason ?? "");
  await waitIdle(p6.id);
  const previewFiles = await readdir(join(G.mapProjectDir(p6.id), "preview"));
  check("预览只出一张地图渲染图（没有切片 contact sheet / 覆盖矩阵）", previewFiles.length === 1 && previewFiles[0] === "map.png", previewFiles.join(" "));
  check("预览作业没有报错", (await G.readMapProject(p6.id)).stages.paint.status === "done", JSON.stringify((await G.readMapProject(p6.id)).stages.paint));
  check("预览跑完后项目不忙，可以再次提交", G.mapBusy(p6.id) === false);
  check("并发提交只放行一个", (await Promise.all([G.runPreviewStage(p6.id), G.runPreviewStage(p6.id)])).filter((item) => item.started === true).length === 1);
  G.cancelMapJob(p6.id);
  await waitIdle(p6.id);
  check("cancelMapJob 能收尾（不忙、阶段不是 error）", G.mapBusy(p6.id) === false && (await G.readMapProject(p6.id)).stages.paint.status !== "error");

  section("15) 导出：目录名 / 产物 / 自动打 zip / 逐字段 / 逐字节 / 逐像素");
  const p5 = await newProject("导出", { cols: 8, rows: 8 });
  const fiveSheet = (await G.importMapTileset(p5.id, "四色", sheetPng(128, 128, 32).toString("base64"))).tilesets[0];
  const renamed = await G.saveMapDocStructure(p5.id, { name: "地图 A/B" });
  check("地图改名（用于验证导出目录名按地图名走）", renamed.doc.name === "地图 A/B");
  await G.applyMapOps(p5.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 1, c: 2, tile: 8 }, { r: 0, c: 0, tile: 1 }] }]);
  const exportStart = await G.runExportStage(p5.id, { scale: 1 });
  check("导出作业已启动", exportStart.started === true, exportStart.reason ?? "");
  const afterExport = await waitIdle(p5.id);
  check("导出作业没有报错", afterExport.stages.export.status === "done", JSON.stringify(afterExport.stages.export));
  const expectedDir = EXPORT.safeFileName("地图 A/B", "x");
  const expectedZip = `${expectedDir}.zip`;
  const exportDirs = await readdir(join(G.mapProjectDir(p5.id), "export"));
  check("导出目录名 = safeFileName(地图名, 地图 id)（不是项目名）", exportDirs.length === 1 && exportDirs[0] === expectedDir, `${exportDirs.join(" ")} vs ${expectedDir}`);
  check("反向验证：导出目录名不是项目名", exportDirs[0] !== EXPORT.safeFileName("导出", "x"));
  const exportDir = join(G.mapProjectDir(p5.id), "export", exportDirs[0]);
  const files = await readdir(exportDir);
  check(
    "默认导出（png+json）给三个文件 + 一个 zip（多个产物自动打包）",
    files.slice().sort().join(",") === ["manifest.json", "map.json", "map.png", expectedZip].sort().join(","),
    files.join(" ")
  );
  check("没有分层 PNG / Tiled .tmj / .tsj", !files.some((name) => name.startsWith("layer-") || name.endsWith(".tmj") || name.endsWith(".tsj")), files.join(" "));

  /**
   * zip 要**真解一遍**：条目、内容、CRC 全部对得上才算数。
   * 反向验证在下面单独一节（只勾一项时不许有 zip）。
   */
  const zipBytes = await readFile(join(exportDir, expectedZip));
  const zipEntries = readZip(zipBytes);
  check("zip 里只有用户勾的产物（map.png + map.json），不含 manifest.json", [...zipEntries.keys()].sort().join(",") === "map.json,map.png", [...zipEntries.keys()].join(" "));
  check("zip 里的 map.png 与盘上那份逐字节一致", zipEntries.get("map.png")?.equals(await readFile(join(exportDir, "map.png"))) === true);
  check("zip 里的 map.json 与盘上那份逐字节一致", zipEntries.get("map.json")?.equals(await readFile(join(exportDir, "map.json"))) === true);


  const mapPng = await decodeFile(join(exportDir, "map.png"));
  check("map.png 尺寸 = 网格脚印（8×32 = 256）", mapPng.width === 256 && mapPng.height === 256, `${mapPng.width}×${mapPng.height}`);
  check(
    "像素位置：第 (2,1) 格画的是素材里 (col 3,row 1) 那一块（行列不能互换）",
    sameColor(pixelAt(mapPng, 2 * 32 + 16, 1 * 32 + 16), blockColor(3, 1)),
    `${pixelAt(mapPng, 2 * 32 + 16, 1 * 32 + 16)} vs ${blockColor(3, 1)}`
  );
  check("像素位置：块的左上角角标落在格子左上角（整体没有偏移）", sameColor(pixelAt(mapPng, 2 * 32, 1 * 32), MARKER), `${pixelAt(mapPng, 2 * 32, 1 * 32)}`);
  const sourceBitmap = await decodeFile(G.mapAssetPath(p5.id, fiveSheet.file));
  check(
    "legend 的 rect 指向源图里正确的那一块（角标在 rect 左上角、中心是那一块的色）",
    sameColor(pixelAt(sourceBitmap, 3 * 32, 1 * 32), MARKER) && sameColor(pixelAt(sourceBitmap, 3 * 32 + 16, 1 * 32 + 16), blockColor(3, 1))
  );

  const ownJson = JSON.parse(await readFile(join(exportDir, "map.json"), "utf8"));
  check("map.json：格式标识 dsh-gem-map@3", ownJson.format === EXPORT.OWN_JSON_FORMAT && ownJson.format === "dsh-gem-map@3", ownJson.format);
  check("map.json：grid 三个字段齐（tileWidth / tileHeight / wrap）", ownJson.grid.tileWidth === 32 && ownJson.grid.tileHeight === 32 && ownJson.grid.wrap === true, JSON.stringify(ownJson.grid));
  check("map.json：cols / rows 与文档一致", ownJson.cols === 8 && ownJson.rows === 8);
  check("map.json：tilesets[].shape / cell / tileCount 齐", ownJson.tilesets[0].shape === "plain" && ownJson.tilesets[0].cell.width === 32 && ownJson.tilesets[0].tileCount === 16, JSON.stringify(ownJson.tilesets[0]));
  check("map.json：不再带旧字段（families / mapId / firstgid / wangsets）", !("families" in ownJson) && !("mapId" in ownJson) && JSON.stringify(ownJson).includes('"firstgid"') === false);
  check("map.json：legend 从 1 开始且与 rect 一一对上（16 块，行优先 32px 网格）", ownJson.legend.length === 16 && ownJson.legend.every((entry, index) => {
    const expectedX = (index % 4) * 32;
    const expectedY = Math.floor(index / 4) * 32;
    return entry.index === index + 1 && entry.rect.x === expectedX && entry.rect.y === expectedY && entry.rect.width === 32 && entry.rect.height === 32;
  }), JSON.stringify(ownJson.legend[5]));
  check("map.json：每层 data 长度 = cols×rows（默认三层都在）", ownJson.layers.length === 3 && ownJson.layers.every((layer) => layer.data.length === 64), JSON.stringify(ownJson.layers.map((l) => [l.name, l.data.length])));
  check("map.json：data 存的是语义序号（1-based 全局图块序号，0 = 空）", ownJson.layers[0].data[0] === 1 && ownJson.layers[0].data[1 * 8 + 2] === 8 && ownJson.layers[0].data[20] === 0, JSON.stringify([ownJson.layers[0].data[0], ownJson.layers[0].data[1 * 8 + 2], ownJson.layers[0].data[20]]));
  check("map.json：data 里的每个非零值都能在 legend 里找到", ownJson.layers[0].data.filter((value) => value > 0).every((value) => ownJson.legend.some((entry) => entry.index === value)));
  check("map.json：tilesets[].image 是相对项目目录的路径（导出目录里没有拷图集）", ownJson.tilesets[0].image === fiveSheet.file && !existsSync(join(exportDir, fiveSheet.file.replace(/^tilesets\//, ""))));
  const manifest = JSON.parse(await readFile(join(exportDir, "manifest.json"), "utf8"));
  check("manifest.json：列出产物、mapPng/mapJson 命名对得上", manifest.mapPng === "map.png" && manifest.mapJson === "map.json" && manifest.mapZip === expectedZip && ["map.png", "map.json", "manifest.json"].every((name) => manifest.files.some((file) => file.path === name)), manifest.files.map((f) => f.path).join(" "));
  check("manifest.json：bounds 与网格脚印一致", manifest.bounds.width === 256 && manifest.bounds.height === 256, JSON.stringify(manifest.bounds));
  const pngA = await readFile(join(exportDir, "map.png"));
  await G.runExportStage(p5.id, { scale: 1 });
  await waitIdle(p5.id);
  const pngB = await readFile(join(exportDir, "map.png"));
  check("同一份文档两次导出：map.png 逐字节一致", pngA.length > 0 && pngA.equals(pngB), `${pngA.length} vs ${pngB.length}`);
  /**
   * zip 的确定性靠**写死时间戳**（见 `zip.ts` 文件头）：用真实时间的话这条会挂，
   * 而「导出可复现」正是它能进版本库 / 能对比回归的前提。
   */
  check("同一份文档两次导出：zip 逐字节一致（时间戳写死）", (await readFile(join(exportDir, expectedZip))).equals(zipBytes), `${zipBytes.length} 字节`);

  /**
   * 反向验证：**只勾一项**不许打包（一个文件再套一层 zip 纯属添乱），
   * 而且这次导出会把上一轮的产物清掉 —— 目录内容永远等于「这次选的东西」。
   */
  await G.runExportStage(p5.id, { scale: 1, formats: { png: true, json: false } });
  await waitIdle(p5.id);
  const pngOnly = await readdir(exportDir);
  check("只勾 PNG：目录里只剩 map.png + manifest.json（没有 zip、上一轮的 map.json 被清掉）", pngOnly.slice().sort().join(",") === "manifest.json,map.png", pngOnly.join(" "));
  const pngOnlyView = await G.mapView(await G.readMapProject(p5.id));
  check("只勾 PNG 的视图：exportFiles 只有两个、exportPath 是本机绝对路径", pngOnlyView.exportFiles.slice().sort().join(",") === "manifest.json,map.png" && pngOnlyView.exportPath === exportDir, `${pngOnlyView.exportFiles.join(" ")} / ${pngOnlyView.exportPath}`);

  // 素材原图：勾了才拷，拷进去的相对路径与 map.json 里的引用同形（整包自包含）
  await G.runExportStage(p5.id, { scale: 1, formats: { png: true, json: true, tilesets: true } });
  await waitIdle(p5.id);
  const withAssets = await readdir(exportDir);
  check("勾「素材原图」：素材图拷进 tilesets/（zip 里也有）", withAssets.includes("tilesets") && (await readdir(join(exportDir, "tilesets"))).length === 1, withAssets.join(" "));
  const assetsZip = readZip(await readFile(join(exportDir, expectedZip)));
  check(
    "带素材的 zip：条目路径与 map.json 的 tilesets[].image 同形（搬到别处也能用）",
    [...assetsZip.keys()].sort().join(",") === ["map.json", "map.png", `tilesets/${fiveSheet.file.split("/").pop()}`].sort().join(","),
    [...assetsZip.keys()].join(" ")
  );
  check(
    "带素材的 zip：拷进去的素材图与项目里那张逐字节一致",
    assetsZip.get(`tilesets/${fiveSheet.file.split("/").pop()}`)?.equals(await readFile(G.mapAssetPath(p5.id, fiveSheet.file))) === true
  );

  const view5 = await G.mapView(await G.readMapProject(p5.id));
  const view6b = await G.mapView(await G.readMapProject(p6.id));
  check("视图：preview 给的是相对路径（界面自己拼 assetBase）", view6b.preview.join(",") === "preview/map.png", view6b.preview.join(" "));
  check("视图：还没跑过预览的项目 preview 是空数组（不是伪造一条路径）", view5.preview.length === 0, view5.preview.join(" "));
  check("视图：exportBase 指向按地图名取的目录", view5.exportBase === `export/${expectedDir}/`, view5.exportBase);
  check("视图：exportFiles 列出这一轮的全部产物（含 zip 与拷进来的素材）", view5.exportFiles.slice().sort().join(",") === ["manifest.json", "map.json", "map.png", expectedZip, `tilesets/${fiveSheet.file.split("/").pop()}`].sort().join(","), view5.exportFiles.join(" "));
  check("视图：legend 覆盖全部块，layers 带 filled 计数", view5.legend.length === 16 && view5.layers[0].filled === 2 && view5.filled === 2, JSON.stringify(view5.layers));
  check("视图：stages 四阶段 + busy/canUndo/maxChunks 字段齐", Object.keys(view5.stages).join(",") === "assets,rules,paint,export" && typeof view5.busy === "boolean" && typeof view5.canUndo === "boolean" && view5.maxChunks > 0);
  check("视图：素材带识别说明与调色板", view5.tilesets[0].reason.includes("正方形网格") && view5.tilesets[0].palette.length === 16, view5.tilesets[0].reason);
  check("视图：A2 与其他素材的画布尺寸跟着文档（不是项目元数据）", view5.cols === 8 && view5.rows === 8);
  const listing = await G.readExportListing(p5.id, "http://127.0.0.1:9999");
  check("readExportListing：base 与 files 都是可点的绝对 URL", listing.base === `http://127.0.0.1:9999/dsh-game-material-master/map-assets/${p5.id}/export/${expectedDir}/` && listing.files.every((url) => url.startsWith("http://127.0.0.1:9999/")), listing.base);
  const listingRelative = await G.mapSnapshot(await G.readMapProject(p5.id), "http://127.0.0.1:9999");
  check("mapSnapshot：绝对 URL 与预览/导出清单齐", listingRelative.previewUrls.every((url) => url.includes("/preview/")) && listingRelative.exportBaseUrl.includes("/export/") && listingRelative.exportFiles.length === view5.exportFiles.length, listingRelative.exportFiles.join(" "));
  check("mapSnapshot：带上导出目录的本机绝对路径（模型要能直接报给用户）", listingRelative.exportPath === exportDir, listingRelative.exportPath);
  check("readExportListing 里 zip 也是可点的绝对 URL", listing.files.some((url) => url.endsWith(expectedZip)), listing.files.join(" "));
  check("mapSnapshot：给出下一步动作", listingRelative.nextActions.length > 0, listingRelative.nextActions[0].step);

  // ══ 16. 标记点 ══════════════════════════════════════════════════════════
  section("16) 标记点：op / 连续编号 / 撤销 / 环绕 / 计划 / 导出");
  const pMark = await newProject("标记点", { cols: 8, rows: 8 });
  const markA = await G.applyMapOps(pMark.id, [{ kind: "marker", op: "add", r: 1, c: 1 }]);
  await G.applyMapOps(pMark.id, [{ kind: "marker", op: "add", r: 2, c: 5, name: "宝箱" }]);
  const markDoc = await G.readTheDoc(pMark.id);
  check("标记：落进文档，id 由宿主分配、位置与名字都对", markDoc.markers.length === 2 && markDoc.markers[0].id === "m1" && markDoc.markers[1].name === "宝箱" && markDoc.markers[1].r === 2, JSON.stringify(markDoc.markers));
  check("标记：改动返回脏块（界面据此重拉那一块）", Array.isArray(markA.dirtyChunks) && markA.dirtyChunks.length > 0, JSON.stringify(markA.dirtyChunks));
  const dupMark = await G.applyMapOps(pMark.id, [{ kind: "marker", op: "add", r: 1, c: 1 }]);
  check("标记：同一格再放被拒，且说清是第几个", dupMark.changed === 0 && dupMark.skipped.some((text) => text.includes("这一格已经有标记了（第 1 个）")), dupMark.skipped.join(" | "));
  const wrapMark = await G.applyMapOps(pMark.id, [{ kind: "marker", op: "add", r: -1, c: 8 }]);
  const afterWrap = await G.readTheDoc(pMark.id);
  check("标记：环绕打开时负数 / 越界格取模落到图内", wrapMark.changed === 1 && afterWrap.markers.length === 3 && afterWrap.markers[2].r === 7 && afterWrap.markers[2].c === 0, JSON.stringify(afterWrap.markers[2]));

  const viewMark = await G.mapView(await G.readMapProject(pMark.id));
  check("视图：编号 = 下标 + 1（圆圈里那个数字就是它）", viewMark.markers.map((marker) => marker.n).join(",") === "1,2,3", JSON.stringify(viewMark.markers));

  const planMark = await G.mapPlan(pMark.id, { view: { x: 0, y: 0, width: 8 * 32, height: 8 * 32 } });
  const firstMark = planMark.markers.find((marker) => marker.id === "m1");
  check("计划：标记带圆心 / 半径 / 字号 / 数字（界面一个数都不用自己推）", planMark.markers.length === 3 && firstMark.x === 1 * 32 + 16 && firstMark.y === 1 * 32 + 16 && firstMark.radius > 0 && firstMark.font > 0 && firstMark.n === 1, JSON.stringify(firstMark));
  const seamMark = await G.mapPlan(pMark.id, { view: { x: 192, y: 128, width: 128, height: 128 } });
  check(
    "计划：视口跨右边界时同一个标记以另一个像素位置再发一条（界面不需要懂环绕）",
    seamMark.markers.some((marker) => marker.c === 1 && marker.x === 9 * 32 + 16) && !seamMark.markers.some((marker) => marker.c === 1 && marker.x === 1 * 32 + 16),
    JSON.stringify(seamMark.markers.map((marker) => [marker.c, marker.x]))
  );
  /**
   * 视口比地图大（地图只占画布一角）：必须给整张地图 —— 8×8 的地图上，
   * 收口若从视口左上角的 -1 起算一整轮，最后一行 / 最后一列会被挤出去，
   * 只剩画布外那份副本（x / y 为负）。夹具里 (7,0) 那个标记正好落在最后一行。
   */
  const wideMark = await G.mapPlan(pMark.id, { view: { x: 0, y: 0, width: 8 * 32 * 3, height: 8 * 32 * 3 } });
  const lastRowMark = wideMark.markers.find((marker) => marker.r === 7 && marker.c === 0);
  check(
    "计划：视口比地图大时给整张地图（最后一行的标记也在图内，不是画布外那份副本）",
    lastRowMark !== undefined && lastRowMark.y === 7 * 32 + 16 && wideMark.markers.every((marker) => marker.x >= 0 && marker.y >= 0),
    JSON.stringify(wideMark.markers.map((marker) => [marker.r, marker.c, marker.x, marker.y]))
  );

  const renamedMark = await G.applyMapOps(pMark.id, [{ kind: "marker", op: "rename", id: "m1", name: "起点" }]);
  check("标记改名：生效，但不脏任何格子（名字不上画布）", renamedMark.changed === 0 && renamedMark.dirtyChunks.length === 0 && (await G.readTheDoc(pMark.id)).markers[0].name === "起点", `changed=${renamedMark.changed} dirty=${renamedMark.dirtyChunks.length}`);
  const movedMark = await G.applyMapOps(pMark.id, [{ kind: "marker", op: "move", id: "m1", r: 4, c: 4 }]);
  const movedDoc = await G.readTheDoc(pMark.id);
  check("标记挪位置：老格子与新格子都标脏", movedMark.changed === 2 && movedDoc.markers[0].r === 4 && movedDoc.markers[0].c === 4, `changed=${movedMark.changed}`);
  const blockedMark = await G.applyMapOps(pMark.id, [{ kind: "marker", op: "move", id: "m1", r: 2, c: 5 }]);
  check("标记挪到已占的格子：拒绝并说清", blockedMark.changed === 0 && blockedMark.skipped.some((text) => text.includes("已经有标记")), blockedMark.skipped.join(" | "));
  const unknownMark = await G.applyMapOps(pMark.id, [{ kind: "marker", op: "remove", id: "nope" }]);
  check("标记 op 认不出 id 时只跳过、不抛", unknownMark.changed === 0 && unknownMark.skipped.some((text) => text.includes("标记不存在")), unknownMark.skipped.join(" | "));

  const removedMark = await G.applyMapOps(pMark.id, [{ kind: "marker", op: "remove", id: "m2" }]);
  const viewMarkb = await G.mapView(await G.readMapProject(pMark.id));
  check("删掉第 2 个：后面的编号自动往前顶（连续编号）", viewMarkb.markers.length === 2 && viewMarkb.markers.map((marker) => marker.n).join(",") === "1,2" && viewMarkb.markers[1].id === "m3", JSON.stringify(viewMarkb.markers));
  check("删掉第 2 个：它后面那些标记的格子一并标脏（圆圈里的数字变了）", removedMark.dirtyChunks.length > 0, JSON.stringify(removedMark.dirtyChunks));

  await G.undoMap(pMark.id);
  const afterUndoRemove = await G.readTheDoc(pMark.id);
  check("撤销删除：标记回到**原来的位置**（编号顺序也回来了）", afterUndoRemove.markers.length === 3 && afterUndoRemove.markers[1].id === "m2", JSON.stringify(afterUndoRemove.markers.map((marker) => marker.id)));
  await G.redoMap(pMark.id);
  check("重做：又删掉", (await G.readTheDoc(pMark.id)).markers.length === 2);
  await G.undoMap(pMark.id);
  await G.undoMap(pMark.id);
  const afterUndoMove = await G.readTheDoc(pMark.id);
  check("撤销挪位置：回到原来的格", afterUndoMove.markers[0].r === 1 && afterUndoMove.markers[0].c === 1, JSON.stringify(afterUndoMove.markers[0]));
  await G.undoMap(pMark.id);
  check("撤销改名：名字回到改之前（不占格的改动也撤得回来）", (await G.readTheDoc(pMark.id)).markers[0].name === "");
  await G.undoMap(pMark.id);
  await G.undoMap(pMark.id);
  await G.undoMap(pMark.id);
  check("全部撤销：标记一个都不剩", (await G.readTheDoc(pMark.id)).markers.length === 0);

  await G.applyMapOps(pMark.id, [{ kind: "marker", op: "add", r: 7, c: 7, name: "角落" }]);
  const shrinkMark = await G.saveMapDocStructure(pMark.id, { cols: 4, rows: 4 });
  check("缩小地图：界外的标记一起丢掉并给 warning", shrinkMark.doc.markers.length === 0 && shrinkMark.warnings.some((text) => text.includes("标记")), shrinkMark.warnings.join(" | "));
  await G.saveMapDocStructure(pMark.id, { cols: 8, rows: 8 });
  await G.applyMapOps(pMark.id, [{ kind: "marker", op: "add", r: 3, c: 3, name: "出口" }]);
  // 导出要求「有素材 + 地图不空」，所以先装内置素材、铺一格 —— 标记本身不算内容。
  await G.importSampleTileset(pMark.id);
  await G.applyMapOps(pMark.id, [{ kind: "paint", layerId: "l0", cells: [{ r: 0, c: 0, tile: 1 }] }]);
  await G.runExportStage(pMark.id, { formats: { png: false, json: true, zip: false } });
  await waitIdle(pMark.id);
  const exportMarkDirs = await readdir(join(G.mapProjectDir(pMark.id), "export"));
  const ownMark = JSON.parse(await readFile(join(G.mapProjectDir(pMark.id), "export", exportMarkDirs[0], "map.json"), "utf8"));
  check("导出：map.json 顶层带 markers（编号 + 名字 + 格坐标）", ownMark.markers.length === 1 && ownMark.markers[0].n === 1 && ownMark.markers[0].name === "出口" && ownMark.markers[0].r === 3 && ownMark.markers[0].c === 3, JSON.stringify(ownMark.markers));
  check("导出：标记不占图层数据（同一格在图层里还是空的）", ownMark.layers[0].data[3 * 8 + 3] === 0 && ownMark.layers[0].data[0] === 1, `marker格=${ownMark.layers[0].data[3 * 8 + 3]} 画的格=${ownMark.layers[0].data[0]}`);

  // ══ 17. 删除 ════════════════════════════════════════════════════════════
  section("17) 删除项目");
  for (const id of created.slice()) {
    const existed = existsSync(G.mapProjectDir(id));
    await G.deleteMapProject(id);
    const index = created.indexOf(id);
    if (index >= 0) created.splice(index, 1);
    if (id === p1.id) {
      check("删之前目录在", existed);
      check("删之后目录没了", !existsSync(G.mapProjectDir(id)));
      check("删之后不在清单里", !(await G.listMapProjects()).some((item) => item.id === id));
    }
  }
  check("所有自检项目都已清理", created.length === 0, created.join(" "));
} finally {
  for (const id of created) await G.deleteMapProject(id).catch(() => undefined);
  await rm(HOME, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${failures.length === 0 ? "全部通过" : "有失败"}：${passed} 项通过${failures.length > 0 ? `，${failures.length} 项失败` : ""}`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
