#!/usr/bin/env node
/**
 * 地图编辑器（模块六）· 纯本地内核自检。不联网、不花钱。
 *
 * 覆盖三层纯函数：
 *   · `mapgeom.ts`   —— 网格、环绕取模、命中测试、chunk、视口范围
 *   · `mapauto.ts`   —— 整格自动连接（16 掩码）与 A2 拼块自动连接（5 形状）
 *   · `maptiles.ts`  —— 素材形态自动识别与切片
 *
 * ## 为什么每条核心断言都配一条「反向验证」
 *
 * 自己验自己最容易骗过自己：写 `a2Shape` 的人当然也会照同一张表写断言。
 * 所以每条核心规则都再写一条**错写法**，断言它必须得出不同结果 ——
 * 错写法也「通过」的话，说明这条断言没有区分力。旧模块六在这里真的抓到过
 * 「blob47 退化成 16 种」与「漏掉 /2 的反解」两个静默坏，这条习惯保留。
 *
 * 用法：node scripts/verify-map.mjs
 */
import { readFileSync } from "node:fs";

const geom = await import("../lib/mapgeom.js");
const auto = await import("../lib/mapauto.js");
const tiles = await import("../lib/maptiles.js");

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
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const WRAP = { tileWidth: 32, tileHeight: 32, wrap: true };
const FLAT = { tileWidth: 32, tileHeight: 32, wrap: false };

// ══ 1. 网格参数 ═══════════════════════════════════════════════════════════
section("1) 网格参数（normalizeGrid / assertGrid）");
{
  const fallback = geom.normalizeGrid(undefined);
  check(
    "空输入回落默认网格（32×32、默认环绕）",
    fallback.tileWidth === geom.DEFAULT_GRID.tileWidth &&
      fallback.tileHeight === geom.DEFAULT_GRID.tileHeight &&
      fallback.wrap === true,
    JSON.stringify(fallback)
  );
  check("wrap 缺省为 true（AsLib 的地图就是环绕的）", geom.normalizeGrid({ tileWidth: 16 }).wrap === true);
  check("wrap: false 被尊重", geom.normalizeGrid({ tileWidth: 16, wrap: false }).wrap === false);
  check("wrap 非法值回落默认 true", geom.normalizeGrid({ wrap: "nope" }).wrap === true);
  check("尺寸取整", geom.normalizeGrid({ tileWidth: 32.4, tileHeight: 31.6 }).tileHeight === 32);

  check("合法网格不抛", !throws(() => geom.assertGrid(WRAP)) && !throws(() => geom.assertGrid(FLAT)));
  check("瓦片尺寸必须是正整数", throws(() => geom.assertGrid({ tileWidth: 0, tileHeight: 32, wrap: true })));
  check("瓦片尺寸有上限", throws(() => geom.assertGrid({ tileWidth: 4096, tileHeight: 32, wrap: true })));
  check(
    "地图尺寸必须是正整数且有上限",
    throws(() => geom.assertMapSize(0, 4)) &&
      throws(() => geom.assertMapSize(geom.MAX_MAP_DIM + 1, 4)) &&
      !throws(() => geom.assertMapSize(1, 1))
  );
}

// ══ 2. 布局与坐标 ═════════════════════════════════════════════════════════
section("2) 布局与坐标（layoutOf / cellCenter / cellAnchor / cellTopLeft）");
{
  const l8 = geom.layoutOf(WRAP, 8, 6);
  check("步长 = 瓦片尺寸", l8.stepX === 32 && l8.stepY === 32);
  check("脚印 = 格数 × 瓦片尺寸", l8.width === 8 * 32 && l8.height === 6 * 32, `${l8.width}×${l8.height}`);
  check("layout 带上 wrap 标志", l8.wrap === true && geom.layoutOf(FLAT, 8, 6).wrap === false);

  const center = geom.cellCenter(l8, 2, 3);
  check("格中心 = (c+0.5, r+0.5) × 瓦片", center.x === 3 * 32 + 16 && center.y === 2 * 32 + 16, `${center.x},${center.y}`);
  const anchor = geom.cellAnchor(l8, 2, 3);
  check("格锚点 = 底边中点（不是中心）", anchor.x === center.x && anchor.y === 3 * 32, `${anchor.x},${anchor.y}`);
  const topLeft = geom.cellTopLeft(l8, 2, 3, 32, 64);
  check("默认锚点 = 底边中点 → 高一格的贴图左上角上移一整格", topLeft.x === 3 * 32 && topLeft.y === 96 - 64, `${topLeft.x},${topLeft.y}`);
  const custom = geom.cellTopLeft(l8, 2, 3, 32, 32, 0, 0);
  check(
    "锚点 (0,0) = 贴图自己的左上角落在格子锚点上（底边中点）",
    custom.x === 112 && custom.y === 96,
    `${custom.x},${custom.y}`
  );

  // 越界坐标必须是**线性**的：环绕时要用它算视口外那些复制格的像素位置。
  const outside = geom.cellTopLeft(l8, -1, -1, 32, 32);
  check("越界坐标（-1,-1）照样给出线性像素位置", outside.x === -32 && outside.y === -32, `${outside.x},${outside.y}`);
}

// ══ 3. 环绕取模 ═══════════════════════════════════════════════════════════
section("3) 环绕取模（wrapRow / wrapCol / wrapCell）");
{
  const l = geom.layoutOf(WRAP, 8, 6);
  check("正数直接取模", geom.wrapRow(l, 7) === 1 && geom.wrapCol(l, 9) === 1);
  check("负数也能取模（-1 → 末行 / 末列）", geom.wrapRow(l, -1) === 5 && geom.wrapCol(l, -1) === 7);
  check("多圈取模", geom.wrapRow(l, 6 * 3 + 2) === 2 && geom.wrapRow(l, -6 * 3 - 2) === 4);
  const cell = geom.wrapCell(l, -1, 8);
  check("wrapCell 同时收敛两个方向", cell.r === 5 && cell.c === 0);

  const flat = geom.layoutOf(FLAT, 8, 6);
  check("非环绕时原样返回（越界仍是越界）", geom.wrapRow(flat, -1) === -1 && geom.wrapCol(flat, 9) === 9);
}

// ══ 4. 命中测试 ═══════════════════════════════════════════════════════════
section("4) 命中测试（pointToCellRaw / pointToCell）");
{
  const l = geom.layoutOf(WRAP, 8, 6);
  let roundTrip = 0;
  const misses = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 8; c++) {
      const center = geom.cellCenter(l, r, c);
      const hit = geom.pointToCell(l, center.x, center.y);
      if (hit.r === r && hit.c === c && hit.inMap === true) roundTrip++;
      else misses.push(`(${r},${c})→(${hit.r},${hit.c})`);
    }
  }
  check("每格中心都能命中自己", misses.length === 0 && roundTrip === 48, misses.slice(0, 4).join(" "));

  // 贴边：格子内部偏移 45% 仍应落在同一格
  let offsetOk = 0;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 8; c++) {
      const center = geom.cellCenter(l, r, c);
      const all = [[14, 0], [-14, 0], [0, 14], [0, -14]].every(([dx, dy]) => {
        const hit = geom.pointToCell(l, center.x + dx, center.y + dy);
        return hit.r === r && hit.c === c;
      });
      if (all) offsetOk++;
    }
  }
  check("中心四周偏移 45% 仍落在同一格", offsetOk === 48, `${offsetOk}/48`);

  const edge = geom.pointToCell(l, 0, 0);
  check("左上角的点落在 (0,0)", edge.r === 0 && edge.c === 0);
  const far = geom.pointToCell(l, 8 * 32 - 0.001, 6 * 32 - 0.001);
  check("右下角内侧落在最后一格", far.r === 5 && far.c === 7, `${far.r},${far.c}`);

  // 环绕：图外的点一定被折回图内，且 inMap 恒为 true（AsLib 同款）。
  const wrapped = geom.pointToCell(l, -1, 6 * 32 + 1);
  check("环绕时图外点折回图内（列 -1 → 7，行 6 → 0）", wrapped.r === 0 && wrapped.c === 7 && wrapped.inMap === true, `${wrapped.r},${wrapped.c}`);
  const raw = geom.pointToCellRaw(l, -1, 6 * 32 + 1);
  check("pointToCellRaw 不折回、inMap = false", raw.r === 6 && raw.c === -1 && raw.inMap === false, `${raw.r},${raw.c}`);

  const flat = geom.layoutOf(FLAT, 8, 6);
  const flatHit = geom.pointToCell(flat, -1, -1);
  check("非环绕时图外点保留越界坐标且 inMap = false", flatHit.r === -1 && flatHit.c === -1 && flatHit.inMap === false);

  // 反向验证：把「取模」换成「原样 floor」，跨边界点必须得出不同结果。
  const naive = Math.floor(-1 / 32);
  check("反向验证：不取模的写法在跨边界点上得到不同结果", naive !== wrapped.c, `naive=${naive} vs wrapped=${wrapped.c}`);
}

// ══ 5. chunk 与脏块 ═══════════════════════════════════════════════════════
section("5) chunk（chunkOf / rangeOfChunk / chunksInRange / canonicalChunk / dirtyChunksFor）");
{
  const l = geom.layoutOf(WRAP, 64, 64);
  const flat = geom.layoutOf(FLAT, 64, 64);
  check("chunkOf 按 32 对齐", geom.chunkOf(0, 0).cx === 0 && geom.chunkOf(31, 33).cx === 1 && geom.chunkOf(32, 0).cy === 1);
  check("负数坐标给出负 chunk 号", geom.chunkOf(-1, -1).cx === -1 && geom.chunkOf(-1, -1).cy === -1);
  check("chunkKey 往返", geom.chunkKey(geom.chunkOf(70, 40)) === "1,2" && geom.parseChunkKey("1,2").cy === 2);
  check("非法 key 返回 undefined", geom.parseChunkKey("a,b") === undefined && geom.parseChunkKey("") === undefined);

  const range = geom.rangeOfChunk({ cx: 0, cy: 1 });
  check("rangeOfChunk 不裁剪（右下开区间 32 格）", range.r0 === 32 && range.r1 === 64 && range.c0 === 0 && range.c1 === 32);
  const negative = geom.rangeOfChunk({ cx: -1, cy: -1 });
  check("rangeOfChunk 对负 chunk 也成立", negative.r0 === -32 && negative.r1 === 0 && negative.c0 === -32);

  const covered = geom.chunksInRange({ r0: 0, c0: 0, r1: 33, c1: 33 });
  check("chunksInRange 覆盖跨界范围（2×2）", covered.length === 4, String(covered.length));
  const coveredNeg = geom.chunksInRange({ r0: -1, c0: -1, r1: 1, c1: 1 });
  check(
    "chunksInRange 覆盖负范围（2×2，含 (-1,-1)）",
    coveredNeg.length === 4 && coveredNeg.some((chunk) => chunk.cx === -1 && chunk.cy === -1),
    coveredNeg.map(geom.chunkKey).join(" ")
  );
  check("空范围 → 空数组", geom.chunksInRange({ r0: 0, c0: 0, r1: 0, c1: 0 }).length === 0);

  check(
    "allChunks = ceil(cols/32) × ceil(rows/32)",
    geom.allChunks(64, 64).length === 4 && geom.allChunks(1, 1).length === 1 && geom.allChunks(33, 33).length === 4
  );

  const canonical = geom.canonicalChunk({ cx: -1, cy: -1 }, 64, 64);
  check("canonicalChunk 把负 chunk 折回（-1 → 1）", canonical.cx === 1 && canonical.cy === 1, `${canonical.cx},${canonical.cy}`);
  check(
    "canonicalChunk 对已经规范的 key 是恒等（所以 dropKeys 用它映射缓存键是安全的）",
    geom.canonicalChunk({ cx: 0, cy: 1 }, 64, 64).cx === 0 && geom.canonicalChunk({ cx: 1, cy: 0 }, 64, 64).cy === 0
  );
  check("canonicalChunk 对多圈的越界 key 也能折回", geom.canonicalChunk({ cx: 5, cy: -3 }, 64, 64).cx === 1 && geom.canonicalChunk({ cx: 5, cy: -3 }, 64, 64).cy === 1);

  // 非环绕时视口范围本来就裁在图内，所以缓存键永远是规范的 —— canonicalChunk 在这里不会被用到。
  const corner = geom.dirtyChunksFor([{ r: 0, c: 0 }], flat);
  check("非环绕：角落一格只弄脏 1 个 chunk", corner.length === 1 && corner[0] === "0,0", corner.join(" "));

  const boundary = geom.dirtyChunksFor([{ r: 32, c: 32 }], flat);
  check("非环绕：32 的倍数边界上恰好弄脏 4 个 chunk", boundary.length === 4, boundary.join(" "));

  // 环绕下画第 0 行会改变最后一行的自动连接外观 → 必须连带弄脏最后一行所在的 chunk。
  // 64×64 的图是 2×2 个 chunk，所以角落一格四处都要弄脏。
  const wrapCorner = geom.dirtyChunksFor([{ r: 0, c: 0 }], l);
  check("环绕：画第 0 行必须连带弄脏最后一行的 chunk", wrapCorner.includes("0,1") && wrapCorner.includes("1,1"), wrapCorner.join(" "));
  check("环绕：角落一格会弄脏全部 4 个 chunk（2×2 的图）", wrapCorner.length === 4, wrapCorner.join(" "));

  const flatCorner = geom.dirtyChunksFor([{ r: 0, c: 0 }], flat);
  check("反向验证：非环绕时不会连带弄脏最后一行", !flatCorner.includes("0,1"), flatCorner.join(" "));
}

// ══ 6. 视口范围 ═══════════════════════════════════════════════════════════
section("6) 视口范围（viewCellRange / clampRangeToMap）");
{
  const l = geom.layoutOf(WRAP, 8, 6);
  // 视口 [32,96) × [32,64) 严格覆盖第 1 行的第 1~2 列。
  // 契约是「四角反解 + 外扩」，所以范围允许比严格覆盖**多一圈**（多画一格无害，
  // 反而是安全的：不会被舍入误差咬掉边上那一列），但不能多出更多。
  const inside = geom.viewCellRange(l, { x: 32, y: 32, width: 64, height: 32 }, 0);
  check(
    "纯图内视口：覆盖到真正的可见格（允许各边多一格）",
    inside.r0 <= 1 && inside.r1 >= 2 && inside.c0 <= 1 && inside.c1 >= 3 && inside.r1 - inside.r0 <= 2 && inside.c1 - inside.c0 <= 3,
    JSON.stringify(inside)
  );
  const padded = geom.viewCellRange(l, { x: 32, y: 32, width: 64, height: 32 }, 1);
  check(
    "padding = 1 向四周各扩一圈（自动连接要看邻居）",
    padded.r0 === inside.r0 - 1 && padded.c0 === inside.c0 - 1 && padded.r1 === inside.r1 + 1 && padded.c1 === inside.c1 + 1,
    JSON.stringify(padded)
  );

  const crossSeam = geom.viewCellRange(l, { x: -16, y: -16, width: 64, height: 64 }, 0);
  check("环绕：跨左上边界时范围可以是负数", crossSeam.r0 === -1 && crossSeam.c0 === -1, JSON.stringify(crossSeam));

  const huge = geom.viewCellRange(l, { x: -4000, y: -4000, width: 8000, height: 8000 }, 0);
  check(
    "环绕：范围被截到最多一张地图那么大（内容重复，多画只会爆计划）",
    huge.r1 - huge.r0 <= 6 && huge.c1 - huge.c0 <= 8,
    `${huge.r1 - huge.r0}×${huge.c1 - huge.c0}`
  );

  const flat = geom.layoutOf(FLAT, 8, 6);
  const clamped = geom.viewCellRange(flat, { x: -4000, y: -4000, width: 8000, height: 8000 }, 0);
  check("非环绕：范围被裁到地图内", clamped.r0 === 0 && clamped.c0 === 0 && clamped.r1 === 6 && clamped.c1 === 8, JSON.stringify(clamped));

  const clamp = geom.clampRangeToMap(flat, { r0: -5, c0: -5, r1: 99, c1: 99 });
  check("clampRangeToMap 裁到地图内", clamp.r0 === 0 && clamp.c0 === 0 && clamp.r1 === 6 && clamp.c1 === 8);
}

// ══ 7. 整格自动连接（16 掩码）══════════════════════════════════════════════
section("7) 整格自动连接（corner16Mask）");
{
  // 十字形：(1,1) 的四邻都在，用来验证「四邻全通」；边缘格用来验证单边。
  const plus = new Set(["1,1", "0,1", "2,1", "1,0", "1,2"]);
  const at = (r, c) => plus.has(`${r},${c}`);
  check("位序 N=1 E=2 S=4 W=8", auto.NB4_N === 1 && auto.NB4_E === 2 && auto.NB4_S === 4 && auto.NB4_W === 8);
  check("四邻都连通 → 15", auto.corner16Mask(at, 1, 1) === 15, String(auto.corner16Mask(at, 1, 1)));
  check("只有上邻连通 → 1", auto.corner16Mask(at, 2, 1) === 1, String(auto.corner16Mask(at, 2, 1)));
  check("只有右邻连通 → 2", auto.corner16Mask(at, 1, 0) === 2, String(auto.corner16Mask(at, 1, 0)));
  check("孤立块 → 0", auto.corner16Mask(at, 5, 5) === 0);
  check("掩码全集是 0..15", auto.CORNER16_MASKS.length === 16 && Math.max(...auto.CORNER16_MASKS) === 15);

  // 反向验证：把 N/E 两位写反，只有上邻的格子结果必须不同。
  const swapped = (at_, r, c) =>
    (at_(r, c + 1) ? 1 : 0) | (at_(r - 1, c) ? 2 : 0) | (at_(r + 1, c) ? 4 : 0) | (at_(r, c - 1) ? 8 : 0);
  check(
    "反向验证：把 N/E 两位写反后结果确实不同",
    swapped(at, 2, 1) !== auto.corner16Mask(at, 2, 1),
    `swapped=${swapped(at, 2, 1)} vs real=${auto.corner16Mask(at, 2, 1)}`
  );

  check("缺块回退取 Hamming 最近的掩码", auto.nearestMask(15, [0, 7]) === 7 && auto.nearestMask(0, [15, 14]) === 14);
  check("回退并列取掩码小的那个", auto.nearestMask(15, [7, 11]) === 7);
  check("没有已配掩码时返回 undefined（绝不留空）", auto.nearestMask(3, []) === undefined);
  check(
    "hammingDistance 对称且相等时为 0",
    auto.hammingDistance(10, 10) === 0 && auto.hammingDistance(10, 15) === auto.hammingDistance(15, 10)
  );
}

// ══ 8. A2 拼块自动连接（5 形状）════════════════════════════════════════════
section("8) A2 拼块自动连接（a2Shape / a2QuadrantShapes）");
{
  check("形状数恰好 5", auto.A2_SHAPES === 5);
  check("四象限顺序固定 TL/TR/BL/BR", JSON.stringify(auto.A2_QUADRANT_ORDER) === JSON.stringify(["TL", "TR", "BL", "BR"]));
  check("都不连通 → 0", auto.a2Shape(false, false, false) === 0 && auto.a2Shape(false, false, true) === 0);
  check("只上连通 → 1", auto.a2Shape(false, true, false) === 1 && auto.a2Shape(false, true, true) === 1);
  check("只左连通 → 2", auto.a2Shape(true, false, false) === 2 && auto.a2Shape(true, false, true) === 2);
  check("左上都连通、对角不通 → 3", auto.a2Shape(true, true, false) === 3);
  check("左上都连通、对角也通 → 4", auto.a2Shape(true, true, true) === 4);

  // 反向验证：只有一边连通时，左与上必须给出不同形状（1 ↔ 2）——
  // 把两者写反的实现在这里一定红。
  check(
    "反向验证：交换 left/up 语义后形状 1 与 2 互换",
    auto.a2Shape(true, false, false) === 2 && auto.a2Shape(false, true, false) === 1
  );

  const solid = (r, c) => r >= 0 && r < 3 && c >= 0 && c < 3;
  check("3×3 实心块正中一格四象限都是 4", auto.a2QuadrantShapes(solid, 1, 1).every((shape) => shape === 4), JSON.stringify(auto.a2QuadrantShapes(solid, 1, 1)));

  const lonely = (r, c) => r === 1 && c === 1;
  check("单格孤岛四象限都是 0", auto.a2QuadrantShapes(lonely, 1, 1).every((shape) => shape === 0));

  const rightOnly = (r, c) => r === 1 && (c === 1 || c === 2);
  const quad = auto.a2QuadrantShapes(rightOnly, 1, 1);
  check("右边有邻居：TL=0 TR=2 BL=0 BR=2", JSON.stringify(quad) === JSON.stringify([0, 2, 0, 2]), JSON.stringify(quad));
}

// ══ 9. 素材形态识别与切片 ═════════════════════════════════════════════════
section("9) 素材形态识别（detectLayout / layoutFor / buildTiles）");
{
  const a2 = tiles.detectLayout(64, 160);
  check(
    "64×160 识别为 A2 拼块（2 变体 × 5 形状）",
    a2.shape === "a2quad" && a2.cell.width === 32 && a2.cell.height === 32 && a2.cols === 2 && a2.rows === 5,
    JSON.stringify({ shape: a2.shape, cell: a2.cell, cols: a2.cols, rows: a2.rows })
  );
  check("识别说明是人话且提到拼块", typeof a2.reason === "string" && a2.reason.includes("拼块"), a2.reason);

  const wide = tiles.detectLayout(256, 160);
  check(
    "256×160 识别为 A2 且 8 变体",
    wide.shape === "a2quad" && wide.cell.width === 32 && wide.cols === 8 && wide.rows === 5,
    JSON.stringify({ shape: wide.shape, cols: wide.cols })
  );

  const plain = tiles.detectLayout(128, 96);
  check(
    "128×96 识别为普通图块（32px、4×3）",
    plain.shape === "plain" && plain.cell.width === 32 && plain.cell.height === 32 && plain.cols === 4 && plain.rows === 3,
    JSON.stringify({ shape: plain.shape, cell: plain.cell, cols: plain.cols, rows: plain.rows })
  );

  const odd = tiles.detectLayout(37, 41);
  check("识别不出来时给出人话原因", typeof odd.reason === "string" && odd.reason.length > 0, odd.reason);

  // 256×192 = 8×6 个 32px 道具。plain 兜底必须**优先 ≤32**，否则「能整除的最大尺寸」
  // 会把它算成 64px 格（4×3）—— 那等于静默把 2×2 个道具并成一块。
  const props = tiles.detectLayout(256, 192);
  check(
    "256×192 的 32px 道具图识别为 32px 格（不会被 64px 抢走）",
    props.shape === "plain" && props.cell.width === 32 && props.cols === 8 && props.rows === 6,
    JSON.stringify({ shape: props.shape, cell: props.cell, cols: props.cols, rows: props.rows })
  );

  check(
    "layoutFor 能强制指定形态（界面上的手动开关）",
    tiles.layoutFor("plain", { width: 16, height: 16 }, 64, 160).shape === "plain" &&
      tiles.layoutFor("plain", { width: 16, height: 16 }, 64, 160).cols === 4
  );

  const a2Tiles = tiles.buildTiles({ shape: "a2quad", cell: { width: 32, height: 32 }, imageWidth: 64, imageHeight: 160 });
  check("A2 切片数量 = 小格列数 × 10 行", a2Tiles.length === 4 * 10, String(a2Tiles.length));
  const shapes = new Set(a2Tiles.map((tile) => tile.shape));
  const variants = new Set(a2Tiles.map((tile) => tile.variant));
  check("A2 小格标了形状 0..4", shapes.size === 5 && Math.min(...shapes) === 0 && Math.max(...shapes) === 4, [...shapes].join(","));
  check("A2 小格标了变体 0..1", variants.size === 2, [...variants].join(","));
  check(
    "A2 小格的 id 由矩形派生、rect 是小格尺寸",
    a2Tiles.every((tile) => /^t\d+_\d+$/.test(tile.id) && tile.rect.width === 16 && tile.rect.height === 16)
  );
  // 契约：小格列 = variant*2 + (0|1)，小格行 = shape*2 + (0|1)
  const cellOf = (shape, variant, dx, dy) =>
    a2Tiles.find(
      (tile) =>
        tile.shape === shape &&
        tile.variant === variant &&
        tile.rect.x === (variant * 2 + dx) * 16 &&
        tile.rect.y === (shape * 2 + dy) * 16
    );
  check(
    "形状/变体 → 小格行列的映射（形状 3 变体 1 的 TL 小格在 (48, 96)）",
    cellOf(3, 1, 0, 0) !== undefined && cellOf(4, 0, 1, 1) !== undefined
  );

  const plainTiles = tiles.buildTiles({ shape: "plain", cell: { width: 32, height: 32 }, imageWidth: 128, imageHeight: 96 });
  check(
    "普通切片 = 4×3 共 12 块、行优先",
    plainTiles.length === 12 && plainTiles[0].rect.x === 0 && plainTiles[0].rect.y === 0 && plainTiles[4].rect.y === 32
  );
  check("普通图块默认没有动画帧", plainTiles.every((tile) => (tile.frame ?? 0) === 0));

  const anim = tiles.buildTiles({ shape: "plain", cell: { width: 32, height: 32 }, imageWidth: 32, imageHeight: 96, animRows: true });
  check("逐行动画：同列不同行 = 同一块的帧 0/1/2", anim.length === 3 && anim.map((tile) => tile.frame).join(",") === "0,1,2");

  const kept = tiles.buildTiles(
    { shape: "plain", cell: { width: 32, height: 32 }, imageWidth: 128, imageHeight: 96 },
    plainTiles.map((tile, index) => (index === 0 ? { ...tile, mask: 7, name: "手工改过的名字" } : tile))
  );
  check("重切时按 id 保留人工字段", kept[0].mask === 7 && kept[0].name === "手工改过的名字", JSON.stringify({ mask: kept[0].mask, name: kept[0].name }));

  const plainTs = {
    id: "a",
    name: "a",
    file: "tilesets/a.png",
    imageWidth: 128,
    imageHeight: 96,
    cell: { width: 32, height: 32 },
    shape: "plain",
    animRows: false,
    variants: 1,
    tiles: plainTiles
  };
  const flat = tiles.flatTiles([plainTs]);
  check("全局图块序号从 1 开始、按切分顺序", flat.length === 12 && flat[0].index === 1 && flat[0].value === 1 && flat[11].index === 12);
  check("按序号反查", tiles.flatIndexByValue([plainTs]).get(2).index === 2);
  check("图块 id 由矩形派生（稳定）", tiles.tileIdFor({ x: 3, y: 5, width: 8, height: 8 }) === "t3_5");

  // cropTile 真的裁对了
  const source = { width: 4, height: 3, rgba: Buffer.alloc(4 * 3 * 4) };
  for (let i = 0; i < 4 * 3; i++) {
    source.rgba[i * 4] = i;
    source.rgba[i * 4 + 3] = 255;
  }
  const cropped = tiles.cropTile(source, { x: 2, y: 1, width: 2, height: 2 });
  check("cropTile 尺寸正确", cropped.width === 2 && cropped.height === 2);
  check("cropTile 取到正确的像素", cropped.rgba[0] === 6 && cropped.rgba[4] === 7 && cropped.rgba[8] === 10, `${cropped.rgba[0]},${cropped.rgba[4]},${cropped.rgba[8]}`);
  check("cropTile 越界时收缩到图内", tiles.cropTile(source, { x: 3, y: 2, width: 8, height: 8 }).width === 1);
}

// ══ 10. 与浏览器半区的契约 ════════════════════════════════════════════════
//
// 客户端复刻的坐标函数与宿主实现的**黄金对照**放在 `verify-map-client.mjs`
// （那边才有真渲染环境）。这里钉两条静态约束：客户端不许自己发明几何，
// 也不许把旧术语（用户抱怨「门槛高」的根因）带回来。
section("10) 客户端静态约束（文本检查）");
{
  const clientText = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
  check(
    "浏览器半区没有自己实现变体挑选 / 绘制顺序 / chunk 计算",
    !clientText.includes("function MAP_pickVariant") &&
      !clientText.includes("function MAP_drawOrder") &&
      !clientText.includes("function MAP_visibleChunks"),
    "变体、顺序、chunk 一律由宿主计划给出"
  );
  check(
    "浏览器半区仍复刻着坐标函数",
    clientText.includes("function MAP_pointToCell") && clientText.includes("function MAP_cellTopLeft")
  );

  // 术语黑名单只扫**模块六那一段**：`图集`（Spine 纹理图集）与 `等距`（45° 地块）
  // 在别的模块里是正确用词，全文件扫会误伤 —— 而模块六的实际代码就在 `模块②：图片生成`
  // **之前**，所以切片终点取「锚点之后的下一条 `// ──` 分节注释」，别再去 indexOf 另一个模块名
  // （那会命中文件更靠前的同名字符串，切出空段 → 黑名单变成假绿）。
  const start = clientText.indexOf("模块六 · 地图编辑器");
  const after = start < 0 ? -1 : clientText.indexOf("\n    // ──", start + 20);
  const sectionText = start < 0 ? "" : clientText.slice(start, after > start ? after : undefined);
  check(
    "模块六段落的切片锚点还在、且切出了足量内容（否则下面的黑名单会假绿）",
    sectionText.length > 20000,
    `start=${start} end=${after} 长度=${sectionText.length}`
  );
  for (const word of ["地形族", "掩码", "优先级", "切分", "图集", "变体种子", "高度偏移", "Tiled", "等距"]) {
    const hit = sectionText.includes(word);
    check(`模块六界面源码里不出现旧术语「${word}」`, !hit, hit ? "命中旧术语" : "");
  }
  // `chunk` 单独用词边界判：宿主协议里的字段名就是 `chunks`，那是**协议**不是界面术语，
  // 禁掉它只会逼出 `"chu" + "nks"` 这类为了骗过自检的写法（真出现过），反而更坏。
  {
    const hit = /\bchunk\b/.test(sectionText);
    check("模块六界面源码里不出现旧术语「chunk」（协议字段 chunks 除外）", !hit, hit ? "命中旧术语" : "");
  }
  check(
    "（对照）整份客户端里仍然允许别处出现「图集」/「等距」（模块④ / 模块⑤ 的正确用词）",
    clientText.length > sectionText.length
  );
}

console.log(`\n${failures.length === 0 ? "全部通过" : "有失败"}：${passed} 项通过${failures.length > 0 ? `，${failures.length} 项失败` : ""}`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
