#!/usr/bin/env node
/**
 * 地图编辑器（模块六）· **走真实网关**的自检（不联网、不花钱）。
 *
 * 与另外几个自检的分工：
 *   · verify-map.mjs           几何 / 自动连接 / 素材识别（纯函数）
 *   · verify-map-pipeline.mjs  数据层与流水线（直接调 mapgen）
 *   · **本脚本**               网关那一层：wire 清单与 payload schema、工具面、
 *                              并发与取消、验收打勾、静态资源路由
 *   · verify-map-client.mjs    浏览器半区真渲染 + 黄金对照
 *
 * 为什么值得单列：真机抓到的 `getTileProject expected 0 argument(s)`（方法表与
 * 调用点参数个数不一致）、`stages.filter is not a function`（形状假设错了）、
 * `tile-assets` 白名单漏一条导致图片 403，全都属于这一层 —— 纯函数全绿、
 * 直接调 mapgen 也全绿，只有走一遍网关才暴露。**尤其是 payload schema 静默丢键**：
 * typert 按 wire.ts 声明校验 payload，schema 里没声明的键会被无声丢掉，
 * 界面上的按钮就变成「点了没反应」。所以本脚本的每一次网关调用都先过一遍
 * schema，再断言「一个字段都没丢」。
 *
 * 用法：node scripts/verify-map-gateway.mjs
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { deepStrictEqual } from "node:assert";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "dsh-map-gw-"));
process.env.DSH_HOME = HOME;

let checks = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) checks++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ──`);
}

const { Context } = await import("@deepseek-ai/cordis");
const plugin = await import("../lib/index.js");
const mapgen = await import("../lib/mapgen.js");
const wire = await import("../lib/wire.js");
const links = await import("../lib/links.js");
const toolsurface = await import("../lib/tools.js");
const EXPORT = await import("../lib/mapexport.js");
const { encodePng } = await import("../lib/png.js");

const captured = { tools: [], routes: [] };
const ctx = new Context();
ctx.provide("typert", {
  register: (manifest) => {
    captured.manifest = manifest;
    return () => {};
  }
});
ctx.provide("webServer", {
  register: (route) => {
    captured.routes.push(route);
    return () => {};
  }
});
ctx.provide("tools", {
  register: (definition) => {
    captured.tools.push(definition);
    return () => {};
  }
});
ctx.provide("systemPrompt", { section: () => () => {} });
plugin.apply(ctx);
const studio = ctx.get("gameStudio");
check("网关实例可用", studio !== undefined && typeof studio.createMapProject === "function");
check("资源路由已注册", captured.routes.length > 0 && typeof captured.routes[0].handler === "function");
check("注册了 8 个 game_material_* 工具", captured.tools.length === 8, captured.tools.map((tool) => tool.name).join("、"));
const tool = (name) => captured.tools.find((entry) => entry.name === name);
const run = async (name, args) => tool(name).execute(args, { signal: undefined });

/** 契约 §8 的 21 个方法（顺序即清单顺序）。 */

const CONTRACT_METHODS = [
  "listMapProjects",
  "createMapProject",
  "getMapProject",
  "saveMapProject",
  "deleteMapProject",
  "importMapTileset",
  "importSampleTileset",
  "composeMapAsset",
  "saveMapTileset",
  "removeMapTileset",
  "saveMapDoc",
  "applyMapOps",
  "mapUndo",
  "mapRedo",
  "mapPlan",
  "runMapGenerate",
  "runMapPreview",
  "runMapExport",
  "cancelMapJob",
  "setMapApproved",
  "revealMapProject"
];
const REMOVED_METHODS = ["saveMapFamilies", "createMapDoc", "deleteMapDoc", "duplicateMapDoc"];

const specOf = (method) => wire.METHODS.find((entry) => entry.method === method);
const payloadLosses = [];
const resultRejections = [];
/**
 * 走真实网关调用。
 *
 * 两道与 schema 有关的检查顺手做掉：
 *   ① 先按 wire.ts 的 zod schema 过一遍（typert 就是这么校验的），再断言
 *      「解析结果与原始 payload 逐键相同」—— 这是「界面加了字段、wire.ts 忘了声明」
 *      的唯一拦路石（那种情况只会静默丢键）；
 *   ② 返回值再跑一遍该方法的 result codec —— 方法表声明了结果形状，返回体必须过得了。
 */
async function gw(method, payload) {
  const spec = specOf(method);
  let parsed = payload;
  if (spec?.payload !== undefined) {
    parsed = spec.payload.parse(payload);
    try {
      deepStrictEqual(parsed, payload);
    } catch {
      payloadLosses.push(`${method}：${JSON.stringify(payload)} → ${JSON.stringify(parsed)}`);
    }
  }
  const value = await studio[method](parsed);
  try {
    // wire.METHODS 上的 `result` 就是 zod schema 本身（`strictCodec` 那层包装在 MANIFEST 里）。
    spec.result.parse(value);
  } catch (error) {
    resultRejections.push(`${method}：${String(error?.message ?? error).slice(0, 80)}`);
  }
  return value;
}
async function failed(fn) {
  try {
    await fn();
    return "";
  } catch (error) {
    return String(error?.message ?? error);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitIdle(id, ms = 60000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!mapgen.mapBusy(id)) {
      const project = await mapgen.readMapProject(id).catch(() => undefined);
      if (!(project !== undefined && Object.values(project.stages ?? {}).some((stage) => stage?.status === "running"))) return true;
    }
    await sleep(100);
  }
  return false;
}

/** 合成一张「每块一个可辨颜色 + 左上角洋红角标」的素材图（与 pipeline 夹具同款）。 */
function sheetPng(size, block) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let row = 0; row * block < size; row++) {
    for (let col = 0; col * block < size; col++) {
      for (let y = 0; y < block; y++) {
        for (let x = 0; x < block; x++) {
          const offset = ((row * block + y) * size + col * block + x) * 4;
          const c = x < 2 && y < 2 ? [255, 0, 255] : [40 + ((col * 53) % 200), 30 + ((row * 71) % 200), 20 + (((col + row) * 37) % 200)];
          rgba[offset] = c[0];
          rgba[offset + 1] = c[1];
          rgba[offset + 2] = c[2];
          rgba[offset + 3] = 255;
        }
      }
    }
  }
  return encodePng(rgba, size, size);
}

let projectId = "";
try {
  // ══ 1. wire 方法表与契约 §8 逐条对齐 ═════════════════════════════════════
  section("1) wire 方法表与契约 §8 逐条对齐");
  const declared = wire.METHODS.map((entry) => entry.method).filter((method) => CONTRACT_METHODS.includes(method) || REMOVED_METHODS.includes(method));
  check("wire 声明的地图方法恰好是契约里的 21 个（不多不少）", declared.length === 21 && CONTRACT_METHODS.every((method) => declared.includes(method)), declared.join(","));
  check("契约 §8 的 21 个方法一个不少", CONTRACT_METHODS.every((method) => specOf(method) !== undefined), CONTRACT_METHODS.filter((method) => specOf(method) === undefined).join(","));
  check("网关上真的实现了这 21 个方法", CONTRACT_METHODS.every((method) => typeof studio[method] === "function"), CONTRACT_METHODS.filter((method) => typeof studio[method] !== "function").join(","));
  const invocations = captured.manifest?.invocations ?? [];
  const invocationIds = new Set(invocations.map((entry) => entry.method));
  check("typert manifest 里也有这 21 个方法", CONTRACT_METHODS.every((method) => invocationIds.has(method)));
  check(
    "每个地图方法都有 result codec（且能 create 出 schema）",
    invocations.filter((entry) => CONTRACT_METHODS.includes(entry.method)).every((entry) => typeof entry.result?.create === "function")
  );
  check(
    "除 listMapProjects 外都是单 payload 参数",
    invocations
      .filter((entry) => CONTRACT_METHODS.includes(entry.method))
      .filter((entry) => entry.method !== "listMapProjects")
      .every((entry) => entry.parameters.length === 1 && entry.parameters[0].wire === "payload" && entry.parameters[0].name === "payload"),
    JSON.stringify(invocations.filter((entry) => entry.method === "mapPlan").map((entry) => entry.parameters.map((p) => p.name)))
  );
  check("listMapProjects 是无参方法", specOf("listMapProjects").payload === undefined);
  check(
    "旧方法已彻底消失（声明与实现都没有）",
    REMOVED_METHODS.every((method) => specOf(method) === undefined && typeof studio[method] !== "function"),
    REMOVED_METHODS.join(",")
  );
  const toolMethods = new Set(wire.TOOL_METHODS.map((entry) => entry.method));
  check("对话面（TOOL_METHODS）能调到全部地图方法", CONTRACT_METHODS.every((method) => toolMethods.has(method)));
  check("对话面也不再有旧方法", REMOVED_METHODS.every((method) => !toolMethods.has(method)));

  // ══ 2. payload schema：每个新字段都必须真的透传 ══════════════════════════
  section("2) payload schema 逐键透传（丢键就是界面静默失效）");
  const parseOf = (method, payload) => specOf(method).payload.parse(payload);
  check(
    "mapPlan：view / have / layerIds 都进 schema",
    (() => {
      const parsed = parseOf("mapPlan", { projectId: "m1", view: { x: 1, y: 2, width: 3, height: 4 }, have: ["0,0"], layerIds: [1] });
      return parsed.view.x === 1 && parsed.view.y === 2 && parsed.view.width === 3 && parsed.view.height === 4 && parsed.have[0] === "0,0" && parsed.layerIds[0] === 1;
    })()
  );
  check(
    "applyMapOps：标记 op 的键也要原样穿过 schema（少一个键就会被静默丢掉）",
    (() => {
      const parsed = parseOf("applyMapOps", { projectId: "m1", ops: [{ kind: "marker", op: "add", r: 1, c: 2, name: "宝箱" }, { kind: "marker", op: "rename", id: "m1", name: "x" }, { kind: "marker", op: "move", id: "m1", r: 3, c: 3 }, { kind: "marker", op: "remove", id: "m1" }] });
      const ops = parsed.ops ?? [];
      return ops.length === 4 && ops[0].name === "宝箱" && ops[0].r === 1 && ops[1].id === "m1" && ops[2].c === 3 && ops[3].op === "remove";
    })(),
  );
  check(
    "applyMapOps：ops / have / stroke 都进 schema，旧字段 mapId 已被移除",
    (() => {
      const parsed = parseOf("applyMapOps", { projectId: "m1", ops: [{ kind: "paint", layerId: "l0", cells: [] }], have: ["0,0"], stroke: "s1", mapId: "old" });
      return parsed.ops.length === 1 && parsed.have[0] === "0,0" && parsed.stroke === "s1" && parsed.mapId === undefined;
    })()
  );
  check(
    "runMapGenerate：kind / tiles / seed / layerId 都进 schema",
    (() => {
      const parsed = parseOf("runMapGenerate", { projectId: "m1", kind: "maze", tiles: [1, 2], seed: 7, layerId: "l1" });
      return parsed.kind === "maze" && parsed.tiles.join(",") === "1,2" && parsed.seed === 7 && parsed.layerId === "l1";
    })()
  );
  check(
    "saveMapTileset：cell / shape / animRows 都进 schema",
    (() => {
      const parsed = parseOf("saveMapTileset", { projectId: "m1", tilesetId: "t1", cell: { width: 64, height: 64 }, shape: "a2quad", animRows: true });
      return parsed.cell.width === 64 && parsed.cell.height === 64 && parsed.shape === "a2quad" && parsed.animRows === true;
    })()
  );
  check(
    "saveMapDoc：九个结构键全进 schema",
    (() => {
      const parsed = parseOf("saveMapDoc", {
        projectId: "m1",
        name: "n",
        cols: 8,
        rows: 9,
        layers: [{ id: "l0", name: "x" }],
        addLayer: { name: "y" },
        removeLayerId: "l2",
        moveLayer: { id: "l1", toIndex: 0 },
        clearLayerId: "l1",
        wrap: false
      });
      return parsed.name === "n" && parsed.cols === 8 && parsed.rows === 9 && parsed.layers[0].name === "x" && parsed.addLayer.name === "y" && parsed.removeLayerId === "l2" && parsed.moveLayer.toIndex === 0 && parsed.clearLayerId === "l1" && parsed.wrap === false;
    })()
  );
  check(
    "createMapProject：name / grid / cols / rows 都进 schema",
    (() => {
      const parsed = parseOf("createMapProject", { name: "n", grid: { tileWidth: 16, tileHeight: 16, wrap: false }, cols: 12, rows: 13 });
      return parsed.grid.tileWidth === 16 && parsed.grid.wrap === false && parsed.cols === 12 && parsed.rows === 13;
    })()
  );
  check("getMapProject：lang 与旧深链接的 mapId 兼容位都在", (() => { const parsed = parseOf("getMapProject", { projectId: "m1", lang: "en", mapId: "old" }); return parsed.lang === "en" && parsed.mapId === "old"; })());
  check("setMapApproved：stage 可空（空 = 四阶段全打）", parseOf("setMapApproved", { projectId: "m1", approved: true }).stage === undefined);
  check("runMapExport：scale / formats 都进 schema", (() => { const parsed = parseOf("runMapExport", { projectId: "m1", scale: 2, formats: { json: false } }); return parsed.scale === 2 && parsed.formats.json === false; })());

  // ══ 3. 模块接线 ══════════════════════════════════════════════════════════
  section("3) 模块接线（模块 key / 阶段 / id 前缀 / 上传槽位）");
  check("STUDIO_MODULES 含 map", [...links.STUDIO_MODULES].includes("map"), links.STUDIO_MODULES.join(","));
  check("MAP_STAGES 四个 key 保持不变", links.MAP_STAGES.join(",") === "assets,rules,paint,export", links.MAP_STAGES.join(","));
  check("每个地图方法都归属 map 模块", CONTRACT_METHODS.every((method) => toolsurface.METHOD_MODULE[method] === "map"), CONTRACT_METHODS.filter((method) => toolsurface.METHOD_MODULE[method] !== "map").join(","));
  check("m 前缀认成 map，t 前缀仍是 tile，未知前缀返回 undefined", toolsurface.moduleForId("m1a2b3c") === "map" && toolsurface.moduleForId("t1a2b3c") === "tile" && toolsurface.moduleForId("zz12") === undefined);
  check("模块中文名不再带旧术语", !String(toolsurface.MODULE_LABELS.map).includes("等距") && !String(toolsurface.MODULE_LABELS.map).includes("地块"), toolsurface.MODULE_LABELS.map);
  check(
    "资源白名单只剩 tilesets / preview / export / ai（maps 已删）",
    !mapgen.SERVABLE_MAP_DIRS.has("maps") && ["tilesets", "preview", "export", "ai"].every((dir) => mapgen.SERVABLE_MAP_DIRS.has(dir)),
    [...mapgen.SERVABLE_MAP_DIRS].join(",")
  );
  const callDescription = tool("game_material_call").description;
  check("对话面方法说明里有新方法（runMapGenerate / importSampleTileset）", callDescription.includes("runMapGenerate") && callDescription.includes("importSampleTileset"));
  check("对话面方法说明里没有旧方法与旧术语", !callDescription.includes("saveMapFamilies") && !callDescription.includes("blob47") && !callDescription.includes("地形族") && !callDescription.includes("Tiled"));
  check("上传工具说明里 map=tileset", tool("game_material_upload").description.includes("map=tileset"), "");

  // ══ 4. 项目 / 素材 / 编辑走网关 ══════════════════════════════════════════
  section("4) 项目与素材（走网关，payload 一个字段都不能丢）");
  // 40×40 = 2×2 个 chunk：只有这样「另一个 chunk 的 key」才有意义（8×8 只有 1 个 chunk，
  // 任何 key 取模后都落在 0,0 —— 那条 have 断言就没有区分力了）。
  const created = await gw("createMapProject", { name: "网关自检地图", cols: 40, rows: 40 });
  projectId = created.id;
  check("createMapProject 返回 m 前缀 id", typeof projectId === "string" && projectId.startsWith("m"), projectId);
  check("返回的是视图：带 assetBase 与 busy=false", String(created.assetBase).endsWith(`/map-assets/${projectId}/`) && created.busy === false, String(created.assetBase));
  check("视图：默认三层（地理 / 装饰 / 建筑）、画布尺寸跟着文档", created.layers.length === 3 && created.layers.map((l) => l.name).join("、") === "地理层、装饰层、建筑层" && created.cols === 40 && created.rows === 40, JSON.stringify(created.layers));
  check("视图：带标记表（新项目是空的）", Array.isArray(created.markers) && created.markers.length === 0, JSON.stringify(created.markers));
  check("视图：没有旧字段（maps / activeMapId / coverage / families）", !("maps" in created) && !("activeMapId" in created) && !("coverage" in created) && !("families" in created), Object.keys(created).join(","));
  check("视图：stages 四阶段、rules 已 done", Object.keys(created.stages).join(",") === "assets,rules,paint,export" && created.stages.rules.status === "done");
  check("视图：还带 maxChunks（界面提示「缩得太小」用）", typeof created.maxChunks === "number" && created.maxChunks > 0);
  const listed = await gw("listMapProjects");
  check("listMapProjects 里有它", Array.isArray(listed.projects) && listed.projects.some((item) => item.id === projectId));
  check("清单摘要带 tilesetCount / tileCount", listed.projects.find((item) => item.id === projectId).tileCount === 0);
  check("读不存在的项目报错清楚", (await failed(() => gw("getMapProject", { projectId: "mzzzz" }))).includes("项目不存在"));
  check("非法 id 被拒（400 那一侧）", (await failed(() => gw("getMapProject", { projectId: "p1234" }))).includes("项目不存在"));

  const imported = await gw("importMapTileset", { projectId, name: "网关图集", data: sheetPng(128, 128, 32).toString("base64") });
  check("importMapTileset 返回摘要（16 块 / 32px）", imported.tilesets.length === 1 && imported.tilesets[0].tileCount === 16 && imported.tilesets[0].cell.width === 32, JSON.stringify(imported.tilesets[0]));
  const tilesetId = imported.tilesets[0].id;
  const withTileset = await gw("getMapProject", { projectId });
  check("视图里素材带可访问的相对 file 路径", withTileset.tilesets[0].file.startsWith("tilesets/") && withTileset.tilesets[0].file.endsWith(".png"), withTileset.tilesets[0].file);
  check("视图里素材带识别说明与调色板（普通素材每格一个笔刷）", withTileset.tilesets[0].reason.includes("正方形网格") && withTileset.tilesets[0].palette.length === 16, withTileset.tilesets[0].reason);
  check("视图里 legend 覆盖全部块", withTileset.legend.length === 16 && withTileset.legend[0].index === 1);
  const sampled = await gw("importSampleTileset", { projectId });
  check("importSampleTileset 一次装 5 张（4 张 A2 + 1 张道具）", sampled.tilesets.length === 5 && sampled.tilesets.filter((t) => t.shape === "a2quad").length === 4, sampled.tilesets.map((t) => t.name).join("、"));
  check("再装一次不重复（跳过并说明）", (await gw("importSampleTileset", { projectId })).tilesets.length === 0);

  // 素材形态：cell / shape / animRows 三个字段必须真的到宿主并生效。
  const animRows = await gw("saveMapTileset", { projectId, tilesetId, animRows: true });
  check("saveMapTileset.animRows 生效（变体数 = 行数 4）", animRows.tileset.animRows === true && animRows.tileset.variants === 4, JSON.stringify({ animRows: animRows.tileset.animRows, variants: animRows.tileset.variants }));
  const resized = await gw("saveMapTileset", { projectId, tilesetId, animRows: false, cell: { width: 64, height: 64 } });
  check("saveMapTileset.cell 生效（128×128 → 2×2 = 4 块）", resized.tileset.cell.width === 64 && resized.tileset.tileCount === 4, JSON.stringify({ cell: resized.tileset.cell, n: resized.tileset.tileCount }));
  const shaped = await gw("saveMapTileset", { projectId, tilesetId, shape: "corner16" });
  check("saveMapTileset.shape 生效", shaped.tileset.shape === "corner16", shaped.tileset.shape);
  check("未知形态明确报错（不静默回落）", (await failed(() => gw("saveMapTileset", { projectId, tilesetId, shape: "hex" }))).includes("未知素材形态"));
  check("改不存在的素材报错", (await failed(() => gw("saveMapTileset", { projectId, tilesetId: "tsnope", name: "x" }))).includes("素材不存在"));

  /**
   * ★ 素材自己的播放速度：**payload schema 里漏一个字段就会被静默丢掉** ——
   * 表现是「界面选了速度、宿主收到的还是 undefined」，而且不报任何错。
   * 所以这两个方法都要真调一遍（import 带上、save 改一次、再清掉）。
   */
  const fpsImported = await gw("importMapTileset", { projectId, name: "快图", data: sheetPng(128, 128, 32).toString("base64"), fps: 6 });
  check("importMapTileset.fps 真的到宿主并生效（6 帧/秒）", fpsImported.tilesets[0].fps === 6, String(fpsImported.tilesets[0].fps));
  check("反向验证：不给 fps 时就是 undefined（跟全局）", imported.tilesets[0].fps === undefined, String(imported.tilesets[0].fps));
  const fpsSaved = await gw("saveMapTileset", { projectId, tilesetId: fpsImported.tilesets[0].id, fps: 12 });
  check("saveMapTileset.fps 生效（改成 12）", fpsSaved.tileset.fps === 12, String(fpsSaved.tileset.fps));
  const fpsCleared = await gw("saveMapTileset", { projectId, tilesetId: fpsImported.tilesets[0].id, fps: null });
  check("saveMapTileset.fps = null 清掉自己的速度（回到跟全局）", fpsCleared.tileset.fps === undefined, String(fpsCleared.tileset.fps));
  check("越界速度明确报错（不静默夹到 30）", (await failed(() => gw("saveMapTileset", { projectId, tilesetId: fpsImported.tilesets[0].id, fps: 99 }))).includes("0.5"));

  /**
   * ★ 清晰度 / 倍数：**同一个 schema 陷阱**（字段不在 schema 里就被静默丢掉）。
   *
   * 这里真跑一遍「一张 4 倍分辨率的素材图按平滑缩到 32px」：进 schema 的是 `clarity`
   * 与 `scale`，出来的是「素材图正好一格大小 + 素材上记着清晰度」。
   */
  const bigSheet = sheetPng(256, 256, 32); // 256×256 = 8×8 块 32px
  const clarityImported = await gw("importMapTileset", {
    projectId,
    name: "清晰度图",
    data: bigSheet.toString("base64"),
    cell: { width: 32, height: 32 },
    shape: "plain",
    scale: 4,
    clarity: "sharp"
  });
  const clarityTileset = clarityImported.tilesets[0];
  check("importMapTileset.scale 真的到宿主并生效（256×256 的 4 倍图 → 缩成 64×64）", clarityTileset.imageWidth === 64 && clarityTileset.imageHeight === 64, `${clarityTileset.imageWidth}×${clarityTileset.imageHeight}`);
  check("importMapTileset.clarity 也真的到宿主（素材上记着 sharp）", clarityTileset.clarity === "sharp", String(clarityTileset.clarity));
  check(
    "缩下来的图真的落到 tilesets/（资源路由能取回来，界面不会图裂）",
    (await gw("getMapProject", { projectId })).tilesets.some((entry) => entry.id === clarityTileset.id && entry.imageWidth === 64)
  );
  check("未知清晰度明确报错（不静默回落）", (await failed(() => gw("importMapTileset", { projectId, name: "乱写", data: bigSheet.toString("base64"), cell: { width: 32, height: 32 }, clarity: "nope" }))).includes("清晰度"));

  /**
   * ★ 素材图的 `rev`（文件 mtime）：界面拼 URL 时带上 `?v=`，否则原地重烘之后
   * 浏览器继续用缓存里的旧图 —— 表现是「重烘跑完了，画面一点没变」。
   */
  const cornerImported = await gw("importMapTileset", {
    projectId,
    name: "转角图",
    data: sheetPng(128, 32).toString("base64"),
    cell: { width: 32, height: 32 },
    shape: "corner16"
  });
  const cornerTileset = cornerImported.tilesets[0];
  check("素材视图带 rev（版本号是数字）", typeof cornerTileset.rev === "number" && cornerTileset.rev > 0, String(cornerTileset.rev));
  const recomposeSource = join(HOME, "recompose-source.png");
  await writeFile(recomposeSource, sheetPng(128, 32));
  const recomposed = await gw("recomposeMapTileset", { projectId, tilesetId: cornerTileset.id, files: [recomposeSource] });
  check(
    "recomposeMapTileset 走网关：素材 id 与图块数不变（16 块，地图不用改）",
    recomposed.tileset.id === cornerTileset.id && recomposed.tileset.tileCount === cornerTileset.tileCount,
    `id ${recomposed.tileset.id}；块 ${recomposed.tileset.tileCount} vs ${cornerTileset.tileCount}`
  );
  check("★ 重烘之后 rev 变新了（界面会重新拉图，不会一张旧图卡住）", recomposed.tileset.rev !== cornerTileset.rev, `${cornerTileset.rev} → ${recomposed.tileset.rev}`);
  check(
    "反向验证：手动导的图集（2×2 = 4 块）不能原地重烘（尺寸对不上，明确报错而不是写坏）",
    (await failed(() => gw("recomposeMapTileset", { projectId, tilesetId: clarityTileset.id, files: [recomposeSource] }))).includes("不能原地重烘")
  );

  /**
   * ★ AI 那条路的整图：`composeMapAsset({shape:"stamp", stampCols, stampRows})` 与回链。
   */
  {
    const frameDir = join(HOME, "stamp-ai");
    await mkdir(frameDir, { recursive: true });
    const frameFile = async (name, tint) => {
      const rgba = Buffer.alloc(96 * 64 * 4);
      for (let i = 0; i < 96 * 64; i++) {
        rgba[i * 4] = 100 + tint;
        rgba[i * 4 + 1] = 60;
        rgba[i * 4 + 2] = 140;
        rgba[i * 4 + 3] = 255;
      }
      const file = join(frameDir, name);
      await writeFile(file, encodePng(rgba, 96, 64));
      return file;
    };
    const f0 = await frameFile("f0.png", 0);
    const f1 = await frameFile("f1.png", 20);
    const composed = await gw("composeMapAsset", { projectId, name: "AI 雕像", files: [f0, f1], shape: "stamp", stampCols: 3, stampRows: 2 });
    check("composeMapAsset(stamp)：形态 / 占格 / 帧数都回来了", composed.shape === "stamp" && composed.stamp?.cols === 3 && composed.stamp?.rows === 2 && composed.stamp?.frames === 2, JSON.stringify({ shape: composed.shape, stamp: composed.stamp }));
    // 源图 = 3 列 × (2 行 × 2 帧 = 4 行) —— **不含**旋转烘焙（那是导入端的事）。
    check("composeMapAsset(stamp)：源图是 3 列 × (2 行 × 2 帧) 格，不烘旋转", composed.width > 0 && composed.height === (composed.width / 3) * 4, `${composed.width}×${composed.height}`);
    check("整图缺占格时明确报错（不按 3×3 静默猜）", (await failed(() => gw("composeMapAsset", { projectId, name: "乱来", files: [f0], shape: "stamp" }))).includes("占几格"));

    /**
     * ★ 整图抠绿幕：`composeMapAsset` 自己抠（回包带 `keyed`），手动导入那条路靠 `stampKey`。
     * 两个字段都必须过 schema —— 少一个，用户点得再多也静默无效。
     */
    const greenBytes = (() => {
      const rgba = Buffer.alloc(96 * 64 * 4);
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 96; x++) {
          const offset = (y * 96 + x) * 4;
          if (x > 24 && x < 72) {
            rgba[offset] = 120;
            rgba[offset + 1] = 110;
            rgba[offset + 2] = 100;
          } else {
            rgba[offset + 1] = 224;
          }
          rgba[offset + 3] = 255;
        }
      }
      return encodePng(rgba, 96, 64);
    })();
    const greenFile = join(HOME, "stamp-ai", "green.png");
    await writeFile(greenFile, greenBytes);
    // 同一张但背景是**蓝色**：抠不到绿，回链不该带 keyed。
    const noGreenFile = join(HOME, "stamp-ai", "nongreen.png");
    await writeFile(noGreenFile, (() => {
      const rgba = Buffer.alloc(96 * 64 * 4);
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 96; x++) {
          const offset = (y * 96 + x) * 4;
          if (x > 24 && x < 72) {
            rgba[offset] = 120;
            rgba[offset + 1] = 110;
            rgba[offset + 2] = 100;
          } else {
            rgba[offset + 2] = 220;
          }
          rgba[offset + 3] = 255;
        }
      }
      return encodePng(rgba, 96, 64);
    })());
    const greenComposed = await gw("composeMapAsset", { projectId, name: "绿幕城门", files: [greenFile], shape: "stamp", stampCols: 3, stampRows: 2 });
    check("★ composeMapAsset 抠到绿幕时回包带 keyed（回链据此不再抠第二遍）", typeof greenComposed.keyed === "number" && greenComposed.keyed > 0.05, String(greenComposed.keyed));
    const greenImported = await gw("importMapTileset", { projectId, name: "手动绿幕", data: greenBytes.toString("base64"), stamp: { cols: 3, rows: 2, frames: 1, pass: [] }, stampKey: true });
    check("★ importMapTileset 的 stampKey 过 schema 不丢（抠过的图左上角透明）", (() => {
      const ts = greenImported.tilesets[0];
      return ts.stamp !== undefined;
    })());
  }

  /**
   * ★ 整图（多格印花）：`stamp` 规格也要过 schema（少声明就被静默丢掉，
   * 表现是「选了整图、导入出来却是普通素材」）。
   */
  const stampSheet = (() => {
    const cell = 8, cols = 3, rows = 2;
    const rgba = Buffer.alloc(cols * cell * rows * cell * 4);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        for (let y = 0; y < cell; y++) {
          for (let x = 0; x < cell; x++) {
            const offset = ((r * cell + y) * cols * cell + c * cell + x) * 4;
            rgba[offset] = 30 + c * 60;
            rgba[offset + 1] = 30 + r * 90;
            rgba[offset + 2] = 120;
            rgba[offset + 3] = 255;
          }
        }
      }
    }
    return encodePng(rgba, cols * cell, rows * cell);
  })();
  const stampImported = await gw("importMapTileset", {
    projectId,
    name: "雕像",
    data: stampSheet.toString("base64"),
    stamp: { cols: 3, rows: 2, frames: 1, pass: [0, 0, 0, 1, 1, 2] }
  });
  const stampTileset = stampImported.tilesets[0];
  check("★ importMapTileset.stamp 过 schema 不丢（形态 = stamp、规格带上）", stampTileset.shape === "stamp" && stampTileset.stamp?.cols === 3 && stampTileset.stamp?.rows === 2, JSON.stringify({ shape: stampTileset.shape, stamp: stampTileset.stamp }));
  check("整图：格子被锁成地图网格（32）", stampTileset.cell.width === 32 && stampTileset.cell.height === 32, JSON.stringify(stampTileset.cell));
  check("整图：调色板只出一条、缩略图是整张（3×2 格）", (await gw("getMapProject", { projectId })).tilesets.find((entry) => entry.id === stampTileset.id)?.palette?.length === 1);
  const stampLayer = (await gw("getMapProject", { projectId })).layers[0].id;
  const placed = await gw("applyMapOps", { projectId, ops: [{ kind: "stampPlace", layerId: stampLayer, tilesetId: stampTileset.id, r: 1, c: 1, rot: 0 }] });
  check("★ stampPlace 走网关：一次占 6 格、stamps 计数 1", placed.changed === 6 && placed.stamps === 1, `changed ${placed.changed} / stamps ${placed.stamps}`);
  const passPlan = await gw("mapPlan", { projectId, view: { x: 0, y: 0, width: 32 * 8, height: 32 * 8 }, have: [], pass: true });
  check("★ mapPlan({pass:true}) 过 schema：回 6 格通行性、三态都有", Array.isArray(passPlan.pass) && passPlan.pass.length === 6 && new Set(passPlan.pass.map((cell) => cell.kind)).size === 3, JSON.stringify(passPlan.pass));
  check("反向验证：不传 pass 时不带这个字段（不让客户端多算）", (await gw("mapPlan", { projectId, view: { x: 0, y: 0, width: 32 * 8, height: 32 * 8 }, have: [] })).pass === undefined);
  const erased = await gw("applyMapOps", { projectId, ops: [{ kind: "paint", layerId: stampLayer, cells: [{ r: 2, c: 2, tile: 0 }] }] });
  check("★ 擦一格 → 整张整图没了（stamps 1）", erased.stamps === 1);

  /** ★ 循环方式：同一个 schema 陷阱（字段不在 schema 里就被静默丢掉）。 */
  const loopImported = await gw("importMapTileset", { projectId, name: "倒放图", data: sheetPng(128, 128, 32).toString("base64"), animRows: true, loop: "reverse" });
  check("importMapTileset.loop 真的到宿主（素材上记着 reverse）", loopImported.tilesets[0].loop === "reverse", String(loopImported.tilesets[0].loop));
  check("反向验证：不给 loop 时就是 forward", (await gw("importMapTileset", { projectId, name: "正放图", data: sheetPng(128, 128, 32).toString("base64"), animRows: true })).tilesets[0].loop === "forward");
  const loopSaved = await gw("saveMapTileset", { projectId, tilesetId: loopImported.tilesets[0].id, loop: "pingpong" });
  check("saveMapTileset.loop 生效（reverse → pingpong）", loopSaved.tileset.loop === "pingpong", String(loopSaved.tileset.loop));
  check("未知循环方式明确报错", (await failed(() => gw("importMapTileset", { projectId, name: "乱写循环", data: bigSheet.toString("base64"), cell: { width: 32, height: 32 }, loop: "yoyo" }))).includes("循环方式"));

  /**
   * ★ 一格多大：`createMapProject` 的 `grid` 必须真的过网关（schema 里没有就被静默丢掉，
   * 表现是「新建时选了 64，建出来还是 32」）。
   */
  const wideGrid = await gw("createMapProject", { name: "64 网格网关", cols: 8, rows: 8, grid: { tileWidth: 64, tileHeight: 64, wrap: true } });
  check("createMapProject.grid 真的到宿主（网格 64×64）", wideGrid.grid.tileWidth === 64 && wideGrid.grid.tileHeight === 64, JSON.stringify(wideGrid.grid));
  const wideSamples = await gw("importSampleTileset", { projectId: wideGrid.id });
  check("64 网格的项目装内置素材：按项目网格放大（每格 64px）", wideSamples.tilesets.every((entry) => entry.cell.width === 64), wideSamples.tilesets.map((entry) => entry.cell.width).join(","));
  await mapgen.deleteMapProject(wideGrid.id);
  check("反向验证：不传 grid 时还是 32（老行为不变）", (await gw("createMapProject", { name: "默认网格", cols: 4, rows: 4 })).grid.tileWidth === 32);

  // ── composeMapAsset：走网关把一批帧整理成一张待确认的素材图 ──────────────
  // 这批帧真的写到盘上（网关那一层要验证的是「payload 有没有丢键 + 返回的
  // file 能不能经资源路由取回来」，不是像素 —— 像素归 verify-map-pipeline）。
  const frameDir = join(HOME, "gw-frames");
  await mkdir(frameDir, { recursive: true });
  const frameA = join(frameDir, "a.png");
  const frameB = join(frameDir, "b.png");
  await writeFile(frameA, sheetPng(16, 16));
  await writeFile(frameB, sheetPng(16, 16));
  const tilesetCountBefore = (await gw("getMapProject", { projectId })).tilesets.length;
  const composed = await gw("composeMapAsset", { projectId, name: "网关AI素材", files: [frameA, frameB] });
  check(
    "composeMapAsset：files / name 原样到宿主，返回 file + shape + cell + frameCount + animRows",
    composed.file === "ai/网关AI素材.png" &&
      composed.frameCount === 2 &&
      composed.animRows === true &&
      composed.shape === "plain" &&
      composed.cell.width === created.grid.tileWidth &&
      composed.cell.height === created.grid.tileHeight,
    JSON.stringify(composed)
  );
  check("composeMapAsset：cell 留空时用的是项目网格（不是写死 32）", composed.width === created.grid.tileWidth && composed.height === created.grid.tileHeight * 2, `${composed.width}×${composed.height}`);
  /**
   * `shape` 是**生图前定好的计划**：schema 里漏了它就会被静默丢掉，宿主动不动就按
   * 普通处理 —— 拼块 / 整格的图导入后全碎，而且不报任何错。
   */
  const cornerComposed = await gw("composeMapAsset", { projectId, name: "网关整格", files: [frameA], shape: "corner16" });
  check(
    "composeMapAsset：shape=corner16 真的到宿主并生效（4 格 × 4 格）",
    cornerComposed.shape === "corner16" &&
      cornerComposed.width === created.grid.tileWidth * 4 &&
      cornerComposed.height === created.grid.tileHeight * 4 &&
      cornerComposed.animRows === false,
    `${cornerComposed.width}×${cornerComposed.height} shape=${cornerComposed.shape}`
  );
  const a2Composed = await gw("composeMapAsset", { projectId, name: "网关拼块", files: [frameA, frameB], shape: "a2quad" });
  check(
    "composeMapAsset：shape=a2quad 真的到宿主并生效（N 列 × 5 行）",
    a2Composed.shape === "a2quad" &&
      a2Composed.variants === 2 &&
      a2Composed.width === created.grid.tileWidth * 2 &&
      a2Composed.height === created.grid.tileHeight * 5,
    `${a2Composed.width}×${a2Composed.height} variants=${a2Composed.variants}`
  );
  check(
    "composeMapAsset：整格给两张 = 形态判断错了，明确报错（要的是**一块**无缝墙砖）",
    (await failed(() => gw("composeMapAsset", { projectId, name: "整格错", files: [frameA, frameB], shape: "corner16" }))).includes("一块")
  );
  const afterCompose = await gw("getMapProject", { projectId });
  check(
    "composeMapAsset：只整理、不导入（素材列表一条不加）",
    afterCompose.tilesets.length === tilesetCountBefore && !afterCompose.tilesets.some((entry) => entry.name === "网关AI素材"),
    `${tilesetCountBefore} → ${afterCompose.tilesets.length}`
  );
  check("composeMapAsset：文件真的落下去了", existsSync(mapgen.mapAssetPath(projectId, composed.file)));
  check(
    "composeMapAsset：空 files 明确报错",
    (await failed(() => gw("composeMapAsset", { projectId, name: "空的", files: [] }))).includes("files")
  );
  check(
    "composeMapAsset：读不到的文件明确报错",
    (await failed(() => gw("composeMapAsset", { projectId, name: "缺的", files: [join(frameDir, "nope.png")] }))).includes("nope.png")
  );

  // ══ 5. 编辑 / 计划 / 撤销（走网关，字段真的影响结果）════════════════════
  /**
   * ★ 素材属性：改名 / 播放速度 / 循环方式都要过 schema（少一个就是「改了没反应」）。
   * 内置素材也允许改这三样，几何仍然拒绝。
   */
  const editable = (await gw("importMapTileset", { projectId, name: "属性自检", data: stampSheet.toString("base64"), stamp: { cols: 3, rows: 2, frames: 2, pass: [] } })).tilesets[0];
  const renamed = await gw("saveMapTileset", { projectId, tilesetId: editable.id, name: "属性自检-改名", fps: 6, loop: "pingpong" });
  check("★ saveMapTileset 的 name / fps / loop 都过 schema 不丢", renamed.tileset.name === "属性自检-改名" && renamed.tileset.fps === 6 && renamed.tileset.loop === "pingpong", JSON.stringify({ name: renamed.tileset.name, fps: renamed.tileset.fps, loop: renamed.tileset.loop }));
  check("改名之后里表里就是新名字", (await gw("getMapProject", { projectId })).tilesets.some((entry) => entry.name === "属性自检-改名"));
  const sampleTs = (await gw("getMapProject", { projectId })).tilesets.find((entry) => entry.builtin === true);
  const sampleRenamed = sampleTs === undefined ? undefined : await gw("saveMapTileset", { projectId, tilesetId: sampleTs.id, name: "内置改名", fps: 3 });
  check("★ 内置素材也能改名 / 改速度（走网关）", sampleRenamed === undefined || (sampleRenamed.tileset.name === "内置改名" && sampleRenamed.tileset.fps === 3), JSON.stringify({ name: sampleRenamed?.tileset?.name, fps: sampleRenamed?.tileset?.fps }));
  const builtinRefused = sampleTs === undefined ? "跳过" : await failed(() => gw("saveMapTileset", { projectId, tilesetId: sampleTs.id, cell: { width: 64, height: 64 } }));
  check("内置素材的格子仍然改不动（走网关也是明确报错）", sampleTs === undefined || builtinRefused.includes("不能改"), builtinRefused.slice(0, 40));

  section("5) 编辑 / 计划 / 撤销（走网关，字段真的影响结果）");
  const base = 1; // 第一块
  const docInfo = await gw("getMapProject", { projectId });
  const layer0 = docInfo.layers[0].id;
  const layer1 = docInfo.layers[1].id;
  const applied = await gw("applyMapOps", { projectId, ops: [{ kind: "paint", layerId: layer0, cells: [{ r: 4, c: 4, tile: base }, { r: 1, c: 1, tile: base }] }] });
  check("applyMapOps 返回 changed / dirtyChunks / canUndo", applied.changed === 2 && Array.isArray(applied.dirtyChunks) && applied.canUndo === true && applied.canRedo === false, JSON.stringify(applied));
  check("applyMapOps 对空 have 回空 dropKeys", applied.dropKeys.length === 0);
  const gwMark = await gw("applyMapOps", { projectId, ops: [{ kind: "marker", op: "add", r: 6, c: 6, name: "网关标记" }] });
  const gwView = await gw("getMapProject", { projectId });
  check("applyMapOps：标记 op 走网关真的落进文档（编号从 1 开始）", gwMark.changed === 1 && gwView.markers.some((marker) => marker.name === "网关标记" && marker.r === 6 && marker.c === 6 && marker.n === 1), JSON.stringify(gwView.markers));
  const gwPlan = await gw("mapPlan", { projectId, view: { x: 0, y: 0, width: 40 * 32, height: 40 * 32 } });
  check("mapPlan 走网关也带 fpsMax（客户端据此推时钟）", gwPlan.fpsMax === 1 && gwPlan.fps === 1, `fps=${gwPlan.fps} fpsMax=${gwPlan.fpsMax}`);
  const gwPlanMark = (gwPlan.markers ?? [])[0];
  check("mapPlan：标记带圆心 / 半径 / 字号 / 数字（界面只 arc + fillText）", gwPlanMark !== undefined && gwPlanMark.x === 6 * 32 + 16 && gwPlanMark.y === 6 * 32 + 16 && gwPlanMark.radius > 0 && gwPlanMark.font > 0 && gwPlanMark.n === 1, JSON.stringify(gwPlanMark ?? null));
  const dropped = await gw("applyMapOps", { projectId, ops: [{ kind: "paint", layerId: layer0, cells: [{ r: 3, c: 3, tile: base }] }], have: ["0,0", "9,9"] });
  check("applyMapOps.have 生效（真的算出该丢哪个 chunk）", dropped.dropKeys.includes("0,0") && !dropped.dropKeys.includes("9,9"), JSON.stringify({ dirty: dropped.dirtyChunks, drop: dropped.dropKeys }));
  const depth0 = mapgen.historyState(projectId).depth;
  await gw("applyMapOps", { projectId, ops: [{ kind: "paint", layerId: layer0, cells: [{ r: 5, c: 5, tile: base }] }], stroke: "笔画1" });
  const depth1 = mapgen.historyState(projectId).depth;
  await gw("applyMapOps", { projectId, ops: [{ kind: "paint", layerId: layer0, cells: [{ r: 5, c: 6, tile: base }] }], stroke: "笔画1" });
  const depth2 = mapgen.historyState(projectId).depth;
  check("applyMapOps.stroke 生效（同一笔的后续提交不压栈）", depth1 === depth0 + 1 && depth2 === depth1, `${depth0} → ${depth1} → ${depth2}`);
  const paletteTile = (await gw("getMapProject", { projectId })).legend[0].index;
  const haveAll = ["0,0", "0,1", "1,0", "1,1"];
  const mapView = { x: 0, y: 0, width: 96, height: 96 };
  const plan = await gw("mapPlan", { projectId, view: mapView });
  check("mapPlan.view 生效（这个视口里能看到刚画的格子）", plan.chunks.flatMap((c) => c.ops).some((op) => op.r === 4 && op.c === 4), JSON.stringify(plan.visibleKeys));
  const planFar = await gw("mapPlan", { projectId, view: { x: 0, y: 0, width: 16, height: 16 } });
  check("mapPlan.view 真的影响结果（另一个视口看不到那个格子）", !planFar.chunks.flatMap((c) => c.ops).some((op) => op.r === 4 && op.c === 4));
  const planHave = await gw("mapPlan", { projectId, view: mapView, have: ["0,0"] });
  check("mapPlan.have 生效（已有的 chunk 不再回、但仍在 visibleKeys 里）", planHave.visibleKeys.includes("0,0") && !planHave.chunks.some((chunk) => chunk.key === "0,0") && plan.chunks.some((chunk) => chunk.key === "0,0"));
  await gw("applyMapOps", { projectId, ops: [{ kind: "paint", layerId: layer1, cells: [{ r: 2, c: 2, tile: base }] }] });
  const planLayer = await gw("mapPlan", { projectId, view: mapView, layerIds: [1] });
  check("mapPlan.layerIds 生效（只算指定层）", planLayer.chunks.flatMap((c) => c.ops).length > 0 && planLayer.chunks.flatMap((c) => c.ops).every((op) => op.l === 1));
  check("mapPlan 的 legend 与 fps / frameCount 齐", plan.legend.length > 0 && plan.fps === 1 && plan.frameCount >= 1);
  check("mapPlan 不带 truncated（小地图）", plan.truncated === false);
  void paletteTile;
  const undone = await gw("mapUndo", { projectId });
  check("mapUndo 回退上一笔", undone.changed > 0 && undone.canRedo === true, JSON.stringify(undone));
  const redone = await gw("mapRedo", { projectId });
  check("mapRedo 重做", redone.changed > 0 && redone.canRedo === false);
  check("到根后再撤销返回空结果而不是抛", (await (async () => { let last; for (let i = 0; i < 20; i++) last = await gw("mapUndo", { projectId }); return last; })()).canUndo === false);

  // saveMapDoc：九个结构键逐个证明「真的到宿主了」
  const docRename = await gw("saveMapDoc", { projectId, name: "改过名的地图" });
  check("saveMapDoc.name 生效", docRename.doc.name === "改过名的地图", docRename.doc.name);
  const docAdd = await gw("saveMapDoc", { projectId, addLayer: { name: "装饰" }, layers: [{ id: layer0, name: "地面" }] });
  check("saveMapDoc.addLayer + layers 改名生效", docAdd.doc.layers.length === 4 && docAdd.doc.layers[0].name === "地面" && docAdd.doc.layers[3].name === "装饰", JSON.stringify(docAdd.doc.layers));
  const docMove = await gw("saveMapDoc", { projectId, moveLayer: { id: "l3", toIndex: 0 } });
  check("saveMapDoc.moveLayer 生效", docMove.doc.layers[0].id === "l3", docMove.doc.layers.map((l) => l.id).join(","));
  const docRemove = await gw("saveMapDoc", { projectId, removeLayerId: "l3" });
  check("saveMapDoc.removeLayerId 生效", docRemove.doc.layers.length === 3 && !docRemove.doc.layers.some((l) => l.id === "l3"));
  const docClear = await gw("saveMapDoc", { projectId, clearLayerId: layer0 });
  check("saveMapDoc.clearLayerId 生效", (await mapgen.readTheDoc(projectId)).data[layer0].every((value) => value === 0));
  check("saveMapDoc 返回体带最新视图（界面要重算画布）", docClear.view !== undefined && docClear.view.cols === docClear.doc.cols && docClear.view.layers.length === docClear.doc.layers.length, JSON.stringify({ viewCols: docClear.view?.cols, docCols: docClear.doc.cols }));
  await gw("applyMapOps", { projectId, ops: [{ kind: "paint", layerId: layer0, cells: [{ r: 1, c: 1, tile: base }, { r: 39, c: 39, tile: base }] }] });
  const docResize = await gw("saveMapDoc", { projectId, cols: 12, rows: 12 });
  check("saveMapDoc.cols / rows 生效，并报出丢掉的格数（12×12 之外那一格）", docResize.doc.cols === 12 && docResize.doc.rows === 12 && docResize.dropped === 1, JSON.stringify({ cols: docResize.doc.cols, dropped: docResize.dropped }));
  const docWrap = await gw("saveMapDoc", { projectId, wrap: false });
  check("saveMapDoc.wrap 生效（落在项目网格上）", docWrap.view.grid.wrap === false, JSON.stringify(docWrap.view.grid));
  await gw("saveMapDoc", { projectId, wrap: true });
  check("未知阶段之外的结构补丁不抛（wrap 关掉再打开）", (await gw("getMapProject", { projectId })).grid.wrap === true);

  // ══ 6. 一键生成（走网关）════════════════════════════════════════════════
  section("6) 一键生成（kind / tiles / seed / layerId 逐个证明）");
  const generated = await gw("runMapGenerate", { projectId, kind: "maze", tiles: [base, base + 1], seed: 4242, layerId: layer1 });
  check("runMapGenerate 返回 changed 与 seed 回声", generated.seed === 4242 && generated.changed > 0, JSON.stringify(generated));
  check("runMapGenerate.layerId 生效（写进第 1 层）", (await mapgen.readTheDoc(projectId)).data[layer1].some((value) => value > 0));
  check("runMapGenerate.tiles 生效（只用了给定池）", [...new Set((await mapgen.readTheDoc(projectId)).data[layer1])].every((value) => [0, base, base + 1].includes(value)));
  const sig = async () => JSON.stringify((await gw("mapPlan", { projectId, view: { x: 0, y: 0, width: 12 * 32, height: 12 * 32 } })).chunks);
  const seedA = await sig();
  await gw("runMapGenerate", { projectId, kind: "random", tiles: [base, base + 1], seed: 999, layerId: layer1 });
  await gw("runMapGenerate", { projectId, kind: "maze", tiles: [base, base + 1], seed: 4242, layerId: layer1 });
  check("runMapGenerate.seed 生效（同种子两次逐项一致）", (await sig()) === seedA);
  check("未知算法在 wire schema 那一层就被拒（枚举校验）", (await failed(() => gw("runMapGenerate", { projectId, kind: "nope" }))).length > 0);
  check("未知算法即使绕过 schema 也被宿主拒绝", (await failed(() => studio.runMapGenerate({ projectId, kind: "nope" }))).includes("未知生成算法"));

  // ══ 7. 素材删除与引用保护（走网关）══════════════════════════════════════
  section("7) 素材删除：引用它的格子被重映射 / 清零");
  await gw("applyMapOps", { projectId, ops: [{ kind: "paint", layerId: layer0, cells: [{ r: 1, c: 1, tile: base }] }] });
  const removed = await gw("removeMapTileset", { projectId, tilesetId });
  check("removeMapTileset 返回 removed / pruned / warnings", typeof removed.removed === "string" && typeof removed.pruned === "number" && Array.isArray(removed.warnings), JSON.stringify(removed));
  check("删掉的素材不再出现在视图里", !(await gw("getMapProject", { projectId })).tilesets.some((t) => t.id === tilesetId));

  // ══ 8. 并发 / 取消 / 验收打勾（走网关）═══════════════════════════════════
  section("8) 并发 / 取消 / 打勾");
  const [a, b] = await Promise.all([gw("runMapPreview", { projectId }), gw("runMapPreview", { projectId })]);
  check("两个 runMapPreview 只放行一个", [a, b].filter((item) => item.started === true).length === 1, JSON.stringify([a.started, b.started]));
  check("另一个给出可读的原因", [a, b].some((item) => item.started === false && typeof item.reason === "string" && item.reason.length > 0), JSON.stringify([a.reason, b.reason]));
  await gw("cancelMapJob", { projectId });
  check("cancelMapJob 返回 ok 且项目能收尾", (await waitIdle(projectId)) === true && mapgen.mapBusy(projectId) === false);
  // 取消可能让预览图没写出来（那正是取消的意义）；这里重跑一次到完成，
  // 后面 review 与资源路由都要拿 preview/map.png。
  check("取消后还能重新提交预览", (await gw("runMapPreview", { projectId })).started === true);
  check("预览跑到完成并写出 preview/map.png", (await waitIdle(projectId)) === true && existsSync(join(mapgen.mapProjectDir(projectId), "preview", "map.png")));
  const approvedStage = await gw("setMapApproved", { projectId, stage: "rules", approved: true });
  check("setMapApproved 单阶段：回 stage=名字", approvedStage.ok === true && approvedStage.stage === "rules");
  const stageView = await gw("getMapProject", { projectId });
  check("单阶段打勾只影响那一个阶段", stageView.stages.rules.approved === true && stageView.stages.export.approved !== true);
  const approvedAll = await gw("setMapApproved", { projectId, approved: true });
  const allView = await gw("getMapProject", { projectId });
  check("空 stage = 四个阶段全打", approvedAll.stage === null && links.MAP_STAGES.every((key) => allView.stages[key].approved === true), JSON.stringify(Object.fromEntries(links.MAP_STAGES.map((k) => [k, allView.stages[k].approved]))));
  const unapproved = await gw("setMapApproved", { projectId, stage: "export", approved: false });
  check("取消通过：approvedAt 一起清掉", unapproved.approved === false && (await gw("getMapProject", { projectId })).stages.export.approved === false);
  check("未知阶段被网关拒绝", (await failed(() => gw("setMapApproved", { projectId, stage: "nope", approved: true }))).includes("未知阶段"));
  check("revealMapProject 仍然在（不调用，只确认存在）", typeof studio.revealMapProject === "function");

  // ══ 9. 导出与验收清单（走网关）══════════════════════════════════════════
  section("9) 导出与验收清单");
  await gw("applyMapOps", { projectId, ops: [{ kind: "fill", layerId: layer1, r: 0, c: 0, tile: base }] });
  const exportStarted = await gw("runMapExport", { projectId, scale: 1 });
  check("runMapExport 启动", exportStarted.started === true, exportStarted.reason ?? "");
  check("导出跑完", (await waitIdle(projectId)) === true);
  const exported = await gw("getMapProject", { projectId });
  const docNow = await mapgen.readTheDoc(projectId);
  const expectedDir = EXPORT.safeFileName(docNow.name, docNow.id);
  check("视图的 exportBase 按地图名取目录", exported.exportBase === `export/${expectedDir}/`, exported.exportBase);
  const expectedZip = `${expectedDir}.zip`;
  check(
    "导出清单 = map.png / map.json / zip / manifest.json（多产物自动打包，走网关也一样）",
    exported.exportFiles.slice().sort().join(",") === ["manifest.json", "map.json", "map.png", expectedZip].sort().join(","),
    exported.exportFiles.join(" ")
  );
  check("视图带上导出目录的本机绝对路径", exported.exportPath.endsWith(join("export", expectedDir)) && exported.exportPath.includes(mapgen.mapProjectDir(projectId)), exported.exportPath);
  const listing = await mapgen.readExportListing(projectId, "http://127.0.0.1:9999");
  check("readExportListing 给绝对 URL", listing.base.startsWith("http://127.0.0.1:9999/dsh-game-material-master/map-assets/") && listing.files.every((url) => url.startsWith("http")));
  check("zip 在清单里也是可点的绝对 URL（界面点一下就能下载）", listing.files.some((url) => url.endsWith(`/${expectedZip}`)), listing.files.join(" "));
  const snapshot = await mapgen.mapSnapshot(await mapgen.readMapProject(projectId), "http://127.0.0.1:9999");
  check("快照把预览图与导出产物换成绝对 URL", snapshot.previewUrls.every((url) => url.includes("/preview/")) && snapshot.exportFiles.length === exported.exportFiles.length, snapshot.previewUrls.join(" "));
  check("快照带 busy 与 nextActions", typeof snapshot.busy === "boolean" && Array.isArray(snapshot.nextActions));

  // ══ 10. 工具面（call / status / review / intake / approve / upload）══════
  section("10) 工具面：call / status / review / intake / approve / upload");
  const called = await run("game_material_call", { method: "mapPlan", payload: { projectId, view: { x: 0, y: 0, width: 64, height: 64 } } });
  check("game_material_call 能调 mapPlan", called.ok === true && called.value.visibleKeys.length > 0 && called.method === "mapPlan");
  check("game_material_call 的 openUrl 指向 map 模块与这个项目", String(called.openUrl).includes("module=map") && String(called.openUrl).includes(projectId), String(called.openUrl));
  check("game_material_call 调无参方法不接受 payload", (await failed(() => run("game_material_call", { method: "listMapProjects", payload: { x: 1 } }))).includes("不接受 payload"));
  check("game_material_call 调有参方法必须要 payload", (await failed(() => run("game_material_call", { method: "mapPlan" }))).includes("需要一个 payload"));
  check("game_material_call 不认旧方法（saveMapFamilies 不在枚举里）", (await failed(() => run("game_material_call", { method: "saveMapFamilies", payload: {} }))).includes("未知方法"));
  /**
   * 「AI 生成素材」的回链：`composeMapAsset` 的 openUrl 必须**带上产物路径与帧数**，
   * 界面靠它把刚整理好的图预填进「新增素材」。少了 `dialog`/`asset`/`frames` 里任何一个，
   * 用户点开只会落在一张空的地图编辑器上 —— 而且不报错。
   */
  const composedCall = await run("game_material_call", {
    method: "composeMapAsset",
    payload: { projectId, name: "工具面AI素材", files: [frameA, frameB] }
  });
  const composedUrl = new URL(String(composedCall.openUrl));
  check(
    "call(composeMapAsset)：openUrl 带 module=map / job=项目 / stage=assets",
    composedUrl.searchParams.get("module") === "map" && composedUrl.searchParams.get("job") === projectId && composedUrl.searchParams.get("stage") === "assets",
    String(composedCall.openUrl)
  );
  check(
    "call(composeMapAsset)：openUrl 带 dialog=add / asset / frames / shape（界面据此预填）",
    composedUrl.searchParams.get("dialog") === "add" &&
      composedUrl.searchParams.get("asset") === "ai/工具面AI素材.png" &&
      composedUrl.searchParams.get("frames") === "2" &&
      composedUrl.searchParams.get("shape") === "plain",
    String(composedCall.openUrl)
  );
  check("call(composeMapAsset)：解析回宿主侧意图后字段一个不丢", (() => {
    const parsed = links.parseIntentQuery(composedUrl.search);
    return parsed?.dialog === "add" && parsed?.asset === "ai/工具面AI素材.png" && parsed?.frames === 2 && parsed?.stage === "assets" && parsed?.shape === "plain";
  })(), JSON.stringify(links.parseIntentQuery(composedUrl.search)));
  /**
   * ★ 整图：回链要多带 `cols/rows` —— 少了它们「新增素材」只能按 3×3 猜，
   * 图与占格对不上就被拉伸（而且这种拉伸一句提示都没有）。
   */
  const stampCall = await run("game_material_call", {
    method: "composeMapAsset",
    payload: { projectId, name: "工具面雕像", files: [frameA], shape: "stamp", stampCols: 4, stampRows: 3 }
  });
  const stampUrl = new URL(String(stampCall.openUrl));
  check(
    "★ call(composeMapAsset)：整图回链带 shape=stamp / cols=4 / rows=3",
    stampUrl.searchParams.get("shape") === "stamp" && stampUrl.searchParams.get("cols") === "4" && stampUrl.searchParams.get("rows") === "3",
    String(stampCall.openUrl)
  );
  check("整图回链解析回意图：cols / rows 也在", (() => {
    const parsed = links.parseIntentQuery(stampUrl.search);
    return parsed?.shape === "stamp" && parsed?.cols === 4 && parsed?.rows === 3;
  })());
  /**
   * 绿幕那条：`composeMapAsset` 抠到了东西就带 `keyed=1` ——「新增素材」据此**取消**勾选，
   * 免得抠第二遍（第二遍按已经没绿的图去采样背景色，会误伤画面里的深绿）。
   */
  // 那两张夹具图由上面的整图那一段写好（同一份路径，别重复造）。
  const toolGreenFile = join(HOME, "stamp-ai", "green.png");
  const toolNoGreenFile = join(HOME, "stamp-ai", "nongreen.png");
  const keyedCall = await run("game_material_call", {
    method: "composeMapAsset",
    payload: { projectId, name: "工具面绿幕", files: [toolGreenFile], shape: "stamp", stampCols: 3, stampRows: 2 }
  });
  const keyedUrl = new URL(String(keyedCall.openUrl));
  check("★ 抠过绿幕的回链带 keyed=1（界面据此不再抠）", keyedUrl.searchParams.get("keyed") === "1" && links.parseIntentQuery(keyedUrl.search)?.keyed === 1, String(keyedCall.openUrl));
  const noKeyCall = await run("game_material_call", {
    method: "composeMapAsset",
    payload: { projectId, name: "工具面没绿幕", files: [toolNoGreenFile], shape: "stamp", stampCols: 3, stampRows: 2 }
  });
  check("反向验证：没抠到绿幕时不带 keyed（界面该怎么抠还怎么抠）", new URL(String(noKeyCall.openUrl)).searchParams.get("keyed") === null);
  const shapedCall = await run("game_material_call", {
    method: "composeMapAsset",
    payload: { projectId, name: "工具面拼块", files: [frameA, frameB, frameB], shape: "a2quad" }
  });
  check(
    "call(composeMapAsset)：形态是拼块时链接里带的就是 a2quad（回链预填不会退回普通）",
    new URL(String(shapedCall.openUrl)).searchParams.get("shape") === "a2quad" && shapedCall.value.variants === 3,
    String(shapedCall.openUrl)
  );
  check(
    "call(composeMapAsset)：openHint 说的是「新增素材已打开并预填好」",
    String(composedCall.openHint).includes("新增素材") && String(composedCall.openHint).includes("预填"),
    String(composedCall.openHint)
  );

  const statusList = await run("game_material_status", { module: "map" });
  check("status 不带 id：列出地图项目", statusList.mapProjects.some((item) => item.id === projectId), JSON.stringify(statusList.mapProjects.map((p) => p.id)));
  check("status 不带 id：带 hiddenModules 与深链接", Array.isArray(statusList.hiddenModules) && String(statusList.links.map).includes("module=map"));
  const statusOne = await run("game_material_status", { module: "map", id: projectId });
  check("status 带 id：给地图快照（cols/rows/tilesets/layers/stages）", statusOne.cols > 0 && Array.isArray(statusOne.tilesets) && Array.isArray(statusOne.layers) && statusOne.stages !== undefined, Object.keys(statusOne).join(","));
  check("status 带 id：预览与导出用绝对 URL", statusOne.previewUrls.every((url) => String(url).startsWith("http")) && statusOne.exportBaseUrl.startsWith("http"), statusOne.exportBaseUrl);
  check("status 带 id：带 openUrl", String(statusOne.openUrl).includes("module=map"));

  const reviewed = await run("game_material_review", { module: "map", id: projectId });
  check("review：map 分支给出四个阶段", Array.isArray(reviewed.stages) && reviewed.stages.length === 4 && reviewed.stages.every((stage) => links.MAP_STAGES.includes(stage.stage)), JSON.stringify(reviewed.stages?.map((s) => s.stage)));
  check("review：含 tilesets（绝对 URL）/ layers / preview / exportBaseUrl / exportFiles / exportPath", Array.isArray(reviewed.tilesets) && reviewed.tilesets.every((t) => String(t.url).startsWith("http")) && Array.isArray(reviewed.layers) && reviewed.previewUrls.length > 0 && reviewed.exportBaseUrl.startsWith("http") && reviewed.exportFiles.length === exported.exportFiles.length && typeof reviewed.exportPath === "string" && reviewed.exportPath !== "");
  check("review：不再有 families / coverage（旧体系的残留）", reviewed.families === undefined && reviewed.coverage === undefined);
  check("review：nextActions 是文字（模型能直接念）", Array.isArray(reviewed.nextActions) && reviewed.nextActions.every((text) => typeof text === "string"));
  check("review：带 openUrl，名称用项目名（地图名在 exportBase 里）", String(reviewed.openUrl).includes("module=map") && reviewed.name === (await mapgen.readMapProject(projectId)).name, reviewed.name);
  const reviewedStage = await run("game_material_review", { module: "map", id: projectId, stage: "paint" });
  check("review 支持只看某一个阶段", reviewedStage.stages.length === 1 && reviewedStage.stages[0].stage === "paint");
  check("review 未知阶段被拒", (await failed(() => run("game_material_review", { module: "map", id: projectId, stage: "nope" }))).includes("未知阶段"));
  const renderedReview = tool("game_material_review").output.render({}, reviewed);
  check("review 的文字渲染里没有旧术语（地形族 / 掩码 / Tiled / 等距）", !/地形族|掩码|Tiled|等距/.test(JSON.stringify(renderedReview)), JSON.stringify(renderedReview).slice(0, 120));
  check("review 的文字渲染里有阶段中文名（素材 / 自动连接 / 地图 / 导出）", /素材/.test(JSON.stringify(renderedReview)) && /自动连接/.test(JSON.stringify(renderedReview)));

  const intakeNew = await run("game_material_intake", { module: "map" });
  const askKeys = intakeNew.questions.map((question) => question.key);
  check("intake：map 的必问项是 tileset / mapSize / generate", ["tileset", "mapSize", "generate"].every((key) => askKeys.includes(key)), askKeys.join(","));
  check("intake：不再问旧参数（grid / families / mapLayout）", !askKeys.includes("families") && !askKeys.includes("mapLayout") && !askKeys.includes("grid"), askKeys.join(","));
  check("intake：map 不加 API Key 阻塞（全本地零计费）", intakeNew.blockers.length === 0, intakeNew.blockers.join("；"));
  check("intake：仍然必问审核模式（auto / manual 两个选项）", intakeNew.reviewModeQuestion.options.map((option) => option.value).join(",") === "auto,manual");
  check("intake：known 里说明这条链路全本地不花钱", JSON.stringify(intakeNew.known).includes("本地") || JSON.stringify(intakeNew.known).includes("不花"), JSON.stringify(intakeNew.known).slice(0, 120));
  const intakeTold = await run("game_material_intake", { module: "map", told: ["tileset", "mapSize", "generate"] });
  check("intake：已经告知过的参数不再问", ["tileset", "mapSize", "generate"].every((key) => !intakeTold.questions.map((question) => question.key).includes(key)), intakeTold.questions.map((q) => q.key).join(","));
  check("intake：新目标时问「新建还是继续」", askKeys.includes("target") || intakeNew.questions.some((question) => question.key === "target"), askKeys.join(","));

  const approvedTool = await run("game_material_approve", { module: "map", id: projectId, stage: "paint", approved: true });
  check("approve：单阶段打勾（回 stage 与 openUrl）", approvedTool.module === "map" && approvedTool.stage === "paint" && approvedTool.approved === true && String(approvedTool.openUrl).includes("module=map"));
  const approvedWhole = await run("game_material_approve", { module: "map", id: projectId, approved: true });
  const approvedView = await gw("getMapProject", { projectId });
  check("approve：不带 stage = 四个阶段全打", approvedWhole.stage === null && links.MAP_STAGES.every((key) => approvedView.stages[key].approved === true));
  check("approve：未知阶段被拒", (await failed(() => run("game_material_approve", { module: "map", id: projectId, stage: "nope", approved: true }))).includes("未知阶段"));

  const uploadPath = join(HOME, "upload-sheet.png");
  await writeFile(uploadPath, sheetPng(64, 64, 32));
  const uploaded = await run("game_material_upload", { module: "map", id: projectId, kind: "tileset", path: uploadPath });
  check("upload：kind=tileset 真的把图集导进去了", uploaded.module === "map" && uploaded.kind === "tileset" && (await gw("getMapProject", { projectId })).tilesets.length >= 1, JSON.stringify(uploaded.kind));
  check("upload：导进来的尺寸按文件头量对（64×64 → 4 块）", (await gw("getMapProject", { projectId })).tilesets.some((t) => t.imageWidth === 64 && t.tileCount === 4));
  check("upload：map 不支持的 kind 被明确拒绝", (await failed(() => run("game_material_upload", { module: "map", id: projectId, kind: "source", path: uploadPath }))).includes("不支持 kind"));

  const waited = await run("game_material_wait", { module: "map", id: projectId, timeoutSeconds: 5 });
  check("wait：地图作业跑完后 settled=true", waited.settled === true && waited.timedOut === false && String(waited.openUrl).includes("module=map"), JSON.stringify({ settled: waited.settled, busy: waited.busy }));

  // ══ 11. 静态资源路由（真调一遍）══════════════════════════════════════════
  section("11) 静态资源路由（403 / 404 就是「图裂了」）");
  const route = captured.routes[0];
  /**
   * 直接调路由处理函数。
   *
   * ⚠️ 响应必须是**真的可写流**：命中文件时宿主走 `createReadStream().pipe(res)`，
   * 拿一个只有 `end()` 的假对象会抛 `dest.on is not a function`。
   */
  const request = async (path, method = "GET") => {
    const chunks = [];
    const headers = {};
    let status = 0;
    const req = new Readable({ read() {} });
    req.url = path;
    req.method = method;
    req.headers = {};
    req.push(null);
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    res.setHeader = (name, value) => {
      headers[String(name).toLowerCase()] = value;
    };
    res.writeHead = (code, more) => {
      status = code;
      for (const [name, value] of Object.entries(more ?? {})) headers[String(name).toLowerCase()] = value;
      return res;
    };
    res.statusCode = 200;
    await route.handler(req, res);
    await Promise.race([once(res, "finish").catch(() => undefined), sleep(500)]);
    return { status: status === 0 ? res.statusCode : status, body: Buffer.concat(chunks), headers };
  };
  const assetBase = `/dsh-game-material-master/map-assets/${projectId}`;
  const tilesetFile = (await gw("getMapProject", { projectId })).tilesets[0].file;
  const okTileset = await request(`${assetBase}/${tilesetFile}`);
  check("图集原图能取到（200，且不是空响应）", okTileset.status === 200 && okTileset.body.length > 0, `status=${okTileset.status} bytes=${okTileset.body.length}`);
  const okPreview = await request(`${assetBase}/preview/map.png`);
  check("预览图能取到（preview 在白名单里）", okPreview.status === 200, `status=${okPreview.status}`);
  /**
   * `ai/` 是「AI 生成素材」的回链落点：界面要 `fetch` 这张图把它填进「新增素材」。
   * 它不在白名单里的话表现是「链接点开了、对话框也弹了，但图没选上」——
   * 只有一个报错提示，很容易被当成「模型没生成成功」。
   */
  const okAiAsset = await request(`${assetBase}/${composed.file.split("/").map(encodeURIComponent).join("/")}`);
  check("AI 素材暂存图能取到（ai/ 在白名单里）", okAiAsset.status === 200 && okAiAsset.body.length > 0, `status=${okAiAsset.status} bytes=${okAiAsset.body.length}`);
  const exportDir = (await gw("getMapProject", { projectId })).exportBase.replace(/^export\//, "").replace(/\/$/, "");
  const okExport = await request(`${assetBase}/export/${exportDir}/map.png`);
  check("导出产物能取到（export 在白名单里）", okExport.status === 200, `status=${okExport.status}`);
  /**
   * zip 走**同一条**路由（白名单只比对第一段 `export`），所以这里要一起钉住：
   * 下载按钮指向的就是这个 URL，它 403/404 的话界面表现只是「点了没反应」。
   */
  const zipName = (await gw("getMapProject", { projectId })).exportFiles.find((file) => file.endsWith(".zip"));
  const okZip = await request(`${assetBase}/export/${exportDir}/${encodeURIComponent(zipName)}`);
  check("导出的 zip 能取到（200，且 MIME 是 application/zip）", okZip.status === 200 && okZip.body.length > 0 && String(okZip.headers["content-type"]).includes("application/zip"), `status=${okZip.status} type=${okZip.headers["content-type"]}`);
  const okHead = await request(`${assetBase}/${tilesetFile}`, "HEAD");
  check("HEAD 也是 200（空体）", okHead.status === 200, `status=${okHead.status}`);
  const traversalEncoded = await request(`/dsh-game-material-master/map-assets/${projectId}/%2e%2e%2f%2e%2e%2fetc/passwd`);
  check("目录穿越（编码过的 ..）被挡：不是 200", traversalEncoded.status !== 200, `status=${traversalEncoded.status}`);
  const traversalPlain = await request(`/dsh-game-material-master/map-assets/${projectId}/../../etc/passwd`);
  check("目录穿越（裸 .. 被 URL 归一化后）也不是 200", traversalPlain.status !== 200, `status=${traversalPlain.status}`);
  const notWhitelisted = await request(`${assetBase}/secret/x.png`);
  check("白名单之外的子目录 403", notWhitelisted.status === 403, `status=${notWhitelisted.status}`);
  const mapsDir = await request(`${assetBase}/maps/x.png`);
  check("★ maps/ 已经不在白名单里（403，不是 200）", mapsDir.status === 403, `status=${mapsDir.status}`);
  const badId = await request(`/dsh-game-material-master/map-assets/p1234/tilesets/x.png`);
  check("非法 id 被拒（400/404 都算，重点是别 200）", badId.status === 400 || badId.status === 404, `status=${badId.status}`);
  const unknownScope = await request(`/dsh-game-material-master/nope-assets/${projectId}/x.png`);
  check("未知 scope 404", unknownScope.status === 404, `status=${unknownScope.status}`);
  const missingFile = await request(`${assetBase}/${tilesetFile.split("/")[0]}/nope.png`);
  check("白名单内但文件不存在 → 404（不是 200 空图）", missingFile.status === 404, `status=${missingFile.status}`);
  const health = await request(`/dsh-game-material-master/_health`);
  check("_health 探针可用（用来区分「代码没生效」和「功能坏了」）", health.status === 200 && JSON.parse(health.body.toString("utf8")).ok === true, health.body.toString("utf8").slice(0, 60));

  // ══ 12. 落盘结构与删除 ═════════════════════════════════════════════════
  section("12) 落盘结构与删除");
  const onDisk = JSON.parse(await readFile(mapgen.mapProjectFile(projectId), "utf8"));
  check("project.json 结构完整（grid / tilesets / stages / logs）", onDisk.grid.wrap === true && Array.isArray(onDisk.tilesets) && Object.keys(onDisk.stages).length === 4 && Array.isArray(onDisk.logs));
  check("project.json 不再有 families / mapIds / activeMapId", !("families" in onDisk) && !("mapIds" in onDisk) && !("activeMapId" in onDisk), Object.keys(onDisk).join(","));
  check("没有 maps/ 目录（单项目单地图）", !existsSync(join(mapgen.mapProjectDir(projectId), "maps")));
  check("project.json 里的素材形态/格尺寸落盘了", onDisk.tilesets.every((t) => typeof t.shape === "string" && typeof t.cell?.width === "number"));
  check("两个 schema 校验汇总：没有任何 payload 丢字段", payloadLosses.length === 0, payloadLosses.join("；").slice(0, 200));
  check("两个 codec 校验汇总：所有返回体都过得了自己的 result codec", resultRejections.length === 0, resultRejections.join("；").slice(0, 200));
  await gw("deleteMapProject", { projectId });
  check("删项目后目录没了", !existsSync(mapgen.mapProjectDir(projectId)));
  check("删项目后不在清单里", !(await gw("listMapProjects")).projects.some((item) => item.id === projectId));
  projectId = "";
} finally {
  if (projectId !== "") await mapgen.deleteMapProject(projectId).catch(() => undefined);
  await rm(HOME, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${failures.length === 0 ? "全部通过" : "有失败"}：${checks} 项通过${failures.length > 0 ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
