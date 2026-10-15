#!/usr/bin/env node
/**
 * 地图编辑器（模块六）· **真实链路端到端**：不联网、不花钱，产物落在真实数据目录里，
 * 方便直接用界面或文件管理器验收。
 *
 *   node scripts/e2e-map.mjs [项目名]
 *
 * 与自检脚本的区别：自检用临时 DSH_HOME、跑完就删；这个脚本**故意留下产物**
 * （素材图、预览图、导出的 PNG / JSON），并打印它们的绝对路径。
 *
 * 它演的是这样一条真实链路：
 *   内置素材（5 张，含 4 张 A2 自动连接图）→ 再合成导入一张 A2 图与一张普通图 →
 *   画满 24×24（自动连接长边）→ 叠一层普通图块 → 看计划里「一格四条 op」→
 *   查一次跨边界的视口（环绕时 visibleKeys 会出现负数 key）→ 撤销 / 重做 →
 *   一键生成三种地图 → 预览图 → 导出 → 打印路径。
 *
 * 任何一条硬断言不过就以非零码退出（它同时是集成期的冒烟手段）。
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const projectName = process.argv[2] ?? "地图编辑器 端到端";

const { dataRoot } = await import("../lib/config.js");
const mapgen = await import("../lib/mapgen.js");
const maptiles = await import("../lib/maptiles.js");
const { encodePng } = await import("../lib/png.js");

const step = (n, text) => console.log(`\n[${n}] ${text}`);
let failures = 0;
function expect(label, ok, detail = "") {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 合成一张能看出「哪块是哪块」的普通网格图：每块一个可区分颜色 + 左上角白点。 */
function makeGridPng(tileSize, columns, rows) {
  const width = tileSize * columns;
  const height = tileSize * rows;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < columns * rows; index++) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    for (let y = 0; y < tileSize; y++) {
      for (let x = 0; x < tileSize; x++) {
        const offset = ((row * tileSize + y) * width + column * tileSize + x) * 4;
        rgba[offset] = 40 + ((index * 37) % 200);
        rgba[offset + 1] = 60 + ((index * 71) % 180);
        rgba[offset + 2] = 30 + ((index * 113) % 200);
        rgba[offset + 3] = 255;
      }
    }
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const offset = ((row * tileSize + y) * width + column * tileSize + x) * 4;
        rgba[offset] = 255;
        rgba[offset + 1] = 255;
        rgba[offset + 2] = 255;
      }
    }
  }
  return encodePng(rgba, width, height);
}

/**
 * 合成一张 **A2 自动连接**图（64×160）：2 变体 × 5 形状 × 32px，每个逻辑块 2×2 个 16px 小格。
 *
 * 形状号的含义（照 AsLib）：0 = 横竖都不连通、1 = 竖直方向连通（横向要画带）、
 * 2 = 横向连通（竖直方向要画带）、3 = 只差对角、4 = 全连通。
 * 带画在小格**朝外**的那条边上（右列小格画右边、下排小格画下边），
 * 所以同一块里四个小格是镜像的 —— 这正是自动连接接缝能对上的原因。
 */
function makeA2Png(cell = 32, variants = 2) {
  const small = cell / 2;
  const width = cell * variants;
  const height = cell * 5;
  const rgba = Buffer.alloc(width * height * 4);
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
    rgba[offset + 3] = 255;
  };
  const BAND = 5;
  for (let shape = 0; shape < 5; shape++) {
    for (let variant = 0; variant < variants; variant++) {
      const horizontalDiffers = shape === 0 || shape === 1;
      const verticalDiffers = shape === 0 || shape === 2;
      const diagOnly = shape === 3;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x0 = (variant * 2 + dx) * small;
          const y0 = (shape * 2 + dy) * small;
          for (let y = 0; y < small; y++) {
            for (let x = 0; x < small; x++) {
              // 本体：带噪声的绿色（变体 1 相位错开，于是两帧看得出在动）
              const noise = ((x * 7 + y * 13 + (variant === 0 ? 0 : 3)) % 5) * 3;
              put(x0 + x, y0 + y, 92 + noise, 150 + noise, 72 + noise);
            }
          }
          // 带：横竖邻居不同时画在外侧；只差对角时在朝角那一段画内角
          const bandColor = [126, 96, 62];
          if (horizontalDiffers) {
            for (let y = 0; y < small; y++) {
              for (let k = 0; k < BAND; k++) {
                const x = dx === 0 ? k : small - BAND + k;
                const blend = k >= BAND - 2 && (x + y) % 2 === 0;
                if (blend) continue;
                put(x0 + x, y0 + y, bandColor[0], bandColor[1], bandColor[2]);
              }
            }
          }
          if (verticalDiffers) {
            for (let x = 0; x < small; x++) {
              for (let k = 0; k < BAND; k++) {
                const y = dy === 0 ? k : small - BAND + k;
                const blend = k >= BAND - 2 && (x + y) % 2 === 1;
                if (blend) continue;
                put(x0 + x, y0 + y, bandColor[0], bandColor[1], bandColor[2]);
              }
            }
          }
          if (diagOnly) {
            for (let k = 0; k < BAND; k++) {
              for (let m = 0; m < BAND; m++) {
                const x = dx === 0 ? k : small - 1 - k;
                const y = dy === 0 ? m : small - 1 - m;
                put(x0 + x, y0 + y, bandColor[0], bandColor[1], bandColor[2]);
              }
            }
          }
        }
      }
    }
  }
  return encodePng(rgba, width, height);
}

console.log(`数据目录：${dataRoot()}`);
console.log(`生图调用：**0 次**（这个模块全本地，不花钱）`);

step(1, "建项目（默认网格：正方形 32×32、四周环绕）");
const project = await mapgen.createMapProject(projectName);
const projectId = project.id;
console.log(`  projectId = ${projectId}`);
console.log(`  目录      = ${mapgen.mapProjectDir(projectId)}`);
console.log(`  网格      = ${JSON.stringify(project.grid)}`);
expect("默认网格是 32×32 且环绕", project.grid.tileWidth === 32 && project.grid.wrap === true);

step(2, "导入内置素材（4 张 A2 自动连接图 + 1 张道具图）");
const sample = await mapgen.importSampleTileset(projectId);
for (const tileset of sample.tilesets) {
  console.log(
    `  ${tileset.name.padEnd(12, " ")} ${String(tileset.imageWidth).padStart(4)}×${String(tileset.imageHeight).padEnd(4)} ` +
      `${tileset.shape.padEnd(7)} 格子 ${tileset.cell.width}px 变体 ${tileset.variants} 块数 ${tileset.tiles.length}`
  );
}
expect("内置素材至少 5 张", sample.tilesets.length >= 5, String(sample.tilesets.length));
expect("内置素材里有 A2 自动连接图", sample.tilesets.some((tileset) => tileset.shape === "a2quad"));
expect("内置素材里有普通道具图", sample.tilesets.some((tileset) => tileset.shape === "plain"));

step(3, "再合成导入两张图：一张 A2（64×160）、一张普通网格（128×96）");
const a2Png = makeA2Png();
const a2Import = await mapgen.importMapTileset(projectId, "合成 A2", a2Png.toString("base64"));
const a2 = a2Import.tilesets[0];
console.log(`  A2：${a2.imageWidth}×${a2.imageHeight} → ${a2.shape}、${a2.tiles.length} 块、变体 ${a2.variants}`);
console.log(`  识别说明：${a2Import.warnings.length === 0 ? "（无告警）" : a2Import.warnings.join("；")}`);
expect("64×160 被识别为 A2 拼块", a2.shape === "a2quad" && a2.cell.width === 32 && a2.tiles.length === 40);

const plainPng = makeGridPng(32, 4, 3);
const plainImport = await mapgen.importMapTileset(projectId, "合成网格", plainPng.toString("base64"));
const plain = plainImport.tilesets[0];
console.log(`  网格：${plain.imageWidth}×${plain.imageHeight} → ${plain.shape}、${plain.tiles.length} 块`);
expect("128×96 被识别为普通图块", plain.shape === "plain" && plain.tiles.length === 12);

step(4, "把地图改成 24×24、加一层，再用 A2 素材铺满第 0 层");
await mapgen.saveMapDocStructure(projectId, { cols: 24, rows: 24, name: "端到端演示图" });
await mapgen.saveMapDocStructure(projectId, { addLayer: { name: "图块层" } });
let view = await mapgen.mapView(await mapgen.readMapProject(projectId));
console.log(`  图层：${view.layers.map((layer) => `${layer.id}/${layer.name}`).join("，")}`);
const a2Palette = view.tilesets.find((tileset) => tileset.id === a2.id)?.palette ?? [];
console.log(`  A2 素材在调色板里的条目数 = ${a2Palette.length}（自动连接素材只出 1 个笔刷）`);
expect("A2 素材在调色板里只有一个笔刷", a2Palette.length === 1);
const a2Brush = a2Palette[0]?.index;
const plainBrush = view.tilesets.find((tileset) => tileset.id === plain.id)?.palette?.[0]?.index;
expect("A2 与普通素材都给出了笔刷序号", typeof a2Brush === "number" && typeof plainBrush === "number");

const groundLayer = view.layers[0].id;
const topLayer = view.layers[1].id;
await mapgen.applyMapOps(projectId, [
  { kind: "rect", layerId: groundLayer, r0: 0, c0: 0, r1: 23, c1: 23, tile: a2Brush, filled: true },
  { kind: "rect", layerId: topLayer, r0: 10, c0: 4, r1: 10, c1: 19, tile: plainBrush, filled: true }
]);
view = await mapgen.mapView(await mapgen.readMapProject(projectId));
console.log(`  已画：${view.filled} 格（第 0 层 ${view.layers[0].filled}、第 1 层 ${view.layers[1].filled}）`);

step(5, "看绘制计划：A2 的每一格必须是 4 条 op（四个象限各一条）");
const fullView = { x: 0, y: 0, width: 24 * 32, height: 24 * 32 };
let plan = await mapgen.mapPlan(projectId, { view: fullView });
const totalOps = plan.chunks.reduce((sum, chunk) => sum + chunk.ops.length, 0);
console.log(`  chunk ${plan.chunks.length} 个、op ${totalOps} 条、legend ${plan.legend.length} 条、fps ${plan.fps}、帧数 ${plan.frameCount}`);
const a2Ops = plan.chunks.flatMap((chunk) => chunk.ops).filter((op) => op.l === 0);
console.log(`  第 0 层 op = ${a2Ops.length}（期望 24×24×4 = ${24 * 24 * 4}）`);
expect("A2 每格 4 条 op", a2Ops.length === 24 * 24 * 4, String(a2Ops.length));
expect("A2 的 op 带循环帧（变体 2 → 每格 2 帧）", a2Ops[0]?.cycle?.length === 2, JSON.stringify(a2Ops[0]?.cycle));
expect("plan 有 fps 与 frameCount", plan.fps > 0 && plan.frameCount >= 2, `fps=${plan.fps} frameCount=${plan.frameCount}`);
const quadrant = new Set(a2Ops.slice(0, 4).map((op) => `${op.x},${op.y}`));
console.log(`  头一格的四个象限像素位置：${[...quadrant].join(" ")}`);
expect("同一格的四个象限落在不同像素位置", quadrant.size === 4, String(quadrant.size));

step(6, "环绕：跨左上边界的视口，visibleKeys 里必须出现负数 key");
const seam = await mapgen.mapPlan(projectId, { view: { x: -16, y: -16, width: 96, height: 96 } });
const negativeKeys = seam.visibleKeys.filter((key) => key.split(",").some((part) => Number.parseInt(part, 10) < 0));
console.log(`  visibleKeys = ${seam.visibleKeys.join(" ")}`);
console.log(`  负数 key = ${negativeKeys.join(" ") || "（无）"}`);
expect("环绕视口覆盖到负 chunk", negativeKeys.length > 0, negativeKeys.join(" "));
const seamOps = seam.chunks.flatMap((chunk) => chunk.ops);
expect("环绕视口真的产出了 op", seamOps.length > 0, String(seamOps.length));

step(7, "dropKeys：同一笔拖拽两次，客户端缓存要能精确知道哪几块失效");
const have = seam.visibleKeys.slice();
const stroke = "e2e-stroke-1";
const first = await mapgen.applyMapOps(
  projectId,
  [{ kind: "paint", layerId: groundLayer, cells: [{ r: 0, c: 0, tile: plainBrush }] }],
  { stroke, have }
);
const second = await mapgen.applyMapOps(
  projectId,
  [{ kind: "paint", layerId: groundLayer, cells: [{ r: 0, c: 1, tile: plainBrush }] }],
  { stroke, have }
);
console.log(`  第一次：changed ${first.changed}、dropKeys ${first.dropKeys.join(" ")}`);
const depthAfterFirst = mapgen.historyState(projectId).depth;
console.log(`  第二次：changed ${second.changed}、dropKeys ${second.dropKeys.join(" ")}`);
expect("改动落在可见 chunk 上时 dropKeys 非空", first.dropKeys.length > 0, first.dropKeys.join(" "));
expect("dropKeys 都是客户端报过的 key 的子集", first.dropKeys.every((key) => have.includes(key)));
const history = mapgen.historyState(projectId);
// 第一次提交会新增一条（上一笔是 rect 填充，stroke 不同）；第二次同 stroke 必须**并进同一条**。
expect("同一 stroke 的第二次提交不再增加撤销深度", history.depth === depthAfterFirst, `depth=${history.depth} 首次提交后=${depthAfterFirst}`);

step(8, "撤销 / 重做回到同一份计划");
const beforeUndo = JSON.stringify((await mapgen.mapPlan(projectId, { view: fullView })).chunks);
await mapgen.undoMap(projectId);
const undonePlan = JSON.stringify((await mapgen.mapPlan(projectId, { view: fullView })).chunks);
await mapgen.redoMap(projectId);
const afterRedo = JSON.stringify((await mapgen.mapPlan(projectId, { view: fullView })).chunks);
console.log(`  撤销后与原计划${undonePlan === beforeUndo ? "相同" : "不同"}；重做后与原计划${afterRedo === beforeUndo ? "相同" : "不同"}`);
expect("重做回到逐项相同的计划", afterRedo === beforeUndo);

step(9, "一键生成：随机铺满 / 迷宫 / 大陆（同种子逐字节可复现）");
for (const kind of ["random", "maze", "continent"]) {
  const runA = await mapgen.runMapGenerate(projectId, { kind, tiles: [a2Brush, plainBrush], seed: 20261011, layerId: topLayer });
  const snapshotA = JSON.stringify((await mapgen.mapPlan(projectId, { view: fullView })).chunks);
  const runB = await mapgen.runMapGenerate(projectId, { kind, tiles: [a2Brush, plainBrush], seed: 20261011, layerId: topLayer });
  const snapshotB = JSON.stringify((await mapgen.mapPlan(projectId, { view: fullView })).chunks);
  console.log(`  ${kind.padEnd(10)} 改了 ${String(runA.changed).padStart(4)} 格、种子 ${runA.seed}${runA.warnings.length > 0 ? `、告警：${runA.warnings.join("；")}` : ""}`);
  console.log(`  ${" ".repeat(10)} 同种子两次${snapshotA === snapshotB ? "逐项相同" : "**不同**"}（第二次改了 ${runB.changed} 格）`);
  expect(`${kind}：同种子两次结果逐项一致`, snapshotA === snapshotB);
}

step(10, "生成验收预览图");
const previewStarted = await mapgen.runPreviewStage(projectId);
if (previewStarted.started !== true) console.log(`  ⚠️ 预览没启动：${previewStarted.reason}`);
for (let i = 0; i < 600 && mapgen.mapBusy(projectId); i++) await new Promise((resolve) => setTimeout(resolve, 100));
const previewDir = join(mapgen.mapProjectDir(projectId), "preview");
console.log(`  preview/：${existsSync(previewDir) ? (await readdir(previewDir)).join("、") : "（没有产出）"}`);

step(11, "导出（PNG + 存档 JSON）");
const exportStarted = await mapgen.runExportStage(projectId, { scale: 1 });
if (exportStarted.started !== true) console.log(`  ⚠️ 导出没启动：${exportStarted.reason}`);
for (let i = 0; i < 600 && mapgen.mapBusy(projectId); i++) await new Promise((resolve) => setTimeout(resolve, 100));
const finalProject = await mapgen.readMapProject(projectId);
const exportRoot = join(mapgen.mapProjectDir(projectId), "export");
const exportNames = existsSync(exportRoot) ? await readdir(exportRoot) : [];
const exportDir = exportNames.length > 0 ? join(exportRoot, exportNames[0]) : exportRoot;
console.log(`  导出目录：${exportDir}`);
console.log(`  产物：${existsSync(exportDir) ? (await readdir(exportDir)).join("、") : "（没有产出）"}`);
console.log(`  阶段：assets=${finalProject.stages.assets.status} rules=${finalProject.stages.rules.status} paint=${finalProject.stages.paint.status} export=${finalProject.stages.export.status}`);
console.log(`  日志尾部：${finalProject.logs.slice(-3).map((entry) => entry.message).join(" | ")}`);
expect("导出目录里有 map.png 与 map.json", existsSync(join(exportDir, "map.png")) && existsSync(join(exportDir, "map.json")));
// 多个产物要打成一个 zip（界面上点一下「导出」拿到一个文件，而不是一串）
const produced = existsSync(exportDir) ? await readdir(exportDir) : [];
const zipName = produced.find((name) => name.endsWith(".zip"));
expect("多个产物自动打了一个 zip", zipName !== undefined && existsSync(join(exportDir, zipName)), produced.join("、"));

step(12, "识别与切片的旁证（纯函数，顺手打印出来对人一眼）");
for (const [width, height] of [[64, 160], [256, 160], [128, 96], [256, 192], [37, 41]]) {
  const guess = maptiles.detectLayout(width, height);
  console.log(`  ${String(width).padStart(4)}×${String(height).padEnd(4)} → ${guess.shape.padEnd(7)} 格子 ${String(guess.cell.width).padStart(3)} ${guess.cols}×${guess.rows}  「${guess.reason}」`);
}

console.log(`\n验收建议：`);
console.log(`  · 用「在访达中打开项目目录」看 ${mapgen.mapProjectDir(projectId)}`);
console.log(`  · 界面上「导出」卡片勾好内容点一下，主下载按钮给的就是 ${zipName ?? "那个 zip"}（一次拿走全部）`);
console.log(`  · export/${exportNames[0] ?? "<地图名>"}/map.png 是成品；map.json 是存档（带 legend，引擎可读）`);
console.log(`  · preview/ 里的渲染图用来肉眼看自动连接的接缝与环绕是否自然`);
console.log(`  · 界面上：侧栏「游戏素材大师」→ 地图编辑器 → 选这个项目`);

if (failures > 0) {
  console.log(`\n端到端有 ${failures} 条硬断言失败。`);
  process.exit(1);
}
console.log(`\n端到端全部通过（生图调用 0 次）。`);
